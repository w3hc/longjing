/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-require-imports */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { existsSync } from 'fs';
import { isProd } from '../config/profile';

const ARTIFACTS = {
  wasm: 'circuits/build/request_js/request.wasm',
  zkey: 'circuits/build/request.zkey',
  vKey: 'circuits/build/request_verification_key.json',
};

/**
 * Groth16 proving and verification with snarkjs, for request.circom
 * (docs/SETTLEMENT.md). Production refuses to start without its
 * verification key.
 */
@Injectable()
export class SnarkjsProofService implements OnModuleInit {
  private readonly logger = new Logger(SnarkjsProofService.name);
  private snarkjs: any;
  private vKey: any;
  private readonly wasmPath = join(process.cwd(), ARTIFACTS.wasm);
  private readonly zkeyPath = join(process.cwd(), ARTIFACTS.zkey);
  private readonly vKeyPath = join(process.cwd(), ARTIFACTS.vKey);
  private isSetup = false;

  /**
   * NestJS lifecycle hook - initialize the service when module loads
   */
  async onModuleInit() {
    if (!(await this.initialize()) && isProd()) {
      throw new Error(
        `Cannot verify requests: verification key missing at ${this.vKeyPath}`,
      );
    }
  }

  /**
   * Initialize snarkjs and load the verification key
   */
  initialize(): Promise<boolean> {
    if (this.isSetup) {
      return Promise.resolve(true);
    }

    try {
      this.snarkjs = require('snarkjs');

      if (!existsSync(this.vKeyPath)) {
        this.logger.warn(
          `Verification key not found at ${this.vKeyPath}. Proofs cannot be verified.`,
        );
        return Promise.resolve(false);
      }

      const fs = require('fs');
      const vKeyContent = fs.readFileSync(this.vKeyPath, 'utf8') as string;
      this.vKey = JSON.parse(vKeyContent);

      this.isSetup = true;
      this.logger.log('SnarkJS initialized with the request circuit');
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
  async generateProof(input: Record<string, string | string[]>): Promise<{
    proof: any;
    publicSignals: string[];
  }> {
    const initialized = await this.initialize();
    if (
      !initialized ||
      !existsSync(this.wasmPath) ||
      !existsSync(this.zkeyPath)
    ) {
      throw new Error(
        'Proof system not initialized. Circuit artifacts missing.',
      );
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
    vKeyPath: string;
    isSetup: boolean;
  } {
    return {
      wasmPath: this.wasmPath,
      zkeyPath: this.zkeyPath,
      vKeyPath: this.vKeyPath,
      isSetup: this.isSetup,
    };
  }
}
