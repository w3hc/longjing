#!/usr/bin/env ts-node
/**
 * Generates refund redemption proofs on the client, so the secret key never
 * leaves the user's machine. Withdrawal proving is tracked in #119.
 *
 * Usage:
 *   pnpm prove refund <input.json>
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
 * serverPublicKey is the refundSigner key from GET /attestation/manifest.
 * The RLN signal x is bound to the payload: x = SHA-256(payload) mod p.
 */

import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { ProofGenService } from '../../src/longjing/proof-gen.service';
import { payloadToSignalX } from '../../src/longjing/utils/payload-signal.util';

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

const toHex = (v: bigint | number | string) => '0x' + BigInt(v).toString(16);

function usage(): never {
  console.error('Usage: pnpm prove refund <input.json>');
  process.exit(1);
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

async function main() {
  Logger.overrideLogger(['error']);
  const [kind, ...args] = process.argv.slice(2);
  const prover = new ProofGenService();

  if (kind !== 'refund') usage();
  const result = await proveRefund(prover, args);

  console.log(JSON.stringify(result, null, 2));
  // snarkjs keeps worker threads alive
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
