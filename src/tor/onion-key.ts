// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import { createHash, createPrivateKey, createPublicKey } from 'crypto';

/**
 * v3 onion service keys, per Tor's rend-spec:
 * https://spec.torproject.org/rend-spec/encoding-onion-addresses.html
 */

const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

export {
  ONION_ADDRESS_LENGTH,
  onionAddress,
  onionPublicKey,
} from './onion-address';

export interface OnionKey {
  /** RFC 8032 ed25519 public key, 32 bytes */
  publicKey: Buffer;
  /**
   * The 64-byte expanded secret key ADD_ONION takes: the clamped scalar, then
   * the PRF secret, i.e. SHA-512(seed) with the first half clamped
   */
  expandedSecretKey: Buffer;
}

/** Expands a 32-byte ed25519 seed into the key pair of an onion service. */
export function onionKeyFromSeed(seed: Uint8Array): OnionKey {
  if (seed.length !== 32) {
    throw new Error('An ed25519 seed is 32 bytes');
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = Buffer.from(jwk.x!, 'base64url');

  const expandedSecretKey = createHash('sha512').update(seed).digest();
  expandedSecretKey[0] &= 248;
  expandedSecretKey[31] &= 127;
  expandedSecretKey[31] |= 64;
  return { publicKey, expandedSecretKey };
}
