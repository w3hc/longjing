/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { readFileSync } from 'fs';
import * as snarkjs from 'snarkjs';
import { buildNoteFixture, NoteFixture, TREE_DEPTH } from './note.fixture';

const BUILD = 'circuits/build';
const SECRET_KEY = 12345n;
const DEPOSIT = 100n;
const MAX_COST = 30n;
const RECIPIENT = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
const THIEF = 0x3c44cdddb6a900fa2b585dd299e03d12fa4293bcn;

const str = (input: Record<string, string | bigint>) =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v.toString()]));

// Real Groth16 proofs against the pinned circuits-v2 keys
describe('request and settlement proofs', () => {
  let fx: NoteFixture;
  let note: ReturnType<NoteFixture['note']>;

  beforeAll(async () => {
    fx = await buildNoteFixture();
    note = fx.note(SECRET_KEY, DEPOSIT);
  });

  afterAll(async () => {
    // snarkjs keeps the curve's worker threads alive, which would hang Jest
    await (globalThis as any).curve_bn128?.terminate();
  });

  const prove = async (circuit: string, input: Record<string, unknown>) => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      `${BUILD}/${circuit}_js/${circuit}.wasm`,
      `${BUILD}/${circuit}.zkey`,
    );
    const vKey = JSON.parse(
      readFileSync(`${BUILD}/${circuit}_verification_key.json`, 'utf8'),
    );
    const verify = (signals: string[]): Promise<boolean> =>
      snarkjs.groth16.verify(vKey, signals, proof);
    return { publicSignals, verify };
  };

  const requestInput = (held: Parameters<NoteFixture['respond']>[0]) => ({
    ...str({
      secretKey: SECRET_KEY,
      deposit: DEPOSIT,
      ...fx.accumulatorInputs(held),
      rerandomizer: 987654321n,
      merkleRoot: note.root,
      maxCost: MAX_COST,
      signalX: 42n,
      serverPublicKeyX: fx.serverKey[0],
      serverPublicKeyY: fx.serverKey[1],
    }),
    merklePathElements: Array<string>(TREE_DEPTH).fill('0'),
    merklePathIndices: Array<string>(TREE_DEPTH).fill('0'),
  });

  it('proves two requests in a row, from genesis then from a signed accumulator', async () => {
    const first = await prove('request', requestInput(note.genesis));
    await expect(first.verify(first.publicSignals)).resolves.toBe(true);

    const signed = fx.respond(note.genesis, 987654321n, 10n);
    const second = await prove('request', requestInput(signed));
    await expect(second.verify(second.publicSignals)).resolves.toBe(true);
    expect(second.publicSignals[0]).not.toBe(first.publicSignals[0]);

    // A_pub is bound: a proof doesn't verify for another accumulator
    const swapped = [...second.publicSignals];
    swapped[2] = first.publicSignals[2];
    swapped[3] = first.publicSignals[3];
    await expect(second.verify(swapped)).resolves.toBe(false);
  }, 120000);

  it('proves a settlement bound to its recipient and payout', async () => {
    const held = fx.respond(note.genesis, 987654321n, 25n);
    const { publicSignals, verify } = await prove(
      'settlement',
      str({
        secretKey: SECRET_KEY,
        ...fx.accumulatorInputs(held),
        claimedIndex: 1n,
        commitment: note.commitment,
        deposit: DEPOSIT,
        maxCost: MAX_COST,
        serverPublicKeyX: fx.serverKey[0],
        serverPublicKeyY: fx.serverKey[1],
        recipient: RECIPIENT,
        signalX: 42n,
      }),
    );
    // [nullifier, signalY, payout, commitment, deposit, maxCost, keyX, keyY, recipient, signalX]
    expect(publicSignals[2]).toBe((DEPOSIT + 25n - MAX_COST).toString());
    await expect(verify(publicSignals)).resolves.toBe(true);

    const redirected = [...publicSignals];
    redirected[8] = THIEF.toString();
    await expect(verify(redirected)).resolves.toBe(false);

    const inflated = [...publicSignals];
    inflated[2] = DEPOSIT.toString();
    await expect(verify(inflated)).resolves.toBe(false);
  }, 120000);
});
