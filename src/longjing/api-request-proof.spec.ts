/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { buildEddsa, buildPoseidon } from 'circomlibjs';
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

    const eddsa = await buildEddsa();
    const poseidon = await buildPoseidon();
    const str = (x: unknown): string => poseidon.F.toObject(x).toString();

    const serverPrvKey = Buffer.alloc(32, 7);
    const serverPub = eddsa.prv2pub(serverPrvKey);
    const refundSigner = {
      getPublicKey: jest
        .fn()
        .mockResolvedValue({ x: str(serverPub[0]), y: str(serverPub[1]) }),
    } as unknown as RefundSignerService;

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

    const timestamp = 1700000000n;
    const zeros = Array<string>(MAX_REFUNDS - 1).fill('0');

    requestFrom = async (prvKey: Buffer) => {
      const pub = eddsa.prv2pub(prvKey);
      const msg = poseidon([idCommitment, 1000n, 20n, timestamp]);
      const sig = eddsa.signMiMC(prvKey, msg);
      const { proof, publicSignals } = await snarkjsProofService.generateProof({
        secretKey: secretKey.toString(),
        ticketIndex: '10',
        initialDeposit: '100',
        merklePathElements: Array<string>(TREE_DEPTH).fill('0'),
        merklePathIndices: Array<string>(TREE_DEPTH).fill('0'),
        numRefunds: '1',
        refundValues: ['20', ...zeros],
        refundTimestamps: Array<string>(MAX_REFUNDS).fill(timestamp.toString()),
        refundSignaturesR8x: [str(sig.R8[0]), ...zeros],
        refundSignaturesR8y: [str(sig.R8[1]), ...zeros],
        refundSignaturesS: [sig.S.toString(), ...zeros],
        refundNullifiers: ['1000', ...zeros],
        serverPublicKeyX: str(pub[0]),
        serverPublicKeyY: str(pub[1]),
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
