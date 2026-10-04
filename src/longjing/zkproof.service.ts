/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-require-imports */

import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

const snarkjs = require('snarkjs');

/**
 * Service for generating and verifying ZK-SNARK proofs using snarkjs
 * Note: eslint warnings disabled for snarkjs (no type definitions available)
 */
@Injectable()
export class ZKProofService {
  private readonly logger = new Logger(ZKProofService.name);
  private wasmPath: string;
  private zkeyPath: string | null = null;
  private zkeyData: Buffer | null = null;
  private vkeyData: unknown = null;

  constructor() {
    // Path to compiled circuit artifacts
    this.wasmPath = join(
      process.cwd(),
      'circuits/build/api_credit_proof_simple_js/api_credit_proof_simple.wasm',
    );

    void this.initialize();
  }

  private initialize(): void {
    try {
      // Check if proving/verification keys exist
      const zkeyPath = join(
        process.cwd(),
        'circuits/build/api_credit_proof_simple.zkey',
      );
      const vkeyPath = join(
        process.cwd(),
        'circuits/build/verification_key.json',
      );

      try {
        this.zkeyData = readFileSync(zkeyPath);
        this.vkeyData = JSON.parse(readFileSync(vkeyPath, 'utf8'));
        this.logger.log('ZK proof keys loaded successfully');
      } catch {
        this.logger.warn(
          'ZK proof keys not found - proofs cannot be generated/verified',
        );
        this.logger.warn(
          'Run: cd circuits && ./scripts/setup_keys.sh to generate keys',
        );
      }
    } catch (error) {
      this.logger.error('Failed to initialize ZK proof service', error);
    }
  }

  /**
   * Generate a ZK proof for API credit
   */
  async generateProof(input: {
    secretKey: string;
    pathElements: string[];
    pathIndices: number[];
    ticketIndex: number;
    merkleRoot: string;
    maxCost: string;
    initialDeposit: string;
    signalX: string;
  }): Promise<{
    proof: any;
    publicSignals: string[];
  }> {
    if (!this.zkeyPath) {
      throw new Error('Proving key not available - run key setup first');
    }

    try {
      this.logger.debug('Generating ZK proof with inputs', {
        ticketIndex: input.ticketIndex,
        merkleRoot: input.merkleRoot.slice(0, 10) + '...',
      });

      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        this.wasmPath,
        this.zkeyPath,
      );

      this.logger.debug('Proof generated successfully', {
        publicSignals: publicSignals.length,
      });

      return { proof, publicSignals };
    } catch (error) {
      this.logger.error('Failed to generate proof', error);
      throw error;
    }
  }

  /**
   * Verify a ZK-SNARK proof
   */
  async verifyProof(proof: any, publicSignals: string[]): Promise<boolean> {
    if (!this.vkeyData) {
      this.logger.warn(
        'Verification key not available - skipping verification',
      );
      return false;
    }

    try {
      const isValid = await snarkjs.groth16.verify(
        this.vkeyData,
        publicSignals,
        proof,
      );

      this.logger.debug('Proof verification result:', isValid);
      return isValid;
    } catch (error) {
      this.logger.error('Failed to verify proof', error);
      return false;
    }
  }

  /**
   * Export verification key for Solidity verifier generation
   */
  async exportSolidityVerifier(): Promise<string> {
    if (!this.vkeyData) {
      throw new Error('Verification key not available');
    }

    try {
      const solidityCode = await snarkjs.zKey.exportSolidityVerifier(
        this.zkeyPath,
      );
      return solidityCode;
    } catch (error) {
      this.logger.error('Failed to export Solidity verifier', error);
      throw error;
    }
  }

  /**
   * Check if proof generation is available
   */
  isAvailable(): boolean {
    return this.zkeyPath !== null && this.vkeyData !== null;
  }

  /**
   * Calculate public outputs from private inputs (for testing)
   */
  calculatePublicOutputs(input: {
    secretKey: bigint;
    ticketIndex: bigint;
    signalX: bigint;
  }): {
    nullifier: bigint;
    signalY: bigint;
    idCommitment: bigint;
  } {
    // These would normally be calculated by the circuit
    // For now, we use placeholders
    const poseidon = require('circomlibjs').poseidon;

    const idCommitment = poseidon([input.secretKey]);
    const a = poseidon([input.secretKey, input.ticketIndex]);
    const nullifier = poseidon([a]);
    const signalY = input.secretKey + a * input.signalX;

    return {
      nullifier,
      signalY,
      idCommitment,
    };
  }
}
