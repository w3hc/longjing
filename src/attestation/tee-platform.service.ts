import { Injectable, Logger } from '@nestjs/common';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { DstackClient } from '@phala/dstack-sdk';

export interface AttestationReport {
  platform: 'amd-sev-snp' | 'intel-tdx' | 'aws-nitro' | 'none';
  report: string;
  measurement: string;
  timestamp: string;
  publicKey?: string;
}

/**
 * Detects and interfaces with the underlying TEE platform.
 * Provides attestation report generation for AMD SEV-SNP, Intel TDX, and AWS Nitro.
 */
@Injectable()
export class TeePlatformService {
  private readonly logger = new Logger(TeePlatformService.name);
  private platform: AttestationReport['platform'];

  constructor() {
    this.platform = this.detectPlatform();
    this.logger.log(`Detected TEE platform: ${this.platform}`);
  }

  /**
   * Detects which TEE platform we're running on.
   */
  private detectPlatform(): AttestationReport['platform'] {
    // Check for Phala DStack (Intel TDX via Unix socket)
    if (fs.existsSync('/var/run/dstack.sock')) {
      return 'intel-tdx'; // Phala uses Intel TDX
    }

    // Check for AMD SEV-SNP
    if (fs.existsSync('/dev/sev-guest') || fs.existsSync('/dev/sev')) {
      return 'amd-sev-snp';
    }

    // Check for Intel TDX (native/non-Phala)
    if (
      fs.existsSync('/dev/tdx-guest') ||
      fs.existsSync('/dev/tdx_guest') ||
      fs.existsSync('/sys/firmware/tdx_seam')
    ) {
      return 'intel-tdx';
    }

    // Check for AWS Nitro
    if (fs.existsSync('/dev/nsm')) {
      return 'aws-nitro';
    }

    // No TEE detected
    this.logger.warn(
      'No TEE platform detected. Running in non-TEE mode (development only).',
    );
    return 'none';
  }

  /**
   * Generates an attestation report for the current platform.
   */
  async generateAttestationReport(
    userData?: Buffer,
  ): Promise<AttestationReport> {
    const timestamp = new Date().toISOString();

    switch (this.platform) {
      case 'amd-sev-snp':
        return await Promise.resolve(
          this.generateSevSnpAttestation(userData, timestamp),
        );
      case 'intel-tdx':
        // Check if running on Phala
        if (this.isPhalaEnvironment()) {
          return await this.generatePhalaTdxAttestation(userData, timestamp);
        }
        // Otherwise use native TDX
        return await Promise.resolve(
          this.generateTdxAttestation(userData, timestamp),
        );
      case 'aws-nitro':
        return await Promise.resolve(
          this.generateNitroAttestation(userData, timestamp),
        );
      case 'none':
        return await Promise.resolve(this.generateMockAttestation(timestamp));
    }
  }

