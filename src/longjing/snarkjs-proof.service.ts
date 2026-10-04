/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-require-imports */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { existsSync } from 'fs';

export type ZkCircuit = 'api_request' | 'api_credit_proof_test';

const CIRCUIT_ARTIFACTS: Record<
  ZkCircuit,
  { wasm: string; zkey: string; vKey: string }
> = {
  api_request: {
    wasm: 'circuits/build/api_request_js/api_request.wasm',
    zkey: 'circuits/build/api_request.zkey',
    vKey: 'circuits/build/api_request_verification_key.json',
  },
  api_credit_proof_test: {
    wasm: 'circuits/build/api_credit_proof_test_js/api_credit_proof_test.wasm',
    zkey: 'circuits/build/api_credit_proof_test.zkey',
    vKey: 'circuits/build/verification_key.json',
  },
};

/**
 * Service for real ZK-SNARK proof generation and verification using snarkjs
 *
 * The circuit comes from ZK_CIRCUIT. Production verifies with api_request and
 * refuses to start without its verification key; other environments default
 * to the lighter test circuit.
 */
@Injectable()
export class SnarkjsProofService implements OnModuleInit {
  private readonly logger = new Logger(SnarkjsProofService.name);
  private snarkjs: any;
  private vKey: any;
  private readonly circuit: ZkCircuit;
  private wasmPath: string;
  private zkeyPath: string;
  private vKeyPath: string;
  private isSetup = false;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';
    const circuit =
      process.env.ZK_CIRCUIT ||
      (isProduction ? 'api_request' : 'api_credit_proof_test');

    if (!(circuit in CIRCUIT_ARTIFACTS)) {
      throw new Error(`Unknown ZK_CIRCUIT: ${circuit}`);
    }
    this.circuit = circuit as ZkCircuit;

    const artifacts = CIRCUIT_ARTIFACTS[this.circuit];
    this.wasmPath = join(process.cwd(), artifacts.wasm);
    this.zkeyPath = join(process.cwd(), artifacts.zkey);
    this.vKeyPath = join(process.cwd(), artifacts.vKey);
  }

  /**
   * NestJS lifecycle hook - initialize the service when module loads
   */
  async onModuleInit() {
    if (process.env.NODE_ENV !== 'production') {
      await this.initialize();
      return;
    }

    if (this.circuit !== 'api_request') {
      throw new Error(
        `ZK_CIRCUIT=${this.circuit} is not allowed in production. Use api_request.`,
      );
    }

    if (!(await this.initialize())) {
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
      this.logger.log(`SnarkJS initialized with circuit ${this.circuit}`);
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
   * Circuit whose verification key is loaded
   */
  getCircuit(): ZkCircuit {
    return this.circuit;
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
    circuit: ZkCircuit;
    wasmPath: string;
    zkeyPath: string;
    vKeyPath: string;
    isSetup: boolean;
  } {
    return {
      circuit: this.circuit,
      wasmPath: this.wasmPath,
      zkeyPath: this.zkeyPath,
      vKeyPath: this.vKeyPath,
      isSetup: this.isSetup,
    };
  }
}
