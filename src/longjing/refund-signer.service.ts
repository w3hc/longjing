import { Injectable, Logger, Inject } from '@nestjs/common';
import { createHash } from 'crypto';
import { buildBabyjub, buildEddsa, buildPoseidon } from 'circomlibjs';
import { RefundTicketDto } from './dto/api-response.dto';
import { SecretsService } from '../config/secrets.service';

/**
 * Service for signing refund tickets using EdDSA with Babyjubjub curve
 * Compatible with circomlib EdDSA circuits
 *
 * Note: circomlibjs does not provide TypeScript types, so we must use any types
 * and disable eslint rules for unsafe operations with circomlibjs objects.
 */
@Injectable()
export class RefundSignerService {
  private readonly logger = new Logger(RefundSignerService.name);
  private privateKey: Buffer;
  private publicKey: { x: string; y: string };

  private eddsa: any;

  private babyJub: any;

  private poseidon: any;
  private initialized = false;
  private initPromise: Promise<void>;

  constructor(
    @Inject(SecretsService)
    private readonly secretsService: SecretsService,
  ) {
    this.initPromise = this.initialize();
  }

  private async initialize() {
    try {
      // Initialize circomlibjs components
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.eddsa = await buildEddsa();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.babyJub = await buildBabyjub();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.poseidon = await buildPoseidon();

      // Load private key from SecretsService which handles:
      // - Local dev: Falls back to process.env (or generates dev key)
      // - Phala TEE: Loads from encrypted environment variables
      // - Cloud with KMS: Fetches from KMS using TEE attestation
      let privateKeyHex: string;
      try {
        privateKeyHex = this.secretsService.get('OPERATOR_PRIVATE_KEY');
      } catch {
        // In production, OPERATOR_PRIVATE_KEY must be set
        const isProduction = process.env.NODE_ENV === 'production';

        if (isProduction) {
          this.logger.error(
            'OPERATOR_PRIVATE_KEY not found in production environment',
          );
          throw new Error(
            'OPERATOR_PRIVATE_KEY must be configured in production. ' +
              'Refusing to use deterministic fallback key.',
          );
        }

        // Development-only fallback
        privateKeyHex =
          process.env.OPERATOR_PRIVATE_KEY || this.generatePrivateKey();
        this.logger.warn(
          'OPERATOR_PRIVATE_KEY not found in SecretsService, using DEV-ONLY fallback',
        );
      }

      // Convert hex string to Buffer (remove 0x prefix if present)
      // Private key must be exactly 32 bytes for Babyjubjub
      const cleanHex = privateKeyHex.replace(/^0x/, '');
      this.privateKey = Buffer.from(cleanHex.padStart(64, '0'), 'hex');

      // Derive public key using Babyjubjub
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const pubKey = this.eddsa.prv2pub(this.privateKey);

      // Convert to hex strings for consistency with existing API

      this.publicKey = {
        x:
          '0x' +
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          String(this.babyJub.F.toString(pubKey[0], 16)).padStart(64, '0'),

        y:
          '0x' +
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          String(this.babyJub.F.toString(pubKey[1], 16)).padStart(64, '0'),
      };

      this.initialized = true;
      this.logger.log('Refund signer initialized with EdDSA/Babyjubjub');
      this.logger.debug(
        `Public key: (${this.publicKey.x.slice(0, 10)}..., ${this.publicKey.y.slice(0, 10)}...)`,
      );
    } catch (error) {
      // Suppress expected circomlibjs teardown errors in test environment
      if (
        error instanceof TypeError &&
        error.message.includes("'instanceof' is not callable")
      ) {
        // This error occurs during Jest teardown when circomlibjs tries to clean up
        // It doesn't affect functionality, so we can safely ignore it in tests
        return;
      }
      this.logger.error('Failed to initialize EdDSA signer', error);
      throw error;
    }
  }

  private async ensureInitialized() {
    if (!this.initialized) {
      await this.initPromise;
    }
  }

