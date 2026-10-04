/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-require-imports */

import { Injectable, Logger } from '@nestjs/common';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Service for generating double-spend slashing ZK proofs
 *
 * The circuit proves:
 * 1. Two RLN signals exist with the same nullifier but different x values
 * 2. Secret key was correctly extracted from these signals
 * 3. The extracted secret key matches the claimed idCommitment
 * 4. All RLN mathematics are correct
 */
@Injectable()
export class SlashingProofService {
  private readonly logger = new Logger(SlashingProofService.name);
  private snarkjs: any;
  private vKey: any;
  private wasmPath: string;
  private zkeyPath: string;
  private isSetup = false;

  constructor() {
    // Paths to double_spend_slashing circuit artifacts
    this.wasmPath = join(
      process.cwd(),
      'circuits/build/double_spend_slashing_js/double_spend_slashing.wasm',
    );
    this.zkeyPath = join(
      process.cwd(),
      'circuits/build/double_spend_slashing_final.zkey',
    );
  }

  /**
   * Initialize snarkjs and load verification key
   */
  initialize(): boolean {
    if (this.isSetup) {
      return true;
    }

    try {
      // Dynamically import snarkjs
      this.snarkjs = require('snarkjs');

      // Check if circuit artifacts exist
      if (!existsSync(this.wasmPath)) {
        this.logger.warn(
          `WASM file not found at ${this.wasmPath}. Slashing proofs unavailable.`,
        );
        return false;
      }

      if (!existsSync(this.zkeyPath)) {
        this.logger.warn(
          `zkey file not found at ${this.zkeyPath}. Slashing proofs unavailable.`,
        );
        return false;
      }

      // Load verification key
      const vKeyPath = join(
        process.cwd(),
        'circuits/build/double_spend_slashing_verification_key.json',
      );

      if (!existsSync(vKeyPath)) {
        this.logger.warn(
          `Verification key not found at ${vKeyPath}. Slashing proofs unavailable.`,
        );
        return false;
      }

      const fs = require('fs');
      const vKeyContent = fs.readFileSync(vKeyPath, 'utf8') as string;
      this.vKey = JSON.parse(vKeyContent);

      this.isSetup = true;
      this.logger.log('Slashing proof system initialized successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize slashing proof system', error);
      return false;
    }
  }

  /**
   * Check if proof system is available
   */
  isAvailable(): boolean {
    return this.isSetup;
  }

  /**
   * Generate a double-spend slashing proof
   *
   * @param signal1 First RLN signal (from stored nullifier)
   * @param signal2 Second RLN signal (from double-spend attempt)
   * @param secretKey Extracted secret key
   * @param nullifier The duplicated nullifier
   * @param ticketIndex Ticket index from the request
   * @returns Groth16 proof and public signals
   */
  async generateSlashingProof(params: {
    signal1_x: string;
    signal1_y: string;
    signal2_x: string;
    signal2_y: string;
    secretKey: string;
    nullifier: string;
    ticketIndex: string;
  }): Promise<{
    proof: string[];
    publicSignals: string[];
  }> {
    if (!this.isSetup) {
      const initialized = this.initialize();
      if (!initialized) {
        throw new Error(
          'Slashing proof system not initialized. Circuit artifacts missing.',
        );
      }
    }

    try {
      this.logger.log('Generating double-spend slashing proof...');

      // Circuit input format
      const input = {
        signal1_x: params.signal1_x,
        signal1_y: params.signal1_y,
        signal2_x: params.signal2_x,
        signal2_y: params.signal2_y,
        ticketIndex: params.ticketIndex,
        secretKeyClaimed: params.secretKey,
        nullifierExpected: params.nullifier,
      };

      this.logger.debug('Circuit inputs prepared', {
        signal1_x: params.signal1_x.slice(0, 20) + '...',
        signal2_x: params.signal2_x.slice(0, 20) + '...',
        ticketIndex: params.ticketIndex,
      });

      // Generate witness and proof
      const { proof, publicSignals } = await this.snarkjs.groth16.fullProve(
        input,
        this.wasmPath,
        this.zkeyPath,
      );

      this.logger.log('Slashing proof generated successfully');
      this.logger.debug('Public signals:', publicSignals);

      // Convert proof to contract format: [pA, pB, pC] -> uint256[8]
      const proofArray = [
        proof.pi_a[0],
        proof.pi_a[1],
        proof.pi_b[0][1],
        proof.pi_b[0][0],
        proof.pi_b[1][1],
        proof.pi_b[1][0],
        proof.pi_c[0],
        proof.pi_c[1],
      ];

      return {
        proof: proofArray,
        publicSignals,
      };
    } catch (error) {
      this.logger.error('Failed to generate slashing proof', error);
      throw error;
    }
  }

  /**
   * Verify a slashing proof (for testing)
   */
  async verifyProof(proof: any, publicSignals: string[]): Promise<boolean> {
    if (!this.isSetup) {
      const initialized = this.initialize();
      if (!initialized) {
        this.logger.warn(
          'Slashing proof system not initialized. Cannot verify proof.',
        );
        return false;
      }
    }

    try {
      const isValid = await this.snarkjs.groth16.verify(
        this.vKey,
        publicSignals,
        proof,
      );

      if (isValid) {
        this.logger.debug('Slashing proof verified successfully');
      } else {
        this.logger.warn('Slashing proof verification failed');
      }

      return isValid;
    } catch (error) {
      this.logger.error('Error verifying slashing proof', error);
      return false;
    }
  }
}
