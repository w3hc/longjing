import { ConfigService } from '@nestjs/config';
import { createMlKem1024 } from 'mlkem';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { TeeKeyManagerService } from './tee-key-manager.service';

describe('TeeKeyManagerService', () => {
  let mlkem: Awaited<ReturnType<typeof createMlKem1024>>;
  let publicKey: Uint8Array;
  let secretKey: Uint8Array;

  beforeAll(async () => {
    mlkem = await createMlKem1024();
    [publicKey, secretKey] = mlkem.generateKeyPair();
  });

  const create = async (
    derived: Partial<KeyDerivationService>,
    env: Record<string, string> = {},
  ) => {
    const config = { get: (key: string) => env[key] } as ConfigService;
    const service = new TeeKeyManagerService(
      config,
      derived as KeyDerivationService,
    );
    await service.onModuleInit();
    return service;
  };

  it('uses the derived keys when dstack derived them', async () => {
    const decapsulate = jest.fn((ct: Uint8Array) => mlkem.decap(ct, secretKey));
    const service = await create(
      { getMlKemPublicKey: () => publicKey, decapsulate },
      {
        ADMIN_MLKEM_PUBLIC_KEY: 'ignored',
        ADMIN_MLKEM_PRIVATE_KEY: 'ignored',
      },
    );
    const [ciphertext, sharedSecret] = mlkem.encap(publicKey);

    expect(service.isTeeMode()).toBe(true);
    expect(service.isAvailable()).toBe(true);
    expect(service.getPublicKeyBytes()).toEqual(Buffer.from(publicKey));
    expect(service.decapsulate(ciphertext)).toEqual(sharedSecret);
    expect(decapsulate).toHaveBeenCalledWith(ciphertext);
  });

  it('falls back to env keys when dstack derived none', async () => {
    const service = await create(
      { getMlKemPublicKey: () => null },
      {
        ADMIN_MLKEM_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
        ADMIN_MLKEM_PRIVATE_KEY: Buffer.from(secretKey).toString('base64'),
      },
    );
    const [ciphertext, sharedSecret] = mlkem.encap(publicKey);

    expect(service.isTeeMode()).toBe(false);
    expect(service.isAvailable()).toBe(true);
    expect(service.decapsulate(ciphertext)).toEqual(sharedSecret);
  });

  it('is unavailable with neither derived nor env keys', async () => {
    const service = await create({ getMlKemPublicKey: () => null });

    expect(service.isAvailable()).toBe(false);
    expect(service.getPublicKey()).toBeNull();
    expect(() => service.decapsulate(new Uint8Array(1568))).toThrow(
      'not initialized',
    );
  });

  it('rejects env keys of the wrong size', async () => {
    await expect(
      create(
        { getMlKemPublicKey: () => null },
        {
          ADMIN_MLKEM_PUBLIC_KEY: Buffer.alloc(10).toString('base64'),
          ADMIN_MLKEM_PRIVATE_KEY: Buffer.from(secretKey).toString('base64'),
        },
      ),
    ).rejects.toThrow('public key size');
  });
});
