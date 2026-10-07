/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
/**
 * Client side of a note (docs/SETTLEMENT.md): the secret key and the
 * accumulator opening never leave the user's machine. Proves requests and
 * withdrawals, and folds each server response into the opening.
 */

import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import { buildEddsa, buildPoseidon } from 'circomlibjs';
import {
  applyRefund,
  commit,
  FIELD_MODULUS,
  Point,
  rerandomize,
  SUBGROUP_ORDER,
} from '../../src/longjing/accumulator';
import { payloadSignalX } from '../../src/longjing/utils/payload-signal.util';

// snarkjs ships no type declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snarkjs = require('snarkjs') as {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string,
      zkey: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    exportSolidityCallData(
      proof: Groth16Proof,
      publicSignals: string[],
    ): Promise<string>;
  };
};

interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

export const NOTE_ABI = [
  'function C_MAX() view returns (uint256)',
  'function merkleRoot() view returns (bytes32)',
  'function serverPublicKey() view returns (bytes32 x, bytes32 y)',
  'function getNote(bytes32) view returns (tuple(uint256 amount, uint256 depositedAt, uint256 leafIndex, uint8 status))',
  'function getMerkleProof(uint256) view returns (bytes32[20] pathElements, uint8[20] pathIndices)',
  'function withdrawalSignalX(address) view returns (uint256)',
  'function deposit(bytes32) payable',
  'function initiateWithdrawal(bytes32 commitment, address recipient, tuple(bytes32 x, bytes32 y) refundKey, uint256[8] proof, uint256 nullifier, uint256 signalY, uint256 payout)',
  'function finalizeWithdrawal(bytes32 commitment)',
  'function slash(uint256 secretKey)',
];

export interface Signature {
  R8x: string;
  R8y: string;
  S: string;
}

/** Everything a note's owner keeps, as decimal strings */
export interface NoteFile {
  secretKey: string;
  rpcUrl: string;
  contract: string;
  opening: { refunds: string; index: string; blinding: string };
  // The server's signature on the accumulator and the key that made it,
  // absent for the genesis accumulator
  signature: Signature | null;
  signedBy: { x: string; y: string } | null;
  // The request in flight, sent again as is if its response was lost
  pending: { rerandomizer: string; body: RequestBody } | null;
}

export interface RequestBody {
  payload: string;
  nonce: string;
  nullifier: string;
  signal: { x: string; y: string };
  proof: string;
  merkleRoot: string;
  accumulator: { x: string; y: string };
  model?: string;
}

/** What POST /longjing/request answers, or the body of its 502 */
export interface RequestResponse {
  refund: string;
  accumulator: { x: string; y: string; signature: Signature };
}

export interface WithdrawalArgs {
  commitment: string;
  recipient: string;
  refundKey: { x: string; y: string };
  proof: string[];
  nullifier: string;
  signalY: string;
  payout: string;
}

const BUILD = 'circuits/build';

const randomBelow = (bound: bigint) =>
  BigInt('0x' + randomBytes(48).toString('hex')) % bound;

let poseidonPromise: Promise<(inputs: bigint[]) => bigint> | undefined;
const poseidon = () =>
  (poseidonPromise ??= buildPoseidon().then(
    (p: any) => (inputs: bigint[]) => p.F.toObject(p(inputs)),
  ));

export function newNote(rpcUrl: string, contract: string): NoteFile {
  return {
    secretKey: randomBelow(FIELD_MODULUS).toString(),
    rpcUrl,
    contract,
    opening: { refunds: '0', index: '0', blinding: '0' },
    signature: null,
    signedBy: null,
    pending: null,
  };
}

/** c = Poseidon(k), what deposit() takes */
export async function commitmentOf(note: NoteFile): Promise<string> {
  const c = (await poseidon())([BigInt(note.secretKey)]);
  return ethers.toBeHex(c, 32);
}

function contractOf(note: NoteFile, runner?: ethers.ContractRunner) {
  return new ethers.Contract(
    note.contract,
    NOTE_ABI,
    runner ?? new ethers.JsonRpcProvider(note.rpcUrl),
  );
}

