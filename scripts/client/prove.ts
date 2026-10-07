#!/usr/bin/env ts-node
/**
 * Generates request and refund redemption proofs on the client, so the secret
 * key never leaves the user's machine, and double-spend slashing proofs, which
 * anyone holding the two signals can make. Withdrawal proving is tracked in
 * #119.
 *
 * Usage:
 *   pnpm prove request <input.json>
 *   pnpm prove refund <input.json>
 *   pnpm prove slashing <input.json>
 *
 * The request input file holds:
 *   {
 *     "secretKey": "0x...",
 *     "ticketIndex": "0x00",
 *     "payload": "<the request payload>",
 *     "maxCost": "<wei, at least the server's worst-case cost>",
 *     "rpcUrl": "http://127.0.0.1:8545",
 *     "contract": "0x<LongjingCredits address>",
 *     "serverPublicKey": { "x": "0x...", "y": "0x..." },
 *     "circuit": "api_request" (default) or "api_request_local"
 *   }
 *
 * It reads the Merkle path, the root and the deposit from the contract, and
 * prints the body for POST /longjing/request. It counts no refund tickets
 * toward the balance yet: the deposit alone must cover (i + 1) · maxCost.
 *
 * The refund input file holds:
 *   {
 *     "secretKey": "0x...",
 *     "ticketIndex": "0x01",
 *     "payload": "<the request payload the refund ticket was issued for>",
 *     "recipient": "0x<ethereum address>",
 *     "refundTicket": { ...the refundTicket returned by POST /longjing/request },
 *     "serverPublicKey": { "x": "0x...", "y": "0x..." }
 *   }
 *
 * The slashing input file holds two signals with the same nullifier:
 *   {
 *     "ticketIndex": "0x00",
 *     "signal1": { "x": "0x...", "y": "0x..." },
 *     "signal2": { "x": "0x...", "y": "0x..." }
 *   }
 *
 * It recovers the secret key from the two signals and prints the arguments
 * for slashDoubleSpend.
 *
 * serverPublicKey is the refundSigner key from GET /attestation/manifest.
 * The RLN signal x is bound to the payload: x = SHA-256(payload) mod p.
 */

import * as fs from 'fs';
import { ethers } from 'ethers';
import { Logger } from '@nestjs/common';
import { ProofGenService } from '../../src/longjing/proof-gen.service';
import { payloadToSignalX } from '../../src/longjing/utils/payload-signal.util';

// snarkjs ships no type declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snarkjs = require('snarkjs');

interface RequestInput {
  secretKey: string;
  ticketIndex: string;
  payload: string;
  maxCost: string;
  rpcUrl: string;
  contract: string;
  serverPublicKey: { x: string; y: string };
  circuit?: RequestCircuit;
}

// Refund slots per circuit, the second argument of ApiRequestProof
const REFUND_SLOTS = { api_request: 10, api_request_local: 2 } as const;
type RequestCircuit = keyof typeof REFUND_SLOTS;

const CONTRACT_ABI = [
  'function merkleRoot() view returns (bytes32)',
  'function getAllIdentityCommitments() view returns (bytes32[])',
  'function getMerkleProof(uint256 _leafIndex) view returns (bytes32[20] pathElements, uint8[20] pathIndices)',
  'function getDeposit(bytes32 _idCommitment) view returns (tuple(bytes32 idCommitment, uint256 rlnStake, uint256 policyStake, uint256 timestamp, bool active))',
];

interface RefundInput {
  secretKey: string;
  ticketIndex: string;
  payload: string;
  recipient: string;
  refundTicket: {
    nullifier: string;
    value: string;
    timestamp: number;
    signature: { R8x: string; R8y: string; S: string };
  };
  serverPublicKey: { x: string; y: string };
}

interface SlashingInput {
  ticketIndex: string;
  signal1: { x: string; y: string };
  signal2: { x: string; y: string };
}

const toHex = (v: bigint | number | string) => '0x' + BigInt(v).toString(16);

function usage(): never {
  console.error('Usage: pnpm prove <request|refund|slashing> <input.json>');
  process.exit(1);
}

