/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { buildPoseidon } from 'circomlibjs';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { BlockchainService } from './blockchain.service';
import { ProofGenService } from './proof-gen.service';
import { ProofVerifierService } from './proof-verifier.service';
import { RefundSignerService } from './refund-signer.service';
import { SnarkjsProofService } from './snarkjs-proof.service';

const TREE_DEPTH = 20;
const MAX_REFUNDS = 10;

// Proves with the committed api_request artifacts and verifies with its verification key
describe('api_request proof verification', () => {
  const env = { ...process.env };
  let snarkjsProofService: SnarkjsProofService;
  let verifier: ProofVerifierService;
  let requestFrom: (
    prvKey: Buffer,
  ) => Promise<{ proof: string; publicSignals: string[] }>;

  beforeAll(async () => {
    process.env.ZK_CIRCUIT = 'api_request';
    snarkjsProofService = new SnarkjsProofService();
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(snarkjsProofService['logger'], level).mockImplementation();
    }

    const poseidon = await buildPoseidon();
    const str = (x: unknown): string => poseidon.F.toObject(x).toString();
    const dec = (hex: string): string => BigInt(hex).toString();

    const signerFor = (prvKey: Buffer) => {
      const signer = new RefundSignerService({
        getRefundSignerPrivateKey: () => prvKey,
      } as unknown as KeyDerivationService);
      for (const level of ['log', 'debug'] as const) {
        jest.spyOn(signer['logger'], level).mockImplementation();
      }
      return signer;
    };
    const refundSigner = signerFor(Buffer.alloc(32, 7));

    verifier = new ProofVerifierService(
      { isAvailable: () => false } as unknown as BlockchainService,
      {} as ProofGenService,
      snarkjsProofService,
      refundSigner,
    );
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(verifier['logger'], level).mockImplementation();
    }

    const secretKey = 12345n;
    const idCommitment = poseidon([secretKey]);
    let root = idCommitment;
    for (let i = 0; i < TREE_DEPTH; i++) root = poseidon([root, 0n]);

    const timestamp = 1700000000;
    const zeros = Array<string>(MAX_REFUNDS - 1).fill('0');

    requestFrom = async (prvKey: Buffer) => {
      const signer = signerFor(prvKey);
      const pub = await signer.getPublicKey();
      const { signature } = await signer.signRefund({
        idCommitment: str(idCommitment),
        nullifier: '1000',
        value: '20',
        timestamp,
      });
      const { proof, publicSignals } = await snarkjsProofService.generateProof({
        secretKey: secretKey.toString(),
        ticketIndex: '10',
        initialDeposit: '100',
        merklePathElements: Array<string>(TREE_DEPTH).fill('0'),
        merklePathIndices: Array<string>(TREE_DEPTH).fill('0'),
        numRefunds: '1',
        refundValues: ['20', ...zeros],
        refundTimestamps: Array<string>(MAX_REFUNDS).fill(timestamp.toString()),
        refundSignaturesR8x: [dec(signature.R8x), ...zeros],
        refundSignaturesR8y: [dec(signature.R8y), ...zeros],
        refundSignaturesS: [dec(signature.S), ...zeros],
        refundNullifiers: ['1000', ...zeros],
        serverPublicKeyX: dec(pub.x),
        serverPublicKeyY: dec(pub.y),
        merkleRootExpected: str(root),
        maxCost: '10',
        signalX: '42',
      });
      // Wire format, as clients send it: projective coordinates, pi_b pairs swapped
      const wire = {
        pi_a: [proof.pi_a[0], proof.pi_a[1], '1'],
        pi_b: [
          [proof.pi_b[0][1], proof.pi_b[0][0], '1'],
          [proof.pi_b[1][1], proof.pi_b[1][0], '1'],
        ],
        pi_c: [proof.pi_c[0], proof.pi_c[1], '1'],
        protocol: 'groth16',
      };
      return { proof: JSON.stringify(wire), publicSignals };
    };
  });

  afterAll(async () => {
    process.env = { ...env };
    // snarkjs keeps the curve's worker threads alive, which would hang Jest
    await (globalThis as any).curve_bn128?.terminate();
  });

  const verify = async ({
    proof,
    publicSignals: [nullifier, signalY, idCommitment, merkleRoot, , maxCost],
  }: {
    proof: string;
    publicSignals: string[];
  }) =>
    verifier.verify(proof, {
      merkleRoot,
      maxCost,
      initialDeposit: '0',
      signalX: '42',
      nullifier,
      signalY,
      idCommitment,
      idCommitmentExpected: idCommitment,
    });

  it('accepts a request whose refunds the server signed', async () => {
    await expect(verify(await requestFrom(Buffer.alloc(32, 7)))).resolves.toBe(
      true,
    );
  }, 120000);

  it('rejects a request whose refunds a foreign key signed', async () => {
    await expect(verify(await requestFrom(Buffer.alloc(32, 9)))).resolves.toBe(
      false,
    );
  }, 120000);
});
