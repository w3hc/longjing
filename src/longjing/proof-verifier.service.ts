/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { RefundSignerService } from './refund-signer.service';
import { SnarkjsProofService } from './snarkjs-proof.service';
import { ComputeLimiterService } from './compute-limiter.service';
import { isProd } from '../config/profile';

/** What a request proof is checked against; none of it identifies the note */
export type RequestPublicInputs = {
  nullifier: string;
  signalY: string;
  accumulatorX: string;
  accumulatorY: string;
  merkleRoot: string;
  maxCost: bigint;
  signalX: string;
};

/**
 * Service for verifying ZK-SNARK proofs using Groth16
 * Now supports real cryptographic verification via snarkjs
 */
@Injectable()
export class ProofVerifierService {
  private readonly logger = new Logger(ProofVerifierService.name);
  private verificationCount = 0;
  private successfulVerifications = 0;
  private failedVerifications = 0;
  private mockVerifications = 0;

  constructor(
    private readonly blockchainService: BlockchainService,
    private readonly snarkjsProofService: SnarkjsProofService,
    private readonly refundSignerService: RefundSignerService,
    private readonly computeLimiter: ComputeLimiterService,
  ) {}

  /**
   * Check if the service is ready for production use
   * @returns true if real cryptographic verification is available
   */
  isProductionReady(): boolean {
    return this.snarkjsProofService.isAvailable();
  }

  /**
   * Get verification metrics for monitoring
   */
  getMetrics() {
    return {
      total: this.verificationCount,
      successful: this.successfulVerifications,
      failed: this.failedVerifications,
      mock: this.mockVerifications,
      successRate:
        this.verificationCount > 0
          ? (this.successfulVerifications / this.verificationCount) * 100
          : 0,
      usingRealVerification: this.snarkjsProofService.isAvailable(),
    };
  }

  /**
   * Verify a ZK-SNARK proof using Groth16 with cryptographic verification
   * @param proof The proof string to verify
   * @param publicInputs The public inputs that should match the proof
   * @returns Promise<boolean> true if proof is valid, false otherwise
   */
  async verify(
    proof: string,
    publicInputs: RequestPublicInputs,
  ): Promise<boolean> {
    // CRITICAL: Production mode requires real cryptographic verification
    if (isProd() && !this.snarkjsProofService.isAvailable()) {
      this.logger.error(
        'CRITICAL: Production mode requires real proof verification. Circuit artifacts not loaded.',
      );
      throw new Error(
        'Proof verification not available in production mode. Configure circuit artifacts.',
      );
    }

    this.logger.debug('Verifying proof with public inputs', {
      nullifier: publicInputs.nullifier.slice(0, 10) + '...',
      maxCost: publicInputs.maxCost.toString(),
    });

    // 1. Verify proof structure
    if (!proof || proof.length < 10) {
      this.logger.warn('Invalid proof format');
      return false;
    }

    let proofData;
    try {
      proofData = JSON.parse(proof);
    } catch (error) {
      this.logger.error('Failed to parse proof JSON', error);
      return false;
    }

    // Basic structure validation
    if (!proofData.protocol || proofData.protocol !== 'groth16') {
      this.logger.warn('Invalid proof protocol');
      return false;
    }

    // Groth16 proofs use projective coordinates (x, y, z) for elliptic curve points
    // Each point should have 3 coordinates, with z typically being "1"
    if (
      !proofData.pi_a ||
      !proofData.pi_b ||
      !proofData.pi_c ||
      proofData.pi_a.length !== 3 ||
      proofData.pi_b.length !== 2 ||
      proofData.pi_b[0].length !== 3 ||
      proofData.pi_b[1].length !== 3 ||
      proofData.pi_c.length !== 3
    ) {
      this.logger.warn('Invalid proof structure');
      this.logger.debug('Proof structure:', {
        pi_a_len: proofData.pi_a?.length,
        pi_b_len: proofData.pi_b?.length,
        pi_b0_len: proofData.pi_b?.[0]?.length,
        pi_b1_len: proofData.pi_b?.[1]?.length,
        pi_c_len: proofData.pi_c?.length,
      });
      return false;
    }

    this.logger.debug('Proof structure validated');

    // Steps 2-3 cost an RPC round-trip and a pairing check, so they are capped
    return this.computeLimiter.verification.run(() =>
      this.verifyAgainstChainAndCircuit(proofData, publicInputs),
    );
  }

