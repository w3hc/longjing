import { BrowserContext, expect, Page, test } from '@playwright/test';
import { readFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { ethers } from 'ethers';
import {
  commitmentOf,
  depositTx,
  newNote,
  NoteFile,
  RequestResponse,
} from '../../src/client/note';
import { fetchTransport, openGateway } from '../../src/client/gateway';
import { proveRequest, receive } from '../../scripts/client/note';

/**
 * The withdrawal page, build/browser/withdraw.html, opened from disk in
 * Chromium: it initiates an exit, and finalizes it after the challenge
 * window from a fresh page given only the commitment. The payout goes to a
 * new address the page makes, or to one the user enters, whose history the
 * page warns about. Either way, another account sends both transactions and
 * the recipient never signs. Every request the page makes is recorded: none
 * goes to a host other than the RPC (or the mirror, when the files come
 * from one), and none carries the secret key, the accumulator's blinding,
 * the signer key or the new address's key.
 */

const ROOT = join(__dirname, '../..');
const PAGE = pathToFileURL(join(ROOT, 'build/browser/withdraw.html')).href;
const BUILD = join(ROOT, 'circuits/build');
const RPC_URL = 'http://127.0.0.1:8545';
const CHALLENGE_WINDOW = 3 * 24 * 60 * 60;
const DEPOSIT = ethers.parseEther('0.01');
// Anvil's accounts #3 (deposits), #4 (signs from the page), #5 (the wallet)
const DEPOSITOR_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const DEPOSITOR = new ethers.Wallet(DEPOSITOR_KEY).address;
const SIGNER_KEY =
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const SIGNER = new ethers.Wallet(SIGNER_KEY).address;
const WALLET = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';

const SETTLEMENT = {
  wasm: join(BUILD, 'settlement_js/settlement.wasm'),
  zkey: join(BUILD, 'settlement.zkey'),
};

const contract = () => process.env.LONGJING_CONTRACT!;
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
  cacheTimeout: -1,
});
const credits = () =>
  new ethers.Contract(
    contract(),
    [
      'function getNote(bytes32) view returns (tuple(uint256 amount, uint256 depositedAt, uint256 leafIndex, uint8 status))',
      'function C_MAX() view returns (uint256)',
    ],
    provider,
  );

interface Recorded {
  url: string;
  body: string;
}

/** Records every request of the context's pages and their workers */
function record(context: BrowserContext): Recorded[] {
  const requests: Recorded[] = [];
  context.on('request', (request) =>
    requests.push({ url: request.url(), body: request.postData() ?? '' }),
  );
  return requests;
}

/** The origins requested over the network, without the page itself */
function origins(requests: Recorded[]): string[] {
  const network = requests
    .map((r) => new URL(r.url))
    .filter((url) => url.protocol === 'http:' || url.protocol === 'https:');
  return [...new Set(network.map((url) => url.origin))];
}

/** A value's decimal and hex spellings, as a request could carry them */
function spellings(value: string | bigint): string[] {
  const n = BigInt(value);
  const hex = n.toString(16);
  return [n.toString(), hex, hex.padStart(64, '0')];
}

function expectNoneCarries(sent: string[], secrets: string[]) {
  for (const text of sent) {
    for (const secret of secrets) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  }
}

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.goto(PAGE);
  (page as Page & { problems: string[] }).problems = problems;
  return page;
}

const problemsOf = (page: Page) =>
  (page as Page & { problems: string[] }).problems;

async function deposit(): Promise<NoteFile> {
  const note = newNote(RPC_URL, contract());
  const depositor = new ethers.Wallet(DEPOSITOR_KEY, provider);
  await (
    await depositor.sendTransaction(await depositTx(note, DEPOSIT))
  ).wait();
  return note;
}

async function passChallengeWindow() {
  await provider.send('evm_increaseTime', [CHALLENGE_WINDOW]);
  await provider.send('evm_mine', []);
}

const statusOf = async (commitment: string) =>
  ((await credits().getNote(commitment)) as bigint[])[3];

