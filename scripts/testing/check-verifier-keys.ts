#!/usr/bin/env ts-node
/**
 * Checks that each circuit's pinned verification key matches its zkey, and
 * that each Solidity verifier embeds that same key, including its IC count.
 *
 * Usage:
 *   pnpm check:verifiers
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const BUILD = join(ROOT, 'circuits/build');

interface Circuit {
  zkey: string;
  vkey: string;
  verifier?: string;
}

const CIRCUITS: Record<string, Circuit> = {
  api_request: {
    zkey: 'api_request.zkey',
    vkey: 'api_request_verification_key.json',
  },
  api_request_local: {
    zkey: 'api_request_local.zkey',
    vkey: 'api_request_local_verification_key.json',
  },
  refund_redemption: {
    zkey: 'refund_redemption.zkey',
    vkey: 'refund_redemption_verification_key.json',
    verifier: 'RefundRedemptionVerifier.sol',
  },
  withdrawal: {
    zkey: 'withdrawal.zkey',
    vkey: 'withdrawal_verification_key.json',
    verifier: 'WithdrawalVerifier.sol',
  },
  double_spend_slashing: {
    zkey: 'double_spend_slashing_final.zkey',
    vkey: 'double_spend_slashing_verification_key.json',
    verifier: 'DoubleSpendSlashingVerifier.sol',
  },
};

type G1 = string[];
type G2 = string[][];
interface VerificationKey {
  nPublic: number;
  vk_alpha_1: G1;
  vk_beta_2: G2;
  vk_gamma_2: G2;
  vk_delta_2: G2;
  IC: G1[];
}

// The constants snarkjs writes into a Solidity verifier, G2 limbs swapped
function expectedConstants(vk: VerificationKey): Map<string, string> {
  const c = new Map<string, string>([
    ['alphax', vk.vk_alpha_1[0]],
    ['alphay', vk.vk_alpha_1[1]],
  ]);
  for (const [name, p] of [
    ['beta', vk.vk_beta_2],
    ['gamma', vk.vk_gamma_2],
    ['delta', vk.vk_delta_2],
  ] as const) {
    c.set(`${name}x1`, p[0][1]);
    c.set(`${name}x2`, p[0][0]);
    c.set(`${name}y1`, p[1][1]);
    c.set(`${name}y2`, p[1][0]);
  }
  vk.IC.forEach((p, i) => {
    c.set(`IC${i}x`, p[0]);
    c.set(`IC${i}y`, p[1]);
  });
  return c;
}

function solidityConstants(source: string): Map<string, string> {
  const c = new Map<string, string>();
  for (const [, name, value] of source.matchAll(
    /uint256 constant (\w+) = (\d+);/g,
  )) {
    c.set(name, value);
  }
  return c;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const snarkjs = require('snarkjs') as {
  zKey: { exportVerificationKey(zkey: string): Promise<VerificationKey> };
};

const canonical = (vk: VerificationKey) =>
  JSON.stringify({ ...vk, vk_alphabeta_12: undefined });

async function check(name: string, circuit: Circuit): Promise<string[]> {
  const errors: string[] = [];
  const pinned = JSON.parse(
    readFileSync(join(BUILD, circuit.vkey), 'utf8'),
  ) as VerificationKey;
  const fromZkey = await snarkjs.zKey.exportVerificationKey(
    join(BUILD, circuit.zkey),
  );

  if (pinned.nPublic !== fromZkey.nPublic) {
    errors.push(
      `${circuit.vkey}: nPublic ${pinned.nPublic}, zkey has ${fromZkey.nPublic}`,
    );
  } else if (canonical(pinned) !== canonical(fromZkey)) {
    errors.push(`${circuit.vkey}: differs from ${circuit.zkey}`);
  }

  if (circuit.verifier) {
    const sol = solidityConstants(
      readFileSync(join(ROOT, 'contracts/src', circuit.verifier), 'utf8'),
    );
    const icCount = [...sol.keys()].filter((k) => /^IC\d+x$/.test(k)).length;
    if (icCount !== fromZkey.nPublic + 1) {
      errors.push(
        `${circuit.verifier}: ${icCount} IC points, zkey needs ${fromZkey.nPublic + 1}`,
      );
    }
    for (const [key, value] of expectedConstants(fromZkey)) {
      if (sol.get(key) !== value) {
        errors.push(`${circuit.verifier}: ${key} differs from ${circuit.zkey}`);
      }
    }
  }

  console.log(`${errors.length ? '✗' : '✓'} ${name}`);
  return errors;
}

async function main() {
  const errors: string[] = [];
  for (const [name, circuit] of Object.entries(CIRCUITS)) {
    errors.push(...(await check(name, circuit)));
  }
  for (const e of errors) console.error(`  ${e}`);
  // snarkjs keeps worker threads alive
  process.exit(errors.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
