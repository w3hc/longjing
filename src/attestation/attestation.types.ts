/**
 * Cross-Platform TEE Attestation Types
 *
 * Unified attestation types supporting AMD SEV-SNP, Intel TDX, AWS Nitro, and Phala Network
 */

export type TeePlatform =
  'phala' | 'intel-tdx' | 'amd-sev-snp' | 'aws-nitro' | 'mock';

/**
 * Attestation quote returned by all platforms
 */
export interface AttestationQuote {
  /** Platform that generated this quote */
  platform: TeePlatform;

  /** Base64 or hex-encoded quote/report (platform-specific format) */
  quote: string;

  /** Hex-encoded report_data: key commitment || client nonce (see report-data.ts) */
  reportData: string;

  /** Hex-encoded measurement (MRTD / MEASUREMENT / PCR0 / RTMR) */
  measurement: string;

  /** dstack event log (JSON array), to replay RTMR0–3 (dstack only) */
  eventLog?: string;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Full parsed response for advanced consumers (platform-specific) */
  raw?: unknown;
}

/**
 * The public values report_data commits to, as returned to clients so they
 * can rebuild it. A null key was not derived from dstack.
 */
export interface BoundKeys {
  /** Base64 ML-KEM-1024 encapsulation key */
  mlkemPublicKey: string;
  /** 0x-hex uncompressed secp256k1 identity public key */
  identityPublicKey: string | null;
  /** 0x-hex Babyjubjub coordinates of the refund signer */
  refundSignerPublicKey: { x: string; y: string } | null;
  /** Base64 DER of the TLS leaf certificate served from inside the enclave */
  tlsCertificate: string | null;
}

/** A quote with the nonce and the keys its report_data commits to. */
export interface BoundAttestation extends AttestationQuote {
  /** 0x-hex client nonce in report_data[32..64], or null */
  nonce: string | null;
  keys: BoundKeys;
}
