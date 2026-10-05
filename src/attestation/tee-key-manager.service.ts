/**
 * TEE Key Manager Service
 *
 * Holds the ML-KEM-1024 key pair the server decrypts with:
 * - In the enclave: derived from the dstack KMS by KeyDerivationService, so
 *   the private key never leaves the enclave and is never stored
 * - Outside production, when dstack is unavailable: read from
 *   ADMIN_MLKEM_PUBLIC_KEY / ADMIN_MLKEM_PRIVATE_KEY (development only)
 *
 * See docs/KEY_DERIVATION.md.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMlKem1024 } from 'mlkem';
import { KeyDerivationService } from '../keys/key-derivation.service';

@Injectable()
export class TeeKeyManagerService implements OnModuleInit {
  private readonly logger = new Logger(TeeKeyManagerService.name);
  private mlkem: Awaited<ReturnType<typeof createMlKem1024>> | null = null;
  private publicKey: Uint8Array | null = null;
  private envPrivateKey: Uint8Array | null = null;
  private derived = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly keyDerivation: KeyDerivationService,
  ) {}

  async onModuleInit() {
    this.mlkem = await createMlKem1024();

    const derivedPublicKey = this.keyDerivation.getMlKemPublicKey();
    if (derivedPublicKey) {
      this.publicKey = derivedPublicKey;
      this.derived = true;
      this.logger.log('ML-KEM-1024 keys derived from the dstack KMS');
      return;
    }

    this.initializeEnvKeys();
  }

  /**
   * Development fallback: keys from env. KeyDerivationService already
   * refuses to start in production without dstack, so this never runs there.
   */
  private initializeEnvKeys() {
    this.logger.warn(
      '⚠️  ML-KEM keys not derived from dstack, reading them from env (development only)',
    );

    const publicKeyBase64 = this.configService.get<string>(
      'ADMIN_MLKEM_PUBLIC_KEY',
    );
    const privateKeyBase64 = this.configService.get<string>(
      'ADMIN_MLKEM_PRIVATE_KEY',
    );

    if (!publicKeyBase64 || !privateKeyBase64) {
      this.logger.warn(
        'ML-KEM keys not configured. Run the dstack simulator, or: pnpm ts-node scripts/testing/generate-admin-keypair.ts',
      );
      return;
    }

    const publicKey = Buffer.from(publicKeyBase64, 'base64');
    const privateKey = Buffer.from(privateKeyBase64, 'base64');

    if (publicKey.length !== 1568) {
      throw new Error(
        `Invalid ML-KEM-1024 public key size: ${publicKey.length} (expected 1568)`,
      );
    }
    if (privateKey.length !== 3168) {
      throw new Error(
        `Invalid ML-KEM-1024 private key size: ${privateKey.length} (expected 3168)`,
      );
    }

    this.publicKey = publicKey;
    this.envPrivateKey = privateKey;
    this.logger.log(
      `ML-KEM-1024 keys loaded from env: ${publicKeyBase64.substring(0, 32)}...`,
    );
  }

  /**
   * Get public key for client-side encryption
   */
  getPublicKey(): string | null {
    if (!this.publicKey) {
      return null;
    }
    return Buffer.from(this.publicKey).toString('base64');
  }

  /**
   * Get public key as Buffer (for attestation binding)
   */
  getPublicKeyBytes(): Buffer | null {
    if (!this.publicKey) {
      return null;
    }
    return Buffer.from(this.publicKey);
  }

  /**
   * Recover the shared secret of an ML-KEM ciphertext sent to this server
   */
  decapsulate(ciphertext: Uint8Array): Uint8Array {
    if (this.derived) {
      return this.keyDerivation.decapsulate(ciphertext);
    }
    if (!this.mlkem || !this.envPrivateKey) {
      throw new Error('ML-KEM encryption not initialized');
    }
    return this.mlkem.decap(ciphertext, this.envPrivateKey);
  }

  /**
   * Get ML-KEM instance
   */
  getMlKem(): Awaited<ReturnType<typeof createMlKem1024>> | null {
    return this.mlkem;
  }

  /**
   * Check if encryption is available
   */
  isAvailable(): boolean {
    return this.mlkem !== null && (this.derived || this.envPrivateKey !== null);
  }

  /**
   * Check if the keys were derived from the dstack KMS
   */
  isTeeMode(): boolean {
    return this.derived;
  }
}
