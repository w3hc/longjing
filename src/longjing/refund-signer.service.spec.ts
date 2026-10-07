import { KeyDerivationService } from '../keys/key-derivation.service';
import { RefundSignerService } from './refund-signer.service';
import { genesis } from './accumulator';
import { buildNoteFixture, SERVER_PRV_KEY } from './note.fixture';

describe('RefundSignerService', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOperatorKey = process.env.OPERATOR_PRIVATE_KEY;

  const create = (key: Buffer | null) =>
    new RefundSignerService({
      getRefundSignerPrivateKey: () => key,
    } as unknown as KeyDerivationService);

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
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
  }, 30000);

  // note.fixture's signer is the one the circuit tests prove with
  it('signs accumulators as the circuits verify them', async () => {
    const signer = create(SERVER_PRV_KEY);
    const fx = await buildNoteFixture();
    const accumulator = genesis(42n);

    const signature = await signer.signAccumulator(accumulator);
    const expected = fx.signerFor(SERVER_PRV_KEY).sign(accumulator);
    expect(Object.values(signature).map(BigInt)).toEqual([
      expected.R8x,
      expected.R8y,
      expected.S,
    ]);
    const key = await signer.getPublicKey();
    expect([BigInt(key.x), BigInt(key.y)]).toEqual(fx.serverKey);

    await expect(
      signer.verifyAccumulator(accumulator, signature),
    ).resolves.toBe(true);
    await expect(
      signer.verifyAccumulator(genesis(43n), signature),
    ).resolves.toBe(false);
  }, 30000);

  it('refuses to fall back in production without a derived key', async () => {
    process.env.NODE_ENV = 'production';

    await expect(create(null).onModuleInit()).rejects.toThrow(
      'Refund signer key not derived from dstack',
    );
  }, 30000);

  it('uses the dev fallback key only in local', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.OPERATOR_PRIVATE_KEY;

    await expect(create(null).getPublicKey()).resolves.toBeDefined();
  }, 30000);
});
