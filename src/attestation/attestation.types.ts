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
