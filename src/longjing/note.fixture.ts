/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { buildEddsa, buildPoseidon } from 'circomlibjs';
import {
  applyRefund,
  commit,
  Opening,
  Point,
  rerandomize,
  SUBGROUP_ORDER,
} from './accumulator';

/**
 * Notes, accumulators and server signatures for the request and settlement
 * circuit tests, following docs/SETTLEMENT.md
 */

export const TREE_DEPTH = 20;

export interface Signature {
  R8x: bigint;
  R8y: bigint;
  S: bigint;
}

/** A signed accumulator and its opening, as a client holds it */
export interface Held {
  opening: Opening;
  signature?: Signature;
}

export interface NoteFixture {
  poseidon: (inputs: bigint[]) => bigint;
  serverKey: Point;
  signerFor: (prvKey: Buffer) => {
    publicKey: Point;
    sign: (accumulator: Point) => Signature;
  };
  note: (
    secretKey: bigint,
    deposit: bigint,
  ) => { commitment: bigint; leaf: bigint; root: bigint; genesis: Held };
  /** The server's side of a request: A' = A_pub + v·G + J, signed */
  respond: (
    held: Held,
    rerandomizer: bigint,
    refund: bigint,
    prvKey?: Buffer,
  ) => Held;
  accumulatorInputs: (held: Held) => Record<string, string>;
}

export const SERVER_PRV_KEY = Buffer.alloc(32, 7);

export async function buildNoteFixture(): Promise<NoteFixture> {
  const p = await buildPoseidon();
  const eddsa = await buildEddsa();
  const F = p.F;

  const poseidon = (inputs: bigint[]): bigint => F.toObject(p(inputs));

  const signerFor = (prvKey: Buffer) => {
    const pub = eddsa.prv2pub(prvKey);
    return {
      publicKey: [F.toObject(pub[0]), F.toObject(pub[1])] as Point,
      sign: (accumulator: Point): Signature => {
        const signature = eddsa.signPoseidon(
          prvKey,
          F.e(poseidon([...accumulator])),
        );
        return {
          R8x: F.toObject(signature.R8[0]),
          R8y: F.toObject(signature.R8[1]),
          S: BigInt(signature.S),
        };
      },
    };
  };

  // A tree with the note as its leftmost leaf and every other leaf empty
  const note = (secretKey: bigint, deposit: bigint) => {
    const commitment = poseidon([secretKey]);
    const leaf = poseidon([commitment, deposit]);
    let root = leaf;
    for (let i = 0; i < TREE_DEPTH; i++) root = poseidon([root, 0n]);
    const opening = { refunds: 0n, index: 0n, commitment, blinding: 0n };
    return { commitment, leaf, root, genesis: { opening } };
  };

  const respond = (
    { opening }: Held,
    rerandomizer: bigint,
    refund: bigint,
    prvKey = SERVER_PRV_KEY,
  ): Held => {
    const next = applyRefund(
      rerandomize(commit(opening), rerandomizer),
      refund,
    );
    return {
      opening: {
        refunds: opening.refunds + refund,
        index: opening.index + 1n,
        commitment: opening.commitment,
        blinding: (opening.blinding + rerandomizer) % SUBGROUP_ORDER,
      },
      signature: signerFor(prvKey).sign(next),
    };
  };

  // Genesis takes a dummy signature, which the circuit doesn't check
  const accumulatorInputs = ({ opening, signature }: Held) => ({
    isGenesis: signature ? '0' : '1',
    refunds: opening.refunds.toString(),
    index: opening.index.toString(),
    blinding: opening.blinding.toString(),
    signatureR8x: (signature?.R8x ?? 0n).toString(),
    signatureR8y: (signature?.R8y ?? 1n).toString(),
    signatureS: (signature?.S ?? 0n).toString(),
  });

  return {
    poseidon,
    serverKey: signerFor(SERVER_PRV_KEY).publicKey,
    signerFor,
    note,
    respond,
    accumulatorInputs,
  };
}
