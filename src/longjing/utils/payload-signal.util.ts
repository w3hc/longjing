/**
 * Payload binding for the RLN signal x
 *
 * The signal x must commit to the request payload, otherwise a proof generated
 * for one payload can be replayed with another, and a client can pick x freely
 * to influence double-spend detection.
 *
 * Canonical definition: x = Poseidon(SHA-256(UTF-8 payload) mod p, ρ), where p
 * is the BN254 scalar field order and ρ a fresh nonce the client sends with the
 * request. The server recomputes x, then forgets the payload and ρ: without ρ,
 * a stored x can't confirm a guessed prompt (docs/SETTLEMENT.md).
 */
import { sha256 } from '@noble/hashes/sha2';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { bytesToHex, utf8ToBytes } from '../../common/bytes';

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

/** SHA-256 of the UTF-8 payload, reduced into the field */
export function payloadDigest(payload: string): bigint {
  const digest = bytesToHex(sha256(utf8ToBytes(payload)));
  return BigInt('0x' + digest) % BN254_SCALAR_FIELD;
}

/** x = Poseidon(SHA-256(payload) mod p, ρ) */
export function payloadSignalX(
  payload: string,
  nonce: bigint,
): Promise<bigint> {
  return Promise.resolve(poseidon2([payloadDigest(payload), nonce]));
}

/** Whether x commits to this payload and nonce, both given as received */
export async function signalXMatchesRequest(
  signalX: string,
  payload: string,
  nonce: string,
): Promise<boolean> {
  let x: bigint;
  let rho: bigint;
  try {
    x = parseFieldElement(signalX);
    rho = parseFieldElement(nonce);
  } catch {
    return false;
  }
  if (rho >= BN254_SCALAR_FIELD) return false;
  return x === (await payloadSignalX(payload, rho));
}