test('withdraws a used note from disk, with an RPC and a signer key', async ({
  context,
}) => {
  // A note that made one request, so its opening and signature are real
  let note = await deposit();
  const gateway = await openGateway(
    fetchTransport(process.env.LONGJING_GATEWAY!),
    { development: true },
  );
  const proved = await proveRequest(note, 'What is Longjing tea?');
  const res = await gateway.post('/longjing/request', proved.body);
  expect(res.status).toBe(200);
  note = await receive(proved.note, res.json as RequestResponse);
  expect(note.opening.index).toBe('1');
  const commitment = await commitmentOf(note);
  const requests = record(context);
  const signerNonce = await provider.getTransactionCount(SIGNER);

  let page = await open(context);
  await page.fill('#rpc', RPC_URL);
  await page.fill('#signer', SIGNER_KEY);
  await page.fill('#note', JSON.stringify(note));
  await expect(page.locator('#contract')).toHaveValue(note.contract);
  await page.click('#read-note');
  await expect(page.locator('#note-status')).toContainText('status active');
  await expect(page.locator('#claimed')).toHaveValue('1');

  // A new address by default, whose key must be saved before proving
  await expect(page.locator('#pay-fresh')).toBeChecked();
  await expect(page.locator('#recipient')).toBeHidden();
  await expect(page.locator('#initiate')).toBeDisabled();
  const recipient = await page.inputValue('#fresh-address');
  const freshKey = await page.inputValue('#fresh-key');
  expect(new ethers.Wallet(freshKey).address).toBe(recipient);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#save-key'),
  ]);
  expect(download.suggestedFilename()).toBe(
    `longjing-recipient-${recipient}.json`,
  );
  const saved = JSON.parse(readFileSync(await download.path(), 'utf8')) as {
    address: string;
    privateKey: string;
  };
  expect(saved).toEqual({ address: recipient, privateKey: freshKey });
  await expect(page.locator('#initiate')).toBeDisabled();
  await page.check('#key-saved');
  await expect(page.locator('#initiate')).toBeEnabled();

  // A file that doesn't match its pinned hash is refused
  await page.setInputFiles(
    '#wasm-file',
    join(BUILD, 'request_js/request.wasm'),
  );
  await expect(page.locator('#wasm-status')).toContainText("doesn't match");
  await page.click('#initiate');
  await expect(page.locator('#initiate-status')).toContainText(
    'Load settlement.wasm and settlement.zkey first',
  );

  await page.setInputFiles('#wasm-file', SETTLEMENT.wasm);
  await page.setInputFiles('#zkey-file', SETTLEMENT.zkey);
  await expect(page.locator('#wasm-status')).toHaveText(
    'Matches the pinned sha256',
  );
  await expect(page.locator('#zkey-status')).toHaveText(
    'Matches the pinned sha256',
  );

  await page.click('#initiate');
  await expect(page.locator('#initiate-status')).toContainText('Initiated in', {
    timeout: 5 * 60_000,
  });
  expect(await statusOf(commitment)).toBe(2n);
  await expect(page.locator('#exit-status')).toContainText(
    'finalize after that',
  );
  await expect(page.locator('#finalize')).toBeDisabled();
  expect(problemsOf(page)).toEqual([]);
  await page.close();

  // Coming back later, with the commitment alone
  await passChallengeWindow();
  page = await open(context);
  await page.fill('#rpc', RPC_URL);
  await page.fill('#signer', SIGNER_KEY);
  await page.fill('#contract', contract());
  await page.fill('#commitment', commitment);
  await page.click('#check-exit');
  await expect(page.locator('#exit-status')).toContainText('ready to finalize');
  await page.click('#finalize');
  await expect(page.locator('#finalize-status')).toContainText('Finalized in');
  await expect(page.locator('#exit-status')).toContainText('The exit is final');
  expect(await statusOf(commitment)).toBe(3n);
  const cMax = (await credits().C_MAX()) as bigint;
  expect(await provider.getBalance(recipient)).toBe(
    DEPOSIT + BigInt(note.opening.refunds) - cMax,
  );
  // The signer sent both transactions, and the recipient never signed
  expect(await provider.getTransactionCount(SIGNER)).toBe(signerNonce + 2);
  expect(await provider.getTransactionCount(recipient)).toBe(0);
  expect(problemsOf(page)).toEqual([]);

  expect(origins(requests)).toEqual([new URL(RPC_URL).origin]);
  expectNoneCarries(
    requests.flatMap((r) => [r.url, r.body]),
    [
      ...spellings(note.secretKey),
      ...spellings(note.opening.blinding),
      SIGNER_KEY.slice(2),
      freshKey.slice(2),
    ],
  );
});

