/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-require-imports */

import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

/**
 * Service for generating ZK proof primitives
 * Uses Poseidon hash and RLN primitives
 * Note: eslint warnings disabled for circomlibjs (no type definitions available)
 */
@Injectable()
export class ProofGenService {
  private readonly logger = new Logger(ProofGenService.name);
  private poseidon: any;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize Poseidon hash (lazy initialization)
   */
  private async initialize() {
    if (this.poseidon) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        // Use require instead of dynamic import to avoid ESM issues
        const circomlibjs = require('circomlibjs');
        this.poseidon = await circomlibjs.buildPoseidon();
        this.logger.log('Poseidon hash initialized');
      } catch (error) {
        this.logger.error('Failed to initialize Poseidon hash', error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Generate identity commitment from secret key
   */
  async generateIdCommitment(secretKey: bigint): Promise<bigint> {
    await this.initialize();
    const F = this.poseidon.F;
    return F.toObject(this.poseidon([secretKey]));
  }

  /**
   * Generate RLN nullifier and signal
   */
  async generateRLNSignal(
    secretKey: bigint,
    ticketIndex: bigint,
    signalX: bigint,
  ): Promise<{
    nullifier: bigint;
    signalY: bigint;
    a: bigint;
  }> {
    await this.initialize();

    const F = this.poseidon.F;

    // a = Hash(secretKey, ticketIndex)
    const a = F.toObject(this.poseidon([secretKey, ticketIndex]));

    // nullifier = Hash(a)
    const nullifier = F.toObject(this.poseidon([a]));

    // signalY = secretKey + a * signalX (using field arithmetic)
    const signalY = F.toObject(
      F.add(F.e(secretKey), F.mul(F.e(a), F.e(signalX))),
    );

    return { nullifier, signalY, a };
  }

  /**
   * Recover secret key from two RLN signals (double-spend detection)
   * Given:
   *   y1 = k + a * x1
   *   y2 = k + a * x2
   * Then:
   *   k = (x2*y1 - x1*y2) / (x2 - x1)
   */
  async recoverSecretKey(
    signal1: { x: bigint; y: bigint },
    signal2: { x: bigint; y: bigint },
  ): Promise<bigint> {
    await this.initialize();

    const F = this.poseidon.F;

    // Ensure signals have different x values
    if (signal1.x === signal2.x) {
      throw new Error('Signals must have different x values');
    }

    // k = (x2*y1 - x1*y2) / (x2 - x1)
    const numerator = F.sub(
      F.mul(F.e(signal2.x), F.e(signal1.y)),
      F.mul(F.e(signal1.x), F.e(signal2.y)),
    );
    const denominator = F.sub(F.e(signal2.x), F.e(signal1.x));
    const secretKey = F.div(numerator, denominator);

    return F.toObject(secretKey);
  }

  /**
   * Generate a mock proof for testing
   * In production, this would use actual ZK-SNARK proof generation
   */
  async generateMockProof(input: {
    secretKey: bigint;
    ticketIndex: bigint;
    signalX: bigint;
    merkleRoot: string;
    maxCost: string;
    initialDeposit: string;
  }): Promise<{
    proof: string;
    publicInputs: {
      merkleRoot: string;
      maxCost: string;
      initialDeposit: string;
      signalX: string;
      nullifier: string;
      signalY: string;
      idCommitment: string;
    };
  }> {
    const idCommitment = await this.generateIdCommitment(input.secretKey);
    const { nullifier, signalY } = await this.generateRLNSignal(
      input.secretKey,
      input.ticketIndex,
      input.signalX,
    );

    // Generate mock proof (hex string)
    const proofData = {
      pi_a: [
        ethers.hexlify(ethers.randomBytes(32)),
        ethers.hexlify(ethers.randomBytes(32)),
      ],
      pi_b: [
        [
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
        ],
        [
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
        ],
      ],
      pi_c: [
        ethers.hexlify(ethers.randomBytes(32)),
        ethers.hexlify(ethers.randomBytes(32)),
      ],
      protocol: 'groth16',
    };

    const proof = JSON.stringify(proofData);

    return {
      proof,
      publicInputs: {
        merkleRoot: input.merkleRoot,
        maxCost: input.maxCost,
        initialDeposit: input.initialDeposit,
        signalX: '0x' + input.signalX.toString(16).padStart(64, '0'),
        nullifier: '0x' + nullifier.toString(16).padStart(64, '0'),
        signalY: '0x' + signalY.toString(16).padStart(64, '0'),
        idCommitment: '0x' + idCommitment.toString(16).padStart(64, '0'),
      },
    };
  }

  /**
   * Verify mock proof (basic validation)
   */
  verifyMockProof(
    proof: string,
    publicInputs: {
      merkleRoot: string;
      maxCost: string;
      initialDeposit: string;
      signalX: string;
      nullifier: string;
      signalY: string;
      idCommitment: string;
    },
  ): boolean {
    try {
      // Parse proof
      const proofData = JSON.parse(proof);

      // Basic validation
      if (proofData.protocol !== 'groth16') {
        return false;
      }

      // Validate structure
      if (
        !proofData.pi_a ||
        !proofData.pi_b ||
        !proofData.pi_c ||
        proofData.pi_a.length !== 2 ||
        proofData.pi_b.length !== 2 ||
        proofData.pi_c.length !== 2
      ) {
        return false;
      }

      // Validate public inputs are hex strings
      const requiredInputs = [
        'merkleRoot',
        'maxCost',
        'initialDeposit',
        'signalX',
        'nullifier',
        'signalY',
        'idCommitment',
      ];

      for (const input of requiredInputs) {
        const key = input as keyof typeof publicInputs;
        if (!publicInputs[key]) {
          return false;
        }
      }

      // In production, this would verify the actual proof using snarkjs
      // For now, we just validate the structure
      this.logger.debug('Mock proof validated successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to verify mock proof', error);
      return false;
    }
  }

  /**
   * Generate withdrawal proof using Groth16
   * @param params Withdrawal parameters
   * @returns Proof formatted for contract submission
   */
  async generateWithdrawalProof(params: {
    secretKey: bigint;
    ticketIndex: bigint;
    signalX: bigint;
  }): Promise<{
    proof: number[];
    publicSignals: number[];
  }> {
    await this.initialize();

    const snarkjs = require('snarkjs');
    const path = require('path');
    const fs = require('fs');

    // Calculate expected values
    const idCommitment = await this.generateIdCommitment(params.secretKey);
    // Generate RLN signal (not used in circuit input, but validates parameters)
    await this.generateRLNSignal(
      params.secretKey,
      params.ticketIndex,
      params.signalX,
    );

    // Prepare circuit inputs
    const inputs = {
      secretKey: params.secretKey.toString(),
      ticketIndex: params.ticketIndex.toString(),
      signalX: params.signalX.toString(),
      idCommitmentExpected: idCommitment.toString(),
    };

    const wasmPath = path.join(
      process.cwd(),
      'circuits/build/api_credit_proof_test_js/api_credit_proof_test.wasm',
    );
    const zkeyPath = path.join(
      process.cwd(),
      'circuits/build/api_credit_proof_test.zkey',
    );

    // Check if files exist
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found: ${wasmPath}`);
    }
    if (!fs.existsSync(zkeyPath)) {
      throw new Error(`zkey file not found: ${zkeyPath}`);
    }

    this.logger.debug('Generating withdrawal proof with inputs', {
      idCommitment: idCommitment.toString(),
      signalX: params.signalX.toString(),
    });

    // Generate proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      wasmPath,
      zkeyPath,
    );

    // Format proof for contract: [pA[0], pA[1], pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC[0], pC[1]]
    const formattedProof = [
      proof.pi_a[0],
      proof.pi_a[1],
      proof.pi_b[0][1],
      proof.pi_b[0][0],
      proof.pi_b[1][1],
      proof.pi_b[1][0],
      proof.pi_c[0],
      proof.pi_c[1],
    ];

    this.logger.log('Withdrawal proof generated successfully');

    return {
      proof: formattedProof,
      publicSignals: publicSignals.map((s: string) => BigInt(s)),
    };
  }

  /**
   * Generate refund redemption proof using Groth16
   * @param params Refund parameters including EdDSA signature from server
   * @returns Proof formatted for contract submission
   */
  async generateRefundRedemptionProof(params: {
    secretKey: bigint;
    ticketIndex: bigint;
    signalX: bigint;
    refundValue: bigint;
    refundTimestamp: number;
    refundSignature: {
      R8x: string;
      R8y: string;
      S: string;
    };
    serverPublicKey: {
      x: string;
      y: string;
    };
    recipient: string; // Ethereum address - required for front-running protection fix
  }): Promise<{
    proof: number[];
    publicSignals: bigint[];
  }> {
    await this.initialize();

    const snarkjs = require('snarkjs');
    const path = require('path');
    const fs = require('fs');

    // Calculate expected values
    const idCommitment = await this.generateIdCommitment(params.secretKey);
    // Generate RLN signal (validates parameters and calculates nullifier for logging)
    const { nullifier } = await this.generateRLNSignal(
      params.secretKey,
      params.ticketIndex,
      params.signalX,
    );

    // Prepare circuit inputs for refund_redemption.circom
    const inputs = {
      secretKey: params.secretKey.toString(),
      ticketIndex: params.ticketIndex.toString(),
      refundValue: params.refundValue.toString(),
      refundTimestamp: params.refundTimestamp.toString(),
      refundSignatureR8x: BigInt(params.refundSignature.R8x).toString(),
      refundSignatureR8y: BigInt(params.refundSignature.R8y).toString(),
      refundSignatureS: BigInt(params.refundSignature.S).toString(),
      signalX: params.signalX.toString(),
      refundValueClaimed: params.refundValue.toString(),
      serverPublicKeyX: BigInt(params.serverPublicKey.x).toString(),
      serverPublicKeyY: BigInt(params.serverPublicKey.y).toString(),
      recipient: BigInt(params.recipient).toString(), // bind recipient to proof
    };

    const wasmPath = path.join(
      process.cwd(),
      'circuits/build/refund_redemption_js/refund_redemption.wasm',
    );
    const zkeyPath = path.join(
      process.cwd(),
      'circuits/build/refund_redemption.zkey',
    );

    // Check if files exist
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found: ${wasmPath}`);
    }
    if (!fs.existsSync(zkeyPath)) {
      throw new Error(`zkey file not found: ${zkeyPath}`);
    }

    this.logger.debug('Generating refund redemption proof with inputs', {
      idCommitment: idCommitment.toString(),
      nullifier: nullifier.toString(),
      refundValue: params.refundValue.toString(),
    });

    // Generate proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      wasmPath,
      zkeyPath,
    );

