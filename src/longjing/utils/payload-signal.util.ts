/**
 * Payload binding for the RLN signal x
 *
 * The signal x must commit to the request payload, otherwise a proof generated
 * for one payload can be replayed with another, and a client can pick x freely
 * to influence double-spend detection.
 *
 * Canonical definition: x = SHA-256(UTF-8 payload) mod p, where p is the BN254
 * scalar field order used by the circuit.
 */
import { createHash } from 'crypto';

export const BN254_SCALAR_FIELD = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

/**
 * Parse a field element given as 0x-prefixed hex, decimal, or bare hex
 */
export function parseFieldElement(value: string): bigint {
  const str = value.trim();
  if (str.startsWith('0x') || /^\d+$/.test(str)) {
    return BigInt(str);
  }
  return BigInt('0x' + str);
}

export function payloadToSignalX(payload: string): bigint {
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return BigInt('0x' + digest) % BN254_SCALAR_FIELD;
}

export function signalXMatchesPayload(
  signalX: string,
  payload: string,
): boolean {
  let x: bigint;
  try {
    x = parseFieldElement(signalX);
  } catch {
    return false;
  }
  return x === payloadToSignalX(payload);
}
