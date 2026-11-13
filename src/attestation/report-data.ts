import { sha256 } from '@noble/hashes/sha2';
import {
  concatBytes,
  hexToBytes,
  strip0x,
  uint32BE,
  utf8ToBytes,
} from '../common/bytes';

export const REPORT_DATA_LABEL = 'longjing-report-v3';
export const NONCE_LENGTH = 32;

/**
 * Public values committed to by the quote. A key or certificate that does not
 * exist yet contributes an empty term.
 */
export interface ReportDataInputs {
  /** Uncompressed secp256k1 identity public key, 65 bytes. */
  identityPublicKey?: Uint8Array;
  /** Babyjubjub refund signer public key as x || y, 32 bytes each. */
  refundSignerPublicKey?: Uint8Array;
  /** DER of the TLS leaf certificate served from inside the enclave. */
  tlsCertificateDer?: Uint8Array;
  /** ed25519 public key of the onion service, 32 bytes. */
  onionPublicKey?: Uint8Array;
}

/**
 * Builds the 64-byte `report_data`:
 *
 *   [0..32]  SHA-256(LP(label) || LP(identity_pubkey)
 *                    || LP(refund_signer_x || refund_signer_y)
 *                    || LP(SHA-256(tls_leaf_cert_der))
 *                    || LP(onion_service_pubkey))
 *   [32..64] client nonce, or zeros
 *
 * See docs/ATTESTATION.md#report_data.
 */
export function buildReportData(
  inputs: ReportDataInputs,
  nonce?: Uint8Array,
): Uint8Array {
  if (nonce && nonce.length !== NONCE_LENGTH) {
    throw new Error(`Nonce must be ${NONCE_LENGTH} bytes`);
  }
  const empty = new Uint8Array(0);
  const certificateHash = inputs.tlsCertificateDer
    ? sha256(inputs.tlsCertificateDer)
    : empty;
  const commitment = sha256(
    concatBytes(
      lengthPrefixed(utf8ToBytes(REPORT_DATA_LABEL)),
      lengthPrefixed(inputs.identityPublicKey ?? empty),
      lengthPrefixed(inputs.refundSignerPublicKey ?? empty),
      lengthPrefixed(certificateHash),
      lengthPrefixed(inputs.onionPublicKey ?? empty),
    ),
  );
  return concatBytes(commitment, nonce ?? new Uint8Array(NONCE_LENGTH));
}

/**
 * Encodes a Babyjubjub public key given as hex coordinates as x || y.
 */
export function encodeRefundSignerPublicKey(publicKey: {
  x: string;
  y: string;
}): Uint8Array {
  return concatBytes(coordinate(publicKey.x), coordinate(publicKey.y));
}

/**
 * Parses a client nonce given as 64 hex characters, with or without `0x`.
 * Returns undefined when no nonce was sent.
 */
export function parseNonce(value?: string): Uint8Array | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const hex = strip0x(value);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Nonce must be ${NONCE_LENGTH} bytes of hex`);
  }
  return hexToBytes(hex);
}

function coordinate(value: string): Uint8Array {
  const hex = strip0x(value);
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) {
    throw new Error('Refund signer coordinate must be at most 32 bytes of hex');
  }
  return hexToBytes(hex.padStart(64, '0'));
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(uint32BE(bytes.length), bytes);
}
