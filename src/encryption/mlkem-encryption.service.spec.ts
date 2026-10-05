import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  MlKemEncryptionService,
  MultiRecipientEncryptedPayload,
} from './mlkem-encryption.service';
import { TeeKeyManagerService } from '../attestation/tee-key-manager.service';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { createMlKem1024 } from 'mlkem';
import * as crypto from 'crypto';

describe('MlKemEncryptionService', () => {
  let service: MlKemEncryptionService;
  let keyManager: TeeKeyManagerService;
  let mlkem: Awaited<ReturnType<typeof createMlKem1024>>;
  let serverPublicKey: Uint8Array;
  let serverPrivateKey: Uint8Array;

  beforeAll(async () => {
    // Generate server keypair for testing
    mlkem = await createMlKem1024();
    [serverPublicKey, serverPrivateKey] = mlkem.generateKeyPair();
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MlKemEncryptionService,
        TeeKeyManagerService,
        {
          provide: KeyDerivationService,
          useValue: { getMlKemPublicKey: () => null },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'ADMIN_MLKEM_PUBLIC_KEY') {
                return Buffer.from(serverPublicKey).toString('base64');
              }
              if (key === 'ADMIN_MLKEM_PRIVATE_KEY') {
                return Buffer.from(serverPrivateKey).toString('base64');
              }
              if (key === 'TEE_PLATFORM') {
                return 'mock';
              }
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<MlKemEncryptionService>(MlKemEncryptionService);
    keyManager = module.get<TeeKeyManagerService>(TeeKeyManagerService);
    await keyManager.onModuleInit();
  });

  describe('onModuleInit', () => {
    it('should initialize ML-KEM with correct key sizes', () => {
      expect(service.isAvailable()).toBe(true);
      expect(service.getPublicKey()).toBeTruthy();

      const publicKey = Buffer.from(service.getPublicKey()!, 'base64');
      expect(publicKey.length).toBe(1568);
    });

    it('should warn when keys are not configured', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MlKemEncryptionService,
          TeeKeyManagerService,
          {
            provide: KeyDerivationService,
            useValue: { getMlKemPublicKey: () => null },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => null),
            },
          },
        ],
      }).compile();

      const testService = module.get<MlKemEncryptionService>(
        MlKemEncryptionService,
      );
      const testKeyManager =
        module.get<TeeKeyManagerService>(TeeKeyManagerService);

      await testKeyManager.onModuleInit();

      expect(testService.isAvailable()).toBe(false);
      expect(testService.getPublicKey()).toBeNull();
    });

    it('should throw error for invalid public key size', async () => {
      const invalidPublicKey = Buffer.alloc(100); // Wrong size
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MlKemEncryptionService,
          TeeKeyManagerService,
          {
            provide: KeyDerivationService,
            useValue: { getMlKemPublicKey: () => null },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'ADMIN_MLKEM_PUBLIC_KEY') {
                  return invalidPublicKey.toString('base64');
                }
                if (key === 'ADMIN_MLKEM_PRIVATE_KEY') {
                  return Buffer.from(serverPrivateKey).toString('base64');
                }
                if (key === 'TEE_PLATFORM') {
                  return 'mock';
                }
                return null;
              }),
            },
          },
        ],
      }).compile();

      const testKeyManager =
        module.get<TeeKeyManagerService>(TeeKeyManagerService);

      await expect(testKeyManager.onModuleInit()).rejects.toThrow(
        /Invalid ML-KEM-1024 public key size/,
      );
    });

    it('should throw error for invalid private key size', async () => {
      const invalidPrivateKey = Buffer.alloc(100); // Wrong size
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MlKemEncryptionService,
          TeeKeyManagerService,
          {
            provide: KeyDerivationService,
            useValue: { getMlKemPublicKey: () => null },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'ADMIN_MLKEM_PUBLIC_KEY') {
                  return Buffer.from(serverPublicKey).toString('base64');
                }
                if (key === 'ADMIN_MLKEM_PRIVATE_KEY') {
                  return invalidPrivateKey.toString('base64');
                }
                if (key === 'TEE_PLATFORM') {
                  return 'mock';
                }
                return null;
              }),
            },
          },
        ],
      }).compile();

      const testKeyManager =
        module.get<TeeKeyManagerService>(TeeKeyManagerService);

      await expect(testKeyManager.onModuleInit()).rejects.toThrow(
        /Invalid ML-KEM-1024 private key size/,
      );
    });
  });

  describe('getPublicKey', () => {
    it('should return base64 encoded public key', () => {
      const publicKeyBase64 = service.getPublicKey();
      expect(publicKeyBase64).toBeTruthy();

      const publicKey = Buffer.from(publicKeyBase64!, 'base64');
      expect(publicKey.length).toBe(1568);
    });
  });

  describe('isAvailable', () => {
    it('should return true when keys are loaded', () => {
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('Multi-Recipient Encryption/Decryption', () => {
    let clientPublicKey: Uint8Array;

    beforeEach(() => {
      // Generate client keypair
      [clientPublicKey] = mlkem.generateKeyPair();
    });

    it('should decrypt multi-recipient payload encrypted by client', async () => {
      const plaintext = 'Test secret message for multi-recipient encryption';

      // Client encrypts for themselves + server
      const encrypted = await encryptMultiRecipient(plaintext, [
        Buffer.from(clientPublicKey).toString('base64'),
        service.getPublicKey()!,
      ]);

      // Server decrypts
      const decrypted = service.decryptMultiRecipient(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle multiple recipients correctly', async () => {
      const plaintext = 'Secret for multiple recipients';

      // Generate additional recipient keypair
      const [recipient2Public] = mlkem.generateKeyPair();

      const encrypted = await encryptMultiRecipient(plaintext, [
        Buffer.from(clientPublicKey).toString('base64'),
        service.getPublicKey()!,
        Buffer.from(recipient2Public).toString('base64'),
      ]);

      expect(encrypted.recipients.length).toBe(3);

      // Server should still be able to decrypt
      const decrypted = service.decryptMultiRecipient(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should throw error if server public key not in recipients', async () => {
      const plaintext = 'Secret not encrypted for server';

      // Encrypt only for client (not server)
      const encrypted = await encryptMultiRecipient(plaintext, [
        Buffer.from(clientPublicKey).toString('base64'),
      ]);

      expect(() => service.decryptMultiRecipient(encrypted)).toThrow(
        /Server public key not found in recipients list/,
      );
    });

    it('should throw error if ciphertext size is invalid', async () => {
      const plaintext = 'Test';
      const encrypted = await encryptMultiRecipient(plaintext, [
        service.getPublicKey()!,
      ]);

      // Corrupt ciphertext size
      encrypted.recipients[0].ciphertext =
        Buffer.from('invalid').toString('base64');

      expect(() => service.decryptMultiRecipient(encrypted)).toThrow(
        /Invalid combined ciphertext size/,
      );
    });

    it('should throw error if auth tag is invalid', async () => {
      const plaintext = 'Test';
      const encrypted = await encryptMultiRecipient(plaintext, [
        service.getPublicKey()!,
      ]);

      // Corrupt auth tag
      encrypted.authTag = Buffer.from('corrupted_tag_12').toString('base64');

      expect(() => service.decryptMultiRecipient(encrypted)).toThrow();
    });

    it('should handle empty plaintext', async () => {
      const plaintext = '';
      const encrypted = await encryptMultiRecipient(plaintext, [
        service.getPublicKey()!,
      ]);

      const decrypted = service.decryptMultiRecipient(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle large plaintext', async () => {
      const plaintext = 'A'.repeat(100000); // 100KB
      const encrypted = await encryptMultiRecipient(plaintext, [
        service.getPublicKey()!,
      ]);

      const decrypted = service.decryptMultiRecipient(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle Unicode characters', async () => {
      const plaintext = '你好世界 🔐 Test émojis Spëcîål çhãrs';
      const encrypted = await encryptMultiRecipient(plaintext, [
        service.getPublicKey()!,
      ]);

      const decrypted = service.decryptMultiRecipient(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('Legacy Single-Recipient Encryption/Decryption', () => {
    it('should encrypt and decrypt with legacy format', () => {
      const plaintext = 'Legacy encryption test';

      const encrypted = service.encrypt(plaintext);

      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.encryptedData).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();

      // Verify sizes
      const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
      expect(ciphertext.length).toBe(1568);

      const decrypted = service.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should throw error on invalid ciphertext size (legacy)', () => {
      const encrypted = service.encrypt('test');
      encrypted.ciphertext = Buffer.from('invalid').toString('base64');

      expect(() => service.decrypt(encrypted)).toThrow(
        /Invalid ML-KEM ciphertext size/,
      );
    });

    it('should throw error on corrupted auth tag (legacy)', () => {
      const encrypted = service.encrypt('test');
      encrypted.authTag = Buffer.from('corrupted_tag').toString('base64');

      expect(() => service.decrypt(encrypted)).toThrow();
    });

    it('should throw error when decrypt called without initialization', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MlKemEncryptionService,
          TeeKeyManagerService,
          {
            provide: KeyDerivationService,
            useValue: { getMlKemPublicKey: () => null },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => null),
            },
          },
        ],
      }).compile();

      const uninitializedService = module.get<MlKemEncryptionService>(
        MlKemEncryptionService,
      );
      const uninitKeyManager =
        module.get<TeeKeyManagerService>(TeeKeyManagerService);

      await uninitKeyManager.onModuleInit();

      const dummyPayload = {
        ciphertext: 'dummy',
        encryptedData: 'dummy',
        iv: 'dummy',
        authTag: 'dummy',
      };

      expect(() => uninitializedService.decrypt(dummyPayload)).toThrow(
        'ML-KEM encryption not initialized',
      );
    });

    it('should throw error when encrypt called without initialization', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MlKemEncryptionService,
          TeeKeyManagerService,
          {
            provide: KeyDerivationService,
            useValue: { getMlKemPublicKey: () => null },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => null),
            },
          },
        ],
      }).compile();

      const uninitializedService = module.get<MlKemEncryptionService>(
        MlKemEncryptionService,
      );
      const uninitKeyManager =
        module.get<TeeKeyManagerService>(TeeKeyManagerService);

      await uninitKeyManager.onModuleInit();

      expect(() => uninitializedService.encrypt('test')).toThrow(
        'ML-KEM encryption not initialized',
      );
    });
  });

  describe('Error handling for uninitialized service', () => {
    it('should throw error when decryptMultiRecipient called without initialization', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MlKemEncryptionService,
          TeeKeyManagerService,
          {
            provide: KeyDerivationService,
            useValue: { getMlKemPublicKey: () => null },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => null),
            },
          },
        ],
      }).compile();

      const uninitializedService = module.get<MlKemEncryptionService>(
        MlKemEncryptionService,
      );
      const uninitKeyManager =
        module.get<TeeKeyManagerService>(TeeKeyManagerService);

      await uninitKeyManager.onModuleInit();

      const dummyPayload = {
        recipients: [],
        encryptedData: 'dummy',
        iv: 'dummy',
        authTag: 'dummy',
      };

      expect(() =>
        uninitializedService.decryptMultiRecipient(dummyPayload),
      ).toThrow('ML-KEM encryption not initialized');
    });
  });
});