  private async verifyAgainstChainAndCircuit(
    proofData: any,
    publicInputs: RequestPublicInputs,
  ): Promise<boolean> {
    // 2. The root must be one the contract recorded recently
    const knownRoot = await this.isKnownRoot(publicInputs.merkleRoot);
    if (knownRoot === false) {
      this.logger.warn('Merkle root is not a recent onchain root');
      return false;
    }

    // 3. Real snarkjs verification (REQUIRED - no mock fallback)
    try {
      this.verificationCount++;

      // CRITICAL: Real cryptographic verification is required
      // The mock fallback has been removed
      if (!this.snarkjsProofService.isAvailable()) {
        this.failedVerifications++;
        this.logger.error(
          'CRITICAL: Proof verification requires circuit artifacts. ' +
            'Run `pnpm circuits:fetch` to download proving/verification keys.',
        );
        throw new Error(
          'Proof verification not available. Circuit artifacts not loaded.',
        );
      }

      this.logger.debug('Using real snarkjs verification');

      // Order must match circuit: PUBLIC OUTPUTS FIRST, then PUBLIC INPUTS
      // Convert hex strings to decimal strings for snarkjs
      // Handle both hex strings (with/without 0x) and decimal strings
      const toBigInt = (value: string): bigint => {
        if (!value) return BigInt(0);
        const str = value.toString().trim();

        // If it starts with 0x, it's a hex string
        if (str.startsWith('0x') || str.startsWith('-0x')) {
          return BigInt(str);
        }

        // If it's a plain number (possibly negative), treat as decimal
        // This handles overflow cases where signalY might be negative
        if (/^-?\d+$/.test(str)) {
          const num = BigInt(str);
          // If negative, convert to field element (add field modulus)
          if (num < 0) {
            // BN254 field modulus
            const FIELD_MODULUS = BigInt(
              '21888242871839275222246405745257275088548364400416034343698204186575808495617',
            );
            return FIELD_MODULUS + num;
          }
          return num;
        }

        // Otherwise assume hex without 0x prefix
        return BigInt('0x' + str);
      };

      this.logger.debug('Raw public inputs received:', publicInputs);

      try {
        // Refunds must be signed by this server, so the key never comes from the request
        const serverKey = await this.refundSignerService.getPublicKey();
        // Outputs first, then inputs:
        // [nullifier, signalY, accumulatorX, accumulatorY, merkleRoot, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]
        const signals = [
          publicInputs.nullifier,
          publicInputs.signalY,
          publicInputs.accumulatorX,
          publicInputs.accumulatorY,
          publicInputs.merkleRoot,
          publicInputs.maxCost.toString(),
          publicInputs.signalX,
          serverKey.x,
          serverKey.y,
        ];
        const publicSignals = signals.map((value) =>
          toBigInt(value).toString(),
        );

        this.logger.debug('Constructed public signals:', publicSignals);

        const isValid = await this.snarkjsProofService.verifyProof(
          proofData,
          publicSignals,
        );

        if (isValid) {
          this.successfulVerifications++;
          this.logger.log('Proof verified successfully (cryptographic)');
        } else {
          this.failedVerifications++;
          this.logger.warn('Proof verification failed (cryptographic)');
        }

        return isValid;
      } catch (conversionError) {
        this.logger.error(
          'Failed to convert public inputs to field elements',
          conversionError,
        );
        throw conversionError;
      }
    } catch (error) {
      this.failedVerifications++;
      this.logger.error('Failed to verify proof', error);
      throw error; // Fail closed - don't return false, propagate the error
    }
  }

  /**
   * Whether the contract recorded this root recently. In prod this fails
   * closed: the root comes from the request, so skipping the check would let a
   * client prove membership in a tree of its own. Elsewhere it returns null
   * when the chain is unreachable, and the check is skipped.
   */
  private async isKnownRoot(root: string): Promise<boolean | null> {
    try {
      if (!this.blockchainService.isAvailable()) {
        throw new Error('Blockchain service not initialized');
      }
      return await this.blockchainService.isKnownRoot(root);
    } catch (error) {
      if (isProd()) {
        this.logger.error('Failed to read onchain state', error);
        throw new ServiceUnavailableException(
          'Cannot verify the Merkle root against the chain',
        );
      }
      this.logger.warn('Onchain state unavailable, skipping checks', error);
      return null;
    }
  }
}