  /**
   * Sign a refund ticket
   */
  async signRefund(refundData: {
    idCommitment: string;
    nullifier: string;
    value: string;
    timestamp: number;
  }): Promise<RefundTicketDto> {
    await this.ensureInitialized();

    // Create message to sign using Poseidon hash
    const message = this.hashRefundData(refundData);

    // Sign using EdDSA with Babyjubjub
    const signature = this.sign(message);

    return {
      nullifier: refundData.nullifier,
      value: refundData.value,
      timestamp: refundData.timestamp,
      signature,
    };
  }

  /**
   * Get the server's public key for signature verification
   */
  async getPublicKey(): Promise<{ x: string; y: string }> {
    await this.ensureInitialized();
    return { ...this.publicKey };
  }

  /**
   * Verify a refund signature (for testing)
   */
  async verifyRefund(
    ticket: RefundTicketDto,
    idCommitment: string,
  ): Promise<boolean> {
    await this.ensureInitialized();

    const message = this.hashRefundData({
      idCommitment,
      nullifier: ticket.nullifier,
      value: ticket.value,
      timestamp: ticket.timestamp,
    });

    return this.verify(message, ticket.signature);
  }

  // ============ Private Methods ============

  private generatePrivateKey(): string {
    // Generate deterministic private key for development
    // This creates a valid 32-byte private key for Babyjubjub
    const hash = createHash('sha256');
    hash.update('longjing-refund-signer-dev-key');
    return '0x' + hash.digest('hex');
  }

  private hashRefundData(data: {
    idCommitment: string;
    nullifier: string;
    value: string;
    timestamp: number;
  }): bigint {
    // Use Poseidon hash for circuit compatibility
    // Canonical message format: Poseidon(idCommitment, nullifier, value, timestamp)
    // This MUST match:
    // - refund_redemption.circom line 64-69
    // - api_credit_proof.circom refund verification
    // - LongjingCredits.sol _hashRefundData
    const idCommitmentBigInt = BigInt(data.idCommitment);
    const nullifierBigInt = BigInt(data.nullifier);
    const valueBigInt = BigInt(data.value);
    const timestampBigInt = BigInt(data.timestamp);

    // Hash with Poseidon(4 inputs)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const hash = this.poseidon([
      idCommitmentBigInt,
      nullifierBigInt,
      valueBigInt,
      timestampBigInt,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    return this.poseidon.F.toObject(hash);
  }

  private sign(message: bigint): {
    R8x: string;
    R8y: string;
    S: string;
  } {
    // Sign using EdDSA with Babyjubjub curve
    // signPoseidon expects the message as a field element (BigInt)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const signature = this.eddsa.signPoseidon(
      this.privateKey,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      this.babyJub.F.e(message),
    );

    // Convert signature components to hex strings
    return {
      R8x:
        '0x' +
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        String(this.babyJub.F.toString(signature.R8[0], 16)).padStart(64, '0'),
      R8y:
        '0x' +
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        String(this.babyJub.F.toString(signature.R8[1], 16)).padStart(64, '0'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      S: '0x' + String(signature.S.toString(16)).padStart(64, '0'),
    };
  }

  private verify(
    message: bigint,
    signature: { R8x: string; R8y: string; S: string },
  ): boolean {
    // Convert hex strings back to field elements
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const R8x = this.babyJub.F.e(BigInt(signature.R8x));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const R8y = this.babyJub.F.e(BigInt(signature.R8y));
    const S = BigInt(signature.S);

    // Get public key as array
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const pubKeyX = this.babyJub.F.e(BigInt(this.publicKey.x));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const pubKeyY = this.babyJub.F.e(BigInt(this.publicKey.y));

    // Verify signature
    const sig = {
      R8: [R8x, R8y],
      S: S,
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    return this.eddsa.verifyPoseidon(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      this.babyJub.F.e(message),
      sig,
      [pubKeyX, pubKeyY],
    );
  }
}
