import { hkdfSync } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { buildEddsa } from 'circomlibjs';
import {
  Provider,
  SigningKey,
  TypedDataEncoder,
  Wallet,
  ZeroHash,
  computeAddress,
  getBytes,
  hexlify,
  sha256,
} from 'ethers';
import { getTlsLeafCertificate } from '../tls/tls-context';
import { OnionKey, onionAddress, onionKeyFromSeed } from '../tor/onion-key';
import { DstackV1Client } from './dstack-v1.client';
import { keysOutsideEnclaveAllowed } from './key-policy';
import { isProd } from '../config/profile';

export const REFUND_SIGNER_DOMAIN = 'longjing/refund-signer/babyjub/v1';
export const IDENTITY_DOMAIN = 'longjing/identity/v1';
export const TX_SIGNER_DOMAIN = 'longjing/tx-signer/v1';
export const ONION_SERVICE_DOMAIN = 'longjing/onion-service/v1';

const HKDF_SALT = 'longjing';
const REFUND_SIGNER_INFO = lengthPrefixed('longjing-refund-signer-babyjub-v1');

export const KEY_MANIFEST_DOMAIN = { name: 'Longjing', version: '3' };
export const KEY_MANIFEST_TYPES = {
  KeyManifest: [
    { name: 'appId', type: 'address' },
    { name: 'refundSignerX', type: 'bytes32' },
    { name: 'refundSignerY', type: 'bytes32' },
    { name: 'tlsCertificateHash', type: 'bytes32' },
    { name: 'onionPublicKey', type: 'bytes32' },
    { name: 'txSignerAddress', type: 'address' },
    { name: 'epoch', type: 'uint64' },
  ],
};

export interface KeyManifest {
  appId: string;
  refundSignerX: string;
  refundSignerY: string;
  /** SHA-256 of the served TLS leaf certificate (DER), or zero if none. */
  tlsCertificateHash: string;
  /** ed25519 public key of the onion service. */
  onionPublicKey: string;
  /** Signs every contract transaction in production; needs gas. */
  txSignerAddress: string;
  epoch: number;
}

