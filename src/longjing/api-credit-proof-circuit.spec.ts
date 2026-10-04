/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { buildEddsa, buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';

const TREE_DEPTH = 20;
const MAX_REFUNDS = 100;
const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HALF_MODULUS_PLUS_ONE = (FIELD_MODULUS + 1n) / 2n;

const hasCircom = spawnSync('circom', ['--version']).status === 0;

const compile = (outDir: string, name: string): string => {
  execFileSync('circom', [
    resolve(__dirname, `../../circuits/${name}.circom`),
    '--wasm',
    '-o',
    outDir,
  ]);
  return join(outDir, `${name}_js`, `${name}.wasm`);
};

const witness = async (wasmPath: string, input: Record<string, unknown>) => {
  const wtns: { type: string; data?: Uint8Array } = { type: 'mem' };
  await snarkjs.wtns.calculate(input, wasmPath, wtns);
  return wtns.data;
};

(hasCircom ? describe : describe.skip)('api credit proof circuits', () => {
  jest.setTimeout(120000);

  let outDir: string;
  let fullWasm: string;
  let simpleWasm: string;
  let fullInput: (
    numRefunds: number,
    refundValue: bigint,
  ) => Record<string, unknown>;
  let simpleInput: () => Record<string, unknown>;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'api-credit-proof-'));
    fullWasm = compile(outDir, 'api_credit_proof');
    simpleWasm = compile(outDir, 'api_credit_proof_simple');

    const eddsa = await buildEddsa();
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const str = (x: unknown): string => F.toObject(x).toString();

    const secretKey = 12345n;
    const idCommitment = poseidon([secretKey]);

    let root = idCommitment;
    for (let i = 0; i < TREE_DEPTH; i++) root = poseidon([root, 0n]);

    const base = {
      secretKey: secretKey.toString(),
      pathElements: Array<string>(TREE_DEPTH).fill('0'),
      pathIndices: Array<string>(TREE_DEPTH).fill('0'),
      ticketIndex: '9',
      merkleRoot: str(root),
      maxCost: '10',
      initialDeposit: '100',
      signalX: '42',
    };

    const prvKey = Buffer.alloc(32, 7);
    const pubKey = eddsa.prv2pub(prvKey);
    const timestamp = 1700000000n;

    const signedSlot = (i: number, value: bigint) => {
      const nullifier = BigInt(1000 + i);
      const msg = poseidon([idCommitment, nullifier, value, timestamp]);
      const sig = eddsa.signPoseidon(prvKey, msg);
      return {
        value: value.toString(),
        nullifier: nullifier.toString(),
        R8x: str(sig.R8[0]),
        R8y: str(sig.R8[1]),
        S: sig.S.toString(),
      };
    };
    const zeroSlots = Array.from({ length: MAX_REFUNDS - 1 }, (_, i) =>
      signedSlot(i + 1, 0n),
    );

    // Every slot carries a valid signature, so each case fails only on the constraint it targets
    fullInput = (numRefunds: number, refundValue: bigint) => {
      const slots = [signedSlot(0, refundValue), ...zeroSlots];
      return {
        ...base,
        numRefunds: String(numRefunds),
        refundValues: slots.map((s) => s.value),
        refundNullifiers: slots.map((s) => s.nullifier),
        refundTimestamps: slots.map(() => timestamp.toString()),
        refundSignaturesR8x: slots.map((s) => s.R8x),
        refundSignaturesR8y: slots.map((s) => s.R8y),
        refundSignaturesS: slots.map((s) => s.S),
        serverPubKeyX: str(pubKey[0]),
        serverPubKeyY: str(pubKey[1]),
      };
    };
    simpleInput = () => ({ ...base });
  }, 600000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const cases: [string, () => string, () => Record<string, unknown>][] = [
    ['api_credit_proof.circom', () => fullWasm, () => fullInput(0, 0n)],
    ['api_credit_proof_simple.circom', () => simpleWasm, () => simpleInput()],
  ];

  describe.each(cases)('%s', (_name, wasm, input) => {
    it('accepts a deposit that covers the request', async () => {
      await expect(witness(wasm(), input())).resolves.toBeInstanceOf(
        Uint8Array,
      );
    });

    it('accepts operands at their maximum width', async () => {
      await expect(
        witness(wasm(), {
          ...input(),
          ticketIndex: (2n ** 32n - 1n).toString(),
          maxCost: '0',
          initialDeposit: (2n ** 128n - 1n).toString(),
        }),
      ).resolves.toBeInstanceOf(Uint8Array);
    });

    // (ticketIndex + 1) * maxCost ≡ 1 (mod p), which passed solvency before the range checks
    it('rejects a ticketIndex that wraps the required balance', async () => {
      await expect(
        witness(wasm(), {
          ...input(),
          ticketIndex: (HALF_MODULUS_PLUS_ONE - 1n).toString(),
          maxCost: '2',
        }),
      ).rejects.toThrow(/Assert Failed/);
    });

    it('rejects a maxCost that wraps the required balance', async () => {
      await expect(
        witness(wasm(), {
          ...input(),
          ticketIndex: '1',
          maxCost: HALF_MODULUS_PLUS_ONE.toString(),
        }),
      ).rejects.toThrow(/Assert Failed/);
    });

    it('rejects a ticketIndex wider than 32 bits', async () => {
      await expect(
        witness(wasm(), {
          ...input(),
          ticketIndex: (2n ** 32n).toString(),
          maxCost: '0',
        }),
      ).rejects.toThrow(/Assert Failed/);
    });

    it('rejects an initialDeposit wider than 128 bits', async () => {
      await expect(
        witness(wasm(), {
          ...input(),
          initialDeposit: (2n ** 128n).toString(),
        }),
      ).rejects.toThrow(/Assert Failed/);
    });
  });

  it('accepts a signed refund that covers the request', async () => {
    await expect(
      witness(fullWasm, { ...fullInput(1, 20n), initialDeposit: '90' }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects a refund value wider than 128 bits', async () => {
    await expect(witness(fullWasm, fullInput(1, 2n ** 128n))).rejects.toThrow(
      /Assert Failed/,
    );
  });
});