async function proveRequest(prover: ProofGenService, args: string[]) {
  if (args.length < 1) usage();
  const input = JSON.parse(fs.readFileSync(args[0], 'utf8')) as RequestInput;
  const circuit = input.circuit ?? 'api_request';
  if (!(circuit in REFUND_SLOTS)) {
    throw new Error(`Unknown circuit: ${circuit}`);
  }
  const secretKey = BigInt(input.secretKey);
  const idCommitment = ethers.toBeHex(
    await prover.generateIdCommitment(secretKey),
    32,
  );

  const contract = new ethers.Contract(
    input.contract,
    CONTRACT_ABI,
    new ethers.JsonRpcProvider(input.rpcUrl),
  );
  const [commitments, root, deposit] = (await Promise.all([
    contract.getAllIdentityCommitments(),
    contract.merkleRoot(),
    contract.getDeposit(idCommitment),
  ])) as [
    string[],
    string,
    { rlnStake: bigint; policyStake: bigint; active: boolean },
  ];
  const leafIndex = commitments.indexOf(idCommitment);
  if (leafIndex < 0 || !deposit.active) {
    throw new Error(`No active deposit for this secret key (${idCommitment})`);
  }
  const [pathElements, pathIndices] = (await contract.getMerkleProof(
    leafIndex,
  )) as [string[], bigint[]];
  const initialDeposit = deposit.rlnStake + deposit.policyStake;

  const slots = REFUND_SLOTS[circuit];
  const zeros = Array<string>(slots).fill('0');
  const dec = (v: bigint | number | string) => BigInt(v).toString();
  const signalX = payloadToSignalX(input.payload);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      secretKey: dec(secretKey),
      ticketIndex: dec(input.ticketIndex),
      initialDeposit: dec(initialDeposit),
      merklePathElements: pathElements.map(dec),
      merklePathIndices: pathIndices.map(dec),
      numRefunds: '0',
      refundValues: zeros,
      refundTimestamps: zeros,
      refundSignaturesR8x: zeros,
      refundSignaturesR8y: zeros,
      refundSignaturesS: zeros,
      refundNullifiers: zeros,
      serverPublicKeyX: dec(input.serverPublicKey.x),
      serverPublicKeyY: dec(input.serverPublicKey.y),
      merkleRootExpected: dec(root),
      maxCost: dec(input.maxCost),
      signalX: dec(signalX),
    },
    `circuits/build/${circuit}_js/${circuit}.wasm`,
    `circuits/build/${circuit}.zkey`,
  );
  // [nullifier, signalY, idCommitment, merkleRoot, merkleRootExpected, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]
  const [nullifier, signalY] = publicSignals;

  // Wire format: projective coordinates, pi_b pairs swapped
  const wire = {
    pi_a: [proof.pi_a[0], proof.pi_a[1], '1'],
    pi_b: [
      [proof.pi_b[0][1], proof.pi_b[0][0], '1'],
      [proof.pi_b[1][1], proof.pi_b[1][0], '1'],
    ],
    pi_c: [proof.pi_c[0], proof.pi_c[1], '1'],
    protocol: 'groth16',
  };

  return {
    payload: input.payload,
    nullifier: toHex(nullifier),
    signal: { x: toHex(signalX), y: toHex(signalY) },
    proof: JSON.stringify(wire),
    maxCost: input.maxCost,
    merkleRoot: root,
    initialDeposit: initialDeposit.toString(),
    ticketIndex: toHex(input.ticketIndex),
    idCommitment,
    idCommitmentExpected: idCommitment,
  };
}

async function proveRefund(prover: ProofGenService, args: string[]) {
  if (args.length < 1) usage();
  const input = JSON.parse(fs.readFileSync(args[0], 'utf8')) as RefundInput;
  const secretKey = BigInt(input.secretKey);
  const ticketIndex = BigInt(input.ticketIndex);
  const signalX = payloadToSignalX(input.payload);

  const idCommitment = await prover.generateIdCommitment(secretKey);
  const { nullifier } = await prover.generateRLNSignal(
    secretKey,
    ticketIndex,
    signalX,
  );
  if (nullifier !== BigInt(input.refundTicket.nullifier)) {
    throw new Error(
      'The refund ticket was not issued for this secret key, ticket index and payload',
    );
  }

  const { proof, publicSignals } = await prover.generateRefundRedemptionProof({
    secretKey,
    ticketIndex,
    signalX,
    refundValue: BigInt(input.refundTicket.value),
    refundTimestamp: input.refundTicket.timestamp,
    refundSignature: input.refundTicket.signature,
    serverPublicKey: input.serverPublicKey,
    recipient: input.recipient,
  });

  return {
    proof: proof.map(toHex),
    publicSignals: publicSignals.map(toHex),
    idCommitment: toHex(idCommitment),
    nullifier: toHex(nullifier),
    value: input.refundTicket.value,
    recipient: input.recipient,
  };
}

async function proveSlashing(prover: ProofGenService, args: string[]) {
  if (args.length < 1) usage();
  const input = JSON.parse(fs.readFileSync(args[0], 'utf8')) as SlashingInput;
  const point = (s: { x: string; y: string }) => ({
    x: BigInt(s.x),
    y: BigInt(s.y),
  });
  const signal1 = point(input.signal1);
  const signal2 = point(input.signal2);
  const secretKey = await prover.recoverSecretKey(signal1, signal2);

  const { proof, publicSignals } = await prover.generateDoubleSpendProof({
    secretKey,
    ticketIndex: BigInt(input.ticketIndex),
    signal1,
    signal2,
  });
  // [idCommitment, nullifier, secretKeyClaimed, nullifierExpected]
  const [idCommitment, nullifier] = publicSignals;

  return {
    secretKey: ethers.toBeHex(secretKey, 32),
    nullifier: ethers.toBeHex(nullifier, 32),
    idCommitment: ethers.toBeHex(idCommitment, 32),
    proof: proof.map(toHex),
    publicSignals: publicSignals.map(toHex),
  };
}

async function main() {
  Logger.overrideLogger(['error']);
  const [kind, ...args] = process.argv.slice(2);
  const prover = new ProofGenService();

  const provers = {
    request: proveRequest,
    refund: proveRefund,
    slashing: proveSlashing,
  };
  if (!(kind in provers)) usage();
  const result = await provers[kind as keyof typeof provers](prover, args);

  console.log(JSON.stringify(result, null, 2));
  // snarkjs keeps worker threads alive
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
