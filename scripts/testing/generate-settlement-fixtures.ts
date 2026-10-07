#!/usr/bin/env ts-node
/**
 * Writes contracts/test/fixtures/settlement.json: real settlement proofs for
 * the Foundry tests, against the pinned circuits-v2 keys.
 *
 * The tests deploy LongjingCredits at FIXTURE_CONTRACT on chain 31337 with
 * the dev server key, so each proof's x = Poseidon(Poseidon(recipient,
 * chainId), contract) matches what the contract computes.
 *
 * Usage:
 *   pnpm exec ts-node -T scripts/testing/generate-settlement-fixtures.ts
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { FIELD_MODULUS } from '../../src/longjing/accumulator';
import {
  buildNoteFixture,
  Held,
  NoteFixture,
} from '../../src/longjing/note.fixture';

// snarkjs ships no type declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snarkjs = require('snarkjs') as {
  groth16: {
    fullProve(
      input: Record<string, string>,
      wasm: string,
      zkey: string,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    exportSolidityCallData(
      proof: unknown,
      publicSignals: string[],
    ): Promise<string>;
  };
};

const ROOT = join(__dirname, '../..');
const BUILD = join(ROOT, 'circuits/build');
const OUT = join(ROOT, 'contracts/test/fixtures/settlement.json');

const FIXTURE_CONTRACT = 0xcafen;
const CHAIN_ID = 31337n;
const C_MAX = 10n ** 15n; // 0.001 ether
const DEPOSIT = 10n ** 16n; // 0.01 ether
const RECIPIENT = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n;
const RERANDOMIZER = 987654321n;

interface Scenario {
  secretKey: bigint;
  held: Held;
  claimedIndex: bigint;
  // A request signal at the claimed index, when the exit understates usage
  requestSignal?: { x: bigint; y: bigint };
}

async function prove(fx: NoteFixture, scenario: Scenario) {
  const { secretKey, held, claimedIndex } = scenario;
  const note = fx.note(secretKey, DEPOSIT);
  const signalX = fx.poseidon([
    fx.poseidon([RECIPIENT, CHAIN_ID]),
    FIXTURE_CONTRACT,
  ]);
  const input = Object.fromEntries(
    Object.entries({
      secretKey,
      ...fx.accumulatorInputs(held),
      claimedIndex,
      commitment: note.commitment,
      deposit: DEPOSIT,
      maxCost: C_MAX,
      serverPublicKeyX: fx.serverKey[0],
      serverPublicKeyY: fx.serverKey[1],
      recipient: RECIPIENT,
      signalX,
    }).map(([k, v]) => [k, v.toString()]),
  );
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(BUILD, 'settlement_js/settlement.wasm'),
    join(BUILD, 'settlement.zkey'),
  );
  const [a, b, c] = JSON.parse(
    `[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`,
  ) as [string[], string[][], string[]];

  return {
    secretKey: secretKey.toString(),
    commitment: note.commitment.toString(),
    proof: [...a, ...b.flat(), ...c].map((v) => BigInt(v).toString()),
    nullifier: publicSignals[0],
    signalY: publicSignals[1],
    payout: publicSignals[2],
    signalX: signalX.toString(),
    ...(scenario.requestSignal && {
      requestSignalX: scenario.requestSignal.x.toString(),
      requestSignalY: scenario.requestSignal.y.toString(),
    }),
  };
}

async function main() {
  const fx = await buildNoteFixture();
  const genesisOf = (secretKey: bigint) => fx.note(secretKey, DEPOSIT).genesis;

  // Two requests refunded 0.0004 and 0.0006 ether: m = 2, R = 0.001 ether
  const honestKey = 111n;
  const honest = fx.respond(
    fx.respond(genesisOf(honestKey), RERANDOMIZER, 4n * 10n ** 14n),
    RERANDOMIZER,
    6n * 10n ** 14n,
  );

  // The note made requests at indices 0 and 1, but exits from the accumulator
  // after the first one, claiming n = 1: index 1 was used with x = 777
  const understatedKey = 333n;
  const understated = fx.respond(
    genesisOf(understatedKey),
    RERANDOMIZER,
    5n * 10n ** 14n,
  );
  const a1 = fx.poseidon([understatedKey, 1n]);

  const fixtures = {
    contract: `0x${FIXTURE_CONTRACT.toString(16).padStart(40, '0')}`,
    chainId: CHAIN_ID.toString(),
    cMax: C_MAX.toString(),
    deposit: DEPOSIT.toString(),
    recipient: `0x${RECIPIENT.toString(16).padStart(40, '0')}`,
    serverPublicKeyX: fx.serverKey[0].toString(),
    serverPublicKeyY: fx.serverKey[1].toString(),
    honest: await prove(fx, {
      secretKey: honestKey,
      held: honest,
      claimedIndex: 2n,
    }),
    genesis: await prove(fx, {
      secretKey: 222n,
      held: genesisOf(222n),
      claimedIndex: 0n,
    }),
    understated: await prove(fx, {
      secretKey: understatedKey,
      held: understated,
      claimedIndex: 1n,
      requestSignal: {
        x: 777n,
        y: (understatedKey + a1 * 777n) % FIELD_MODULUS,
      },
    }),
  };

  writeFileSync(OUT, JSON.stringify(fixtures, null, 2) + '\n');
  console.log(`✓ ${OUT}`);
  // snarkjs keeps worker threads alive
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
