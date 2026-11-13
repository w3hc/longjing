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
 * - an attacker, who holds deposits and cheats
 *
 * 1. Deploy LongjingCredits with NODE_ENV=development, or use the deployed one
 * 2. Start the server pointed at it, or use the gateway
 * 3. Alice's client verifies the gateway's attestation, with a fresh nonce,
 *    before it sends anything; an attacker on the path swaps a key or
 *    replays an old attestation, and the client sends nothing
 * 4. Alice deposits and sends a request, proved on her machine
 *    (scripts/client/note.ts, what pnpm prove runs)
 * 5. Alice retries it, then sends a second request from the signed accumulator
 * 6. The operator tries to link Alice's requests to each other and to her
 *    deposit; the observer looks for her requests onchain
 * 7. The attacker double-spends, and a wallet that is not serverAddress
 *    slashes them with the revealed key
 * 8. The attacker exits claiming fewer requests than they made, and the
 *    operator slashes the exit with the signal it stored
 * 9. Alice exits: the attacker can't redirect her payout, she proves the
 *    withdrawal herself, and it pays D + R − n · C_MAX after the window
 * 10. Alice's closed note can make no request, and no request body contained
 *     a secret key
 * 11. serverAddress (on Anvil) or the demo wallet withdraws the operator's
 *     balance, which goes to operatorPayout, not the caller
 *
 * On Anvil, the server answers with mock responses: ANTHROPIC_API_KEY is
 * ignored, and the challenge window passes with evm_increaseTime. Against a
 * deployment, the requests reach the provider and cost what they cost, and
 * Alice's exit stays pending until finalizeWithdrawal after the window.
 */

import { parseArgs } from 'util';
import { ethers } from 'ethers';
import type { INestApplication } from '@nestjs/common';
import {
  commitmentOf,
  newNote,
  NOTE_ABI,
  NoteFile,
  proveRequest,
  proveWithdrawal,
  receive,
  RequestBody,
  RequestResponse,
  WithdrawalArgs,
} from '../client/note';
import { SlashingService } from '../../src/longjing/slashing.service';
import {
  AttestationRefused,
  Gateway,
  GatewayRequest,
  GatewayTransport,
  openGateway,
} from '../../src/client/gateway';
import { nodeTransport } from '../client/transport';
import type { BoundAttestation } from '../../src/attestation/attestation.types';
import {
  ANVIL_RPC_URL as RPC_URL,
  deployLocal,
  startLocalGateway,
} from '../testing/local-gateway';

const anvilKey = (index: number) =>
  ethers.HDNodeWallet.fromPhrase(
    'test test test test test test test test test test test junk',
    undefined,
    `m/44'/60'/0'/0/${index}`,
  ).privateKey;
// Anvil account #1 pays; #0 deploys and is serverAddress; #2 is a wallet of the operator's that is not serverAddress
const SERVER_KEY = anvilKey(0);
const ALICE_KEY = anvilKey(1);
const SLASHER_KEY = anvilKey(2);
const CHALLENGE_WINDOW = 3 * 24 * 60 * 60;
const PAYLOAD = 'What does 苟全性命於亂世，不求聞達於諸侯。mean?';
const PAYLOAD_2 = 'Who wrote 出師表?';
const PAYLOAD_ATTACKER = 'What does 鞠躬盡瘁 mean?';
const PAYLOAD_DOUBLE = 'What does 死而後已 mean?';
// The same for every request at a given time, so it identifies no one
const SHARED_BY_DESIGN = new Set(['merkleRoot']);
const ISSUES = 'https://github.com/w3hc/longjing/issues';

const ABI = [
  ...NOTE_ABI,
  'function SLASH_BOUNTY() view returns (uint256)',
  'function serverAddress() view returns (address)',
  'function operatorPayout() view returns (address)',
  'function operatorBalance() view returns (uint256)',
  'function withdrawOperatorBalance()',
  'function getLeaves() view returns (bytes32[])',
  'function leaves(uint256) view returns (bytes32)',
  'event Deposited(bytes32 indexed commitment, uint256 amount, uint256 leafIndex)',
  'event WithdrawalInitiated(bytes32 indexed commitment, uint256 nullifier, uint256 signalX, uint256 signalY, uint256 payout, address indexed recipient, uint256 exitAt)',
  'error InvalidProof()',
];

