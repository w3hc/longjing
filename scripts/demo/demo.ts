#!/usr/bin/env ts-node
/**
 * Checks Longjing's goals against a deployment and prints one line per goal:
 * verified, not met (with its issue) or not checked yet. Exits non-zero only
 * when a goal expected to be verified is not.
 *
 * Usage:
 *   anvil        # in another terminal
 *   pnpm demo
 *
 * 1. Deploy LongjingCredits with NODE_ENV=development
 * 2. Start the server pointed at it
 * 3. Alice deposits with her secret
 * 4. She proves membership with that secret against the onchain root
 *    (pnpm prove request)
 * 5. POST /longjing/request, then replay it
 * 6. She proves the refund (pnpm prove refund), redeems it onchain, then
 *    tries again
 * 7. She sends a second request, and the demo compares what the two
 *    requests publish with each other and with her deposit
 * 8. It checks that no request body it sent contains her secret key
 *
 * The server answers with mock responses: ANTHROPIC_API_KEY is ignored.
 */

import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import type { INestApplication } from '@nestjs/common';
import { BN254_SCALAR_FIELD } from '../../src/longjing/utils/payload-signal.util';

// circomlibjs ships no type declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const circomlibjs = require('circomlibjs');

const run = promisify(execFile);

const RPC_URL = 'http://127.0.0.1:8545';
// Anvil account #1; #0 deploys
const ALICE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPOSIT = ethers.parseEther('0.2');
const MAX_COST = ethers.parseEther('0.05');
const PAYLOAD = 'What does 苟全性命於亂世，不求聞達於諸侯。mean?';
const PAYLOAD_2 = 'Who wrote 出師表?';
// The same for every request at a given time, so they identify no one
const SHARED_BY_DESIGN = new Set(['merkleRoot', 'maxCost']);
const ISSUES = 'https://github.com/w3hc/longjing/issues';

const ABI = [
  'function deposit(bytes32 _idCommitment) payable',
  'function merkleRoot() view returns (bytes32)',
  'function getAllIdentityCommitments() view returns (bytes32[])',
  'function serverPublicKey() view returns (bytes32 x, bytes32 y)',
  'function getDeposit(bytes32 _idCommitment) view returns (tuple(bytes32 idCommitment, uint256 rlnStake, uint256 policyStake, uint256 timestamp, bool active))',
  'function redeemRefund(bytes32 _idCommitment, bytes32 _nullifier, uint256 _refundValue, address _recipient, uint256[8] _proof, uint256[8] _publicSignals)',
  'error RefundAlreadyRedeemed()',
];

interface RefundTicket {
  nullifier: string;
  value: string;
  timestamp: number;
  signature: { R8x: string; R8y: string; S: string };
}

type Status = 'verified' | 'not met' | 'not checked yet';

interface Goal {
  label: string;
  expected: Status;
  issues?: number[];
  status?: Status;
  detail?: string;
}

const goal = (
  label: string,
  expected: Status,
  issues?: number[],
  detail?: string,
): Goal => ({ label, expected, issues, detail });

const goals = {
  deposit: goal('A deposit is recorded onchain', 'verified'),
  root: goal('A request proof is against the onchain root', 'verified'),
  nullifier: goal(
    'A nullifier is accepted once, a replay is rejected',
    'verified',
  ),
  refund: goal(
    'A refund is maxCost − actualCost, signed by the key registered onchain, redeemable once',
    'verified',
  ),
  requestToDeposit: goal(
    "A request can't be linked to the deposit",
    'not met',
    [134],
  ),
  requestToRequest: goal(
    "Two requests can't be linked to each other",
    'not met',
    [134],
  ),
  solvency: goal(
    'Solvency is enforced: spending is deducted, D is bound to the deposit',
    'not checked yet',
    [134],
  ),
  slashing: goal(
    'A double-spend reveals k and anyone can slash the RLN stake',
    'not checked yet',
  ),
  secretKey: goal(
    'The client sends nothing that contains the secret key',
    'verified',
  ),
  attestation: goal(
    'The client verifies the attestation before sending anything',
    'not checked yet',
    [99, 130],
  ),
  provider: goal(
    'Protocol, pricing and refunds work with any provider',
    'not checked yet',
  ),
  withdrawal: goal(
    'A depositor can withdraw without the server',
    'not met',
    [119, 157],
    'known, no check yet',
  ),
  walkaway: goal(
    'Every depositor can exit if the operator and every host disappear',
    'not met',
    [157, 135],
    'known, no check yet',
  ),
};

