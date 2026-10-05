import { createHash } from 'crypto';
import { AbiCoder, Interface, ZeroHash, keccak256 } from 'ethers';

const APP_OWNER = new Interface([
  'function execute(bytes data) returns (bytes)',
]);

const DSTACK_APP = new Interface([
  'function addComposeHash(bytes32 composeHash)',
  'function removeComposeHash(bytes32 composeHash)',
]);

const TIMELOCK = new Interface([
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)',
]);

export interface ReleaseBatch {
  composeHash: string;
  /** The compose hashes the batch removes */
  retired: string[];
  /** The TimelockController operation id, to follow it on chain */
  operationId: string;
  schedule: { to: string; data: string };
  execute: { to: string; data: string };
}

/**
 * The compose hash dstack measures into RTMR3 and checks against the
 * DstackApp: the SHA-256 of the app-compose.json bytes, as deployed.
 */
export function composeHashOf(appCompose: Buffer): string {
  return `0x${createHash('sha256').update(appCompose).digest('hex')}`;
}

/**
 * Checks that an app-compose.json deploys this repository's compose file,
 * with the image pinned by digest (docs/DOCKER.md#releases).
 * @returns The failed checks, empty when it does
 */
export function checkAppCompose(
  appCompose: Buffer,
  dockerCompose: string,
): string[] {
  let parsed: { docker_compose_file?: unknown };
  try {
    parsed = JSON.parse(appCompose.toString('utf-8')) as typeof parsed;
  } catch {
    return ['app-compose.json is not JSON'];
  }
  const failures: string[] = [];
  if (parsed.docker_compose_file !== dockerCompose) {
    failures.push(
      "app-compose.json's docker_compose_file is not this repository's docker-compose.yml",
    );
  }
  const images = [...dockerCompose.matchAll(/^\s*image:\s*(\S+)/gm)].map(
    (match) => match[1],
  );
  if (images.length === 0) {
    failures.push('docker-compose.yml has no image');
  }
  for (const image of images.filter(
    (image) => !/@sha256:[0-9a-f]{64}$/.test(image),
  )) {
    failures.push(`${image} is not pinned by digest`);
  }
  return failures;
}

/**
 * Builds the timelock batch that allows a release: it adds the new compose
 * hash and removes every other allowed one, so a single build can derive the
 * keys once it executes. The Safe schedules it, then executes it after the delay.
 * @param options.appOwner The LongjingAppOwner that owns the DstackApp
 * @param options.timelock The TimelockController behind it
 * @param options.delay The delay to schedule with, at least the timelock's minimum
 * @param options.composeHash The new release's compose hash
 * @param options.allowed The compose hashes allowed now
 */
export function buildReleaseBatch(options: {
  appOwner: string;
  timelock: string;
  delay: bigint;
  composeHash: string;
  allowed: string[];
}): ReleaseBatch {
  const composeHash = options.composeHash.toLowerCase();
  const retired = options.allowed
    .map((hash) => hash.toLowerCase())
    .filter((hash) => hash !== composeHash);

  const calls = [
    DSTACK_APP.encodeFunctionData('addComposeHash', [composeHash]),
    ...retired.map((hash) =>
      DSTACK_APP.encodeFunctionData('removeComposeHash', [hash]),
    ),
  ];
  const targets = calls.map(() => options.appOwner);
  const values = calls.map(() => 0n);
  const payloads = calls.map((call) =>
    APP_OWNER.encodeFunctionData('execute', [call]),
  );
  // The compose hash as salt makes each release a distinct operation
  const salt = composeHash;

  return {
    composeHash,
    retired,
    operationId: keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'],
        [targets, values, payloads, ZeroHash, salt],
      ),
    ),
    schedule: {
      to: options.timelock,
      data: TIMELOCK.encodeFunctionData('scheduleBatch', [
        targets,
        values,
        payloads,
        ZeroHash,
        salt,
        options.delay,
      ]),
    },
    execute: {
      to: options.timelock,
      data: TIMELOCK.encodeFunctionData('executeBatch', [
        targets,
        values,
        payloads,
        ZeroHash,
        salt,
      ]),
    },
  };
}

/**
 * A file for the Safe Transaction Builder app, which imports it as a batch.
 */
export function safeTransactionBuilderFile(
  chainId: bigint,
  name: string,
  description: string,
  transaction: { to: string; data: string },
) {
  return {
    version: '1.0',
    chainId: chainId.toString(),
    createdAt: Date.now(),
    meta: { name, description },
    transactions: [
      {
        to: transaction.to,
        value: '0',
        data: transaction.data,
        contractMethod: null,
        contractInputsValues: null,
      },
    ],
  };
}