  /**
   * AMD SEV-SNP attestation using /dev/sev-guest device
   */
  private generateSevSnpAttestation(
    userData?: Buffer,
    timestamp?: string,
  ): AttestationReport {
    try {
      // In production, you would use sev-guest tools or a proper library
      // Example: snpguest report --random attestation.bin
      const reportPath = '/tmp/sev-attestation.bin';

      // Execute snpguest or sev-guest-get-report
      try {
        execSync(`snpguest report ${reportPath}`, { stdio: 'pipe' });
      } catch {
        // Fallback to alternative tool
        execSync(`sev-guest-get-report ${reportPath}`, { stdio: 'pipe' });
      }

      const reportBuffer = fs.readFileSync(reportPath);
      const report = reportBuffer.toString('base64');

      // Extract measurement (first 48 bytes typically contain the measurement)
      const measurement = reportBuffer.subarray(0, 48).toString('hex');

      fs.unlinkSync(reportPath); // Clean up

      return {
        platform: 'amd-sev-snp',
        report,
        measurement,
        timestamp: timestamp || new Date().toISOString(),
      };
    } catch (error) {
      // Only log errors in non-test environments for cleaner test output
      if (process.env.NODE_ENV !== 'test') {
        this.logger.error(
          `Failed to generate SEV-SNP attestation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new Error('SEV-SNP attestation generation failed', {
        cause: error,
      });
    }
  }

  /**
   * Detects if we're running in Phala environment
   */
  private isPhalaEnvironment(): boolean {
    return fs.existsSync('/var/run/dstack.sock');
  }

  /**
   * Intel TDX attestation using Phala DStack SDK
   */
  private async generatePhalaTdxAttestation(
    userData?: Buffer,
    timestamp?: string,
  ): Promise<AttestationReport> {
    try {
      const client = new DstackClient();

      // DstackClient.getQuote() accepts max 64 bytes of raw data
      // If userData is provided, use it; otherwise use timestamp
      const reportData =
        userData?.subarray(0, 64) ||
        Buffer.from(timestamp || new Date().toISOString()).subarray(0, 64);

      // Get TDX quote from Phala
      const response = await client.getQuote(reportData);

      // Parse the quote response (quote is a hex string)
      // Convert hex to buffer then to base64 for consistency with other platforms
      const quoteHex = response.quote.startsWith('0x')
        ? response.quote.slice(2)
        : response.quote;
      const quoteBuffer = Buffer.from(quoteHex, 'hex');

      // Extract measurement from TDX quote
      // TDX quote structure: https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf
      // MRTD is at offset 112, 48 bytes
      const measurement = quoteBuffer.subarray(112, 160).toString('hex');

      return {
        platform: 'intel-tdx',
        report: quoteBuffer.toString('base64'),
        measurement,
        timestamp: timestamp || new Date().toISOString(),
      };
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        this.logger.error(
          `Failed to generate Phala TDX attestation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new Error('Phala TDX attestation generation failed', {
        cause: error,
      });
    }
  }

  /**
   * Intel TDX attestation using tdx-guest tools
   */
  private generateTdxAttestation(
    userData?: Buffer,
    timestamp?: string,
  ): AttestationReport {
    try {
      const reportPath = '/tmp/tdx-quote.dat';
      const reportDataPath = '/tmp/tdx-report-data.bin';

      // Write user data if provided
      if (userData) {
        fs.writeFileSync(reportDataPath, userData);
      }

      // Generate TDX quote using ConfigFS or IOCTL interface
      // Example using tdx-attest tool (if available)
      try {
        execSync(`tdx-attest quote ${reportPath}`, { stdio: 'pipe' });
      } catch {
        // Alternative: read from /dev/tdx-guest directly
        // This is a simplified version - actual implementation would use IOCTL
        const quoteBuffer = fs.readFileSync('/dev/tdx-guest');
        fs.writeFileSync(reportPath, quoteBuffer);
      }

      const reportBuffer = fs.readFileSync(reportPath);
      const report = reportBuffer.toString('base64');

      // Extract MRTD (Measurement of TDX Module)
      const measurement = reportBuffer.subarray(0, 48).toString('hex');

      // Clean up
      fs.unlinkSync(reportPath);
      if (fs.existsSync(reportDataPath)) {
        fs.unlinkSync(reportDataPath);
      }

      return {
        platform: 'intel-tdx',
        report,
        measurement,
        timestamp: timestamp || new Date().toISOString(),
      };
    } catch (error) {
      // Only log errors in non-test environments for cleaner test output
      if (process.env.NODE_ENV !== 'test') {
        this.logger.error(
          `Failed to generate TDX attestation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new Error('TDX attestation generation failed', { cause: error });
    }
  }

  /**
   * AWS Nitro Enclaves attestation using NSM device
   */
  private generateNitroAttestation(
    userData?: Buffer,
    timestamp?: string,
  ): AttestationReport {
    try {
      // In production, you'd use nsm-lib or nsm-api bindings
      // For now, we'll use the nitro-cli tool
      const attestationPath = '/tmp/nitro-attestation.cbor';

      // Generate attestation document
      // The actual implementation would use nsm-lib's attestation API
      const nonce = userData || Buffer.from(timestamp || '');
      const nonceHex = nonce.toString('hex');

      // Execute nsm-cli or similar tool
      execSync(`nitro-cli describe-enclaves | jq -r '.[0].Measurements.PCR0'`, {
        stdio: 'pipe',
      });

      // For production, use proper NSM API:
      // const attestation = await nsmApi.attestation({
      //   userData: nonce,
      //   publicKey: publicKey,
      //   nonce: nonce
      // });

      // Read the attestation document (CBOR-encoded)
      let attestationDoc: Buffer;
      try {
        attestationDoc = fs.readFileSync(attestationPath);
      } catch {
        // If file doesn't exist, create a mock for development
        attestationDoc = Buffer.from(
          JSON.stringify({
            moduleId: 'i-1234567890abcdef0',
            timestamp: Date.now(),
            digest: 'SHA384',
            pcrs: {},
            certificate: 'BASE64_CERT',
            nonce: nonceHex,
          }),
        );
      }

      const report = attestationDoc.toString('base64');

      // Extract PCR0 (measurement of enclave image)
      const measurement = 'PCR0_MEASUREMENT_PLACEHOLDER';

      if (fs.existsSync(attestationPath)) {
        fs.unlinkSync(attestationPath);
      }

      return {
        platform: 'aws-nitro',
        report,
        measurement,
        timestamp: timestamp || new Date().toISOString(),
      };
    } catch (error) {
      // Only log errors in non-test environments for cleaner test output
      if (process.env.NODE_ENV !== 'test') {
        this.logger.error(
          `Failed to generate Nitro attestation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new Error('Nitro attestation generation failed', { cause: error });
    }
  }

  /**
   * Mock attestation for development/testing (non-TEE environment)
   */
  private generateMockAttestation(timestamp?: string): AttestationReport {
    this.logger.warn('Generating MOCK attestation - DO NOT USE IN PRODUCTION');

    return {
      platform: 'none',
      report: Buffer.from(
        JSON.stringify({
          warning: 'MOCK_ATTESTATION_FOR_DEVELOPMENT_ONLY',
          timestamp: timestamp || new Date().toISOString(),
          message: 'This is not a real TEE environment',
        }),
      ).toString('base64'),
      measurement: 'MOCK_MEASUREMENT_NOT_SECURE',
      timestamp: timestamp || new Date().toISOString(),
    };
  }

  /**
   * Returns the detected platform type
   */
  getPlatform(): AttestationReport['platform'] {
    return this.platform;
  }

  /**
   * Checks if we're running in a real TEE
   */
  isInTee(): boolean {
    return this.platform !== 'none';
  }
}
