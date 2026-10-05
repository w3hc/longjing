import { hkdfSync } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SigningKey, computeAddress, getBytes, hexlify } from 'ethers';
import { createMlKem1024 } from 'mlkem';
import { DstackV1Client } from './dstack-v1.client';

export const MLKEM_DOMAIN = 'longjing/mlkem-1024/v1';
export const REFUND_SIGNER_DOMAIN = 'longjing/refund-signer/babyjub/v1';
export const IDENTITY_DOMAIN = 'longjing/identity/v1';

const HKDF_SALT = 'longjing';
const MLKEM_SEED_INFO = lengthPrefixed('longjing-mlkem-1024-seed-v1');
const REFUND_SIGNER_INFO = lengthPrefixed('longjing-refund-signer-babyjub-v1');

type MlKem = Awaited<ReturnType<typeof createMlKem1024>>;

/**
 * Derives Longjing's long-lived keys inside the enclave from the dstack KMS.
 *
 * Keys are a deterministic function of the app's KMS-held root key, so they
 * are never generated elsewhere, stored or passed through env, and every
 * instance of the same app gets the same keys.
 *
 * See docs/KEY_DERIVATION.md.
 */
@Injectable()
export class KeyDerivationService implements OnModuleInit {
  private readonly logger = new Logger(KeyDerivationService.name);
  private mlkem: MlKem | null = null;
  private mlkemPublicKey: Uint8Array | null = null;
  private mlkemSecretKey: Uint8Array | null = null;
  private refundSignerKey: Buffer | null = null;
  private refundSignerSignatureChain: Uint8Array[] = [];
  private identity: SigningKey | null = null;
  private identitySignatureChain: Uint8Array[] = [];

  constructor(private readonly dstack: DstackV1Client) {}

  async onModuleInit(): Promise<void> {
    const production = process.env.NODE_ENV === 'production';

    if (production && this.dstack.isSimulator()) {
      throw new Error(
        'DSTACK_SIMULATOR_ENDPOINT must not be set in production: its keys are public',
      );
    }

    try {
      await this.derive();
    } catch (error) {
      if (production) {
        throw new Error('Key derivation from dstack v1 GetKey failed', {
          cause: error,
        });
      }
      this.logger.warn(
        'dstack v1 GetKey unavailable, keys not derived. Run the dstack simulator and set DSTACK_SIMULATOR_ENDPOINT.',
      );
      return;
    }

    if (this.dstack.isSimulator()) {
      this.logger.warn('Keys derived from the dstack simulator (public root)');
    }
    this.logger.log(
      `Keys derived: ML-KEM-1024 ${Buffer.from(this.mlkemPublicKey!).toString('base64').substring(0, 32)}..., identity ${this.getIdentityAddress()}`,
    );
  }

  private async derive(): Promise<void> {
    const mlkemSource = await this.dstack.getKey(MLKEM_DOMAIN, 'ed25519');
    const seed = new Uint8Array(
      hkdfSync('sha256', mlkemSource.key, HKDF_SALT, MLKEM_SEED_INFO, 64),
    );
    const mlkem = await createMlKem1024();
    const [publicKey, secretKey] = mlkem.deriveKeyPair(seed);
    mlkemSource.key.fill(0);
    seed.fill(0);

    // ed25519 only because its 32 bytes are an opaque seed: the Baby Jubjub
    // EdDSA private key is any 32 bytes, hashed by circomlibjs before use
    const refundSigner = await this.dstack.getKey(
      REFUND_SIGNER_DOMAIN,
      'ed25519',
    );
    const refundSignerKey = Buffer.from(
      hkdfSync('sha256', refundSigner.key, HKDF_SALT, REFUND_SIGNER_INFO, 32),
    );
    refundSigner.key.fill(0);

    const identity = await this.dstack.getKey(IDENTITY_DOMAIN, 'secp256k1');
    // hexlify leaves an immutable string copy of the key that fill(0) cannot
    // reach; ethers' SigningKey only takes the key as a hex string
    const signingKey = new SigningKey(hexlify(identity.key));
    identity.key.fill(0);

    this.mlkem = mlkem;
    this.mlkemPublicKey = publicKey;
    this.mlkemSecretKey = secretKey;
    this.refundSignerKey = refundSignerKey;
    this.refundSignerSignatureChain = refundSigner.signatureChain;
    this.identity = signingKey;
    this.identitySignatureChain = identity.signatureChain;
  }

  isAvailable(): boolean {
    return (
      this.mlkemSecretKey !== null &&
      this.refundSignerKey !== null &&
      this.identity !== null
    );
  }

  getMlKemPublicKey(): Uint8Array | null {
    return this.mlkemPublicKey;
  }

  decapsulate(ciphertext: Uint8Array): Uint8Array {
    if (!this.mlkem || !this.mlkemSecretKey) {
      throw new Error('ML-KEM keys not derived');
    }
    return this.mlkem.decap(ciphertext, this.mlkemSecretKey);
  }

  /**
   * The Baby Jubjub EdDSA private key that signs refund tickets. Only
   * RefundSignerService calls this: the circuits verify its signatures, so
   * the signing has to stay in circomlibjs.
   */
  getRefundSignerPrivateKey(): Buffer | null {
    return this.refundSignerKey;
  }

  getRefundSignerSignatureChain(): Uint8Array[] {
    return this.refundSignerSignatureChain;
  }

  getIdentityAddress(): string | null {
    return this.identity ? computeAddress(this.identity.publicKey) : null;
  }

  /** Uncompressed secp256k1 identity public key, 65 bytes. */
  getIdentityPublicKey(): Uint8Array | null {
    return this.identity ? getBytes(this.identity.publicKey) : null;
  }

  getIdentitySignatureChain(): Uint8Array[] {
    return this.identitySignatureChain;
  }
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf-8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
