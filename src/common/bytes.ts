/**
 * Byte helpers on Uint8Array, for code shared by the server, the Node client
 * and the browser client, which has no Buffer.
 */

export { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

export function strip0x(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

/** Hex, with or without 0x; throws on an odd length or a non-hex digit */
export function hexToBytes(hex: string): Uint8Array {
  const digits = strip0x(hex);
  if (digits.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(digits)) {
    throw new Error('Invalid hex');
  }
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function uint32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
