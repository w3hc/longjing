/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Injectable, Logger } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { ProofGenService } from './proof-gen.service';
import { RefundSignerService } from './refund-signer.service';
import { SnarkjsProofService } from './snarkjs-proof.service';
import { isProd } from '../config/profile';

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
    private readonly proofGenService: ProofGenService,
    private readonly snarkjsProofService: SnarkjsProofService,
    private readonly refundSignerService: RefundSignerService,
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
    publicInputs: {
      merkleRoot: string;
      maxCost: string;
      initialDeposit: string;
      signalX: string;
      nullifier: string;
      signalY: string;
      idCommitment: string;
      idCommitmentExpected: string;
    },
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
      maxCost: publicInputs.maxCost,
      idCommitment: publicInputs.idCommitment.slice(0, 10) + '...',
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

    // 2. Verify against blockchain state if available
    if (this.blockchainService.isAvailable()) {
      try {
        const onChainMerkleRoot = await this.blockchainService.getMerkleRoot();

        // Check if nullifier has been slashed
        const isSlashed = await this.blockchainService.isNullifierSlashed(
          publicInputs.nullifier,
        );

        if (isSlashed) {
          this.logger.warn(
            `Nullifier ${publicInputs.nullifier} has been slashed`,
          );
          return false;
        }

        // Verify Merkle root matches onchain root
        if (onChainMerkleRoot !== publicInputs.merkleRoot) {
          this.logger.warn('Merkle root mismatch with onchain state', {
            expected: onChainMerkleRoot,
            provided: publicInputs.merkleRoot,
          });
          return false;
        }

        this.logger.debug('Blockchain state verified successfully');
      } catch (error) {
        this.logger.warn('Failed to verify against blockchain state', error);
        // Continue with verification in dev mode
      }
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
            'Run `npm run setup:circuit` to generate proving/verification keys.',
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
        let signals: string[];
        if (this.snarkjsProofService.getCircuit() === 'api_request') {
          // Refunds must be signed by this server, so the key never comes from the request
          const serverKey = await this.refundSignerService.getPublicKey();
          // [nullifier, signalY, idCommitment, merkleRoot, merkleRootExpected, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]
          signals = [
            publicInputs.nullifier,
            publicInputs.signalY,
            publicInputs.idCommitment,
            publicInputs.merkleRoot,
            publicInputs.merkleRoot,
            publicInputs.maxCost,
            publicInputs.signalX,
            serverKey.x,
            serverKey.y,
          ];
        } else {
          // [nullifier, signalY, idCommitment, signalX, idCommitmentExpected]
          signals = [
            publicInputs.nullifier,
            publicInputs.signalY,
            publicInputs.idCommitment,
            publicInputs.signalX,
            publicInputs.idCommitmentExpected,
          ];
        }
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
}
