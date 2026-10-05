#!/usr/bin/env ts-node

/**
 * Builds the timelock batch that allows a Longjing release on its DstackApp:
 * it adds the release's compose hash and removes every other allowed one.
 *
 * Usage:
 *   pnpm governance:propose-release <app-compose.json> --app <DstackApp>
 *     [--rpc <url>] [--from-block <n>] [--out <dir>]
 *
 * It writes two Safe Transaction Builder files: schedule it now, execute it
 * once the delay has passed. See docs/GOVERNANCE.md#releases.
 */

import * as fs from 'fs';
import * as path from 'path';
import { JsonRpcProvider } from 'ethers';
import { readAppGovernance } from '../../src/attestation/app-governance';
import {
  buildReleaseBatch,
  checkAppCompose,
  composeHashOf,
  safeTransactionBuilderFile,
} from '../../src/governance/release-batch';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
}

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function main() {
  const app = flag('--app');
  const rpc =
    flag('--rpc') ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
  const fromBlock = flag('--from-block');
  const out = flag('--out') ?? '.';
  const [appComposePath] = args;
  if (!appComposePath || !app) {
    fail(
      'Usage: pnpm governance:propose-release <app-compose.json> --app <DstackApp> [--rpc <url>] [--from-block <n>] [--out <dir>]',
    );
  }

  const appCompose = fs.readFileSync(appComposePath);
  const dockerCompose = fs.readFileSync(
    path.join(__dirname, '../../docker-compose.yml'),
    'utf-8',
  );
  const failures = checkAppCompose(appCompose, dockerCompose);
  if (failures.length > 0) {
    failures.forEach((failure) => console.error(`❌ ${failure}`));
    process.exit(1);
  }
  const composeHash = composeHashOf(appCompose);
  console.log(`Compose hash: ${composeHash}`);

  const provider = new JsonRpcProvider(rpc);
  const governance = await readAppGovernance(provider, app, {
    fromBlock: fromBlock ? Number(fromBlock) : undefined,
  });
  if (!governance.appOwner) {
    fail(
      `${app} is owned by ${governance.owner}, not a LongjingAppOwner: set up governance first (docs/GOVERNANCE.md#setup)`,
    );
  }
  const allowed = governance.composeHashes
    .filter((record) => record.allowed)
    .map((record) => record.composeHash);
  if (allowed.includes(composeHash)) {
    console.log('⚠️  This compose hash is already allowed');
  }

  const batch = buildReleaseBatch({
    appOwner: governance.appOwner.address,
    timelock: governance.appOwner.timelock,
    delay: governance.appOwner.minDelay,
    composeHash,
    allowed,
  });
  const { chainId } = await provider.getNetwork();
  const short = composeHash.slice(2, 10);
  const description = [
    `Allow compose hash ${composeHash}`,
    ...batch.retired.map((hash) => `remove ${hash}`),
  ].join(', ');

  fs.mkdirSync(out, { recursive: true });
  for (const [step, transaction] of [
    ['schedule', batch.schedule],
    ['execute', batch.execute],
  ] as const) {
    const file = path.join(out, `release-${short}-${step}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        safeTransactionBuilderFile(
          chainId,
          `Longjing release ${short}: ${step}`,
          description,
          transaction,
        ),
        null,
        2,
      ),
    );
    console.log(`Wrote ${file}`);
  }

  console.log(`\nTimelock operation: ${batch.operationId}`);
  console.log(`Adds:    ${composeHash}`);
  batch.retired.forEach((hash) => console.log(`Removes: ${hash}`));
  console.log(
    `\nImport the schedule file in the Safe Transaction Builder now, and the execute file after ${governance.appOwner.minDelay}s.`,
  );
}

main().catch((err: unknown) =>
  fail(err instanceof Error ? err.message : String(err)),
);
