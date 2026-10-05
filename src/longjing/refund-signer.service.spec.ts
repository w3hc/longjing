import { KeyDerivationService } from '../keys/key-derivation.service';
import { RefundSignerService } from './refund-signer.service';

describe('RefundSignerService', () => {
  const originalProfile = process.env.PROFILE;
  const originalOperatorKey = process.env.OPERATOR_PRIVATE_KEY;

  const create = (key: Buffer | null) =>
    new RefundSignerService({
      getRefundSignerPrivateKey: () => key,
    } as unknown as KeyDerivationService);

  const ticket = {
    idCommitment: '0x01',
    nullifier: '0x02',
    value: '1000',
    timestamp: 1_700_000_000,
  };

  afterEach(() => {
    process.env.PROFILE = originalProfile;
    if (originalOperatorKey === undefined) {
      delete process.env.OPERATOR_PRIVATE_KEY;
    } else {
      process.env.OPERATOR_PRIVATE_KEY = originalOperatorKey;
    }
  });

  it('signs with the derived key, ignoring OPERATOR_PRIVATE_KEY', async () => {
    process.env.OPERATOR_PRIVATE_KEY = '0x' + '11'.repeat(32);
    const derived = create(Buffer.alloc(32, 7));
    const fromEnv = create(null);

    const derivedKey = await derived.getPublicKey();

    expect(derivedKey).toEqual(
      await create(Buffer.alloc(32, 7)).getPublicKey(),
    );
    expect(derivedKey).not.toEqual(await fromEnv.getPublicKey());
    const signed = await derived.signRefund(ticket);
    expect(await derived.verifyRefund(signed, ticket.idCommitment)).toBe(true);
  }, 30000);

  it('refuses to fall back in production without a derived key', async () => {
    process.env.PROFILE = 'prod';

    await expect(create(null).onModuleInit()).rejects.toThrow(
      'Refund signer key not derived from dstack',
    );
  }, 30000);

  it('uses the dev fallback key only in local', async () => {
    process.env.PROFILE = 'local';
    delete process.env.OPERATOR_PRIVATE_KEY;

    await expect(create(null).getPublicKey()).resolves.toBeDefined();
  }, 30000);
});
