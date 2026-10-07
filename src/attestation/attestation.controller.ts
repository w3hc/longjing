import {
  BadRequestException,
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  KEY_MANIFEST_DOMAIN,
  KEY_MANIFEST_TYPES,
  KeyDerivationService,
} from '../keys/key-derivation.service';
import { AttestationService } from './attestation.service';
import { TeePlatform } from './attestation.types';
import { parseNonce } from './report-data';

/**
 * Attestation controller.
 * Provides cryptographic proof of the code running inside the TEE.
 * report_data commits to every public key the service uses (ML-KEM,
 * identity, refund signer) and to the in-enclave TLS certificate, followed
 * by the client's nonce. See docs/ATTESTATION.md#report_data.
 *
 * Clients should:
 * 1. Fetch GET /attestation?nonce=<32 random bytes, hex>
 * 2. Rebuild report_data from the returned keys and their nonce, and check
 *    it equals the quote's (see verifyKeyBinding in key-binding.ts)
 * 3. Check the returned TLS certificate is the one their TLS session saw
 * 4. Verify the quote signature with the TEE platform's verification service
 * 5. Replay RTMR0–3 from the event log and compare the measurements and the
 *    compose hash against the published values
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
   * which binds the ML-KEM, refund signer and TLS keys and the transaction
   * signer address to the app id, with
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
   * Returns the TEE attestation quote, the keys its report_data commits to
   * and, on dstack, the event log to replay RTMR0–3.
   * Clients must verify this cryptographically before trusting the service.
   * In non-TEE environments, returns a mock quote with platform='mock'.
   *
   * @param nonce - Optional 32-byte client challenge, hex, bound in
   *                report_data[32..64] for freshness
   */
  @Get()
  @ApiOperation({
    summary: 'Get TEE attestation quote bound to the service keys and a nonce',
  })
  @ApiQuery({
    name: 'nonce',
    required: false,
    description: '32 random bytes as hex, bound in report_data[32..64]',
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
            'Hex-encoded report_data: key commitment || nonce (see docs/ATTESTATION.md)',
        },
        nonce: { type: 'string', nullable: true },
        keys: {
          type: 'object',
          description: 'The public keys report_data commits to',
        },
        eventLog: {
          type: 'string',
          description: 'dstack event log (JSON), to replay RTMR0–3',
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
  @ApiResponse({ status: 400, description: 'Malformed nonce' })
  @ApiResponse({
    status: 500,
    description: 'Failed to generate attestation quote',
  })
  async getAttestation(@Query('nonce') nonce?: string) {
    let parsedNonce: Buffer | undefined;
    try {
      parsedNonce = parseNonce(nonce);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const attestation =
      await this.attestationService.getAttestation(parsedNonce);

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
          'Replay RTMR0–3 from eventLog and compare them against published values. ' +
          'Rebuild report_data from keys and your nonce (docs/ATTESTATION.md). ' +
          'Docs: https://docs.phala.com/phala-cloud/attestation/verify-your-application'
        );
      case 'intel-tdx':
        return (
          'Verify this TDX quote using Intel DCAP verification. ' +
          'Compare MRTD measurement against published value. ' +
          'Rebuild report_data from keys and your nonce (docs/ATTESTATION.md). ' +
          'Verification service: https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity'
        );
      case 'amd-sev-snp':
        return (
          'Verify this SEV-SNP report using AMD verification tools. ' +
          'Compare MEASUREMENT against published value. ' +
          'Rebuild report_data from keys and your nonce (docs/ATTESTATION.md). ' +
          'Verification service: https://kdsintf.amd.com/vcek/v1/{product}/cert_chain'
        );
      case 'aws-nitro':
        return (
          'Verify this Nitro attestation document using AWS verification. ' +
          'Compare PCR0 against published value. ' +
          'Rebuild user_data from keys and your nonce (docs/ATTESTATION.md). ' +
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
