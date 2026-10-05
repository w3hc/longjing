import { createHash, hkdfSync } from 'crypto';
import {
  SigningKey,
  ZeroHash,
  computeAddress,
  getBytes,
  hexlify,
  verifyTypedData,
} from 'ethers';
import { createMlKem1024 } from 'mlkem';
import {
  DstackV1Client,
  GetKeyResponse,
  KeyAlgorithm,
} from './dstack-v1.client';
import {
  KEY_MANIFEST_DOMAIN,
  KEY_MANIFEST_TYPES,
  KeyDerivationService,
  REFUND_SIGNER_DOMAIN,
} from './key-derivation.service';
import { RefundSignerService } from '../longjing/refund-signer.service';
import {
  clearTlsLeafCertificate,
  setTlsLeafCertificate,
} from '../tls/tls-context';

// App root key from the dstack guest API v1 spec test vectors
const ROOT_KEY =
  '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b';

const APP_ID = '0x1111111111111111111111111111111111111111';

const lp = (value: string) => {
  const bytes = Buffer.from(value, 'utf-8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
};

/** In-process dstack agent implementing the v1 KDF (guest-api-v1.md). */
class FakeDstack {
  simulator = false;
  failing = false;

  isSimulator() {
    return this.simulator;
  }

  getAppId() {
    return Promise.resolve(APP_ID);
  }

  getKey(domain: string, algorithm: KeyAlgorithm): Promise<GetKeyResponse> {
    if (this.failing) {
      return Promise.reject(new Error('connect ENOENT /var/run/dstack.sock'));
    }
    const info = Buffer.concat([
      lp('dstack-guest-v1-key'),
      lp(algorithm),
      lp(domain),
    ]);
    const key = new Uint8Array(
      hkdfSync(
        'sha256',
        Buffer.from(ROOT_KEY, 'hex'),
        'dstack-guest-v1',
        info,
        32,
      ),
    );
    const publicKey =
      algorithm === 'secp256k1'
        ? getBytes(SigningKey.computePublicKey(key, true))
        : new Uint8Array(0);
    return Promise.resolve({ key, publicKey, signatureChain: [] });
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

describe('KeyDerivationService', () => {
  let dstack: FakeDstack;
  const originalEnv = process.env.NODE_ENV;

  const create = async () => {
    const service = new KeyDerivationService(
      dstack as unknown as DstackV1Client,
    );
    await service.onModuleInit();
    return service;
  };

  beforeEach(() => {
    dstack = new FakeDstack();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    clearTlsLeafCertificate();
  });

  describe('test vectors', () => {
    it('fake agent matches the dstack v1 KDF vectors', async () => {
      const secp = await dstack.getKey('storage-encryption', 'secp256k1');
      const ed = await dstack.getKey('storage-encryption', 'ed25519');

      expect(hex(secp.key)).toBe(
        '5510330f86902ddae38c6d89c93a8408019332c17a429e1abd01c4a28d1544a6',
      );
      expect(hex(ed.key)).toBe(
        '3c4c3ece12fa99ccb93fc0090877f80e70545fdd971e2ac93d3398c4684538d3',
      );
    });

    it('derives the pinned keys from the spec root key', async () => {
      // Changing these rotates every key: the contract's serverPublicKey
      // and clients' pinned ML-KEM key stop matching
      const service = await create();

      expect(sha256(service.getMlKemPublicKey()!)).toBe(
        'e3d78b123044b4c76cc54604ec6a62f2c8027dd91482f7cff092a5a6e6d29b83',
      );
      expect(hex(service.getRefundSignerPrivateKey()!)).toBe(
        '52498b625136c3fc7034d9dc2eb8b48158abe6a7e4dff1f9270db1d959c80890',
      );
      expect(service.getIdentityAddress()).toBe(
        '0x031f079bd169eE6651d2ecE665aF167f68434b1A',
      );
    });
  });

  describe('derivation', () => {
    it('is deterministic across instances', async () => {
      const a = await create();
      const b = await create();

      expect(hex(a.getMlKemPublicKey()!)).toBe(hex(b.getMlKemPublicKey()!));
      expect(hex(a.getRefundSignerPrivateKey()!)).toBe(
        hex(b.getRefundSignerPrivateKey()!),
      );
      expect(a.getIdentityAddress()).toBe(b.getIdentityAddress());
    });

    it('expands the refund signer GetKey output under its own label', async () => {
      const service = await create();
      const { key } = await dstack.getKey(REFUND_SIGNER_DOMAIN, 'ed25519');
      const expected = hkdfSync(
        'sha256',
        key,
        'longjing',
        lp('longjing-refund-signer-babyjub-v1'),
        32,
      );

      expect(hex(service.getRefundSignerPrivateKey()!)).toBe(
        hex(new Uint8Array(expected)),
      );
    });

    it('serves the refund signer signature chain', async () => {
      const chain = [new Uint8Array([1]), new Uint8Array([2])];
      const getKey = dstack.getKey.bind(dstack);
      dstack.getKey = async (domain, algorithm) => ({
        ...(await getKey(domain, algorithm)),
        signatureChain: domain === REFUND_SIGNER_DOMAIN ? chain : [],
      });

      const service = await create();

      expect(service.getRefundSignerSignatureChain()).toEqual(chain);
      expect(service.getIdentitySignatureChain()).toEqual([]);
    });

    it('exposes the uncompressed identity public key of its address', async () => {
      const service = await create();
      const publicKey = service.getIdentityPublicKey()!;

      expect(publicKey).toHaveLength(65);
      expect(publicKey[0]).toBe(0x04);
      expect(computeAddress(hexlify(publicKey))).toBe(
        service.getIdentityAddress(),
      );
    });

    it('decapsulates what is encapsulated to its public key', async () => {
      const service = await create();
      const mlkem = await createMlKem1024();

      const [ciphertext, sharedSecret] = mlkem.encap(
        service.getMlKemPublicKey()!,
      );

      expect(hex(service.decapsulate(ciphertext))).toBe(hex(sharedSecret));
    });
  });

  describe('key manifest', () => {
    it('signs a manifest for its app id recoverable to the identity address', async () => {
      const service = await create();

      const { manifest, signature } = service.getKeyManifest()!;

      expect(manifest.appId).toBe(APP_ID);
      expect(manifest.mlkemPublicKeyHash).toBe(
        '0x' + sha256(service.getMlKemPublicKey()!),
      );
      expect(manifest.tlsCertificateHash).toBe(ZeroHash);
      expect(
        verifyTypedData(
          KEY_MANIFEST_DOMAIN,
          KEY_MANIFEST_TYPES,
          manifest,
          signature,
        ),
      ).toBe(service.getIdentityAddress());
    });

    it('commits to the refund signer key RefundSignerService signs with', async () => {
      const service = await create();
      const signer = new RefundSignerService(service);

      const { manifest } = service.getKeyManifest()!;
      const publicKey = await signer.getPublicKey();

      expect(manifest.refundSignerX).toBe(publicKey.x);
      expect(manifest.refundSignerY).toBe(publicKey.y);
      expect(service.getRefundSignerPublicKey()).toEqual(publicKey);
    }, 30000);

    it('re-signs when the TLS certificate is registered', async () => {
      const service = await create();
      const before = service.getKeyManifest()!;
      const der = Buffer.from('leaf certificate');

      setTlsLeafCertificate(der);
      const after = service.getKeyManifest()!;

      expect(after.manifest.tlsCertificateHash).toBe('0x' + sha256(der));
      expect(after.signature).not.toBe(before.signature);
      expect(service.getKeyManifest()).toBe(after);
    });

    it('has no manifest without derived keys', async () => {
      process.env.NODE_ENV = 'development';
      dstack.failing = true;

      const service = await create();

      expect(service.getKeyManifest()).toBeNull();
    });
  });

  describe('failure modes', () => {
    it('refuses the simulator in production', async () => {
      process.env.NODE_ENV = 'production';
      dstack.simulator = true;

      await expect(create()).rejects.toThrow('DSTACK_SIMULATOR_ENDPOINT');
    });

    it('fails startup in production when dstack is unreachable', async () => {
      process.env.NODE_ENV = 'production';
      dstack.failing = true;

      await expect(create()).rejects.toThrow('Key derivation');
    });

    it('starts without keys outside production when dstack is unreachable', async () => {
      process.env.NODE_ENV = 'development';
      dstack.failing = true;

      const service = await create();

      expect(service.isAvailable()).toBe(false);
      expect(service.getMlKemPublicKey()).toBeNull();
      expect(service.getRefundSignerPrivateKey()).toBeNull();
      expect(() => service.decapsulate(new Uint8Array(1568))).toThrow(
        'not derived',
      );
    });
  });
});
