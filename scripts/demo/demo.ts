#!/usr/bin/env ts-node
/**
 * Runs one user, Alice, from deposit to refund against Anvil, and asserts
 * every step. Exits non-zero on the first failed check.
 *
 * Usage:
 *   anvil        # in another terminal
 *   pnpm demo
 *
 * 1. Deploy LongjingCredits with NODE_ENV=development
 * 2. Start the server pointed at it
 * 3. Alice deposits with her secret
 * 4. She proves membership with that secret against the on-chain root
 *    (pnpm prove request)
 * 5. POST /longjing/request, then replay it
 * 6. She proves the refund (pnpm prove refund), redeems it on chain, then
 *    tries again
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

const ABI = [
  'function deposit(bytes32 _idCommitment) payable',
  'function merkleRoot() view returns (bytes32)',
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

const passed: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  }
  passed.push(label);
  console.log(`  ✓ ${label}`);
}

function step(title: string): void {
  console.log(`\n${title}`);
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

  try {
    step('3. Alice deposits with her secret');
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
    await (await contract.deposit(idCommitment, { value: DEPOSIT })).wait();
    const deposit = await contract.getDeposit(idCommitment);
    check(
      'the deposit is active on chain',
      deposit.active && deposit.rlnStake + deposit.policyStake === DEPOSIT,
    );

    step('4. Alice proves membership with that secret (pnpm prove request)');
    const serverPublicKey = (await (
      await fetch(`${url}/longjing/server-pubkey`)
    ).json()) as { x: string; y: string };
    const onChainKey = await contract.serverPublicKey();
    check(
      "the server's refund key is the one registered on chain",
      BigInt(serverPublicKey.x) === BigInt(onChainKey.x) &&
        BigInt(serverPublicKey.y) === BigInt(onChainKey.y),
    );
    const body = await prove('request', {
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
      "the proof's root matches the chain",
      body.merkleRoot === (await contract.merkleRoot()),
    );
    check(
      'the proof is for the deposited secret',
      body.idCommitment === idCommitment,
    );

    step('5. POST /longjing/request, then replay it');
    const send = () =>
      fetch(`${url}/longjing/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const first = await send();
    const response = (await first.json()) as {
      actualCost: string;
      refundTicket: RefundTicket;
    };
    check(
      'the nullifier is accepted once',
      first.status === 200,
      `HTTP ${first.status} ${JSON.stringify(response)}`,
    );
    const replay = await send();
    check(
      'a replay is rejected',
      replay.status === 403 &&
        ((await replay.json()) as { message: string }).message ===
          'Nullifier already used',
      `HTTP ${replay.status}`,
    );

    const ticket = response.refundTicket;
    check(
      'the refund is maxCost minus the actual cost',
      BigInt(ticket.value) === MAX_COST - BigInt(response.actualCost) &&
        BigInt(ticket.value) > 0n,
      `${ticket.value} wei`,
    );
    check(
      'the refund ticket signature verifies against serverPublicKey',
      await verifyTicket(ticket, idCommitment, serverPublicKey),
    );

    step('6. Alice proves the refund (pnpm prove refund) and redeems it');
    const recipient = ethers.Wallet.createRandom().address;
    const refund = await prove('refund', {
      secretKey,
      ticketIndex: '0x00',
      payload: PAYLOAD,
      recipient,
      refundTicket: ticket,
      serverPublicKey,
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
      'a second redemption reverts',
      revert === 'RefundAlreadyRedeemed',
      revert || 'it succeeded',
    );
  } finally {
    await app.close();
  }

  console.log(`\nProven, ${passed.length} checks:`);
  for (const label of passed) console.log(`  ✓ ${label}`);
}

// snarkjs keeps worker threads alive, so exit explicitly
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`\n  ✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