async function onchainNote(note: NoteFile, contract: ethers.Contract) {
  const commitment = await commitmentOf(note);
  const [amount, , leafIndex, status] = (await contract.getNote(
    commitment,
  )) as [bigint, bigint, bigint, bigint];
  if (status !== 1n) throw new Error(`Note ${commitment} is not active`);
  return { commitment, amount, leafIndex };
}

async function serverKey(contract: ethers.Contract) {
  const [x, y] = (await contract.serverPublicKey()) as [string, string];
  return { x: BigInt(x).toString(), y: BigInt(y).toString() };
}

function accumulatorInputs(note: NoteFile) {
  return {
    isGenesis: note.signature ? '0' : '1',
    refunds: note.opening.refunds,
    index: note.opening.index,
    blinding: note.opening.blinding,
    // Genesis takes a dummy signature, which the circuit doesn't check
    signatureR8x: note.signature?.R8x ?? '0',
    signatureR8y: note.signature?.R8y ?? '1',
    signatureS: note.signature?.S ?? '0',
  };
}

const openingOf = (note: NoteFile, commitment: bigint) => ({
  refunds: BigInt(note.opening.refunds),
  index: BigInt(note.opening.index),
  commitment,
  blinding: BigInt(note.opening.blinding),
});

/**
 * Proves the note's next request. While a request is pending, returns its
 * body again: a retry must carry the same signal.
 */
export async function proveRequest(
  note: NoteFile,
  payload: string,
  model?: string,
): Promise<{ body: RequestBody; note: NoteFile }> {
  if (note.pending) return { body: note.pending.body, note };

  const contract = contractOf(note);
  const { amount, leafIndex } = await onchainNote(note, contract);
  const [pathElements, pathIndices] = (await contract.getMerkleProof(
    leafIndex,
  )) as [string[], bigint[]];
  const [root, cMax, key] = await Promise.all([
    contract.merkleRoot() as Promise<string>,
    contract.C_MAX() as Promise<bigint>,
    serverKey(contract),
  ]);

  const nonce = randomBelow(FIELD_MODULUS);
  const rerandomizer = randomBelow(SUBGROUP_ORDER);
  const signalX = await payloadSignalX(payload, nonce);
  const dec = (v: bigint | string) => BigInt(v).toString();

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      secretKey: note.secretKey,
      deposit: dec(amount),
      merklePathElements: pathElements.map(dec),
      merklePathIndices: pathIndices.map(dec),
      ...accumulatorInputs(note),
      rerandomizer: dec(rerandomizer),
      merkleRoot: dec(root),
      maxCost: dec(cMax),
      signalX: dec(signalX),
      serverPublicKeyX: key.x,
      serverPublicKeyY: key.y,
    },
    `${BUILD}/request_js/request.wasm`,
    `${BUILD}/request.zkey`,
  );
  // [nullifier, signalY, accumulatorX, accumulatorY, merkleRoot, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]
  const [nullifier, signalY, accumulatorX, accumulatorY] = publicSignals;

  // Wire format: projective coordinates, pi_b pairs swapped
  const wire = {
    pi_a: [proof.pi_a[0], proof.pi_a[1], '1'],
    pi_b: [
      [proof.pi_b[0][1], proof.pi_b[0][0], '1'],
      [proof.pi_b[1][1], proof.pi_b[1][0], '1'],
    ],
    pi_c: [proof.pi_c[0], proof.pi_c[1], '1'],
    protocol: 'groth16',
  };

  const body: RequestBody = {
    payload,
    nonce: nonce.toString(),
    nullifier,
    signal: { x: signalX.toString(), y: signalY },
    proof: JSON.stringify(wire),
    merkleRoot: dec(root),
    accumulator: { x: accumulatorX, y: accumulatorY },
    ...(model && { model }),
  };
  return {
    body,
    note: { ...note, pending: { rerandomizer: rerandomizer.toString(), body } },
  };
}

/**
 * Folds the server's answer into the opening, once its signature checks
 * against the key registered onchain: (R + v, i + 1, c, s + s')
 */