    // Format proof for contract
    const formattedProof = [
      proof.pi_a[0],
      proof.pi_a[1],
      proof.pi_b[0][1],
      proof.pi_b[0][0],
      proof.pi_b[1][1],
      proof.pi_b[1][0],
      proof.pi_c[0],
      proof.pi_c[1],
    ];

    this.logger.log('Refund redemption proof generated successfully');

    return {
      proof: formattedProof,
      publicSignals: publicSignals.map((s: string) => BigInt(s)),
    };
  }

  /**
   * Generate double-spend slashing proof using Groth16
   * @param params Slashing parameters including two signals
   * @returns Proof formatted for contract submission
   */
  async generateDoubleSpendProof(params: {
    secretKey: bigint;
    ticketIndex: bigint;
    signal1: { x: bigint; y: bigint };
    signal2: { x: bigint; y: bigint };
  }): Promise<{
    proof: number[];
    publicSignals: number[];
  }> {
    await this.initialize();

    const snarkjs = require('snarkjs');
    const path = require('path');
    const fs = require('fs');

    // Verify the secret key can be recovered from the two signals
    const recoveredKey = await this.recoverSecretKey(
      params.signal1,
      params.signal2,
    );
    if (recoveredKey !== params.secretKey) {
      throw new Error('Secret key does not match recovered key from signals');
    }

    // Calculate expected values
    const idCommitment = await this.generateIdCommitment(params.secretKey);
    const { nullifier } = await this.generateRLNSignal(
      params.secretKey,
      params.ticketIndex,
      params.signal1.x,
    );

    // For slashing proof, we use one of the signals as the proof
    // In production, this would be a dedicated slashing circuit
    const inputs = {
      secretKey: params.secretKey.toString(),
      ticketIndex: params.ticketIndex.toString(),
      signalX: params.signal1.x.toString(),
      idCommitmentExpected: idCommitment.toString(),
    };

    const wasmPath = path.join(
      process.cwd(),
      'circuits/build/api_credit_proof_test_js/api_credit_proof_test.wasm',
    );
    const zkeyPath = path.join(
      process.cwd(),
      'circuits/build/api_credit_proof_test.zkey',
    );

    // Check if files exist
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found: ${wasmPath}`);
    }
    if (!fs.existsSync(zkeyPath)) {
      throw new Error(`zkey file not found: ${zkeyPath}`);
    }

    this.logger.debug('Generating slashing proof with inputs', {
      secretKey: params.secretKey.toString(),
      nullifier: nullifier.toString(),
    });

    // Generate proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      wasmPath,
      zkeyPath,
    );

    // Format proof for contract
    const formattedProof = [
      proof.pi_a[0],
      proof.pi_a[1],
      proof.pi_b[0][1],
      proof.pi_b[0][0],
      proof.pi_b[1][1],
      proof.pi_b[1][0],
      proof.pi_c[0],
      proof.pi_c[1],
    ];

    this.logger.log('Slashing proof generated successfully');

    return {
      proof: formattedProof,
      publicSignals: publicSignals.map((s: string) => BigInt(s)),
    };
  }
}
