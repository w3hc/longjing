/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as snarkjs from 'snarkjs';
import { commit, FIELD_MODULUS, rerandomize } from './accumulator';
import {
  buildNoteFixture,
  Held,
  NoteFixture,
  TREE_DEPTH,
} from './note.fixture';

const SECRET_KEY = 12345n;
const DEPOSIT = 100n;
const MAX_COST = 30n;
const SIGNAL_X = 42n;
const RERANDOMIZER = 987654321n;

const hasCircom = spawnSync('circom', ['--version']).status === 0;

(hasCircom ? describe : describe.skip)('request.circom', () => {
  let outDir: string;
  let wasmPath: string;
  let fx: NoteFixture;
  let note: ReturnType<NoteFixture['note']>;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'request-'));
    execFileSync('circom', [
      resolve(__dirname, '../../circuits/request.circom'),
      '--wasm',
      '-o',
      outDir,
    ]);
    wasmPath = join(outDir, 'request_js', 'request.wasm');
    fx = await buildNoteFixture();
    note = fx.note(SECRET_KEY, DEPOSIT);
  }, 600000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const inputFor = (
    held: Held,
    overrides: Record<string, string | bigint> = {},
  ): Record<string, unknown> => {
    const input: Record<string, string | bigint> = {
      secretKey: SECRET_KEY,
      deposit: DEPOSIT,
      ...fx.accumulatorInputs(held),
      rerandomizer: RERANDOMIZER,
      merkleRoot: note.root,
      maxCost: MAX_COST,
      signalX: SIGNAL_X,
      serverPublicKeyX: fx.serverKey[0],
      serverPublicKeyY: fx.serverKey[1],
      ...overrides,
    };
    return {
      ...Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, v.toString()]),
      ),
      merklePathElements: Array<string>(TREE_DEPTH).fill('0'),
      merklePathIndices: Array<string>(TREE_DEPTH).fill('0'),
    };
  };

  // Layout: [1, nullifier, signalY, accumulatorX, accumulatorY, merkleRoot, maxCost, signalX, serverPublicKeyX, serverPublicKeyY, ...]
  const publicSignals = async (input: Record<string, unknown>) => {
    const wtns: { type: string; data?: Uint8Array } = { type: 'mem' };
    await snarkjs.wtns.calculate(input, wasmPath, wtns);
    const signals: bigint[] = await snarkjs.wtns.exportJson(wtns);
    return signals.slice(1, 10);
  };

  const rlnFor = (index: bigint) => {
    const a = fx.poseidon([SECRET_KEY, index]);
    return {
      nullifier: fx.poseidon([a]),
      signalY: (SECRET_KEY + a * SIGNAL_X) % FIELD_MODULUS,
    };
  };

  it('accepts the first request from the genesis accumulator', async () => {
    const signals = await publicSignals(inputFor(note.genesis));
    const published = rerandomize(commit(note.genesis.opening), RERANDOMIZER);
    const { nullifier, signalY } = rlnFor(0n);

    expect(signals.slice(0, 4)).toEqual([nullifier, signalY, ...published]);
    expect(signals.slice(4)).toEqual([
      note.root,
      MAX_COST,
      SIGNAL_X,
      ...fx.serverKey,
    ]);
  });

  it('accepts the next request on the accumulator the server signed', async () => {
    const second = fx.respond(note.genesis, RERANDOMIZER, 10n);
    const signals = await publicSignals(inputFor(second));
    expect(signals[0]).toEqual(rlnFor(1n).nullifier);
  });

  it('reveals no commitment, leaf, deposit or index', async () => {
    const second = fx.respond(note.genesis, RERANDOMIZER, 10n);
    const signals = await publicSignals(inputFor(second));
    for (const secret of [note.commitment, note.leaf, DEPOSIT, 1n, 10n]) {
      expect(signals).not.toContain(secret);
    }
  });

  it('publishes a fresh accumulator for every rerandomizer', async () => {
    const first = await publicSignals(inputFor(note.genesis));
    const second = await publicSignals(
      inputFor(note.genesis, { rerandomizer: RERANDOMIZER + 1n }),
    );
    expect(second.slice(2, 4)).not.toEqual(first.slice(2, 4));
  });

  // Request 2 after refunds of 20 and 0: D + R = 120 = 3 · 40
  const third = () =>
    fx.respond(fx.respond(note.genesis, RERANDOMIZER, 20n), RERANDOMIZER, 0n);

  it('accepts a request that spends exactly the balance', async () => {
    await expect(
      publicSignals(inputFor(third(), { maxCost: 40n })),
    ).resolves.toHaveLength(9);
  });

  it('rejects an over-budget request', async () => {
    await expect(
      publicSignals(inputFor(third(), { maxCost: 41n })),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects a deposit other than the one in the leaf', async () => {
    await expect(
      publicSignals(inputFor(note.genesis, { deposit: DEPOSIT + 1n })),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects an accumulator from another note', async () => {
    const other = fx.note(SECRET_KEY + 1n, DEPOSIT);
    const signed = fx.respond(other.genesis, RERANDOMIZER, 10n);
    await expect(publicSignals(inputFor(signed))).rejects.toThrow(
      /Assert Failed/,
    );
  });

  it('rejects an accumulator signed by another key', async () => {
    const forged = fx.respond(
      note.genesis,
      RERANDOMIZER,
      10n,
      Buffer.alloc(32, 9),
    );
    await expect(publicSignals(inputFor(forged))).rejects.toThrow(
      /Assert Failed/,
    );
  });

  it('rejects refunds the server never signed', async () => {
    const second = fx.respond(note.genesis, RERANDOMIZER, 10n);
    await expect(
      publicSignals(inputFor(second, { refunds: 1000n })),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects a genesis accumulator past the first request', async () => {
    await expect(
      publicSignals(inputFor(note.genesis, { index: 1n })),
    ).rejects.toThrow(/Assert Failed/);
    await expect(
      publicSignals(inputFor(note.genesis, { refunds: 10n })),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects a deposit wider than 128 bits', async () => {
    const wide = fx.note(SECRET_KEY, 2n ** 128n);
    await expect(
      publicSignals(
        inputFor(wide.genesis, { deposit: 2n ** 128n, merkleRoot: wide.root }),
      ),
    ).rejects.toThrow(/Assert Failed/);
  });
});
