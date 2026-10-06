/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { RefundSignerService } from './refund-signer.service';

const TREE_DEPTH = 20;
const MAX_REFUNDS = 10;
const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HALF_MODULUS_PLUS_ONE = (FIELD_MODULUS + 1n) / 2n;
const ascending = Array.from({ length: MAX_REFUNDS }, (_, i) =>
  BigInt(1000 + i),
);

const hasCircom = spawnSync('circom', ['--version']).status === 0;

(hasCircom ? describe : describe.skip)('api_request.circom', () => {
  let outDir: string;
  let wasmPath: string;
  let serverKey: [string, string];
  let inputFor: (
    numRefunds: number,
    values: bigint[],
    options?: { prvKey?: Buffer; nullifiers?: bigint[] },
  ) => Promise<Record<string, unknown>>;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'api-request-'));
    execFileSync('circom', [
      resolve(__dirname, '../../circuits/api_request.circom'),
      '--wasm',
      '-o',
      outDir,
    ]);
    wasmPath = join(outDir, 'api_request_js', 'api_request.wasm');

    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const str = (x: unknown): string => F.toObject(x).toString();

    const secretKey = 12345n;
    const idCommitment = poseidon([secretKey]);

    let root = idCommitment;
    for (let i = 0; i < TREE_DEPTH; i++) root = poseidon([root, 0n]);

    // Tickets come from the server's own signer, so the circuit is tested against it
    const signers = new Map<string, RefundSignerService>();
    const signerFor = (prvKey: Buffer) => {
      const cached = signers.get(prvKey.toString('hex'));
      if (cached) return cached;
      const signer = new RefundSignerService({
        getRefundSignerPrivateKey: () => prvKey,
      } as unknown as KeyDerivationService);
      for (const level of ['log', 'debug'] as const) {
        jest.spyOn(signer['logger'], level).mockImplementation();
      }
      signers.set(prvKey.toString('hex'), signer);
      return signer;
    };
    const dec = (hex: string): string => BigInt(hex).toString();

    const serverPrvKey = Buffer.alloc(32, 7);
    const serverPub = await signerFor(serverPrvKey).getPublicKey();
    serverKey = [dec(serverPub.x), dec(serverPub.y)];

    const timestamp = 1700000000;

    inputFor = async (
      numRefunds: number,
      values: bigint[],
      { prvKey = serverPrvKey, nullifiers = ascending } = {},
    ) => {
      const signer = signerFor(prvKey);
      const slots = await Promise.all(
        values.map((value, i) =>
          signer.signRefund({
            idCommitment: str(idCommitment),
            nullifier: nullifiers[i].toString(),
            value: value.toString(),
            timestamp,
          }),
        ),
      );
      const pub = await signer.getPublicKey();
      return {
        secretKey: secretKey.toString(),
        ticketIndex: '10',
        initialDeposit: '100',
        merklePathElements: Array<string>(TREE_DEPTH).fill('0'),
        merklePathIndices: Array<string>(TREE_DEPTH).fill('0'),
        numRefunds: String(numRefunds),
        refundValues: slots.map((s) => s.value),
        refundTimestamps: slots.map((s) => s.timestamp.toString()),
        refundSignaturesR8x: slots.map((s) => dec(s.signature.R8x)),
        refundSignaturesR8y: slots.map((s) => dec(s.signature.R8y)),
        refundSignaturesS: slots.map((s) => dec(s.signature.S)),
        refundNullifiers: slots.map((s) => s.nullifier),
        serverPublicKeyX: dec(pub.x),
        serverPublicKeyY: dec(pub.y),
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

  // Witness layout: [1, nullifier, signalY, idCommitment, merkleRoot, merkleRootExpected, maxCost, signalX, serverPublicKeyX, serverPublicKeyY, ...]
  const publicServerKey = async (input: Record<string, unknown>) => {
    const signals: bigint[] = await snarkjs.wtns.exportJson({
      type: 'mem',
      data: await witness(input),
    });
    return [signals[8].toString(), signals[9].toString()];
  };

  // Every slot carries a valid signature, so each case fails only on the constraint it targets
  const values = (...head: bigint[]): bigint[] => [
    ...head,
    ...Array<bigint>(MAX_REFUNDS - head.length).fill(0n),
  ];

  it('accepts a signed refund that covers the request', async () => {
    await expect(
      witness(await inputFor(1, values(20n))),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('accepts numRefunds equal to MAX_REFUNDS', async () => {
    await expect(
      witness(await inputFor(MAX_REFUNDS, values(20n))),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects numRefunds greater than MAX_REFUNDS', async () => {
    await expect(
      witness(await inputFor(MAX_REFUNDS + 1, values(20n))),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects the same ticket in two active slots', async () => {
    const nullifiers = [1000n, ...ascending.slice(0, MAX_REFUNDS - 1)];
    await expect(
      witness(await inputFor(2, values(20n, 20n), { nullifiers })),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects active refund nullifiers out of order', async () => {
    const nullifiers = [1001n, 1000n, ...ascending.slice(2)];
    await expect(
      witness(await inputFor(2, values(20n, 20n), { nullifiers })),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('ignores the order of turned-off slots', async () => {
    const nullifiers = [1000n, ...Array<bigint>(MAX_REFUNDS - 1).fill(0n)];
    await expect(
      witness(await inputFor(1, values(20n), { nullifiers })),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  // Poseidon nullifiers span the whole field, above what a 252-bit comparator handles
  it('orders nullifiers across the whole field', async () => {
    const top = [FIELD_MODULUS - 2n, FIELD_MODULUS - 1n];
    const filler = Array<bigint>(MAX_REFUNDS - 2).fill(0n);

    await expect(
      witness(
        await inputFor(2, values(20n, 20n), {
          nullifiers: [...top, ...filler],
        }),
      ),
    ).resolves.toBeInstanceOf(Uint8Array);
    await expect(
      witness(
        await inputFor(2, values(20n, 20n), {
          nullifiers: [...top].reverse().concat(filler),
        }),
      ),
    ).rejects.toThrow(/Assert Failed/);
  }, 30000);

  it('rejects a nonzero value in a turned-off slot', async () => {
    await expect(witness(await inputFor(1, values(20n, 50n)))).rejects.toThrow(
      /Assert Failed/,
    );
  });

  // (ticketIndex + 1) * maxCost ≡ 1 (mod p), which passed solvency before the range checks
  it('rejects a ticketIndex that wraps the required balance', async () => {
    await expect(
      witness({
        ...(await inputFor(0, values())),
        ticketIndex: (HALF_MODULUS_PLUS_ONE - 1n).toString(),
        maxCost: '2',
      }),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects a maxCost that wraps the required balance', async () => {
    await expect(
      witness({
        ...(await inputFor(0, values())),
        ticketIndex: '1',
        maxCost: HALF_MODULUS_PLUS_ONE.toString(),
      }),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('accepts operands at their maximum width', async () => {
    await expect(
      witness({
        ...(await inputFor(0, values())),
        ticketIndex: (2n ** 32n - 1n).toString(),
        maxCost: '0',
        initialDeposit: (2n ** 128n - 1n).toString(),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects a ticketIndex wider than 32 bits', async () => {
    await expect(
      witness({
        ...(await inputFor(0, values())),
        ticketIndex: (2n ** 32n).toString(),
        maxCost: '0',
      }),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects an initialDeposit wider than 128 bits', async () => {
    await expect(
      witness({
        ...(await inputFor(0, values())),
        initialDeposit: (2n ** 128n).toString(),
      }),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('rejects a refund value wider than 128 bits', async () => {
    await expect(
      witness(await inputFor(1, values(2n ** 128n))),
    ).rejects.toThrow(/Assert Failed/);
  });

  it('exposes the server key as a public signal', async () => {
    await expect(
      publicServerKey(await inputFor(1, values(20n))),
    ).resolves.toEqual(serverKey);
  });

  // The circuit accepts any signer, so the verifier must reject a foreign key
  it('exposes a foreign signing key instead of the server key', async () => {
    const foreignKey = await publicServerKey(
      await inputFor(1, values(20n), { prvKey: Buffer.alloc(32, 9) }),
    );
    expect(foreignKey).not.toEqual(serverKey);
  });
});
