// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import { createHash, createPrivateKey, createPublicKey } from 'crypto';

/**
 * v3 onion service keys and addresses, per Tor's rend-spec:
 * https://spec.torproject.org/rend-spec/encoding-onion-addresses.html
 */

const VERSION = 0x03;
const CHECKSUM_LABEL = Buffer.from('.onion checksum', 'ascii');
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

export const ONION_ADDRESS_LENGTH = 56;

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

/**
 * The 56-character address, without ".onion":
 * base32(PUBKEY || CHECKSUM[:2] || VERSION), with
 * CHECKSUM = SHA3-256(".onion checksum" || PUBKEY || VERSION)
 */
export function onionAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('An onion service public key is 32 bytes');
  }
  const version = Buffer.from([VERSION]);
  const checksum = createHash('sha3-256')
    .update(CHECKSUM_LABEL)
    .update(publicKey)
    .update(version)
    .digest()
    .subarray(0, 2);
  return base32(Buffer.concat([publicKey, checksum, version]));
}

/**
 * The public key an onion address encodes, or null when the address is not
 * a well-formed v3 address. Takes the address with or without ".onion".
 */
export function onionPublicKey(address: string): Buffer | null {
  const label = address.toLowerCase().replace(/\.onion\.?$/, '');
  if (!new RegExp(`^[a-z2-7]{${ONION_ADDRESS_LENGTH}}$`).test(label)) {
    return null;
  }
  const publicKey = base32Decode(label).subarray(0, 32);
  return onionAddress(publicKey) === label ? publicKey : null;
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(text: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