function check(target: Goal, label: string, ok: boolean, detail = ''): void {
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? `: ${detail}` : ''}`,
  );
  if (ok) {
    target.status ??= 'verified';
  } else {
    target.status = 'not met';
    target.detail = detail ? `${label}: ${detail}` : label;
  }
}

/** Runs the checks of one goal; an error marks the goal not met */
async function verify(target: Goal, checks: () => Promise<void>) {
  try {
    await checks();
  } catch (error) {
    check(
      target,
      error instanceof Error ? error.message : String(error),
      false,
    );
  }
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined)
    throw new Error(`no ${what}, an earlier goal failed`);
  return value;
}

function step(title: string): void {
  console.log(`\n${title}`);
}

const MARKS: Record<Status, string> = {
  verified: '✓',
  'not met': '✗',
  'not checked yet': '–',
};

/** Prints the goal table and returns whether a goal expected to be verified is not */
function report(): boolean {
  console.log('\nGoals');
  const width = Math.max(...Object.keys(MARKS).map((s) => s.length));
  let regressed = false;
  for (const g of Object.values(goals)) {
    const status =
      g.status ?? (g.expected === 'verified' ? 'not met' : g.expected);
    const detail =
      g.detail ?? (g.expected === 'verified' && !g.status ? 'not run' : '');
    const issues = (g.issues ?? []).map((n) => `${ISSUES}/${n}`).join(' ');
    console.log(
      `  ${MARKS[status]} ${status.padEnd(width)}  ${g.label}` +
        (detail ? ` (${detail})` : '') +
        (issues ? `  ${issues}` : ''),
    );
    if (g.expected === 'verified' && status !== 'verified') regressed = true;
    if (g.expected !== 'verified' && status === 'verified') {
      console.log(`    now verified: update its expected status in demo.ts`);
    }
  }
  return regressed;
}

/** A request's public fields, normalized, without the proof and the payload */
function publicFields(body: Record<string, unknown>): Map<string, string> {
  const fields = new Map<string, string>();
  const walk = (value: unknown, path: string) => {
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    } else if (path !== 'proof' && path !== 'payload') {
      const text = String(value);
      try {
        fields.set(path, BigInt(text).toString());
      } catch {
        fields.set(path, text);
      }
    }
  };
  walk(body, '');
  return fields;
}

const workDir = mkdtempSync(join(tmpdir(), 'longjing-demo-'));

async function prove(kind: 'request' | 'refund', input: object) {
  const file = join(workDir, `${kind}.json`);
  writeFileSync(file, JSON.stringify(input, null, 2));
  const { stdout } = await run('pnpm', ['-s', 'prove', kind, file], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Record<string, any>;
}

async function deploy(): Promise<string> {
  const { stdout } = await run(
    'forge',
    [
      'script',
      'script/DeployLongjingCredits.s.sol:DeployLongjingCredits',
      '--rpc-url',
      RPC_URL,
      '--broadcast',
    ],
    {
      cwd: 'contracts',
      env: { ...process.env, NODE_ENV: 'development' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const address = /LongjingCredits deployed at: (0x[a-fA-F0-9]{40})/.exec(
    stdout,
  )?.[1];
  if (!address) throw new Error(`Deployment failed:\n${stdout}`);
  return address;
}

async function startServer(contract: string): Promise<INestApplication> {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    ANVIL_RPC_URL: RPC_URL,
    ZK_CONTRACT_ADDRESS: contract,
    ZK_CIRCUIT: 'api_request_local',
    DATA_DIR: workDir,
    KMS_URL: 'http://localhost:3001',
    ADMIN_MLKEM_PUBLIC_KEY: Buffer.alloc(1568).toString('base64'),
    ADMIN_MLKEM_PRIVATE_KEY: Buffer.alloc(3168).toString('base64'),
  });
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANVIL_PRIVATE_KEY',
    'ETHEREUM_RPC_URLS',
    'DSTACK_SIMULATOR_ENDPOINT',
  ]) {
    delete process.env[name];
  }

  // Required after the env is set: ConfigModule validates it on import
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NestFactory } =
    require('@nestjs/core') as typeof import('@nestjs/core');
  const { ValidationPipe } =
    require('@nestjs/common') as typeof import('@nestjs/common');
  const { AppModule } =
    require('../../src/app.module') as typeof import('../../src/app.module');
  const { TeeExceptionFilter } =
    require('../../src/filters/tee-exception.filter') as typeof import('../../src/filters/tee-exception.filter');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new TeeExceptionFilter());
  // Plain HTTP on loopback: dev TLS needs certificates in ./secrets
  await app.listen(0, '127.0.0.1');
  return app;
}

async function verifyTicket(
  ticket: RefundTicket,
  idCommitment: string,
  key: { x: string; y: string },
): Promise<boolean> {
  const eddsa = await circomlibjs.buildEddsa();
  const F = eddsa.babyJub.F;
  const message = eddsa.poseidon([
    BigInt(idCommitment),
    BigInt(ticket.nullifier),
    BigInt(ticket.value),
    BigInt(ticket.timestamp),
  ]);
  return eddsa.verifyPoseidon(
    message,
    {
      R8: [
        F.e(BigInt(ticket.signature.R8x)),
        F.e(BigInt(ticket.signature.R8y)),
      ],
      S: BigInt(ticket.signature.S),
    },
    [F.e(BigInt(key.x)), F.e(BigInt(key.y))],
  ) as boolean;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    cacheTimeout: -1,
  });
  try {
    await provider.getBlockNumber();
  } catch {
    throw new Error(`Anvil is not running on ${RPC_URL}. Start it with: anvil`);
  }

  step('1. Deploy the contract with NODE_ENV=development');
  const address = await deploy();
  console.log(`  LongjingCredits at ${address}`);
  const alice = new ethers.Wallet(ALICE_KEY, provider);
  const contract = new ethers.Contract(address, ABI, alice);

  step('2. Start the server pointed at it');
  const app = await startServer(address);
  const url = await app.getUrl();
  console.log(`  Listening on ${url}`);
  const sent: string[] = [];
  const post = (request: object) => {
    const json = JSON.stringify(request);
    sent.push(json);
    return fetch(`${url}/longjing/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json,
    });
  };

  try {
    const secretKey =
      '0x' +
      (
        BigInt('0x' + randomBytes(32).toString('hex')) % BN254_SCALAR_FIELD
      ).toString(16);
    const poseidon = await circomlibjs.buildPoseidon();
    const idCommitment = ethers.toBeHex(
      poseidon.F.toObject(poseidon([BigInt(secretKey)])) as bigint,
      32,
    );

    step('3. Alice deposits with her secret');
    await verify(goals.deposit, async () => {
      await (await contract.deposit(idCommitment, { value: DEPOSIT })).wait();
      const deposit = await contract.getDeposit(idCommitment);
      check(
        goals.deposit,
        'the deposit is active onchain',
        deposit.active && deposit.rlnStake + deposit.policyStake === DEPOSIT,
      );
    });

    step('4. Alice proves membership with that secret (pnpm prove request)');
    let serverPublicKey: { x: string; y: string } | undefined;
    let body: Record<string, any> | undefined;
    await verify(goals.root, async () => {
      serverPublicKey = (await (
        await fetch(`${url}/longjing/server-pubkey`)
      ).json()) as { x: string; y: string };
      body = await prove('request', {
        secretKey,
        ticketIndex: '0x00',
        payload: PAYLOAD,
        maxCost: MAX_COST.toString(),
        rpcUrl: RPC_URL,
        contract: address,
        serverPublicKey,
        circuit: 'api_request_local',
      });
      check(
        goals.root,
        "the proof's root matches the chain",
        body.merkleRoot === (await contract.merkleRoot()),
      );
    });

    step('5. POST /longjing/request, then replay it');
    let response:
      { actualCost: string; refundTicket: RefundTicket } | undefined;
    await verify(goals.nullifier, async () => {
      const request = required(body, 'request proof');
      const send = () => post(request);
      const first = await send();
      const json = (await first.json()) as typeof response;
      check(
        goals.nullifier,
        'the nullifier is accepted once',
        first.status === 200,
        `HTTP ${first.status} ${JSON.stringify(json)}`,
      );
      if (first.status === 200) response = json;
      const replay = await send();
      check(
        goals.nullifier,
        'a replay is rejected',
        replay.status === 403 &&
          ((await replay.json()) as { message: string }).message ===
            'Nullifier already used',
        `HTTP ${replay.status}`,
      );
    });

    step('6. Alice proves the refund (pnpm prove refund) and redeems it');
    await verify(goals.refund, async () => {
      const key = required(serverPublicKey, 'server public key');
      const { actualCost, refundTicket: ticket } = required(
        response,
        'refund ticket',
      );
      const onChainKey = await contract.serverPublicKey();
      check(
        goals.refund,
        "the server's refund key is the one registered onchain",
        BigInt(key.x) === BigInt(onChainKey.x) &&
          BigInt(key.y) === BigInt(onChainKey.y),
      );
      check(
        goals.refund,
        'the refund is maxCost minus the actual cost',
        BigInt(ticket.value) === MAX_COST - BigInt(actualCost) &&
          BigInt(ticket.value) > 0n,
        `${ticket.value} wei`,
      );
      check(
        goals.refund,
        'the refund ticket signature verifies against serverPublicKey',
        await verifyTicket(ticket, idCommitment, key),
      );

      const recipient = ethers.Wallet.createRandom().address;
      const refund = await prove('refund', {
        secretKey,
        ticketIndex: '0x00',
        payload: PAYLOAD,
        recipient,
        refundTicket: ticket,
        serverPublicKey: key,
      });
      const args = [
        ethers.toBeHex(BigInt(refund.idCommitment), 32),
        ethers.toBeHex(BigInt(refund.nullifier), 32),
        refund.value,
        recipient,
        refund.proof,
        refund.publicSignals,
      ];
      const before = await provider.getBalance(recipient);
      await (await contract.redeemRefund(...args)).wait();
      const after = await provider.getBalance(recipient);
      check(
        goals.refund,
        'the balance changes by the refund',
        after - before === BigInt(ticket.value),
        `${after - before} wei`,
      );
      let revert = '';
      try {
        await contract.redeemRefund.staticCall(...args);
      } catch (error) {
        revert = (error as { revert?: { name: string } }).revert?.name ?? '';
      }
      check(
        goals.refund,
        'a second redemption reverts',
        revert === 'RefundAlreadyRedeemed',
        revert || 'it succeeded',
      );
    });

    step('7. Alice sends a second request and compares what they publish');
    await verify(goals.requestToRequest, async () => {
      const first = publicFields(required(body, 'request proof'));
      const second = await prove('request', {
        secretKey,
        ticketIndex: '0x01',
        payload: PAYLOAD_2,
        maxCost: MAX_COST.toString(),
        rpcUrl: RPC_URL,
        contract: address,
        serverPublicKey: required(serverPublicKey, 'server public key'),
        circuit: 'api_request_local',
      });
      const res = await post(second);
      if (res.status !== 200) {
        throw new Error(
          `the second request failed: HTTP ${res.status} ${await res.text()}`,
        );
      }
      const fields = publicFields(second);
      const shared = [...first]
        .filter(([k, v]) => !SHARED_BY_DESIGN.has(k) && fields.get(k) === v)
        .map(([k]) => k);
      check(
        goals.requestToRequest,
        'the two requests share no identifier',
        shared.length === 0,
        `both publish the same ${shared.join(', ')}`,
      );
    });
    await verify(goals.requestToDeposit, async () => {
      const commitments = (
        (await contract.getAllIdentityCommitments()) as string[]
      ).map((c) => BigInt(c).toString());
      const linked = [...publicFields(required(body, 'request proof'))]
        .filter(([, v]) => commitments.includes(v) || v === DEPOSIT.toString())
        .map(([k]) => k);
      check(
        goals.requestToDeposit,
        'no public field of the request matches the deposit',
        linked.length === 0,
        `${linked.join(', ')} match Alice's deposit`,
      );
    });

    step('8. Check what the client sent the server');
    await verify(goals.secretKey, async () => {
      const key = BigInt(secretKey);
      const forms = [key.toString(), key.toString(16)];
      const leaked = sent.filter((json) =>
        forms.some((form) => json.toLowerCase().includes(form)),
      );
      check(
        goals.secretKey,
        `none of the ${sent.length} request bodies contains the secret key`,
        sent.length > 0 && leaked.length === 0,
        `${leaked.length} do`,
      );
    });
  } finally {
    await app.close();
  }

  return report();
}

// snarkjs keeps worker threads alive, so exit explicitly
main()
  .then((regressed) => process.exit(regressed ? 1 : 0))
  .catch((error: unknown) => {
    console.error(`\n  ✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
