/**
 * Client side of a note (docs/SETTLEMENT.md): the secret key and the
 * accumulator opening never leave the user's device. Proves requests and
 * withdrawals, and folds each server response into the opening.
 *
 * Runs in a browser and in Node: no fs, no Node crypto, no process. The note
 * is a plain object the caller stores; randomness comes from Web Crypto.
 */

import { ethers } from 'ethers';
import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { verifySignature } from '@zk-kit/eddsa-poseidon';
import {
  applyRefund,
  commit,
  FIELD_MODULUS,
  Point,
  rerandomize,
  SUBGROUP_ORDER,
} from '../longjing/accumulator';
import { payloadSignalX } from '../longjing/utils/payload-signal.util';
import { artifactName, Artifacts, Circuit, loadArtifact } from './artifacts';
import { Groth16Proof, Prover } from './prover';

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

/** A transaction for the user's own wallet to send */
export interface TransactionRequest {
  to: string;
  data: string;
  value?: bigint;
}

export interface ClientConfig {
  /** The circuit files, checked against circuits/artifacts.json before use */
  artifacts: Artifacts;
  /** Runs Groth16 proving: a Web Worker in the browser build */
  prover: Prover;
  /** Reads the chain; defaults to a JSON-RPC provider on the note's rpcUrl */
  provider?: (note: NoteFile) => ethers.ContractRunner;
}

export interface LongjingClient {
  proveRequest(
    note: NoteFile,
    payload: string,
    model?: string,
  ): Promise<{ body: RequestBody; note: NoteFile }>;
  receive(note: NoteFile, response: RequestResponse): Promise<NoteFile>;
  proveWithdrawal(
    note: NoteFile,
    recipient: string,
    claimedIndex?: bigint,
  ): Promise<WithdrawalArgs>;
}

const contractInterface = new ethers.Interface(NOTE_ABI);

/** A uniform field element from Web Crypto: 48 bytes reduced, bias < 2^-128 */
export function randomBelow(bound: bigint): bigint {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(48));
  return BigInt(ethers.hexlify(bytes)) % bound;
}

/**
 * A new note with a fresh secret key, or with the one given, for instance
 * derived from a passkey: any field element other than 0
 */
export function newNote(
  rpcUrl: string,
  contract: string,
  secretKey?: bigint | string,
): NoteFile {
  const k =
    secretKey === undefined ? randomNonZero(FIELD_MODULUS) : BigInt(secretKey);
  if (k <= 0n || k >= FIELD_MODULUS) {
    throw new Error('The secret key must be a nonzero BN254 field element');
  }
  return {
    secretKey: k.toString(),
    rpcUrl,
    contract: ethers.getAddress(contract),
    opening: { refunds: '0', index: '0', blinding: '0' },
    signature: null,
    signedBy: null,
    pending: null,
  };
}

/** c = Poseidon(k), what deposit() takes */
export function commitmentOf(note: NoteFile): Promise<string> {
  return Promise.resolve(
    ethers.toBeHex(poseidon1([BigInt(note.secretKey)]), 32),
  );
}

/** The nullifier of the note's request with index n, Poseidon(Poseidon(k, n)) */
export function nullifierAt(note: NoteFile, index: bigint): Promise<bigint> {
  return Promise.resolve(
    poseidon1([poseidon2([BigInt(note.secretKey), index])]),
  );
}

/** The deposit() call that registers the note with D = value */
export async function depositTx(
  note: NoteFile,
  value: bigint,
): Promise<TransactionRequest> {
  return {
    to: note.contract,
    data: contractInterface.encodeFunctionData('deposit', [
      await commitmentOf(note),
    ]),
    value,
  };
}

/** The initiateWithdrawal() call for a proved exit, from any wallet */
export function initiateWithdrawalTx(
  note: NoteFile,
  args: WithdrawalArgs,
): TransactionRequest {
  return {
    to: note.contract,
    data: contractInterface.encodeFunctionData('initiateWithdrawal', [
      args.commitment,
      args.recipient,
      args.refundKey,
      args.proof,
      args.nullifier,
      args.signalY,
      args.payout,
    ]),
  };
}

/** The finalizeWithdrawal() call, once the challenge window has passed */
export function finalizeWithdrawalTx(
  note: NoteFile,
  commitment: string,
): TransactionRequest {
  return {
    to: note.contract,
    data: contractInterface.encodeFunctionData('finalizeWithdrawal', [
      commitment,
    ]),
  };
}

/**
 * Whether a signature on an accumulator verifies under a refund key:
 * circomlib's EdDSA-Poseidon over Baby Jubjub, on Poseidon(x, y)
 */
export function verifyAccumulatorSignature(
  accumulator: Point,
  signature: Signature,
  key: { x: string; y: string },
): boolean {
  try {
    return verifySignature(
      poseidon2([...accumulator]),
      {
        R8: [BigInt(signature.R8x), BigInt(signature.R8y)],
        S: BigInt(signature.S),
      },
      [BigInt(key.x), BigInt(key.y)],
    );
  } catch {
    return false;
  }
}

