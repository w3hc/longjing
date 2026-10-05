import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  KEY_MANIFEST_DOMAIN,
  KEY_MANIFEST_TYPES,
  KeyDerivationService,
} from '../keys/key-derivation.service';
import { AttestationService } from './attestation.service';
import { TeePlatform } from './attestation.types';

/**
 * Attestation controller.
 * Provides cryptographic proof of the code running inside the TEE.
 * Binds the TEE-generated ML-KEM public key and the in-enclave TLS
 * certificate to the attestation quote via report_data.
 *
 * Security model:
 * - ML-KEM key pair is derived inside the TEE from the dstack KMS
 * - Private key never leaves the TEE and is never stored
 * - Public key is bound to attestation via report_data (first 32 bytes)
 * - The TLS certificate served by this process is bound via report_data
 *   (second 32 bytes), proving TLS terminates inside the enclave
 *
 * Clients should:
 * 1. Fetch the attestation quote from this endpoint
 * 2. Fetch the ML-KEM public key from /mlkem/pubkey
 * 3. Verify report_data = SHA-256(mlkem_public_key) || SHA-256(tls_cert_der),
 *    where tls_cert_der is the DER encoding of the TLS certificate presented
 *    by this server (a zero second half means TLS terminates OUTSIDE the TEE)
 * 4. Verify the quote signature with the TEE platform's verification service
 * 5. Compare the measurement hash against the published value
 * 6. Only send sensitive data if verification succeeds
 */
@ApiTags('Attestation')
@Controller('attestation')
export class AttestationController {
  constructor(
    private readonly attestationService: AttestationService,
    private readonly keyDerivation: KeyDerivationService,
  ) {}

  /**
   * Returns the EIP-712 key manifest signed by the enclave's identity key,
   * which binds the ML-KEM, refund signer and TLS keys to the app id, with
   * the GetKey signature chains that tie the keys to the dstack KMS root.
   * See docs/KEY_DERIVATION.md.
   */
  @Get('manifest')
  @ApiOperation({
    summary: 'Get the key manifest signed by the enclave identity key',
  })
  @ApiResponse({ status: 200, description: 'Signed key manifest' })
  @ApiResponse({
    status: 503,
    description: 'Keys were not derived from dstack (development only)',
  })
  getKeyManifest() {
    const signed = this.keyDerivation.getKeyManifest();
    if (!signed) {
      throw new ServiceUnavailableException(
        'Keys were not derived from dstack, so there is no key manifest',
      );
    }
    const hex = (bytes: Uint8Array) =>
      '0x' + Buffer.from(bytes).toString('hex');

    return {
      ...signed,
      domain: KEY_MANIFEST_DOMAIN,
      types: KEY_MANIFEST_TYPES,
      mlkemPublicKey: Buffer.from(
        this.keyDerivation.getMlKemPublicKey()!,
      ).toString('base64'),
      identity: {
        address: this.keyDerivation.getIdentityAddress(),
        publicKey: hex(this.keyDerivation.getIdentityPublicKey()!),
        signatureChain: this.keyDerivation.getIdentitySignatureChain().map(hex),
      },
      refundSigner: {
        ...this.keyDerivation.getRefundSignerPublicKey(),
        signatureChain: this.keyDerivation
          .getRefundSignerSignatureChain()
          .map(hex),
      },
    };
  }

  /**
   * Returns the TEE attestation quote with bound ML-KEM public key.
   * The ML-KEM key pair is generated inside the TEE, and the private key never leaves it.
   * Clients must verify this cryptographically before trusting the service.
   * In non-TEE environments, returns a mock quote with platform='mock'.
   *
   * @returns Attestation quote with embedded report_data
   *          (SHA-256 of ML-KEM public key || SHA-256 of TLS certificate)
   */
  @Get()
  @ApiOperation({
    summary: 'Get TEE attestation quote with bound ML-KEM public key',
  })
  @ApiResponse({
    status: 200,
    description:
      'Attestation quote generated successfully with bound public key',
    schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['phala', 'intel-tdx', 'amd-sev-snp', 'aws-nitro', 'mock'],
        },
        quote: {
          type: 'string',
          description: 'Base64-encoded attestation quote',
        },
        reportData: {
          type: 'string',
          description:
            'Hex-encoded report_data: SHA-256(mlkem_public_key) || SHA-256(tls_cert_der)',
        },
        measurement: {
          type: 'string',
          description: 'Hex-encoded TEE measurement (MRTD/PCR0/etc)',
        },
        timestamp: { type: 'string', format: 'date-time' },
        instructions: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Failed to generate attestation quote',
  })
  async getAttestation() {
    // Generate attestation with TEE-generated key bound to report_data
    const attestation = await this.attestationService.getAttestation();

    return {
      ...attestation,
      instructions: this.getVerificationInstructions(attestation.platform),
    };
  }

  /**
   * Returns platform-specific verification instructions
   */
  private getVerificationInstructions(platform: TeePlatform): string {
    switch (platform) {
      case 'phala':
        return (
          'Verify this quote using Phala verification service (https://verifier.phala.network/verify). ' +
          'Compare RTMR measurements against published values. ' +
          'Verify report_data = SHA-256(mlkem_public_key) || SHA-256(tls_cert_der). ' +
          'Docs: https://docs.phala.com/phala-cloud/attestation/verify-your-application'
        );
      case 'intel-tdx':
        return (
          'Verify this TDX quote using Intel DCAP verification. ' +
          'Compare MRTD measurement against published value. ' +
          'Verify report_data = SHA-256(mlkem_public_key) || SHA-256(tls_cert_der). ' +
          'Verification service: https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity'
        );
      case 'amd-sev-snp':
        return (
          'Verify this SEV-SNP report using AMD verification tools. ' +
          'Compare MEASUREMENT against published value. ' +
          'Verify report_data = SHA-256(mlkem_public_key) || SHA-256(tls_cert_der). ' +
          'Verification service: https://kdsintf.amd.com/vcek/v1/{product}/cert_chain'
        );
      case 'aws-nitro':
        return (
          'Verify this Nitro attestation document using AWS verification. ' +
          'Compare PCR0 against published value. ' +
          'Verify user_data = SHA-256(mlkem_public_key) || SHA-256(tls_cert_der). ' +
          'Use aws-nitro-enclaves-cose library for verification'
        );
      case 'mock':
        return (
          'WARNING: This is a MOCK attestation for development only. ' +
          'DO NOT use in production. No TEE environment detected. ' +
          'The application is running in standard mode without hardware security guarantees.'
        );
    }
  }
}
