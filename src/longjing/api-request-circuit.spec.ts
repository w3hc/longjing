/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { buildEddsa, buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';

const TREE_DEPTH = 20;
const MAX_REFUNDS = 10;

const hasCircom = spawnSync('circom', ['--version']).status === 0;

(hasCircom ? describe : describe.skip)('api_request.circom', () => {
  let outDir: string;
  let wasmPath: string;
  let inputFor: (
    numRefunds: number,
    values: bigint[],
  ) => Record<string, unknown>;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'api-request-'));
    execFileSync('circom', [
      resolve(__dirname, '../../circuits/api_request.circom'),
      '--wasm',
      '-o',
      outDir,
    ]);
    wasmPath = join(outDir, 'api_request_js', 'api_request.wasm');

    const eddsa = await buildEddsa();
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const str = (x: unknown): string => F.toObject(x).toString();

    const secretKey = 12345n;
    const idCommitment = poseidon([secretKey]);

    let root = idCommitment;
    for (let i = 0; i < TREE_DEPTH; i++) root = poseidon([root, 0n]);

    const prvKey = Buffer.alloc(32, 7);
    const pubKey = eddsa.prv2pub(prvKey);

    const timestamp = 1700000000n;
    const signedSlots = (values: bigint[]) =>
      values.map((value, i) => {
        const nullifier = BigInt(1000 + i);
        const msg = poseidon([idCommitment, nullifier, value, timestamp]);
        const sig = eddsa.signMiMC(prvKey, msg);
        return {
          value: value.toString(),
          nullifier: nullifier.toString(),
          R8x: str(sig.R8[0]),
          R8y: str(sig.R8[1]),
          S: sig.S.toString(),
        };
      });

    inputFor = (numRefunds: number, values: bigint[]) => {
      const slots = signedSlots(values);
      return {
        secretKey: secretKey.toString(),
        ticketIndex: '10',
        initialDeposit: '100',
        merklePathElements: Array<string>(TREE_DEPTH).fill('0'),
        merklePathIndices: Array<string>(TREE_DEPTH).fill('0'),
        numRefunds: String(numRefunds),
        refundValues: slots.map((s) => s.value),
        refundTimestamps: slots.map(() => timestamp.toString()),
        refundSignaturesR8x: slots.map((s) => s.R8x),
        refundSignaturesR8y: slots.map((s) => s.R8y),
        refundSignaturesS: slots.map((s) => s.S),
        refundNullifiers: slots.map((s) => s.nullifier),
        serverPublicKeyX: str(pubKey[0]),
        serverPublicKeyY: str(pubKey[1]),
        merkleRootExpected: str(root),
        maxCost: '10',
        signalX: '42',
      };
    };
  }, 600000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const witness = async (input: Record<string, unknown>) => {
    const wtns: { type: string; data?: Uint8Array } = { type: 'mem' };
    await snarkjs.wtns.calculate(input, wasmPath, wtns);
    return wtns.data;
  };

  // Every slot carries a valid signature, so each case fails only on the constraint it targets
  const values = (...head: bigint[]): bigint[] => [
    ...head,
    ...Array<bigint>(MAX_REFUNDS - head.length).fill(0n),
  ];

  it('accepts a signed refund that covers the request', async () => {
    await expect(witness(inputFor(1, values(20n)))).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it('accepts numRefunds equal to MAX_REFUNDS', async () => {
    await expect(
      witness(inputFor(MAX_REFUNDS, values(20n))),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects numRefunds greater than MAX_REFUNDS', async () => {
    await expect(
      witness(inputFor(MAX_REFUNDS + 1, values(20n))),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects a nonzero value in a turned-off slot', async () => {
    await expect(witness(inputFor(1, values(20n, 50n)))).rejects.toThrow(
      /Assert Failed/,
    );
  });
});
