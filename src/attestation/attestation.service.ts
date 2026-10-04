/**
 * Attestation Service
 *
 * Orchestrates cross-platform TEE attestation with report_data binding
 * Binds the TEE-generated ML-KEM public key AND the in-enclave TLS
 * certificate to attestation quotes using SHA-256 hashes:
 *
 *   report_data = SHA-256(mlkem_public_key) || SHA-256(tls_leaf_cert_der)
 *
 * Security model:
 * - ML-KEM key pair is generated inside the TEE
 * - Private key is sealed and never leaves the TEE
 * - Public key is bound to attestation via report_data (first 32 bytes)
 * - TLS terminates inside the enclave; the served certificate is bound via
 *   report_data (second 32 bytes), so clients can verify the TLS session
 *   ends inside the attested enclave — not at an external proxy
 * - Clients can verify: attestation → report_data → public key / TLS cert
 *   → encrypted messages and transport
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AttestationQuote } from './attestation.types';
import { ITeePlatform } from './platforms/platform.interface';
import { PhalaPlatform } from './platforms/phala.platform';
import { TdxPlatform } from './platforms/tdx.platform';
import { SevSnpPlatform } from './platforms/sev-snp.platform';
import { NitroPlatform } from './platforms/nitro.platform';
import { MockPlatform } from './platforms/mock.platform';
import { TeeKeyManagerService } from './tee-key-manager.service';
import { getTlsLeafCertificate } from '../tls/tls-context';

@Injectable()
export class AttestationService implements OnModuleInit {
  private readonly logger = new Logger(AttestationService.name);
  private platform: ITeePlatform | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly keyManager: TeeKeyManagerService,
  ) {}

  async onModuleInit() {
    // Check if TEE_PLATFORM is explicitly set in environment
    const forcedPlatform = this.configService.get<string>('TEE_PLATFORM');

    if (forcedPlatform && forcedPlatform !== 'auto') {
      this.logger.log(
        `TEE_PLATFORM forced to: ${forcedPlatform} (via environment variable)`,
      );
      this.platform = this.createPlatformByName(forcedPlatform);
      return;
    }

    // Auto-detect platform
    const candidates: ITeePlatform[] = [
      new PhalaPlatform(),
      new TdxPlatform(),
      new SevSnpPlatform(),
      new NitroPlatform(),
      new MockPlatform(), // Always available, last resort
    ];

    for (const candidate of candidates) {
      if (await candidate.isAvailable()) {
        this.platform = candidate;
        this.logger.log(`✅ TEE platform detected: ${this.platform.name}`);
        return;
      }
    }

    // Fallback to mock (should never happen since MockPlatform is always available)
    this.platform = new MockPlatform();
    this.logger.warn(
      '⚠️  No TEE platform detected, using mock (development only)',
    );
  }

  /**
   * Create platform adapter by name (for forced platform selection)
   */
  private createPlatformByName(name: string): ITeePlatform {
    switch (name) {
      case 'phala':
        return new PhalaPlatform();
      case 'intel-tdx':
      case 'tdx':
        return new TdxPlatform();
      case 'amd-sev-snp':
      case 'sev-snp':
        return new SevSnpPlatform();
      case 'aws-nitro':
      case 'nitro':
        return new NitroPlatform();
      case 'mock':
        return new MockPlatform();
      default:
        this.logger.warn(
          `Unknown platform: ${name}, falling back to auto-detection`,
        );
        return new MockPlatform();
    }
  }

  /**
   * Build report_data from the ML-KEM public key and the TLS leaf certificate
   * @param mlkemPublicKey - ML-KEM-1024 public key (1568 bytes)
   * @returns SHA-256(mlkem_public_key) || SHA-256(tls_leaf_cert_der)
   *          (second half is zero when this process is not terminating TLS,
   *          e.g. behind an external proxy — clients should treat that as
   *          a weaker guarantee)
   */
  private buildReportData(mlkemPublicKey: Buffer): Buffer {
    const mlkemHash = createHash('sha256').update(mlkemPublicKey).digest(); // 32 bytes
    const tlsCertDer = getTlsLeafCertificate();
    const tlsHash = tlsCertDer
      ? createHash('sha256').update(tlsCertDer).digest() // 32 bytes
      : Buffer.alloc(32);
    return Buffer.concat([mlkemHash, tlsHash]); // → 64 bytes
  }

  /**
   * Generate an attestation quote with embedded ML-KEM public key
   * Uses the TEE-generated public key from TeeKeyManagerService
   * @returns Platform-specific attestation quote with bound report_data
   */
  async getAttestation(): Promise<AttestationQuote> {
    if (!this.platform) {
      throw new Error('Attestation service not initialized');
    }

    // Get TEE-generated public key
    const mlkemPublicKey = this.keyManager.getPublicKeyBytes();
    if (!mlkemPublicKey) {
      throw new Error('ML-KEM public key not available from TEE Key Manager');
    }

    // Build report_data: SHA-256(mlkem_public_key) || SHA-256(tls_cert_der)
    const reportData = this.buildReportData(mlkemPublicKey);

    this.logger.log(
      `Generating attestation with platform: ${this.platform.name}`,
    );
    this.logger.debug(
      `Report data (first 32 bytes): ${reportData.subarray(0, 32).toString('hex')}`,
    );

    return this.platform.generateQuote(reportData);
  }

  /**
   * Get the currently detected platform name
   */
  getPlatform(): string {
    return this.platform?.name || 'unknown';
  }

  /**
   * Check if running in a real TEE
   */
  isInTee(): boolean {
    return this.platform?.name !== 'mock';
  }
}
