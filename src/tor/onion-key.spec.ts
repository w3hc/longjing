import { createHash } from 'crypto';
import { onionAddress, onionKeyFromSeed, onionPublicKey } from './onion-key';

// RFC 8032 section 7.1, test 1
const SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
);
const PUBLIC_KEY =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
// Tor's test_build_address (src/test/test_hs_common.c) for that public key;
// tor 0.4.9.15 also answers ADD_ONION with this ServiceID for the expanded
// key below
const ADDRESS = '25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkenl5sid';

describe('onionKeyFromSeed', () => {
  it('derives the RFC 8032 public key', () => {
    expect(onionKeyFromSeed(SEED).publicKey.toString('hex')).toBe(PUBLIC_KEY);
  });

  it('expands the seed into the clamped scalar and the PRF secret', () => {
    const digest = createHash('sha512').update(SEED).digest();
    const { expandedSecretKey } = onionKeyFromSeed(SEED);

    expect(expandedSecretKey).toHaveLength(64);
    expect(expandedSecretKey[0] & 7).toBe(0);
    expect(expandedSecretKey[31] & 0xc0).toBe(0x40);
    expect(expandedSecretKey.subarray(1, 31)).toEqual(digest.subarray(1, 31));
    expect(expandedSecretKey.subarray(32)).toEqual(digest.subarray(32));
  });

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => onionKeyFromSeed(Buffer.alloc(31))).toThrow('32 bytes');
  });
});

describe('onionAddress', () => {
  it("matches tor's test vector", () => {
    expect(onionAddress(Buffer.from(PUBLIC_KEY, 'hex'))).toBe(ADDRESS);
  });

  it('rejects a public key that is not 32 bytes', () => {
    expect(() => onionAddress(Buffer.alloc(33))).toThrow('32 bytes');
  });
});

describe('onionPublicKey', () => {
  it('decodes an address, with or without .onion', () => {
    expect(onionPublicKey(ADDRESS)?.toString('hex')).toBe(PUBLIC_KEY);
    expect(onionPublicKey(`${ADDRESS}.onion`)?.toString('hex')).toBe(
      PUBLIC_KEY,
    );
  });

  it('refuses a bad checksum, length or alphabet', () => {
    const flipped = (ADDRESS[0] === 'a' ? 'b' : 'a') + ADDRESS.slice(1);
    expect(onionPublicKey(flipped)).toBeNull();
    expect(onionPublicKey(ADDRESS.slice(1))).toBeNull();
    expect(onionPublicKey(ADDRESS.replace(/.$/, '1'))).toBeNull();
  });
});
