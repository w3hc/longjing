/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { readFileSync } from 'fs';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { RefundSignerService } from './refund-signer.service';

const TREE_DEPTH = 20;
const BUILD = 'circuits/build';

// A proof must stop verifying once its recipient is swapped, which is what
// keeps a relayer from redirecting a withdrawal or a refund to itself
describe('recipient binding', () => {
  const recipient = BigInt('0x70997970C51812dc3A010C7d01b50e0d17dC79C8');
  const thief = BigInt('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
  let poseidon: any;
  let str: (x: unknown) => string;

  beforeAll(async () => {
    poseidon = await buildPoseidon();
    str = (x) => poseidon.F.toObject(x).toString();
  });

  afterAll(async () => {
    // snarkjs keeps the curve's worker threads alive, which would hang Jest
    await (globalThis as any).curve_bn128?.terminate();
  });

  const expectBound = async (
    circuit: string,
    zkey: string,
    input: Record<string, unknown>,
  ) => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      `${BUILD}/${circuit}_js/${circuit}.wasm`,
      `${BUILD}/${zkey}`,
    );
    const vKey = JSON.parse(
      readFileSync(`${BUILD}/${circuit}_verification_key.json`, 'utf8'),
    );
    // recipient is the last public signal in both circuits
    const swapped = [...publicSignals.slice(0, -1), thief.toString()];

    expect(publicSignals.at(-1)).toBe(recipient.toString());
    await expect(
      snarkjs.groth16.verify(vKey, publicSignals, proof),
    ).resolves.toBe(true);
    await expect(snarkjs.groth16.verify(vKey, swapped, proof)).resolves.toBe(
      false,
    );
  };

  it('binds a withdrawal proof to its recipient', async () => {
    const secretKey = 12345n;
    let root = poseidon([secretKey]);
    for (let i = 0; i < TREE_DEPTH; i++) root = poseidon([root, 0n]);

    await expectBound('withdrawal', 'withdrawal.zkey', {
      secretKey: secretKey.toString(),
      ticketIndex: '1',
      merklePathElements: Array<string>(TREE_DEPTH).fill('0'),
      merklePathIndices: Array<string>(TREE_DEPTH).fill('0'),
      signalX: '42',
      merkleRootExpected: str(root),
      recipient: recipient.toString(),
    });
  }, 120000);

  it('binds a refund redemption proof to its recipient', async () => {
    const secretKey = 12345n;
    const ticketIndex = 1n;
    const idCommitment = poseidon([secretKey]);
    const nullifier = poseidon([poseidon([secretKey, ticketIndex])]);

    const signer = new RefundSignerService({
      getRefundSignerPrivateKey: () => Buffer.alloc(32, 7),
    } as unknown as KeyDerivationService);
    for (const level of ['log', 'debug'] as const) {
      jest.spyOn(signer['logger'], level).mockImplementation();
    }
    const ticket = await signer.signRefund({
      idCommitment: str(idCommitment),
      nullifier: str(nullifier),
      value: '20',
      timestamp: 1700000000,
    });
    const pub = await signer.getPublicKey();
    const dec = (hex: string): string => BigInt(hex).toString();

    await expectBound('refund_redemption', 'refund_redemption.zkey', {
      secretKey: secretKey.toString(),
      ticketIndex: ticketIndex.toString(),
      refundValue: ticket.value,
      refundTimestamp: ticket.timestamp.toString(),
      refundSignatureR8x: dec(ticket.signature.R8x),
      refundSignatureR8y: dec(ticket.signature.R8y),
      refundSignatureS: dec(ticket.signature.S),
      signalX: '42',
      refundValueClaimed: ticket.value,
      serverPublicKeyX: dec(pub.x),
      serverPublicKeyY: dec(pub.y),
      recipient: recipient.toString(),
    });
  }, 120000);
});
