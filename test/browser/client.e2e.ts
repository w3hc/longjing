import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import { ethers } from 'ethers';
import type * as Client from '../../src/client/browser';

/**
 * The browser build of the client, in Chromium, against Anvil and a local
 * gateway: a deposit, a request, a receive and a withdrawal, with no Node
 * module or global in the page. The page loads only build/browser/ and the
 * circuit files, from a static server on an origin of its own.
 */

declare global {
  interface Window {
    Longjing: typeof Client;
    state: Record<string, unknown>;
    nodeGlobalsUsed: string[];
    workersStarted: number;
  }
}

const ROOT = join(__dirname, '../..');
const RPC_URL = 'http://127.0.0.1:8545';
const CHALLENGE_WINDOW = 3 * 24 * 60 * 60;
// Anvil's unlocked account #1 pays the deposit and sends the exit
const PAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const DEPOSIT = ethers.parseEther('0.01');

const contract = () => process.env.LONGJING_CONTRACT!;
const gateway = () => process.env.LONGJING_GATEWAY!;

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const file =
      path === '/'
        ? null
        : path.startsWith('/longjing-client.')
          ? join(ROOT, 'build/browser', path.slice(1))
          : path.startsWith('/artifacts/')
            ? join(ROOT, 'circuits/build', path.slice('/artifacts/'.length))
            : undefined;
    if (file === null) {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><script src="/longjing-client.js"></script>');
      return;
    }
    try {
      if (!file || path.includes('..')) throw new Error('not found');
      const body = readFileSync(file);
      res.setHeader(
        'content-type',
        file.endsWith('js') ? 'text/javascript' : 'application/octet-stream',
      );
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

test.afterAll(
  () => new Promise<void>((resolve) => server.close(() => resolve())),
);

async function servePage(page: Page) {
  // Records any read of a Node global, and counts the Web Workers started
  await page.addInitScript(() => {
    window.nodeGlobalsUsed = [];
    for (const name of ['process', 'require', 'Buffer', 'global']) {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          window.nodeGlobalsUsed.push(name);
          return undefined;
        },
      });
    }
    window.workersStarted = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        window.workersStarted++;
      }
    };
  });
  await page.goto(`${origin}/`);
}

/** Sends a transaction from Anvil's unlocked account, from the page */
const SEND = `async (tx) => {
  const rpc = async (method, params) => {
    const res = await fetch('${RPC_URL}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  };
  const hash = await rpc('eth_sendTransaction', [{
    from: '${PAYER}',
    to: tx.to,
    data: tx.data,
    value: tx.value === undefined ? undefined : '0x' + tx.value.toString(16),
  }]);
  let receipt = null;
  for (let i = 0; !receipt && i < 100; i++) {
    receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (!receipt) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (receipt?.status !== '0x1') throw new Error('Transaction failed');
  return hash;
}`;