const Status = { Active: 1n, Exiting: 2n, Closed: 3n, Slashed: 4n } as const;

type GoalStatus = 'verified' | 'not met' | 'not checked yet';

interface Goal {
  label: string;
  expected: GoalStatus;
  issues?: number[];
  status?: GoalStatus;
  detail?: string;
}

const goal = (
  label: string,
  expected: GoalStatus,
  issues?: number[],
  detail?: string,
): Goal => ({ label, expected, issues, detail });

const goals = {
  deposit: goal(
    'A deposit is recorded onchain, bound into its leaf',
    'verified',
  ),
  root: goal('A request proof is against a recent onchain root', 'verified'),
  nullifier: goal(
    'A retry returns the same accumulator, a reused index is refused',
    'verified',
  ),
  refund: goal(
    'The accumulator grows by C_max − C_actual, signed by the key registered onchain',
    'verified',
  ),
  requestToDeposit: goal(
    "A request can't be linked to the deposit",
    'verified',
  ),
  requestToRequest: goal(
    "Two requests can't be linked to each other",
    'verified',
  ),
  refundOnchain: goal("A request's refund never appears onchain", 'verified'),
  withdrawalRecipient: goal(
    'A withdrawal pays only the recipient in its proof',
    'verified',
  ),
  solvency: goal(
    'Solvency is enforced: an exit pays D + R − n · C_max',
    'verified',
  ),
  slashing: goal(
    'Anyone holding k slashes, and the caller gets the bounty, not the stake',
    'verified',
  ),
  understatedExit: goal(
    'An exit that understates usage is slashed during the window',
    'verified',
  ),
  operatorPayout: goal(
    "The operator's balance goes only to its payout address, whoever withdraws it",
    'verified',
  ),
  closedNote: goal("A closed note can't make requests", 'verified'),
  secretKey: goal(
    'The client sends nothing that contains the secret key',
    'verified',
  ),
  attestation: goal(
    'The client verifies the attestation before sending anything',
    'verified',
  ),
  tlsKeyExchange: goal(
    "An eavesdropper's recording needs both the classical and the ML-KEM key exchange broken",
    'not checked yet',
    undefined,
    'the demo runs over plain HTTP',
  ),
  provider: goal(
    'Protocol, pricing and refunds work with any provider',
    'not checked yet',
  ),
  withdrawal: goal('A depositor can withdraw without the server', 'verified'),
  walkaway: goal(
    'Every depositor can exit if the operator and every host disappear',
    'not met',
    [135],
    'the withdrawal page is in no release yet, on single-party keys',
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

const MARKS: Record<GoalStatus, string> = {
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
      deposit: { type: 'string', default: '0.01' },
    },
  });
  const deposit = ethers.parseEther(values.deposit);
  const { gateway, contract, rpc } = values;
  if (!gateway && !contract && !rpc) {
    return {
      rpcUrl: RPC_URL,
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
    aliceKey,
    slasherKey: process.env.DEMO_SLASHER_PRIVATE_KEY ?? aliceKey,
    deposit,
  };
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
    address = await deployLocal();
    console.log(`  LongjingCredits at ${address}`);
    step('2. Start the server pointed at it');
    app = await startLocalGateway(address);
    url = await app.getUrl();
    console.log(`  Listening on ${url}`);
  }
  const onAnvil = !options.gateway;
  const alice = new ethers.Wallet(options.aliceKey, provider);
  const contract = new ethers.Contract(address, ABI, alice);
  const cMax = (await contract.C_MAX()) as bigint;
  const sent: string[] = [];
  const secrets: bigint[] = [];
  // On Anvil, the local server attests with the mock platform over HTTP
  const development = onAnvil;
  let gateway: Gateway | undefined;
  const post = async (body: RequestBody) => {
    sent.push(JSON.stringify(body));
    return required(gateway, 'verified gateway').post(
      '/longjing/request',
      body,
    );
  };
  const open = async () => {
    const note = newNote(options.rpcUrl, address);
    secrets.push(BigInt(note.secretKey));
    await (
      await contract.deposit(await commitmentOf(note), {
        value: options.deposit,
      })
    ).wait();
    return note;
  };
  const statusOf = async (note: NoteFile) =>
    ((await contract.getNote(await commitmentOf(note))) as bigint[])[3];
  const commitments = async () =>
    new Set(
      (await contract.queryFilter(contract.filters.Deposited())).map((e) =>
        BigInt((e as ethers.EventLog).args[0] as string).toString(),
      ),
    );

  try {
    step(
      "3. Alice's client verifies the attestation, and refuses a tampered one",
    );
    await verify(goals.attestation, async () => {
      const seen: GatewayRequest[] = [];
      const recording = (
        tamper?: (attestation: BoundAttestation) => BoundAttestation,
      ): GatewayTransport => {
        const inner = nodeTransport(url);
        return {
          host: inner.host,
          secure: inner.secure,
          async request(request) {
            seen.push(request);
            const res = await inner.request(request);
            return tamper && request.path.startsWith('/attestation?')
              ? {
                  ...res,
                  body: JSON.stringify(
                    tamper(JSON.parse(res.body) as BoundAttestation),
                  ),
                }
              : res;
          },
        };
      };
      const posts = () => seen.filter((r) => r.method === 'POST').length;
      // Opens the gateway and sends a request through it; true if refused
      // with nothing sent
      const refuses = async (
        transport: GatewayTransport,
        dev = development,
      ) => {
        const before = posts();
        try {
          const opened = await openGateway(transport, { development: dev });
          await opened.post('/longjing/request', { probe: true });
          return false;
        } catch (error) {
          return error instanceof AttestationRefused && posts() === before;
        }
      };

      gateway = await openGateway(recording(), { development });
      const first = seen[0];
      check(
        goals.attestation,
        'the first request is GET /attestation with a fresh 32-byte nonce',
        first?.method === 'GET' &&
          /^\/attestation\?nonce=[0-9a-f]{64}$/.test(first.path) &&
          first.path.endsWith(gateway.attestation.nonce!.slice(2)),
        first?.path,
      );
      check(
        goals.attestation,
        'the honest gateway is accepted before anything is sent',
        posts() === 0,
      );
      const honest = gateway.attestation;

      check(
        goals.attestation,
        'an attestation with a swapped refund key is refused, nothing sent',
        await refuses(
          recording((a) => ({
            ...a,
            keys: {
              ...a.keys,
              refundSignerPublicKey: { x: '0x01', y: '0x02' },
            },
          })),
        ),
      );
      check(
        goals.attestation,
        'an attestation replayed for an earlier nonce is refused, nothing sent',
        await refuses(recording(() => honest)),
      );
      if (development) {
        check(
          goals.attestation,
          'outside development, a gateway not in a TEE is refused, nothing sent',
          await refuses(recording(), false),
        );
      }
      console.log(
        development
          ? '    (mock platform: the quote signature is not checked on Anvil)'
          : `    ${honest.platform} quote over TLS, onion service ${honest.onionAddress ?? 'none'}`,
      );
    });

    step('4. Alice deposits and sends a request, proved on her machine');
    let note: NoteFile | undefined;
    let firstBody: RequestBody | undefined;
    let firstResponse: RequestResponse | undefined;
    const firstBlock = await provider.getBlockNumber();
    await verify(goals.deposit, async () => {
      note = await open();
      const commitment = await commitmentOf(note);
      const [amount, , leafIndex] = (await contract.getNote(
        commitment,
      )) as bigint[];
      check(
        goals.deposit,
        'the note holds the whole deposit',
        amount === options.deposit,
      );
      const poseidonLeaf = await contract.leaves(leafIndex);
      check(
        goals.deposit,
        'its leaf is computed onchain from the deposit',
        BigInt(poseidonLeaf as string) !== 0n &&
          BigInt(poseidonLeaf as string) !== BigInt(commitment),
      );
    });
    await verify(goals.root, async () => {
      const proved = await proveRequest(required(note, 'note'), PAYLOAD);
      note = proved.note;
      firstBody = proved.body;
      check(
        goals.root,
        "the proof's root is the contract's latest",
        BigInt(firstBody.merkleRoot) ===
          BigInt((await contract.merkleRoot()) as string),
      );
      const res = await post(firstBody);
      check(
        goals.root,
        'the server accepts it',
        res.status === 200,
        `HTTP ${res.status} ${JSON.stringify(res.json)}`,
      );
      firstResponse = res.json as RequestResponse;
    });
    await verify(goals.refund, async () => {
      const response = required(firstResponse, 'response');
      const refund = BigInt(response.refund);
      check(
        goals.refund,
        'the refund is C_max − C_actual, between 0 and C_max',
        refund > 0n && refund <= cMax,
        `${refund} wei`,
      );
      // receive() checks A' = A_pub + v·G + J and the signature against the onchain key
      note = await receive(required(note, 'note'), response);
      check(
        goals.refund,
        'the signed accumulator adds up',
        note.opening.index === '1',
      );
    });

    step('5. Alice retries her request, then sends a second one');
    await verify(goals.nullifier, async () => {
      const retry = await post(required(firstBody, 'request'));
      check(
        goals.nullifier,
        'a retry gets the same accumulator back',
        retry.status === 200 &&
          JSON.stringify(retry.json.accumulator) ===
            JSON.stringify(required(firstResponse, 'response').accumulator),
        `HTTP ${retry.status}`,
      );
    });
    let secondBody: RequestBody | undefined;
    await verify(goals.requestToRequest, async () => {
      const proved = await proveRequest(required(note, 'note'), PAYLOAD_2);
      secondBody = proved.body;
      const res = await post(secondBody);
      if (res.status !== 200) {
        throw new Error(
          `the second request failed: HTTP ${res.status} ${JSON.stringify(res.json)}`,
        );
      }
      note = await receive(proved.note, res.json as RequestResponse);
    });

    step("6. The operator and the observer try to link Alice's requests");
    await verify(goals.requestToRequest, async () => {
      const first = publicFields(required(firstBody, 'request') as never);
      const second = publicFields(required(secondBody, 'request') as never);
      const shared = [...first]
        .filter(([k, v]) => !SHARED_BY_DESIGN.has(k) && second.get(k) === v)
        .map(([k]) => k);
      check(
        goals.requestToRequest,
        'the two requests share no value',
        shared.length === 0,
        `both carry the same ${shared.join(', ')}`,
      );
    });
    await verify(goals.requestToDeposit, async () => {
      const known = await commitments();
      const leaves = ((await contract.getLeaves()) as string[]).map((l) =>
        BigInt(l).toString(),
      );
      const linked = [
        ...publicFields(required(firstBody, 'request') as never),
        ...publicFields(required(secondBody, 'request') as never),
      ]
        .filter(
          ([, v]) =>
            known.has(v) ||
            (v !== '0' && leaves.includes(v)) ||
            v === options.deposit.toString(),
        )
        .map(([k]) => k);
      check(
        goals.requestToDeposit,
        'no request carries a commitment, a leaf or the deposit',
        linked.length === 0,
        `${linked.join(', ')} match a deposit`,
      );
      if (!app) return;
      // On Anvil, the operator's database is in this process
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { NullifierStoreService } =
        require('../../src/longjing/nullifier-store.service') as typeof import('../../src/longjing/nullifier-store.service');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const stored = app
        .get(NullifierStoreService)
        .get(BigInt(required(firstBody, 'request').nullifier).toString());
      const extra = Object.keys(stored ?? {}).filter(
        (k) => !['x', 'y'].includes(k),
      );
      check(
        goals.requestToDeposit,
        "the operator's database stores only (x, y) under the nullifier",
        !!stored && extra.length === 0,
        stored ? `it stores ${extra.join(', ')}` : 'nothing stored',
      );
    });
    await verify(goals.refundOnchain, async () => {
      const logs = await provider.getLogs({
        address,
        fromBlock: firstBlock + 2,
      });
      check(
        goals.refundOnchain,
        "the contract logged nothing while Alice's requests were served",
        logs.length === 0,
        `${logs.length} events`,
      );
    });

    step(
      '7. The attacker double-spends, a wallet that is not serverAddress slashes them',
    );
    await verify(goals.slashing, async () => {
      const attacker = await open();
      const a = await proveRequest(attacker, PAYLOAD_ATTACKER);
      const b = await proveRequest(attacker, PAYLOAD_DOUBLE);
      if ((await post(a.body)).status !== 200) {
        throw new Error("the attacker's first request failed");
      }
      const res = await post(b.body);
      const refused =
        res.status === 403 &&
        String(res.json.message).startsWith('Double-spend detected');
      check(
        goals.nullifier,
        'a second signal at a used index is refused',
        refused,
        `HTTP ${res.status} ${res.json.message}`,
      );
      check(
        goals.slashing,
        'the server treats it as a double-spend',
        refused,
        `HTTP ${res.status} ${res.json.message}`,
      );
      const k = SlashingService.recoverSecretKey(
        { x: BigInt(a.body.signal.x), y: BigInt(a.body.signal.y) },
        { x: BigInt(b.body.signal.x), y: BigInt(b.body.signal.y) },
      );
      check(
        goals.slashing,
        "the two signals reveal the attacker's secret key",
        k === BigInt(attacker.secretKey),
      );

      const slasher = new ethers.Wallet(options.slasherKey, provider);
      check(
        goals.slashing,
        'the slashing wallet is not serverAddress',
        slasher.address !== (await contract.serverAddress()),
      );
      const before = await provider.getBalance(slasher.address);
      const receipt = (await (
        await (contract.connect(slasher) as ethers.Contract).slash(k)
      ).wait()) as ethers.TransactionReceipt;
      const reward =
        (await provider.getBalance(slasher.address)) -
        before +
        receipt.gasUsed * receipt.gasPrice;
      const bounty = (await contract.SLASH_BOUNTY()) as bigint;
      check(
        goals.slashing,
        'the slashing wallet gets the bounty, not the deposit',
        reward === (bounty < options.deposit ? bounty : options.deposit),
        `${reward} wei`,
      );
      check(
        goals.slashing,
        "the attacker's note is slashed",
        (await statusOf(attacker)) === Status.Slashed,
      );
    });

    step('8. The attacker exits claiming fewer requests than they made');
    if (!app) {
      goals.understatedExit.status = 'not checked yet';
      goals.understatedExit.detail = "needs the operator's database";
    } else {
      await verify(goals.understatedExit, async () => {
        let attacker = await open();
        const served = await proveRequest(attacker, PAYLOAD_ATTACKER);
        attacker = await receive(
          served.note,
          (await post(served.body)).json as RequestResponse,
        );
        // Index 1 is served, then the attacker exits claiming n = 1
        const unanswered = await proveRequest(attacker, PAYLOAD_DOUBLE);
        await post(unanswered.body);
        const args = await proveWithdrawal(
          attacker,
          ethers.Wallet.createRandom().address,
          1n,
        );
        await initiate(contract, args);

        // The operator finds the exit's nullifier in its database
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { NullifierStoreService } =
          require('../../src/longjing/nullifier-store.service') as typeof import('../../src/longjing/nullifier-store.service');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const stored = app!
          .get(NullifierStoreService)
          .get(BigInt(unanswered.body.nullifier).toString());
        const exitSignalX = (await contract.withdrawalSignalX(
          args.recipient,
        )) as bigint;
        check(
          goals.understatedExit,
          'the exit reuses the nullifier of a served request',
          !!stored &&
            BigInt(args.nullifier) === BigInt(unanswered.body.nullifier),
        );
        const k = SlashingService.recoverSecretKey(
          { x: BigInt(stored!.x), y: BigInt(stored!.y) },
          { x: exitSignalX, y: BigInt(args.signalY) },
        );
        const slasher = new ethers.Wallet(options.slasherKey, provider);
        await (
          await (contract.connect(slasher) as ethers.Contract).slash(k)
        ).wait();
        check(
          goals.understatedExit,
          'the operator slashes it within the window',
          (await statusOf(attacker)) === Status.Slashed,
        );
      });
    }

    step('9. Alice exits, with a withdrawal she proves herself');
    let exit: WithdrawalArgs | undefined;
    await verify(goals.withdrawalRecipient, async () => {
      const recipient = ethers.Wallet.createRandom().address;
      exit = await proveWithdrawal(required(note, 'note'), recipient);
      const thief = ethers.Wallet.createRandom().address;
      const swapped = await revertOf(
        contract.initiateWithdrawal.staticCall(
          exit.commitment,
          thief,
          exit.refundKey,
          exit.proof,
          exit.nullifier,
          exit.signalY,
          exit.payout,
        ),
      );
      check(
        goals.withdrawalRecipient,
        "the attacker can't redirect Alice's payout to themselves",
        swapped === 'InvalidProof',
        swapped || 'it succeeded',
      );
    });
    await verify(goals.withdrawal, async () => {
      const args = required(exit, 'withdrawal proof');
      // Nothing from here on touches the server
      await app?.close();
      app = undefined;
      await initiate(contract, args);
      check(
        goals.withdrawal,
        'the exit starts with the chain and a client-side proof alone',
        (await statusOf(required(note, 'note'))) === Status.Exiting,
      );
      if (!onAnvil) {
        console.log(
          '  – finalizeWithdrawal pays out after the challenge window',
        );
        return;
      }
      await provider.send('evm_increaseTime', [CHALLENGE_WINDOW]);
      await provider.send('evm_mine', []);
      await (await contract.finalizeWithdrawal(args.commitment)).wait();
      check(
        goals.withdrawal,
        'it pays out after the window',
        (await provider.getBalance(args.recipient)) === BigInt(args.payout),
      );
      check(
        goals.withdrawal,
        'another wallet sent both transactions: the recipient never signed',
        (await provider.getTransactionCount(args.recipient)) === 0,
      );
    });
    await verify(goals.solvency, async () => {
      const args = required(exit, 'withdrawal proof');
      const expected =
        options.deposit +
        BigInt(required(note, 'note').opening.refunds) -
        2n * cMax;
      check(
        goals.solvency,
        'the payout is D + R − n · C_max for her two requests',
        BigInt(args.payout) === expected,
        `${args.payout} wei, expected ${expected}`,
      );
    });

    step("10. Alice's note is closed, and no body carried a secret key");
    await verify(goals.closedNote, async () => {
      const refused = await proveRequest(required(note, 'note'), 'One more?')
        .then(() => '')
        .catch((error: Error) => error.message);
      check(
        goals.closedNote,
        'no request can be proved against the closed note',
        refused.includes('not active'),
        refused || 'a proof was made',
      );
    });
    await verify(goals.secretKey, async () => {
      const forms = secrets.flatMap((k) => [k.toString(), k.toString(16)]);
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

    step(
      onAnvil
        ? "11. serverAddress withdraws the operator's balance"
        : "11. The demo wallet withdraws the operator's balance",
    );
    await verify(goals.operatorPayout, async () => {
      const caller = onAnvil ? new ethers.Wallet(SERVER_KEY, provider) : alice;
      const payout = (await contract.operatorPayout()) as string;
      const balance = (await contract.operatorBalance()) as bigint;
      if (onAnvil) {
        check(
          goals.operatorPayout,
          'the caller is serverAddress',
          caller.address === (await contract.serverAddress()),
        );
      }
      check(
        goals.operatorPayout,
        'the caller is not the payout address',
        caller.address !== payout,
      );
      check(
        goals.operatorPayout,
        'the slashes left a balance to withdraw',
        balance > 0n,
      );
      const payoutBefore = await provider.getBalance(payout);
      const callerBefore = await provider.getBalance(caller.address);
      const receipt = (await (
        await (
          contract.connect(caller) as ethers.Contract
        ).withdrawOperatorBalance()
      ).wait()) as ethers.TransactionReceipt;
      const received = (await provider.getBalance(payout)) - payoutBefore;
      const callerGain =
        (await provider.getBalance(caller.address)) -
        callerBefore +
        receipt.gasUsed * receipt.gasPrice;
      check(
        goals.operatorPayout,
        'the payout address gets the whole balance',
        received === balance,
        `${received} wei of ${balance}`,
      );
      check(
        goals.operatorPayout,
        'the caller gets nothing',
        callerGain === 0n,
        `${callerGain} wei`,
      );
      check(
        goals.operatorPayout,
        'the operator balance is empty',
        ((await contract.operatorBalance()) as bigint) === 0n,
      );
    });
  } finally {
    await app?.close();
  }

  return report();
}

async function initiate(contract: ethers.Contract, args: WithdrawalArgs) {
  await (
    (await contract.initiateWithdrawal(
      args.commitment,
      args.recipient,
      args.refundKey,
      args.proof,
      args.nullifier,
      args.signalY,
      args.payout,
    )) as ethers.ContractTransactionResponse
  ).wait();
}

// snarkjs keeps worker threads alive, so exit explicitly
main()
  .then((regressed) => process.exit(regressed ? 1 : 0))
  .catch((error: unknown) => {
    console.error(`\n  ✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
