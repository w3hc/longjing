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
import { createHash } from 'crypto';
import { buildPoseidon } from 'circomlibjs';

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
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return BigInt('0x' + digest) % BN254_SCALAR_FIELD;
}

let poseidon: Promise<(inputs: bigint[]) => bigint> | undefined;

function poseidonHash(): Promise<(inputs: bigint[]) => bigint> {
  poseidon ??= buildPoseidon().then(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    (p: any) => (inputs: bigint[]) => p.F.toObject(p(inputs)),
  );
  return poseidon;
}

/** x = Poseidon(SHA-256(payload) mod p, ρ) */
export async function payloadSignalX(
  payload: string,
  nonce: bigint,
): Promise<bigint> {
  return (await poseidonHash())([payloadDigest(payload), nonce]);
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
