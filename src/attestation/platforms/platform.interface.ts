/**
 * TEE Platform Interface
 *
 * Common interface for all TEE platform adapters
 */

import { AttestationQuote, TeePlatform } from '../attestation.types';

export interface ITeePlatform {
  /** Platform identifier */
  readonly name: TeePlatform;

  /**
   * Check if this platform is available on the current system
   * @returns true if the platform device/socket is accessible
   */
  isAvailable(): Promise<boolean>;

  /**
   * Generate an attestation quote with embedded report_data
   * @param reportData - Data to embed in the quote (64 bytes, see report-data.ts)
   * @returns Platform-specific attestation quote
   */
  generateQuote(reportData: Buffer): Promise<AttestationQuote>;
}