export function createClient(config: ClientConfig): LongjingClient {
  const loaded = new Map<string, Promise<Uint8Array>>();
  const artifact = (circuit: Circuit, kind: 'wasm' | 'zkey') => {
    const name = artifactName(circuit, kind);
    let bytes = loaded.get(name);
    if (!bytes) {
      bytes = loadArtifact(name, config.artifacts[circuit][kind]);
      // A failed load, a mismatch included, is retried on the next proof
      bytes.catch(() => loaded.delete(name));
      loaded.set(name, bytes);
    }
    return bytes;
  };
  const prove = async (circuit: Circuit, input: Record<string, unknown>) => {
    const [wasm, zkey] = await Promise.all([
      artifact(circuit, 'wasm'),
      artifact(circuit, 'zkey'),
    ]);
    return config.prover(input, wasm, zkey);
  };
  const contractOf = (note: NoteFile) =>
    new ethers.Contract(
      note.contract,
      NOTE_ABI,
      config.provider?.(note) ?? new ethers.JsonRpcProvider(note.rpcUrl),
    );

  return {
    async proveRequest(note, payload, model) {
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

      const { proof, publicSignals } = await prove('request', {
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
      });
      // [nullifier, signalY, accumulatorX, accumulatorY, merkleRoot, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]
      const [nullifier, signalY, accumulatorX, accumulatorY] = publicSignals;

      const body: RequestBody = {
        payload,
        nonce: nonce.toString(),
        nullifier,
        signal: { x: signalX.toString(), y: signalY },
        proof: JSON.stringify(wireProof(proof)),
        merkleRoot: dec(root),
        accumulator: { x: accumulatorX, y: accumulatorY },
        ...(model && { model }),
      };
      return {
        body,
        note: {
          ...note,
          pending: { rerandomizer: rerandomizer.toString(), body },
        },
      };
    },

    async receive(note, response) {
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
        throw new Error(
          "The server's accumulator doesn't add up to the refund",
        );
      }

      const key = await serverKey(contractOf(note));
      const { signature } = response.accumulator;
      if (!verifyAccumulatorSignature(received, signature, key)) {
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
          R8x: dec(signature.R8x),
          R8y: dec(signature.R8y),
          S: dec(signature.S),
        },
        signedBy: key,
        pending: null,
      };
    },

    /**
     * Proves an exit paying D + R − n · C_MAX to the recipient. n defaults
     * to the indices the note used: one more if a response was lost, as that
     * request may have been served.
     */
    async proveWithdrawal(note, recipient, claimedIndex) {
      const contract = contractOf(note);
      const { commitment, amount } = await onchainNote(note, contract);
      const used = BigInt(note.opening.index) + (note.pending ? 1n : 0n);
      const n = claimedIndex ?? used;
      if (n < BigInt(note.opening.index)) {
        throw new Error(
          'The claim must cover every index the accumulator used',
        );
      }
      const [cMax, signalX] = await Promise.all([
        contract.C_MAX() as Promise<bigint>,
        contract.withdrawalSignalX(recipient) as Promise<bigint>,
      ]);
      // A genesis accumulator needs no signature, so any accepted key works
      const key = note.signedBy ?? (await serverKey(contract));

      const { proof, publicSignals } = await prove('settlement', {
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
      });

      // [nullifier, signalY, payout, ...]
      return {
        commitment,
        recipient: ethers.getAddress(recipient),
        refundKey: {
          x: ethers.toBeHex(BigInt(key.x), 32),
          y: ethers.toBeHex(BigInt(key.y), 32),
        },
        proof: solidityProof(proof),
        nullifier: publicSignals[0],
        signalY: publicSignals[1],
        payout: publicSignals[2],
      };
    },
  };
}

const dec = (v: bigint | string) => BigInt(v).toString();

function randomNonZero(bound: bigint): bigint {
  for (;;) {
    const value = randomBelow(bound);
    if (value !== 0n) return value;
  }
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
  return { x: dec(x), y: dec(y) };
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

/** Wire format of a request proof: projective coordinates, pi_b pairs swapped */
function wireProof(proof: Groth16Proof) {
  return {
    pi_a: [proof.pi_a[0], proof.pi_a[1], '1'],
    pi_b: [
      [proof.pi_b[0][1], proof.pi_b[0][0], '1'],
      [proof.pi_b[1][1], proof.pi_b[1][0], '1'],
    ],
    pi_c: [proof.pi_c[0], proof.pi_c[1], '1'],
    protocol: 'groth16',
  };
}

/** uint256[8] for the verifier contract, as snarkjs's exportSolidityCallData orders it */
function solidityProof(proof: Groth16Proof): string[] {
  return [
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
    proof.pi_c[0],
    proof.pi_c[1],
  ].map(dec);
}