export async function receive(
  note: NoteFile,
  response: RequestResponse,
): Promise<NoteFile> {
  if (!note.pending) throw new Error('No request is pending for this note');
  const commitment = BigInt(await commitmentOf(note));
  const rerandomizer = BigInt(note.pending.rerandomizer);
  const refund = BigInt(response.refund);

  const expected = applyRefund(
    rerandomize(commit(openingOf(note, commitment)), rerandomizer),
    refund,
  );
  const received: Point = [
    BigInt(response.accumulator.x),
    BigInt(response.accumulator.y),
  ];
  if (expected.join() !== received.join()) {
    throw new Error("The server's accumulator doesn't add up to the refund");
  }

  const key = await serverKey(contractOf(note));
  const eddsa = await buildEddsa();
  const F = eddsa.F;
  const { signature } = response.accumulator;
  const valid = eddsa.verifyPoseidon(
    F.e((await poseidon())(received as unknown as bigint[])),
    {
      R8: [F.e(BigInt(signature.R8x)), F.e(BigInt(signature.R8y))],
      S: BigInt(signature.S),
    },
    [F.e(BigInt(key.x)), F.e(BigInt(key.y))],
  ) as boolean;
  if (!valid) {
    throw new Error(
      "The accumulator isn't signed by the key registered onchain",
    );
  }

  return {
    ...note,
    opening: {
      refunds: (BigInt(note.opening.refunds) + refund).toString(),
      index: (BigInt(note.opening.index) + 1n).toString(),
      blinding: (
        (BigInt(note.opening.blinding) + rerandomizer) %
        SUBGROUP_ORDER
      ).toString(),
    },
    signature: {
      R8x: BigInt(signature.R8x).toString(),
      R8y: BigInt(signature.R8y).toString(),
      S: BigInt(signature.S).toString(),
    },
    signedBy: key,
    pending: null,
  };
}

/**
 * Proves an exit paying D + R − n · C_MAX to the recipient. n defaults to
 * the indices the note used: one more if a response was lost, as that request
 * may have been served.
 */
export async function proveWithdrawal(
  note: NoteFile,
  recipient: string,
  claimedIndex?: bigint,
): Promise<WithdrawalArgs> {
  const contract = contractOf(note);
  const { commitment, amount } = await onchainNote(note, contract);
  const used = BigInt(note.opening.index) + (note.pending ? 1n : 0n);
  const n = claimedIndex ?? used;
  if (n < BigInt(note.opening.index)) {
    throw new Error('The claim must cover every index the accumulator used');
  }
  const [cMax, signalX] = await Promise.all([
    contract.C_MAX() as Promise<bigint>,
    contract.withdrawalSignalX(recipient) as Promise<bigint>,
  ]);
  // A genesis accumulator needs no signature, so any accepted key works
  const key = note.signedBy ?? (await serverKey(contract));

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      secretKey: note.secretKey,
      ...accumulatorInputs(note),
      claimedIndex: n.toString(),
      commitment: BigInt(commitment).toString(),
      deposit: amount.toString(),
      maxCost: cMax.toString(),
      serverPublicKeyX: key.x,
      serverPublicKeyY: key.y,
      recipient: BigInt(recipient).toString(),
      signalX: signalX.toString(),
    },
    `${BUILD}/settlement_js/settlement.wasm`,
    `${BUILD}/settlement.zkey`,
  );
  const [a, b, c] = JSON.parse(
    `[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`,
  ) as [string[], string[][], string[]];

  // [nullifier, signalY, payout, ...]
  return {
    commitment,
    recipient: ethers.getAddress(recipient),
    refundKey: {
      x: ethers.toBeHex(BigInt(key.x), 32),
      y: ethers.toBeHex(BigInt(key.y), 32),
    },
    proof: [...a, ...b.flat(), ...c].map((v) => BigInt(v).toString()),
    nullifier: publicSignals[0],
    signalY: publicSignals[1],
    payout: publicSignals[2],
  };
}

/** Index n of a request signal, for a note whose requests are known */
export async function nullifierAt(
  note: NoteFile,
  index: bigint,
): Promise<bigint> {
  const hash = await poseidon();
  return hash([hash([BigInt(note.secretKey), index])]);
}
