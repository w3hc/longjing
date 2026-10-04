#!/usr/bin/env ts-node
/**
 * Client-side utility for generating ZK proofs for API access
 *
 * Usage:
 *   ts-node scripts/generate-proof.ts <secretKey> <ticketIndex>
 *
 * Generates REAL Groth16 cryptographic proofs using snarkjs.
 * Uses api_credit_proof_test.circom for faster testing.
 */

const circomlibjs = require('circomlibjs');
const snarkjs = require('snarkjs');
import { ethers } from 'ethers';
import * as path from 'path';
import * as fs from 'fs';

interface ProofInput {
  secretKey: bigint;
  ticketIndex: bigint;
  signalX: bigint;
  idCommitmentExpected: bigint;
}

async function generateIdCommitment(poseidon: any, secretKey: bigint): Promise<bigint> {
  const F = poseidon.F;
  return F.toObject(poseidon([secretKey]));
}

async function generateRealProof(input: ProofInput) {
  console.log('\n🔐 Generating Real ZK Proof with Groth16...\n');

  // Circuit artifacts
  const wasmPath = path.join(process.cwd(), 'circuits/build/api_credit_proof_test_js/api_credit_proof_test.wasm');
  const zkeyPath = path.join(process.cwd(), 'circuits/build/api_credit_proof_test.zkey');

  // Verify artifacts exist
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found: ${wasmPath}`);
  }
  if (!fs.existsSync(zkeyPath)) {
    throw new Error(`zkey file not found: ${zkeyPath}`);
  }

  console.log('Private Inputs:');
  console.log(`  Secret Key: ${input.secretKey}`);
  console.log(`  Ticket Index: ${input.ticketIndex}`);
  console.log();

  console.log('Public Inputs:');
  console.log(`  Signal X: ${input.signalX}`);
  console.log(`  ID Commitment Expected: ${input.idCommitmentExpected}`);
  console.log();

  // Prepare circuit inputs
  const circuitInput = {
    secretKey: input.secretKey.toString(),
    ticketIndex: input.ticketIndex.toString(),
    signalX: input.signalX.toString(),
    idCommitmentExpected: input.idCommitmentExpected.toString(),
  };

  console.log('⏳ Generating proof (this may take a few seconds)...\n');

  // Generate proof using snarkjs
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath,
  );

  // Parse public outputs
  // Public signal order from circom: [outputs first, then inputs]
  // [nullifier, signalY, idCommitment, signalX, idCommitmentExpected]
  const nullifier = publicSignals[0];
  const signalY = publicSignals[1];
  const idCommitment = publicSignals[2];

  console.log('Public Outputs (from proof):');
  console.log(`  Nullifier: 0x${BigInt(nullifier).toString(16)}`);
  console.log(`  Signal Y: ${signalY}`);
  console.log(`  ID Commitment: 0x${BigInt(idCommitment).toString(16)}`);
  console.log();

  // Format proof for API
  // Note: Groth16 proofs use projective coordinates (x, y, z)
  // snarkjs returns affine coordinates [x, y], so we add z=1
  const proofData = {
    pi_a: [proof.pi_a[0], proof.pi_a[1], '1'],
    pi_b: [
      [proof.pi_b[0][1], proof.pi_b[0][0], '1'], // snarkjs returns in reverse order
      [proof.pi_b[1][1], proof.pi_b[1][0], '1'],
    ],
    pi_c: [proof.pi_c[0], proof.pi_c[1], '1'],
    protocol: 'groth16',
  };

  const proofString = JSON.stringify(proofData, null, 2);

  // For backward compatibility with test scripts, include additional fields
  // These are used by the API but not part of the circuit
  const publicInputs = {
    nullifier: '0x' + BigInt(nullifier).toString(16).padStart(64, '0'),
    signalX: '0x' + input.signalX.toString(16).padStart(64, '0'),
    signalY: '0x' + BigInt(signalY).toString(16).padStart(64, '0'),
    idCommitment: '0x' + BigInt(idCommitment).toString(16).padStart(64, '0'),
    // These would normally come from the contract state
    merkleRoot: ethers.ZeroHash,
    maxCost: ethers.parseEther('0.001').toString(),
    initialDeposit: ethers.parseEther('0.1').toString(),
  };

  console.log('✅ Real cryptographic proof generated successfully!\n');

  return { proof: proofString, publicInputs };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: ts-node scripts/generate-proof.ts <secretKey> <ticketIndex>');
    console.error('');
    console.error('Example:');
    console.error('  ts-node scripts/generate-proof.ts 12345 0');
    process.exit(1);
  }

  const secretKey = BigInt(args[0]);
  const ticketIndex = BigInt(args[1]);

  // Initialize Poseidon to compute expected ID commitment
  const poseidon = await circomlibjs.buildPoseidon();
  const idCommitmentExpected = await generateIdCommitment(poseidon, secretKey);

  // Use random signalX for this request
  // Note: Large random values can cause slow witness generation in some circuits.
  // For testing, we use a hash of timestamp to get reasonable-sized values.
  const timestamp = Date.now();
  const signalX = BigInt(ethers.keccak256(ethers.toBeHex(timestamp, 32))) % BigInt('1000000000000');

  const input: ProofInput = {
    secretKey,
    ticketIndex,
    signalX,
    idCommitmentExpected,
  };

  const { proof, publicInputs } = await generateRealProof(input);

  console.log('Proof (JSON):');
  console.log(proof);
  console.log();

  console.log('Public Inputs (JSON):');
  console.log(JSON.stringify(publicInputs, null, 2));
  console.log();

  console.log('📋 To use this proof with the API, send a POST request to /longjing/request');

  // Explicitly exit to prevent hanging (snarkjs/circomlibjs may keep event loop alive)
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
