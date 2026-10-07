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
 * Against an existing deployment instead of Anvil, with DEMO_PRIVATE_KEY set
 * to the wallet that pays the deposits (and, optionally,
 * DEMO_SLASHER_PRIVATE_KEY to slash from another wallet):
 *   pnpm demo --gateway <url> --contract <address> --rpc <url> [--deposit <eth>]
 *
 * Four actors:
 * - Alice, an honest user
 * - the operator, who runs the gateway and sees every request and its own
 *   database
 * - an observer, who sees only the chain
 * - an attacker, who holds a deposit and cheats
 *
 * 1. Deploy LongjingCredits with NODE_ENV=development, or use the deployed one
 * 2. Start the server pointed at it, or use the gateway
 * 3. Alice deposits and sends a request (pnpm prove request)
 * 4. The attacker replays Alice's request
 * 5. Alice proves her refund (pnpm prove refund). The attacker tries to
 *    redeem it to their own address, then Alice redeems it
 * 6. Alice sends a second request
 * 7. The operator tries to link Alice's requests to each other and to her
 *    deposit
 * 8. The observer tries to link Alice's refund to her deposit, and checks
 *    that the contract still holds every active stake
 * 9. The attacker deposits and double-spends a ticket. The operator recovers
 *    their secret key from the two signals (pnpm prove slashing) and slashes
 *    them from a wallet that is not serverAddress
 * 10. Alice checks that no request body contains a secret key
 *
 * On Anvil, the server answers with mock responses: ANTHROPIC_API_KEY is
 * ignored. Against a deployment, the requests reach the provider and cost
 * what they cost, and Alice's deposit stays locked until withdrawal works
 * (#119).
 */

import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs, promisify } from 'util';
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
// Anvil account #2, a wallet of the operator's that is not serverAddress
const SLASHER_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const MAX_COST = ethers.parseEther('0.05');
const PAYLOAD = 'What does 苟全性命於亂世，不求聞達於諸侯。mean?';
const PAYLOAD_2 = 'Who wrote 出師表?';
const PAYLOAD_ATTACKER = 'What does 鞠躬盡瘁 mean?';
const PAYLOAD_DOUBLE = 'What does 死而後已 mean?';
// The same for every request at a given time, so they identify no one
const SHARED_BY_DESIGN = new Set(['merkleRoot', 'maxCost']);
const ISSUES = 'https://github.com/w3hc/longjing/issues';

const ABI = [
  'function deposit(bytes32 _idCommitment) payable',
  'function merkleRoot() view returns (bytes32)',
  'function getAllIdentityCommitments() view returns (bytes32[])',
  'function serverPublicKey() view returns (bytes32 x, bytes32 y)',
  'function getDeposit(bytes32 _idCommitment) view returns (tuple(bytes32 idCommitment, uint256 rlnStake, uint256 policyStake, uint256 timestamp, bool active))',
  'function serverAddress() view returns (address)',
  'function slashingVerifier() view returns (address)',
  'function slashDoubleSpend(bytes32 _secretKey, bytes32 _nullifier, bytes32 _idCommitment, uint256[8] _proof, uint256[4] _publicSignals)',
  'function redeemRefund(bytes32 _idCommitment, bytes32 _nullifier, uint256 _refundValue, address _recipient, uint256[8] _proof, uint256[8] _publicSignals)',
  'event RefundRedeemed(bytes32 indexed idCommitment, bytes32 indexed nullifier, uint256 amount, address indexed recipient)',
  'event DoubleSpendSlashed(bytes32 indexed secretKey, bytes32 indexed nullifier, address indexed slasher, uint256 reward)',
  'error RefundAlreadyRedeemed()',
  'error InvalidProof()',
];

