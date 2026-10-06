/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ethers } from 'ethers';
import { buildEddsa, buildPoseidon } from 'circomlibjs';
import { AppModule } from '../src/app.module';

const run = promisify(execFile);

interface RefundTicket {
  nullifier: string;
  value: string;
  timestamp: number;
  signature: { R8x: string; R8y: string; S: string };
}

// The same steps as `pnpm demo`: one user, Alice, from deposit to refund
describe('Deposit -> request -> refund (e2e)', () => {
  const RPC_URL = 'http://127.0.0.1:8545';
  // Anvil account #1; #0 deploys
  const ALICE_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const DEPOSIT = ethers.parseEther('0.2');
  const MAX_COST = ethers.parseEther('0.05');
  const PAYLOAD = 'What does 苟全性命於亂世，不求聞達於諸侯。mean?';
  const SECRET_KEY = '0x5ec12e7a11ce';
  const ABI = [
    'function deposit(bytes32 _idCommitment) payable',
    'function merkleRoot() view returns (bytes32)',
    'function serverPublicKey() view returns (bytes32 x, bytes32 y)',
    'function getDeposit(bytes32 _idCommitment) view returns (tuple(bytes32 idCommitment, uint256 rlnStake, uint256 policyStake, uint256 timestamp, bool active))',
    'function redeemRefund(bytes32 _idCommitment, bytes32 _nullifier, uint256 _refundValue, address _recipient, uint256[8] _proof, uint256[8] _publicSignals)',
    'error RefundAlreadyRedeemed()',
  ];

  const env = { ...process.env };
  const workDir = mkdtempSync(join(tmpdir(), 'longjing-e2e-'));
  let app: INestApplication<App>;
  let provider: ethers.JsonRpcProvider;
  let contract: ethers.Contract;
  let address: string;
  let idCommitment: string;
  let serverPublicKey: { x: string; y: string };
  let body: Record<string, any>;
  let ticket: RefundTicket;

  const prove = async (kind: 'request' | 'refund', input: object) => {
    const file = join(workDir, `${kind}.json`);
    writeFileSync(file, JSON.stringify(input));
    const { stdout } = await run('pnpm', ['-s', 'prove', kind, file], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as Record<string, any>;
  };

  beforeAll(async () => {
    // No request cache, so balances read right after a transaction are fresh
    provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
      cacheTimeout: -1,
    });
    try {
      await provider.getBlockNumber();
    } catch {
      throw new Error(
        `Anvil is not running on ${RPC_URL}. Start it with: anvil`,
      );
    }

    // The contract first, so the app reads its root from the chain
    const { stdout } = await run(
      'forge',
      [
        'script',
        'script/DeployLongjingCredits.s.sol:DeployLongjingCredits',
        '--rpc-url',
        RPC_URL,
        '--broadcast',
      ],
      { cwd: 'contracts', maxBuffer: 16 * 1024 * 1024 },
    );
    address = /LongjingCredits deployed at: (0x[a-fA-F0-9]{40})/.exec(
      stdout,
    )![1];
    contract = new ethers.Contract(
      address,
      ABI,
      new ethers.Wallet(ALICE_KEY, provider),
    );

    Object.assign(process.env, {
      ANVIL_RPC_URL: RPC_URL,
      ZK_CONTRACT_ADDRESS: address,
      ZK_CIRCUIT: 'api_request_local',
      DATA_DIR: ':memory:',
      KMS_URL: 'http://localhost:3001',
      ADMIN_MLKEM_PUBLIC_KEY: Buffer.alloc(1568).toString('base64'),
      ADMIN_MLKEM_PRIVATE_KEY: Buffer.alloc(3168).toString('base64'),
    });
    // Mock responses: no cost, and the refund does not depend on a model
    delete process.env.ANTHROPIC_API_KEY;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    process.env = { ...env };
  });

  it('Alice deposits with her secret', async () => {
    const poseidon = await buildPoseidon();
    idCommitment = ethers.toBeHex(
      poseidon.F.toObject(poseidon([BigInt(SECRET_KEY)])),
      32,
    );

    await (await contract.deposit(idCommitment, { value: DEPOSIT })).wait();

    const deposit = await contract.getDeposit(idCommitment);
    expect(deposit.active).toBe(true);
    expect(deposit.rlnStake + deposit.policyStake).toBe(DEPOSIT);
  });

  it('proves membership with that secret against the on-chain root', async () => {
    const { body: key } = await request(app.getHttpServer())
      .get('/longjing/server-pubkey')
      .expect(200);
    serverPublicKey = key;
    const onChain = await contract.serverPublicKey();
    expect(BigInt(key.x)).toBe(BigInt(onChain.x));
    expect(BigInt(key.y)).toBe(BigInt(onChain.y));

    body = await prove('request', {
      secretKey: SECRET_KEY,
      ticketIndex: '0x00',
      payload: PAYLOAD,
      maxCost: MAX_COST.toString(),
      rpcUrl: RPC_URL,
      contract: address,
      serverPublicKey,
      circuit: 'api_request_local',
    });

    expect(body.merkleRoot).toBe(await contract.merkleRoot());
    expect(body.idCommitment).toBe(idCommitment);
  }, 120000);

  it('accepts the nullifier once and rejects a replay', async () => {
    const { body: response } = await request(app.getHttpServer())
      .post('/longjing/request')
      .send(body)
      .expect(200);
    ticket = response.refundTicket;
    expect(BigInt(ticket.value)).toBe(MAX_COST - BigInt(response.actualCost));
    expect(BigInt(ticket.value)).toBeGreaterThan(0n);

    const { body: replay } = await request(app.getHttpServer())
      .post('/longjing/request')
      .send(body)
      .expect(403);
    expect(replay.message).toBe('Nullifier already used');
  }, 120000);

  it('signs the refund ticket with serverPublicKey', async () => {
    const eddsa = await buildEddsa();
    const F = eddsa.babyJub.F;
    const message = eddsa.poseidon([
      BigInt(idCommitment),
      BigInt(ticket.nullifier),
      BigInt(ticket.value),
      BigInt(ticket.timestamp),
    ]);

    expect(
      eddsa.verifyPoseidon(
        message,
        {
          R8: [
            F.e(BigInt(ticket.signature.R8x)),
            F.e(BigInt(ticket.signature.R8y)),
          ],
          S: BigInt(ticket.signature.S),
        },
        [F.e(BigInt(serverPublicKey.x)), F.e(BigInt(serverPublicKey.y))],
      ),
    ).toBe(true);
  });

  it('redeems the refund once with a real proof, and rejects a second redemption', async () => {
    const recipient = ethers.Wallet.createRandom().address;
    const refund = await prove('refund', {
      secretKey: SECRET_KEY,
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

    await (await contract.redeemRefund(...args)).wait();
    expect(await provider.getBalance(recipient)).toBe(BigInt(ticket.value));

    await expect(
      contract.redeemRefund.staticCall(...args),
    ).rejects.toMatchObject({
      revert: { name: 'RefundAlreadyRedeemed' },
    });
  }, 120000);
});
