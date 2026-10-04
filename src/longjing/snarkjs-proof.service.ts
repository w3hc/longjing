/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-require-imports */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Service for real ZK-SNARK proof generation and verification using snarkjs
 *
 * This replaces the mock implementation with cryptographically valid proofs.
 * Requires a completed trusted setup (zkey + verification key).
 */
@Injectable()
export class SnarkjsProofService implements OnModuleInit {
  private readonly logger = new Logger(SnarkjsProofService.name);
  private snarkjs: any;
  private vKey: any;
  private wasmPath: string;
  private zkeyPath: string;
  private isSetup = false;

  constructor() {
    // Paths to circuit artifacts
    // NOTE: Currently using test circuit due to full circuit (775K constraints)
    // taking 12+ hours on M1. Generate full circuit on cloud infrastructure.
    // See docs/ZK.md for details.
    this.wasmPath = join(
      process.cwd(),
      'circuits/build/api_credit_proof_test_js/api_credit_proof_test.wasm',
    );
    this.zkeyPath = join(
      process.cwd(),
      'circuits/build/api_credit_proof_test.zkey',
    );
  }

  /**
   * NestJS lifecycle hook - initialize the service when module loads
   */
  async onModuleInit() {
    await this.initialize();
  }

  /**
   * Initialize snarkjs and load verification key
   */
  initialize(): Promise<boolean> {
    if (this.isSetup) {
      return Promise.resolve(true);
    }

    try {
      // Dynamically import snarkjs
      this.snarkjs = require('snarkjs');

      // Check if circuit artifacts exist
      if (!existsSync(this.wasmPath)) {
        this.logger.warn(
          `WASM file not found at ${this.wasmPath}. Using mock proofs.`,
        );
        return Promise.resolve(false);
      }

      if (!existsSync(this.zkeyPath)) {
        this.logger.warn(
          `zkey file not found at ${this.zkeyPath}. Using mock proofs.`,
        );
        return Promise.resolve(false);
      }

      // Load verification key
      const vKeyPath = join(
        process.cwd(),
        'circuits/build/verification_key.json',
      );

      if (!existsSync(vKeyPath)) {
        this.logger.warn(
          `Verification key not found at ${vKeyPath}. Using mock proofs.`,
        );
        return Promise.resolve(false);
      }

      const fs = require('fs');
      const vKeyContent = fs.readFileSync(vKeyPath, 'utf8') as string;
      this.vKey = JSON.parse(vKeyContent);

      this.isSetup = true;
      this.logger.log('SnarkJS proof system initialized successfully');
      this.logger.log(
        `Loaded vKey delta[0][0]: ${this.vKey.vk_delta_2[0][0].substring(0, 20)}...`,
      );
      return Promise.resolve(true);
    } catch (error) {
      this.logger.error('Failed to initialize snarkjs', error);
      return Promise.resolve(false);
    }
  }

  /**
   * Check if real proof system is available
   */
  isAvailable(): boolean {
    return this.isSetup;
  }

  /**
   * Generate a real ZK-SNARK proof
   *
   * @param input Circuit inputs
   * @returns Proof and public signals
   */
  async generateProof(input: {
    secretKey: string;
    ticketIndex: string;
    signalX: string;
    idCommitmentExpected: string;
  }): Promise<{
    proof: any;
    publicSignals: string[];
  }> {
    if (!this.isSetup) {
      const initialized = await this.initialize();
      if (!initialized) {
        throw new Error(
          'Proof system not initialized. Circuit artifacts missing.',
        );
      }
    }

    try {
      this.logger.debug('Generating witness...');

      // Generate witness
      const { proof, publicSignals } = await this.snarkjs.groth16.fullProve(
        input,
        this.wasmPath,
        this.zkeyPath,
      );

      this.logger.debug('Proof generated successfully', {
        publicSignals: publicSignals.slice(0, 2),
      });

      return { proof, publicSignals };
    } catch (error) {
      this.logger.error('Failed to generate proof', error);
      throw error;
    }
  }

  /**
   * Verify a ZK-SNARK proof
   *
   * @param proof The proof object
   * @param publicSignals Public inputs to verify against
   * @returns true if proof is valid, false otherwise
   */
  async verifyProof(proof: any, publicSignals: string[]): Promise<boolean> {
    if (!this.isSetup) {
      const initialized = await this.initialize();
      if (!initialized) {
        this.logger.warn('Proof system not initialized. Cannot verify proof.');
        return false;
      }
    }

    try {
      this.logger.debug('Verifying proof with public signals:', publicSignals);
      this.logger.debug('Proof data:', JSON.stringify(proof));

      // Convert proof from API format (projective coordinates with z) to snarkjs format (affine)
      // API format: pi_a = [x, y, z], snarkjs expects: pi_a = [x, y]
      // Also, pi_b coordinates are in reverse order in snarkjs
      const snarkjsProof = {
        pi_a: [proof.pi_a[0], proof.pi_a[1]],
        pi_b: [
          [proof.pi_b[0][1], proof.pi_b[0][0]], // Note: reversed order
          [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        pi_c: [proof.pi_c[0], proof.pi_c[1]],
        protocol: proof.protocol || 'groth16',
        curve: 'bn128',
      };

      this.logger.debug(
        'Converted to snarkjs format:',
        JSON.stringify(snarkjsProof),
      );

      const isValid = await this.snarkjs.groth16.verify(
        this.vKey,
        publicSignals,
        snarkjsProof,
      );

      if (isValid) {
        this.logger.debug('Proof verified successfully');
      } else {
        this.logger.warn('Proof verification failed - snarkjs returned false');
        this.logger.warn('Expected gamma:', this.vKey?.vk_gamma_2);
        this.logger.warn('Expected delta:', this.vKey?.vk_delta_2);
      }

      return isValid;
    } catch (error) {
      this.logger.error('Error verifying proof', error);
      return false;
    }
  }

  /**
   * Export proof to JSON format for storage/transmission
   */
  exportProof(proof: any): string {
    return JSON.stringify(proof);
  }

  /**
   * Import proof from JSON format
   */
  importProof(proofJson: string): any {
    return JSON.parse(proofJson);
  }

  /**
   * Get circuit information
   */
  getCircuitInfo(): {
    wasmPath: string;
    zkeyPath: string;
    isSetup: boolean;
  } {
    return {
      wasmPath: this.wasmPath,
      zkeyPath: this.zkeyPath,
      isSetup: this.isSetup,
    };
  }
}