const VERIFIER_ABI = [
  'function verifySlashingProof(uint256[8] _proof, uint256[4] _publicSignals) view returns (bool)',
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
  refundToDeposit: goal(
    "A refund redemption onchain can't be linked to the deposit",
    'not met',
    [134],
  ),
  refundRecipient: goal(
    'A refund can only be redeemed to the recipient in its proof',
    'verified',
  ),
  solvency: goal(
    'Solvency is enforced: spending is deducted, D is bound to the deposit',
    'not met',
    [134],
  ),
  slashing: goal(
    'A double-spend reveals k and anyone with the proof can slash the RLN stake',
    'verified',
  ),
  secretKey: goal(
    'The client sends nothing that contains the secret key',
    'verified',
  ),
  attestation: goal(
    'The client verifies the attestation before sending anything',
    'not checked yet',
    [99],
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

/** The custom error name or require message a call reverts with, or '' if it succeeds */
async function revertOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return '';
  } catch (error) {
    const revert = (error as { revert?: { name: string; args: unknown[] } })
      .revert;
    if (!revert) throw error;
    return revert.name === 'Error' ? String(revert.args[0]) : revert.name;
  }
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

interface Options {
  gateway?: string;
  contract?: string;
  rpcUrl: string;
  circuit: 'api_request' | 'api_request_local';
  aliceKey: string;
  slasherKey: string;
  deposit: bigint;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      gateway: { type: 'string' },
      contract: { type: 'string' },
      rpc: { type: 'string' },
      deposit: { type: 'string', default: '0.2' },
    },
  });
  const deposit = ethers.parseEther(values.deposit);
  const { gateway, contract, rpc } = values;
  if (!gateway && !contract && !rpc) {
    return {
      rpcUrl: RPC_URL,
      circuit: 'api_request_local',
      aliceKey: ALICE_KEY,
      slasherKey: SLASHER_KEY,
      deposit,
    };
  }
  if (!gateway || !contract || !rpc) {
    throw new Error('--gateway, --contract and --rpc go together');
  }
  const aliceKey = process.env.DEMO_PRIVATE_KEY;
  if (!aliceKey) {
    throw new Error(
      'Set DEMO_PRIVATE_KEY to the wallet that pays the deposits',
    );
  }
  return {
    gateway: gateway.replace(/\/$/, ''),
    contract,
    rpcUrl: rpc,
    circuit: 'api_request',
    aliceKey,
    slasherKey: process.env.DEMO_SLASHER_PRIVATE_KEY ?? aliceKey,
    deposit,
  };
}

const workDir = mkdtempSync(join(tmpdir(), 'longjing-demo-'));

