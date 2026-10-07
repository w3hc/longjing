/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ethers } from 'ethers';
import { AppModule } from '../src/app.module';
import {
  commitmentOf,
  newNote,
  NOTE_ABI,
  NoteFile,
  proveRequest,
  proveWithdrawal,
  receive,
  RequestResponse,
  WithdrawalArgs,
} from '../scripts/client/note';

const run = promisify(execFile);

const RPC_URL = 'http://127.0.0.1:8545';
// Anvil accounts: #0 deploys and is the server, the others are users
const anvilKey = (index: number) =>
  ethers.HDNodeWallet.fromPhrase(
    'test test test test test test test test test test test junk',
    undefined,
    `m/44'/60'/0'/0/${index}`,
  ).privateKey;
const SERVER_KEY = anvilKey(0);
const USER_KEYS = [1, 2, 3].map(anvilKey);
const DEPOSIT = ethers.parseEther('0.01');
const CHALLENGE_WINDOW = 3 * 24 * 60 * 60;

const Status = { Active: 1, Exiting: 2, Closed: 3, Slashed: 4 } as const;

// docs/SETTLEMENT.md end to end on Anvil: the real contract, server and
// client, with the provider mocked
describe('Notes, requests and settlement (e2e)', () => {
  const env = { ...process.env };
  let app: INestApplication<App>;
  let provider: ethers.JsonRpcProvider;
  let address: string;
  let cMax: bigint;

  const contractFor = (key: string) =>
    new ethers.Contract(
      address,
      NOTE_ABI,
      new ethers.NonceManager(new ethers.Wallet(key, provider)),
    );

  const open = async (key: string): Promise<NoteFile> => {
    const note = newNote(RPC_URL, address);
    await (
      await contractFor(key).deposit(await commitmentOf(note), {
        value: DEPOSIT,
      })
    ).wait();
    return note;
  };

  const status = async (note: NoteFile) =>
    Number(
      (await contractFor(SERVER_KEY).getNote(await commitmentOf(note)))[3],
    );

  const post = (body: object) =>
    request(app.getHttpServer()).post('/longjing/request').send(body);

  /** Proves, sends and folds the response in */
  const serve = async (note: NoteFile, payload: string) => {
    const proved = await proveRequest(note, payload);
    const { body } = await post(proved.body).expect(200);
    return {
      note: await receive(proved.note, body as RequestResponse),
      body: proved.body,
      response: body as RequestResponse,
    };
  };

  const initiate = async (key: string, args: WithdrawalArgs) => {
    const tx = (await contractFor(key).initiateWithdrawal(
      args.commitment,
      args.recipient,
      args.refundKey,
      args.proof,
      args.nullifier,
      args.signalY,
      args.payout,
    )) as ethers.ContractTransactionResponse;
    await tx.wait();
  };

  const passWindow = async () => {
    await provider.send('evm_increaseTime', [CHALLENGE_WINDOW]);
    await provider.send('evm_mine', []);
  };

  beforeAll(async () => {
    // No request cache, so state read right after a transaction is fresh
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
        env: { ...process.env, NODE_ENV: 'test' },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    address = /LongjingCredits deployed at: (0x[a-fA-F0-9]{40})/.exec(
      stdout,
    )![1];
    cMax = (await contractFor(SERVER_KEY).C_MAX()) as bigint;

    Object.assign(process.env, {
      ANVIL_RPC_URL: RPC_URL,
      ZK_CONTRACT_ADDRESS: address,
      SERVER_TX_PRIVATE_KEY: SERVER_KEY,
      DATA_DIR: ':memory:',
      KMS_URL: 'http://localhost:3001',
      ADMIN_MLKEM_PUBLIC_KEY: Buffer.alloc(1568).toString('base64'),
      ADMIN_MLKEM_PRIVATE_KEY: Buffer.alloc(3168).toString('base64'),
    });
    // Mock responses, priced like any other
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
  }, 180000);

  afterAll(async () => {
    await app?.close();
    process.env = { ...env };
  });

  describe('Alice: two requests, then an honest exit', () => {
    let note: NoteFile;
    let first: Awaited<ReturnType<typeof serve>>;

    it('registers the server key the server signs with', async () => {
      const { body: key } = await request(app.getHttpServer())
        .get('/longjing/server-pubkey')
        .expect(200);
      const [x, y] = (await contractFor(SERVER_KEY).serverPublicKey()) as [
        string,
        string,
      ];
      const served = key as { x: string; y: string };
      expect([BigInt(served.x), BigInt(served.y)]).toEqual([
        BigInt(x),
        BigInt(y),
      ]);
    });

    it('serves a first request from the genesis accumulator', async () => {
      note = await open(USER_KEYS[0]);
      first = await serve(note, 'What does 苟全性命於亂世 mean?');
      note = first.note;

      expect(note.opening.index).toBe('1');
      expect(BigInt(first.response.refund)).toBeGreaterThan(0n);
      expect(BigInt(first.response.refund)).toBeLessThanOrEqual(cMax);
    }, 180000);

    it('sends nothing that identifies the note, its deposit or its index', async () => {
      const commitment = BigInt(await commitmentOf(note));
      const values = JSON.stringify(first.body);
      for (const secret of [commitment, DEPOSIT, BigInt(note.secretKey)]) {
        expect(values).not.toContain(secret.toString());
      }
      expect(Object.keys(first.body).sort()).toEqual(
        [
          'accumulator',
          'merkleRoot',
          'nonce',
          'nullifier',
          'payload',
          'proof',
          'signal',
        ].sort(),
      );
    });

    it('answers a retry with the same accumulator', async () => {
      const { body } = await post(first.body).expect(200);
      expect(body.accumulator).toEqual(first.response.accumulator);
    }, 60000);

    it('serves a second request from the signed accumulator', async () => {
      const second = await serve(note, 'Who wrote the Chu Shi Biao?');
      note = second.note;

      expect(note.opening.index).toBe('2');
      expect(second.body.accumulator).not.toEqual(first.body.accumulator);
      expect(second.body.nullifier).not.toBe(first.body.nullifier);
    }, 180000);

    it('exits with D + R − n · C_MAX after the window', async () => {
      const recipient = ethers.Wallet.createRandom().address;
      const args = await proveWithdrawal(note, recipient);
      await initiate(USER_KEYS[0], args);
      expect(await status(note)).toBe(Status.Exiting);

      await passWindow();
      await (
        await contractFor(USER_KEYS[1]).finalizeWithdrawal(args.commitment)
      ).wait();

      const expected = DEPOSIT + BigInt(note.opening.refunds) - 2n * cMax;
      expect(BigInt(args.payout)).toBe(expected);
      expect(await provider.getBalance(recipient)).toBe(expected);
      expect(await status(note)).toBe(Status.Closed);
    }, 180000);

    it('can make no request once closed', async () => {
      await expect(proveRequest(note, 'One more?')).rejects.toThrow(
        'is not active',
      );
    });
  });

  describe('Bob: a double-spend', () => {
    it('reveals k, and the server slashes the note', async () => {
      const note = await open(USER_KEYS[1]);
      const a = await proveRequest(note, 'first payload');
      const b = await proveRequest(note, 'second payload');
      expect(b.body.nullifier).toBe(a.body.nullifier);

      await post(a.body).expect(200);
      const { body } = await post(b.body).expect(403);
      expect(body.message).toContain('Double-spend detected');

      expect(await status(note)).toBe(Status.Slashed);
    }, 180000);
  });

  describe('Carol: an exit that understates usage', () => {
    it('is slashed by the server during the window', async () => {
      let note = await open(USER_KEYS[2]);
      note = (await serve(note, 'first')).note;
      // Index 1 is served, but Carol drops the response and exits claiming n = 1
      const unanswered = await proveRequest(note, 'second');
      await post(unanswered.body).expect(200);

      const args = await proveWithdrawal(
        note,
        ethers.Wallet.createRandom().address,
        1n,
      );
      await initiate(USER_KEYS[2], args);

      const deadline = Date.now() + 30000;
      while ((await status(note)) !== Status.Slashed) {
        if (Date.now() > deadline) throw new Error('The exit was not slashed');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      await passWindow();
      await expect(
        contractFor(USER_KEYS[2]).finalizeWithdrawal.staticCall(
          args.commitment,
        ),
      ).rejects.toThrow();
    }, 180000);
  });
});