test('deposits, requests, receives and withdraws in a browser', async ({
  page,
}) => {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
    cacheTimeout: -1,
  });
  const credits = new ethers.Contract(
    contract(),
    [
      'function getNote(bytes32) view returns (tuple(uint256 amount, uint256 depositedAt, uint256 leafIndex, uint8 status))',
    ],
    provider,
  );
  await servePage(page);

  // Deposit: the page draws the note and sends deposit() itself
  const commitment = await page.evaluate(
    async ({ rpcUrl, address, deposit, send }) => {
      const L = window.Longjing;
      const note = L.newNote(rpcUrl, address);
      window.state = { note, send: (0, eval)(send) as unknown };
      const sendTx = window.state.send as (
        tx: Client.TransactionRequest,
      ) => Promise<string>;
      await sendTx(await L.depositTx(note, BigInt(deposit)));
      return L.commitmentOf(note);
    },
    {
      rpcUrl: RPC_URL,
      address: contract(),
      deposit: DEPOSIT.toString(),
      send: SEND,
    },
  );
  const [amount, , , status] = (await credits.getNote(commitment)) as bigint[];
  expect(amount).toBe(DEPOSIT);
  expect(status).toBe(1n);

  // Attestation: a tampered key, or a gateway outside a TEE, gets nothing
  const refusals = await page.evaluate(async (url) => {
    const L = window.Longjing;
    let posts = 0;
    const tampered = (
      tamper: (a: Client.Gateway['attestation']) => unknown,
    ): Client.GatewayTransport => {
      const inner = L.fetchTransport(url);
      return {
        ...inner,
        async request(request) {
          if (request.method === 'POST') posts++;
          const res = await inner.request(request);
          if (!request.path.startsWith('/attestation?')) return res;
          return {
            ...res,
            body: JSON.stringify(
              tamper(JSON.parse(res.body) as Client.Gateway['attestation']),
            ),
          };
        },
      };
    };
    const refused = async (
      transport: Client.GatewayTransport,
      development: boolean,
    ) => {
      try {
        const opened = await L.openGateway(transport, { development });
        await opened.post('/longjing/request', { probe: true });
        return '';
      } catch (error) {
        return error instanceof L.AttestationRefused
          ? (error as Error).message
          : `not refused: ${String(error)}`;
      }
    };
    const swapped = await refused(
      tampered((a) => ({
        ...a,
        keys: { ...a.keys, refundSignerPublicKey: { x: '0x01', y: '0x02' } },
      })),
      true,
    );
    const outsideTee = await refused(
      tampered((a) => a),
      false,
    );
    return { swapped, outsideTee, posts };
  }, gateway());
  expect(refusals.swapped).toContain('reportData does not commit');
  expect(refusals.outsideTee).toContain("A browser can't pin the TLS");
  expect(refusals.posts).toBe(0);

  // Artifacts that don't match circuits/artifacts.json are never proved with
  const mismatch = await page.evaluate(async () => {
    const L = window.Longjing;
    let proofs = 0;
    const client = L.createClient({
      artifacts: {
        request: {
          wasm: new Uint8Array([0, 97, 115, 109]),
          zkey: '/artifacts/request.zkey',
        },
        settlement: {
          wasm: '/artifacts/settlement_js/settlement.wasm',
          zkey: '/artifacts/settlement.zkey',
        },
      },
      prover: () => {
        proofs++;
        return Promise.reject(new Error('proved'));
      },
    });
    const error = await client
      .proveRequest(window.state.note as Client.NoteFile, 'hi')
      .then(() => null)
      .catch((e: Error) => e);
    return {
      name: error?.name,
      message: error?.message,
      proofs,
    };
  });
  expect(mismatch).toMatchObject({ name: 'ArtifactMismatch', proofs: 0 });

  // Request and receive, proved in a Web Worker, through the verified gateway
  const received = await page.evaluate(async (url) => {
    const L = window.Longjing;
    const client = L.createClient({
      artifacts: {
        request: {
          wasm: '/artifacts/request_js/request.wasm',
          zkey: '/artifacts/request.zkey',
        },
        settlement: {
          wasm: '/artifacts/settlement_js/settlement.wasm',
          zkey: '/artifacts/settlement.zkey',
        },
      },
    });
    window.state.client = client;
    const opened = await L.openGateway(L.fetchTransport(url), {
      development: true,
    });
    const proved = await client.proveRequest(
      window.state.note as Client.NoteFile,
      'What does 苟全性命於亂世 mean?',
    );
    const res = await opened.post('/longjing/request', proved.body);
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.json)}`);
    }
    const note = await client.receive(
      proved.note,
      res.json as Client.RequestResponse,
    );
    window.state.note = note;
    return { opening: note.opening, body: JSON.stringify(proved.body) };
  }, gateway());
  expect(received.opening.index).toBe('1');
  expect(BigInt(received.opening.refunds)).toBeGreaterThan(0n);

  // Withdrawal: proved in the page, initiated and finalized from it
  const recipient = ethers.Wallet.createRandom().address;
  const exit = await page.evaluate(async (to) => {
    const L = window.Longjing;
    const client = window.state.client as Client.LongjingClient;
    const note = window.state.note as Client.NoteFile;
    const send = window.state.send as (
      tx: Client.TransactionRequest,
    ) => Promise<string>;
    const args = await client.proveWithdrawal(note, to);
    await send(L.initiateWithdrawalTx(note, args));
    window.state.args = args;
    return args;
  }, recipient);
  expect(((await credits.getNote(commitment)) as bigint[])[3]).toBe(2n);

  await provider.send('evm_increaseTime', [CHALLENGE_WINDOW]);
  await provider.send('evm_mine', []);
  await page.evaluate(async () => {
    const L = window.Longjing;
    const send = window.state.send as (
      tx: Client.TransactionRequest,
    ) => Promise<string>;
    const args = window.state.args as Client.WithdrawalArgs;
    await send(
      L.finalizeWithdrawalTx(
        window.state.note as Client.NoteFile,
        args.commitment,
      ),
    );
  });
  expect(await provider.getBalance(recipient)).toBe(BigInt(exit.payout));
  expect(BigInt(exit.payout)).toBe(
    DEPOSIT + BigInt(received.opening.refunds) - (await cMax(provider)),
  );

  // The secret key never left the page, proofs ran in Workers, no Node global
  const secretKey = await page.evaluate(
    () => (window.state.note as Client.NoteFile).secretKey,
  );
  expect(received.body).not.toContain(secretKey);
  expect(received.body).not.toContain(BigInt(secretKey).toString(16));
  expect(await page.evaluate(() => window.workersStarted)).toBe(2);
  expect(await page.evaluate(() => window.nodeGlobalsUsed)).toEqual([]);
});

test('the ES module build exports the same client', async ({ page }) => {
  await servePage(page);
  const exported = await page.evaluate(async () => {
    const url = '/longjing-client.mjs';
    const module = (await import(url)) as typeof Client;
    return Object.keys(module).sort();
  });
  expect(exported).toEqual(
    await page.evaluate(() => Object.keys(window.Longjing).sort()),
  );
  expect(exported).toEqual(
    expect.arrayContaining([
      'commitmentOf',
      'createClient',
      'newNote',
      'nullifierAt',
      'openGateway',
    ]),
  );
});

async function cMax(provider: ethers.Provider): Promise<bigint> {
  const credits = new ethers.Contract(
    contract(),
    ['function C_MAX() view returns (uint256)'],
    provider,
  );
  return (await credits.C_MAX()) as bigint;
}