/**
 * Helper: Encrypt data for multiple recipients using ML-KEM-1024
 * (Simplified version of w3pk's mlkemEncrypt)
 */
async function encryptMultiRecipient(
  plaintext: string,
  recipientPublicKeys: string[],
): Promise<MultiRecipientEncryptedPayload> {
  const mlkem = await createMlKem1024();

  // Generate random AES-256 key
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  // Encrypt data with AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  let encrypted = cipher.update(plaintext, 'utf-8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Encapsulate AES key for each recipient
  const recipients = [];

  for (const pubKeyBase64 of recipientPublicKeys) {
    const publicKey = Buffer.from(pubKeyBase64, 'base64');

    // Encapsulate to get shared secret
    const [kemCiphertext, sharedSecret] = mlkem.encap(publicKey);

    // XOR-encrypt the AES key with shared secret
    const kek = sharedSecret.subarray(0, 32);
    const encryptedAesKey = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      encryptedAesKey[i] = aesKey[i] ^ kek[i];
    }

    // Combine: ML-KEM ciphertext (1568) + encrypted AES key (32)
    const combinedCiphertext = Buffer.concat([kemCiphertext, encryptedAesKey]);

    recipients.push({
      publicKey: pubKeyBase64,
      ciphertext: combinedCiphertext.toString('base64'),
    });
  }

  return {
    recipients,
    encryptedData: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}
