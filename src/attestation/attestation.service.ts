/**
 * Attestation Service
 *
 * Orchestrates cross-platform TEE attestation with report_data binding.
 * The first 32 bytes of report_data commit to every public key the service
 * uses (ML-KEM, identity, refund signer) and to the in-enclave TLS
 * certificate; the last 32 bytes carry the client's nonce. See
 * report-data.ts and docs/ATTESTATION.md#report_data.
 */

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AttestationQuote,
  BoundAttestation,
  BoundKeys,
} from './attestation.types';
import { ITeePlatform } from './platforms/platform.interface';
import { PhalaPlatform, tdxQuoteReportData } from './platforms/phala.platform';
import { TdxPlatform } from './platforms/tdx.platform';
import { SevSnpPlatform } from './platforms/sev-snp.platform';
import { NitroPlatform } from './platforms/nitro.platform';
import { MockPlatform } from './platforms/mock.platform';
import { TeeKeyManagerService } from './tee-key-manager.service';
import {
  buildReportData,
  encodeRefundSignerPublicKey,
  ReportDataInputs,
} from './report-data';
import { KeyDerivationService } from '../keys/key-derivation.service';
import { getTlsLeafCertificate } from '../tls/tls-context';
import { isProd } from '../config/profile';

@Injectable()
export class AttestationService
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly logger = new Logger(AttestationService.name);
  private platform: ITeePlatform | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly keyManager: TeeKeyManagerService,
    private readonly keyDerivation: KeyDerivationService,
  ) {}

  async onModuleInit() {
    // Check if TEE_PLATFORM is explicitly set in environment
    const forcedPlatform = this.configService.get<string>('TEE_PLATFORM');

    if (isProd()) {
      this.platform = await this.selectProductionPlatform(forcedPlatform);
      this.logger.log('✅ TEE platform: dstack');
      return;
    }

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
   * Production attests only through dstack, so the server refuses to start
   * rather than fall back to another platform or to the mock.
   */
  private async selectProductionPlatform(
    forcedPlatform?: string,
  ): Promise<ITeePlatform> {
    if (forcedPlatform && !['auto', 'phala'].includes(forcedPlatform)) {
      throw new Error(
        `TEE_PLATFORM=${forcedPlatform} is not allowed in production: only dstack attests`,
      );
    }
    if (process.env.DSTACK_SIMULATOR_ENDPOINT) {
      throw new Error(
        'DSTACK_SIMULATOR_ENDPOINT must not be set in production: its quotes are not from a TEE',
      );
    }

    const platform = new PhalaPlatform();
    if (!(await platform.isAvailable())) {
      throw new Error(
        'Cannot start in production without the dstack socket at /var/run/dstack.sock',
      );
    }
    return platform;
  }

  /**
   * In production, generates a first quote before serving and checks that
   * it carries the requested report_data.
   */
  async onApplicationBootstrap() {
    if (!isProd()) {
      return;
    }

    const requested = buildReportData(this.boundKeys().inputs);

    let quote: AttestationQuote;
    try {
      quote = await this.getAttestation();
    } catch (error) {
      throw new Error('Cannot start in production: first quote failed', {
        cause: error,
      });
    }

    const attested = tdxQuoteReportData(Buffer.from(quote.quote, 'base64'));
    if (!attested.equals(requested)) {
      throw new Error(
        'Cannot start in production: the quote does not carry the requested report_data',
      );
    }
    this.logger.log('✅ First quote carries the requested report_data');
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
        throw new Error(`Unknown TEE_PLATFORM: ${name}`);
    }
  }

  /**
   * The public values report_data commits to. A key that was not derived
   * from dstack is null and contributes an empty term.
   */
  private boundKeys(): {
    inputs: ReportDataInputs;
    keys: BoundKeys;
  } {
    const mlkemPublicKey = this.keyManager.getPublicKeyBytes();
    if (!mlkemPublicKey) {
      throw new Error('ML-KEM public key not available from TEE Key Manager');
    }
    const identityPublicKey = this.keyDerivation.getIdentityPublicKey();
    const refundSigner = this.keyDerivation.getRefundSignerPublicKey();
    const tlsCertificate = getTlsLeafCertificate();
    return {
      inputs: {
        mlkemPublicKey,
        identityPublicKey: identityPublicKey ?? undefined,
        refundSignerPublicKey: refundSigner
          ? encodeRefundSignerPublicKey(refundSigner)
          : undefined,
        tlsCertificateDer: tlsCertificate ?? undefined,
      },
      keys: {
        mlkemPublicKey: Buffer.from(mlkemPublicKey).toString('base64'),
        identityPublicKey: identityPublicKey
          ? '0x' + Buffer.from(identityPublicKey).toString('hex')
          : null,
        refundSignerPublicKey: refundSigner,
        tlsCertificate: tlsCertificate?.toString('base64') ?? null,
      },
    };
  }

  /**
   * Generate an attestation quote whose report_data commits to the service's
   * public keys and the client's nonce
   * @param nonce - Optional 32-byte client challenge for freshness
   * @returns The quote, with the nonce and the keys report_data commits to
   */
  async getAttestation(nonce?: Buffer): Promise<BoundAttestation> {
    if (!this.platform) {
      throw new Error('Attestation service not initialized');
    }

    const { inputs, keys } = this.boundKeys();
    const reportData = buildReportData(inputs, nonce);

    this.logger.log(
      `Generating attestation with platform: ${this.platform.name}`,
    );
    this.logger.debug(
      `Report data commitment: ${reportData.subarray(0, 32).toString('hex')}`,
    );

    const quote = await this.platform.generateQuote(reportData);
    return {
      ...quote,
      nonce: nonce ? '0x' + nonce.toString('hex') : null,
      keys,
    };
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