async function prove(kind: 'request' | 'refund' | 'slashing', input: object) {
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
    'SERVER_TX_PRIVATE_KEY',
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
  const options = parseOptions();
  const provider = new ethers.JsonRpcProvider(options.rpcUrl, undefined, {
    cacheTimeout: -1,
  });
  try {
    await provider.getBlockNumber();
  } catch {
    throw new Error(
      options.gateway
        ? `Can't reach ${options.rpcUrl}`
        : `Anvil is not running on ${RPC_URL}. Start it with: anvil`,
    );
  }

  let address: string;
  let app: INestApplication | undefined;
  let url: string;
  if (options.gateway && options.contract) {
    step('1. Use the deployed contract');
    address = options.contract;
    console.log(`  LongjingCredits at ${address} on ${options.rpcUrl}`);
    step('2. Use the gateway');
    url = options.gateway;
    console.log(`  ${url}`);
  } else {
    step('1. Deploy the contract with NODE_ENV=development');
    address = await deploy();
    console.log(`  LongjingCredits at ${address}`);
    step('2. Start the server pointed at it');
    app = await startServer(address);
    url = await app.getUrl();
    console.log(`  Listening on ${url}`);
  }
  const alice = new ethers.Wallet(options.aliceKey, provider);
  const contract = new ethers.Contract(address, ABI, alice);
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
    const poseidon = await circomlibjs.buildPoseidon();
    const newIdentity = () => {
      const secret =
        '0x' +
        (
          BigInt('0x' + randomBytes(32).toString('hex')) % BN254_SCALAR_FIELD
        ).toString(16);
      const commitment = ethers.toBeHex(
        poseidon.F.toObject(poseidon([BigInt(secret)])) as bigint,
        32,
      );
      return { secret, commitment };
    };
    const { secret: secretKey, commitment: idCommitment } = newIdentity();
    const secrets = [secretKey];
    let serverPublicKey: { x: string; y: string } | undefined;
    const requestFor = (secret: string, ticketIndex: string, payload: string) =>
      prove('request', {
        secretKey: secret,
        ticketIndex,
        payload,
        maxCost: MAX_COST.toString(),
        rpcUrl: options.rpcUrl,
        contract: address,
        serverPublicKey: required(serverPublicKey, 'server public key'),
        circuit: options.circuit,
      });

    step('3. Alice deposits and sends a request (pnpm prove request)');
    await verify(goals.deposit, async () => {
      await (
        await contract.deposit(idCommitment, { value: options.deposit })
      ).wait();
      const deposit = await contract.getDeposit(idCommitment);
      check(
        goals.deposit,
        'the deposit is active onchain',
        deposit.active &&
          deposit.rlnStake + deposit.policyStake === options.deposit,
      );
    });
    let body: Record<string, any> | undefined;
    await verify(goals.root, async () => {
      serverPublicKey = (await (
        await fetch(`${url}/longjing/server-pubkey`)
      ).json()) as { x: string; y: string };
      body = await requestFor(secretKey, '0x00', PAYLOAD);
      check(
        goals.root,
        "the proof's root matches the chain",
        body.merkleRoot === (await contract.merkleRoot()),
      );
    });
    let response:
      { actualCost: string; refundTicket: RefundTicket } | undefined;
    await verify(goals.nullifier, async () => {
      const res = await post(required(body, 'request proof'));
      const json = (await res.json()) as typeof response;
      check(
        goals.nullifier,
        'the nullifier is accepted once',
        res.status === 200,
        `HTTP ${res.status} ${JSON.stringify(json)}`,
      );
      if (res.status === 200) response = json;
    });

    step("4. The attacker replays Alice's request");
    await verify(goals.nullifier, async () => {
      const replay = await post(required(body, 'request proof'));
      check(
        goals.nullifier,
        'the replay is rejected',
        replay.status === 403 &&
          ((await replay.json()) as { message: string }).message ===
            'Nullifier already used',
        `HTTP ${replay.status}`,
      );
    });

    step(
      '5. Alice proves her refund, the attacker tries to take it, Alice redeems it',
    );
    let redemption: ethers.TransactionReceipt | undefined;
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
      const args = (to: string) => [
        ethers.toBeHex(BigInt(refund.idCommitment), 32),
        ethers.toBeHex(BigInt(refund.nullifier), 32),
        refund.value,
        to,
        refund.proof,
        refund.publicSignals,
      ];

      // Front-running: Alice's proof with the attacker's address
      await verify(goals.refundRecipient, async () => {
        const thief = ethers.Wallet.createRandom().address;
        const swapped = await revertOf(
          contract.redeemRefund.staticCall(...args(thief)),
        );
        check(
          goals.refundRecipient,
          "the attacker can't redeem it to their own address",
          swapped === 'recipient mismatch',
          swapped || 'it succeeded',
        );
        const [idc, nullifier, value, , proof, signals] = args(thief);
        const forged = await revertOf(
          contract.redeemRefund.staticCall(
            idc,
            nullifier,
            value,
            thief,
            proof,
            [...(signals as string[]).slice(0, 7), BigInt(thief).toString()],
          ),
        );
        check(
          goals.refundRecipient,
          "nor by rewriting the proof's recipient signal",
          forged === 'InvalidProof',
          forged || 'it succeeded',
        );
      });

      const before = await provider.getBalance(recipient);
      redemption = (await (
        await contract.redeemRefund(...args(recipient))
      ).wait()) as ethers.TransactionReceipt;
      const after = await provider.getBalance(recipient);
      check(
        goals.refund,
        "Alice's balance changes by the refund",
        after - before === BigInt(ticket.value),
        `${after - before} wei`,
      );
      const revert = await revertOf(
        contract.redeemRefund.staticCall(...args(recipient)),
      );
      check(
        goals.refund,
        'a second redemption reverts',
        revert === 'RefundAlreadyRedeemed',
        revert || 'it succeeded',
      );
    });

    step('6. Alice sends a second request');
    let second: Record<string, any> | undefined;
    await verify(goals.requestToRequest, async () => {
      second = await requestFor(secretKey, '0x01', PAYLOAD_2);
      const res = await post(second);
      if (res.status !== 200) {
        throw new Error(
          `the second request failed: HTTP ${res.status} ${await res.text()}`,
        );
      }
    });

    step("7. The operator tries to link Alice's requests");
    await verify(goals.requestToRequest, async () => {
      const first = publicFields(required(body, 'request proof'));
      const fields = publicFields(required(second, 'second request'));
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
        .filter(
          ([, v]) =>
            commitments.includes(v) || v === options.deposit.toString(),
        )
        .map(([k]) => k);
      check(
        goals.requestToDeposit,
        'no public field of the request matches a deposit',
        linked.length === 0,
        `${linked.join(', ')} match Alice's deposit`,
      );
      if (!app) return;
      // On Anvil, the operator's database is in this process
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { NullifierStoreService } =
        require('../../src/longjing/nullifier-store.service') as typeof import('../../src/longjing/nullifier-store.service');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const stored = app
        .get(NullifierStoreService)
        .get(required(body, 'request proof').nullifier as string);
      check(
        goals.requestToDeposit,
        "the operator's database stores no deposit next to the nullifier",
        !stored?.idCommitment ||
          !commitments.includes(BigInt(stored.idCommitment).toString()),
        'it stores idCommitment',
      );
    });

    step("8. The observer tries to link Alice's refund to her deposit");
    await verify(goals.refundToDeposit, async () => {
      const receipt = required(redemption, 'refund redemption');
      const deposits = new Set(
        ((await contract.getAllIdentityCommitments()) as string[]).map((c) =>
          BigInt(c).toString(),
        ),
      );
      const linked = receipt.logs
        .map((log) => contract.interface.parseLog(log))
        .filter((event) => event?.name === 'RefundRedeemed')
        .some((event) => deposits.has(BigInt(event!.args[0]).toString()));
      check(
        goals.refundToDeposit,
        'no redemption event names a deposit',
        !linked,
        'RefundRedeemed publishes idCommitment',
      );
    });
    await verify(goals.solvency, async () => {
      let owed = 0n;
      for (const c of (await contract.getAllIdentityCommitments()) as string[]) {
        const deposit = await contract.getDeposit(c);
        if (deposit.active) owed += deposit.rlnStake + deposit.policyStake;
      }
      const held = await provider.getBalance(address);
      check(
        goals.solvency,
        'after the refund, the contract still holds every active stake',
        held >= owed,
        `it holds ${ethers.formatEther(held)} ETH and owes ${ethers.formatEther(owed)} ETH`,
      );
    });

    step('9. The attacker double-spends, the operator slashes them');
    await verify(goals.slashing, async () => {
      const attacker = newIdentity();
      secrets.push(attacker.secret);
      const deposited = (await (
        await contract.deposit(attacker.commitment, { value: options.deposit })
      ).wait()) as ethers.TransactionReceipt;
      const before = await contract.getDeposit(attacker.commitment);
      const first = await requestFor(attacker.secret, '0x00', PAYLOAD_ATTACKER);
      const accepted = await post(first);
      if (accepted.status !== 200) {
        throw new Error(
          `the attacker's first request failed: HTTP ${accepted.status} ${await accepted.text()}`,
        );
      }
      const doubleSpend = await requestFor(
        attacker.secret,
        '0x00',
        PAYLOAD_DOUBLE,
      );
      check(
        goals.slashing,
        'the second signal reuses the nullifier',
        doubleSpend.nullifier === first.nullifier,
      );
      const res = await post(doubleSpend);
      const { message } = (await res.json()) as { message?: string };
      check(
        goals.slashing,
        'the server rejects it as a double-spend',
        res.status === 403 && !!message?.startsWith('Double-spend detected'),
        `HTTP ${res.status} ${message}`,
      );

      // The operator holds the two signals, and nothing else is needed
      const slash = await prove('slashing', {
        ticketIndex: '0x00',
        signal1: first.signal,
        signal2: doubleSpend.signal,
      });
      check(
        goals.slashing,
        "the two signals reveal the attacker's secret key",
        BigInt(slash.secretKey) === BigInt(attacker.secret),
      );
      const verifier = new ethers.Contract(
        (await contract.slashingVerifier()) as string,
        VERIFIER_ABI,
        provider,
      );
      check(
        goals.slashing,
        'the onchain verifier accepts the slashing proof',
        (await verifier.verifySlashingProof(
          slash.proof,
          slash.publicSignals,
        )) as boolean,
      );

      if (!(await contract.getDeposit(attacker.commitment)).active) {
        // A server with a transaction signer slashes as soon as it sees the double-spend
        const slashed = await contract.queryFilter(
          contract.filters.DoubleSpendSlashed(null, slash.nullifier),
          deposited.blockNumber,
        );
        check(
          goals.slashing,
          'the server already slashed the deposit',
          slashed.length > 0,
          'the deposit is inactive but no DoubleSpendSlashed event was found',
        );
        return;
      }
      const slasher = new ethers.Wallet(options.slasherKey, provider);
      check(
        goals.slashing,
        'the slashing wallet is not serverAddress',
        slasher.address !== (await contract.serverAddress()),
      );
      const balance = await provider.getBalance(slasher.address);
      const receipt = (await (
        await (
          new ethers.Contract(address, ABI, slasher) as ethers.Contract
        ).slashDoubleSpend(
          slash.secretKey,
          slash.nullifier,
          slash.idCommitment,
          slash.proof,
          slash.publicSignals,
        )
      ).wait()) as ethers.TransactionReceipt;
      const reward =
        (await provider.getBalance(slasher.address)) -
        balance +
        receipt.gasUsed * receipt.gasPrice;
      check(
        goals.slashing,
        'the slashing wallet receives the RLN and policy stakes',
        reward === before.rlnStake + before.policyStake,
        `${reward} wei`,
      );
      check(
        goals.slashing,
        "the attacker's deposit is no longer active",
        !(await contract.getDeposit(attacker.commitment)).active,
      );
    });

    step('10. Alice checks what the clients sent the server');
    await verify(goals.secretKey, async () => {
      const forms = secrets.flatMap((secret) => {
        const key = BigInt(secret);
        return [key.toString(), key.toString(16)];
      });
      const leaked = sent.filter((json) =>
        forms.some((form) => json.toLowerCase().includes(form)),
      );
      check(
        goals.secretKey,
        `none of the ${sent.length} request bodies contains a secret key`,
        sent.length > 0 && leaked.length === 0,
        `${leaked.length} do`,
      );
    });
  } finally {
    await app?.close();
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
