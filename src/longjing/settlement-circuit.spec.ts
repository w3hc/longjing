/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as snarkjs from 'snarkjs';
import { FIELD_MODULUS } from './accumulator';
import { buildNoteFixture, Held, NoteFixture } from './note.fixture';

const SECRET_KEY = 12345n;
const DEPOSIT = 100n;
const MAX_COST = 30n;
const RECIPIENT = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
const SIGNAL_X = 42n;
const RERANDOMIZER = 987654321n;

const hasCircom = spawnSync('circom', ['--version']).status === 0;

(hasCircom ? describe : describe.skip)('settlement.circom', () => {
  let outDir: string;
  let wasmPath: string;
  let fx: NoteFixture;
  let note: ReturnType<NoteFixture['note']>;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'settlement-'));
    execFileSync('circom', [
      resolve(__dirname, '../../circuits/settlement.circom'),
      '--wasm',
      '-o',
      outDir,
    ]);
    wasmPath = join(outDir, 'settlement_js', 'settlement.wasm');
    fx = await buildNoteFixture();
    note = fx.note(SECRET_KEY, DEPOSIT);
  }, 600000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const inputFor = (
    held: Held,
    claimedIndex: bigint,
    overrides: Record<string, bigint> = {},
  ): Record<string, string> => {
    const input: Record<string, string | bigint> = {
      secretKey: SECRET_KEY,
      ...fx.accumulatorInputs(held),
      claimedIndex,
      commitment: note.commitment,
      deposit: DEPOSIT,
      maxCost: MAX_COST,
      serverPublicKeyX: fx.serverKey[0],
      serverPublicKeyY: fx.serverKey[1],
      recipient: RECIPIENT,
      signalX: SIGNAL_X,
      ...overrides,
    };
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, v.toString()]),
    );
  };

  // Layout: [1, nullifier, signalY, payout, commitment, deposit, maxCost, serverPublicKeyX, serverPublicKeyY, recipient, signalX, ...]
  const publicSignals = async (input: Record<string, unknown>) => {
    const wtns: { type: string; data?: Uint8Array } = { type: 'mem' };
    await snarkjs.wtns.calculate(input, wasmPath, wtns);
    const signals: bigint[] = await snarkjs.wtns.exportJson(wtns);
    return signals.slice(1, 11);
  };

  // Two requests with refunds of 25 and 5: m = 2, R = 30
  const afterTwoRequests = () =>
    fx.respond(fx.respond(note.genesis, RERANDOMIZER, 25n), RERANDOMIZER, 5n);

  it('pays D + R − n · C_MAX on an honest exit', async () => {
    const a = fx.poseidon([SECRET_KEY, 2n]);
    const signals = await publicSignals(inputFor(afterTwoRequests(), 2n));
    expect(signals).toEqual([
      fx.poseidon([a]),
      (SECRET_KEY + a * SIGNAL_X) % FIELD_MODULUS,
      DEPOSIT + 30n - 2n * MAX_COST,
      note.commitment,
      DEPOSIT,
      MAX_COST,
      ...fx.serverKey,
      RECIPIENT,
      SIGNAL_X,
    ]);
  });

  it('pays the whole deposit for a note that made no request', async () => {
    const signals = await publicSignals(inputFor(note.genesis, 0n));
    expect(signals[2]).toBe(DEPOSIT);
  });

  it('charges C_MAX for each index claimed past the accumulator', async () => {
    const signals = await publicSignals(inputFor(afterTwoRequests(), 3n));
    expect(signals[2]).toBe(DEPOSIT + 30n - 3n * MAX_COST);
  });

  it('lets a user who lost the accumulator exit from genesis', async () => {
    const signals = await publicSignals(inputFor(note.genesis, 2n));
    expect(signals[2]).toBe(DEPOSIT - 2n * MAX_COST);
  });

  it('rejects a claim below the accumulator index', async () => {
    await expect(
      publicSignals(inputFor(afterTwoRequests(), 1n)),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects a negative payout', async () => {
    await expect(publicSignals(inputFor(note.genesis, 4n))).rejects.toThrow(
      /Assert Failed/,
    );
  });

  it('rejects a key that does not open the note', async () => {
    await expect(
      publicSignals(
        inputFor(note.genesis, 0n, { commitment: note.commitment + 1n }),
      ),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects an accumulator from another note', async () => {
    const other = fx.note(SECRET_KEY + 1n, DEPOSIT);
    const signed = fx.respond(other.genesis, RERANDOMIZER, 25n);
    await expect(publicSignals(inputFor(signed, 1n))).rejects.toThrow(
      /Assert Failed/,
    );
  });

  it('rejects refunds the server never signed', async () => {
    await expect(
      publicSignals(inputFor(afterTwoRequests(), 2n, { refunds: 1000n })),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects an accumulator signed by another key', async () => {
    const forged = fx.respond(
      note.genesis,
      RERANDOMIZER,
      25n,
      Buffer.alloc(32, 9),
    );
    await expect(publicSignals(inputFor(forged, 1n))).rejects.toThrow(
      /Assert Failed/,
    );
  });

  it('rejects a claimed index wider than 32 bits', async () => {
    await expect(
      publicSignals(inputFor(note.genesis, 2n ** 32n, { maxCost: 0n })),
    ).rejects.toThrow(/Assert Failed/);
  });
});