test('withdraws a never-used note through a browser wallet, with files from a mirror', async ({
  context,
}) => {
  const note = await deposit();
  const commitment = await commitmentOf(note);

  // A mirror of the release, served with CORS: /good/ holds the pinned
  // files, /bad/ a settlement.wasm that is another circuit
  const mirror: Server = createServer((req, res) => {
    const files: Record<string, string> = {
      '/good/settlement.wasm': SETTLEMENT.wasm,
      '/good/settlement.zkey': SETTLEMENT.zkey,
      '/bad/settlement.wasm': join(BUILD, 'request_js/request.wasm'),
      '/bad/settlement.zkey': SETTLEMENT.zkey,
    };
    const file = files[req.url ?? ''];
    res.setHeader('access-control-allow-origin', '*');
    if (!file) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => mirror.listen(0, '127.0.0.1', resolve));
  const mirrorUrl = `http://127.0.0.1:${(mirror.address() as AddressInfo).port}`;

  // An injected EIP-1193 wallet, like an extension: its calls reach Anvil
  // from the test, not from the page, and are recorded apart
  const walletCalls: string[] = [];
  await context.exposeFunction(
    'walletRequest',
    async (method: string, params: unknown[]) => {
      walletCalls.push(JSON.stringify({ method, params }));
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return [WALLET];
      }
      return provider.send(method, params) as Promise<unknown>;
    },
  );
  await context.addInitScript(() => {
    const call = (window as unknown as Record<string, unknown>)
      .walletRequest as (method: string, params: unknown[]) => unknown;
    (window as unknown as Record<string, unknown>).ethereum = {
      request: ({ method, params }: { method: string; params?: unknown[] }) =>
        call(method, params ?? []),
    };
  });
  const requests = record(context);

  let page = await open(context);
  await page.check('#mode-wallet');
  await expect(page.locator('#rpc')).toBeHidden();
  await page.fill('#note', JSON.stringify(note));
  await page.click('#read-note');
  await expect(page.locator('#note-status')).toContainText('status active');
  await expect(page.locator('#claimed')).toHaveValue('0');

  await page.fill('#mirror', `${mirrorUrl}/bad`);
  await page.click('#load-mirror');
  await expect(page.locator('#wasm-status')).toContainText("doesn't match");
  await page.fill('#mirror', `${mirrorUrl}/good/`);
  await page.click('#load-mirror');
  await expect(page.locator('#wasm-status')).toHaveText(
    'Matches the pinned sha256',
  );
  await expect(page.locator('#zkey-status')).toHaveText(
    'Matches the pinned sha256',
  );

  // An address of the user's own: one with a history is warned about,
  // read through the wallet
  const freshKey = await page.inputValue('#fresh-key');
  await page.check('#pay-own');
  await expect(page.locator('#fresh-key')).toBeHidden();
  await expect(page.locator('#initiate')).toBeEnabled();
  await page.fill('#recipient', DEPOSITOR);
  await page.locator('#recipient').blur();
  await expect(page.locator('#recipient-status')).toContainText('its nonce is');
  const recipient = ethers.Wallet.createRandom().address;
  await page.fill('#recipient', recipient);
  await page.locator('#recipient').blur();
  await expect(page.locator('#recipient-status')).toHaveText(
    `${recipient} has never sent a transaction and holds nothing`,
  );
  await page.click('#initiate');
  await expect(page.locator('#initiate-status')).toContainText('Initiated in', {
    timeout: 5 * 60_000,
  });
  expect(await statusOf(commitment)).toBe(2n);
  expect(problemsOf(page)).toEqual([]);
  await page.close();

  await passChallengeWindow();
  page = await open(context);
  await page.check('#mode-wallet');
  await page.fill('#contract', contract());
  await page.fill('#commitment', commitment);
  await page.click('#check-exit');
  await expect(page.locator('#exit-status')).toContainText('ready to finalize');
  await page.click('#finalize');
  await expect(page.locator('#finalize-status')).toContainText('Finalized in');
  expect(await statusOf(commitment)).toBe(3n);
  expect(await provider.getBalance(recipient)).toBe(DEPOSIT);
  expect(await provider.getTransactionCount(recipient)).toBe(0);
  expect(problemsOf(page)).toEqual([]);

  await new Promise<void>((resolve) => mirror.close(() => resolve()));
  const sent = walletCalls.filter((call) =>
    call.includes('eth_sendTransaction'),
  );
  expect(sent).toHaveLength(2);
  for (const call of sent) {
    const { params } = JSON.parse(call) as { params: { from: string }[] };
    expect(ethers.getAddress(params[0].from)).toBe(WALLET);
  }
  expect(
    walletCalls.some(
      (call) =>
        call.includes('eth_getTransactionCount') &&
        call.toLowerCase().includes(DEPOSITOR.toLowerCase()),
    ),
  ).toBe(true);
  expect(origins(requests)).toEqual([mirrorUrl]);
  expectNoneCarries(
    [...requests.flatMap((r) => [r.url, r.body]), ...walletCalls],
    [...spellings(note.secretKey), freshKey.slice(2)],
  );
});
