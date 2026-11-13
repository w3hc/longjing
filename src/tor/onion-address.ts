// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import { sha3_256 } from '@noble/hashes/sha3';
import { concatBytes, utf8ToBytes } from '../common/bytes';

/**
 * v3 onion addresses, per Tor's rend-spec:
 * https://spec.torproject.org/rend-spec/encoding-onion-addresses.html
 */

const VERSION = 0x03;
const CHECKSUM_LABEL = utf8ToBytes('.onion checksum');
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const ONION_ADDRESS_LENGTH = 56;

/**
 * The 56-character address, without ".onion":
 * base32(PUBKEY || CHECKSUM[:2] || VERSION), with
 * CHECKSUM = SHA3-256(".onion checksum" || PUBKEY || VERSION)
 */
export function onionAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('An onion service public key is 32 bytes');
  }
  const version = new Uint8Array([VERSION]);
  const checksum = sha3_256(
    concatBytes(CHECKSUM_LABEL, publicKey, version),
  ).subarray(0, 2);
  return base32(concatBytes(publicKey, checksum, version));
}

/**
 * The public key an onion address encodes, or null when the address is not
 * a well-formed v3 address. Takes the address with or without ".onion".
 */
export function onionPublicKey(address: string): Uint8Array | null {
  const label = address.toLowerCase().replace(/\.onion\.?$/, '');
  if (!new RegExp(`^[a-z2-7]{${ONION_ADDRESS_LENGTH}}$`).test(label)) {
    return null;
  }
  const publicKey = base32Decode(label).subarray(0, 32);
  return onionAddress(publicKey) === label ? publicKey : null;
}

function base32(bytes: Uint8Array): string {
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

function base32Decode(text: string): Uint8Array {
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
  return new Uint8Array(out);
}