export interface SignedKeyManifest {
  manifest: KeyManifest;
  signature: string;
}

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
  private refundSignerKey: Buffer | null = null;
  private refundSignerPublicKey: { x: string; y: string } | null = null;
  private refundSignerSignatureChain: Uint8Array[] = [];
  private identity: SigningKey | null = null;
  private identitySignatureChain: Uint8Array[] = [];
  private txSigner: SigningKey | null = null;
  private onionKey: OnionKey | null = null;
  private onionSignatureChain: Uint8Array[] = [];
  private appId: string | null = null;
  private keyManifest: SignedKeyManifest | null = null;

  constructor(private readonly dstack: DstackV1Client) {}

  async onModuleInit(): Promise<void> {
    const production = isProd() && !keysOutsideEnclaveAllowed();

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
      `Keys derived: identity ${this.getIdentityAddress()}, tx signer ${this.getTxSignerAddress()}`,
    );
  }

  private async derive(): Promise<void> {
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
    const refundSignerPublicKey = await babyJubjubPublicKey(refundSignerKey);

    const identity = await this.dstack.getKey(IDENTITY_DOMAIN, 'secp256k1');
    // hexlify leaves an immutable string copy of the key that fill(0) cannot
    // reach; ethers' SigningKey only takes the key as a hex string
    const signingKey = new SigningKey(hexlify(identity.key));
    identity.key.fill(0);

    const txSigner = await this.dstack.getKey(TX_SIGNER_DOMAIN, 'secp256k1');
    const txSigningKey = new SigningKey(hexlify(txSigner.key));
    txSigner.key.fill(0);

    // v1 returns the RFC 8032 seed and its public key, which the signature
    // chain claims, so the onion service's key is the chain's key
    const onion = await this.dstack.getKey(ONION_SERVICE_DOMAIN, 'ed25519');
    const onionKey = onionKeyFromSeed(onion.key);
    onion.key.fill(0);
    if (!onionKey.publicKey.equals(onion.publicKey)) {
      throw new Error(
        "dstack GetKey returned an ed25519 public key that is not the seed's",
      );
    }

    const appId = await this.dstack.getAppId();

    this.refundSignerKey = refundSignerKey;
    this.refundSignerPublicKey = refundSignerPublicKey;
    this.refundSignerSignatureChain = refundSigner.signatureChain;
    this.identity = signingKey;
    this.identitySignatureChain = identity.signatureChain;
    this.txSigner = txSigningKey;
    this.onionKey = onionKey;
    this.onionSignatureChain = onion.signatureChain;
    this.appId = appId;
  }

  isAvailable(): boolean {
    return (
      this.refundSignerKey !== null &&
      this.identity !== null &&
      this.txSigner !== null &&
      this.onionKey !== null
    );
  }

  /**
   * The Baby Jubjub EdDSA private key that signs refund tickets. Only
   * RefundSignerService calls this: the circuits verify its signatures, so
   * the signing has to stay in circomlibjs.
   */
  getRefundSignerPrivateKey(): Buffer | null {
    return this.refundSignerKey;
  }

  /** Baby Jubjub public key, as the contract's serverPublicKey expects it. */
  getRefundSignerPublicKey(): { x: string; y: string } | null {
    return this.refundSignerPublicKey;
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

  getTxSignerAddress(): string | null {
    return this.txSigner ? computeAddress(this.txSigner.publicKey) : null;
  }

  /**
   * The onion service's key pair, secret included. Only OnionService calls
   * this, to hand the key to tor over its control socket.
   */
  getOnionKey(): OnionKey | null {
    return this.onionKey;
  }

  /** The onion service's ed25519 public key, 32 bytes. */
  getOnionPublicKey(): Buffer | null {
    return this.onionKey?.publicKey ?? null;
  }

  /** The onion service's address, with ".onion". */
  getOnionAddress(): string | null {
    return this.onionKey
      ? `${onionAddress(this.onionKey.publicKey)}.onion`
      : null;
  }

  getOnionSignatureChain(): Uint8Array[] {
    return this.onionSignatureChain;
  }

  /**
   * In production the only key that sends transactions, so its address
   * needs gas and is the contract's serverAddress.
   */
  getTxSigner(provider: Provider): Wallet | null {
    return this.txSigner ? new Wallet(this.txSigner, provider) : null;
  }

  /**
   * The key manifest for this CVM's app id, signed by the identity key.
   * Re-signed when the served TLS certificate changes, since main.ts loads
   * it after the keys are derived.
   */
  getKeyManifest(): SignedKeyManifest | null {
    if (!this.appId) {
      return null;
    }
    const cert = getTlsLeafCertificate();
    const tlsCertificateHash = cert ? sha256(cert) : ZeroHash;
    if (this.keyManifest?.manifest.tlsCertificateHash !== tlsCertificateHash) {
      this.keyManifest = this.signKeyManifest(this.appId, tlsCertificateHash);
    }
    return this.keyManifest;
  }

  /**
   * Signs the EIP-712 key manifest binding Longjing's public keys to its
   * app id.
   */
  signKeyManifest(
    appId: string,
    tlsCertificateHash: string,
    epoch = 1,
  ): SignedKeyManifest {
    if (
      !this.identity ||
      !this.txSigner ||
      !this.refundSignerPublicKey ||
      !this.onionKey
    ) {
      throw new Error('Keys not derived');
    }
    const manifest: KeyManifest = {
      appId,
      refundSignerX: this.refundSignerPublicKey.x,
      refundSignerY: this.refundSignerPublicKey.y,
      tlsCertificateHash,
      onionPublicKey: hexlify(this.onionKey.publicKey),
      txSignerAddress: computeAddress(this.txSigner.publicKey),
      epoch,
    };
    const digest = TypedDataEncoder.hash(
      KEY_MANIFEST_DOMAIN,
      KEY_MANIFEST_TYPES,
      manifest,
    );
    return { manifest, signature: this.identity.sign(digest).serialized };
  }
}

// circomlibjs has no types
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
let eddsaPromise: ReturnType<typeof buildEddsa> | null = null;

async function babyJubjubPublicKey(
  privateKey: Buffer,
): Promise<{ x: string; y: string }> {
  // Building the wasm is slow; one instance serves every derivation
  eddsaPromise ??= buildEddsa();
  const eddsa = await eddsaPromise;
  const [x, y] = eddsa.prv2pub(privateKey);
  const toHex = (value: unknown) =>
    '0x' + String(eddsa.F.toString(value, 16)).padStart(64, '0');
  return { x: toHex(x), y: toHex(y) };
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf-8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
