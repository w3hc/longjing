/**
 * The client of src/client/note.ts for Node: circuit files read from
 * circuits/build, proofs made in this process by snarkjs. The browser build
 * runs the same module with a Web Worker.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createClient,
  LongjingClient,
  NoteFile,
  RequestResponse,
} from '../../src/client/note';
import { artifactName, Circuit } from '../../src/client/artifacts';
import type { FullProof, Prover } from '../../src/client/prover';

export {
  commitmentOf,
  newNote,
  NOTE_ABI,
  nullifierAt,
} from '../../src/client/note';
export type {
  NoteFile,
  RequestBody,
  RequestResponse,
  Signature,
  WithdrawalArgs,
} from '../../src/client/note';

const BUILD = join(__dirname, '../../circuits/build');

// snarkjs ships no type declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const snarkjs = require('snarkjs') as {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: Uint8Array,
      zkey: Uint8Array,
    ): Promise<FullProof>;
  };
};

/** snarkjs in this process, from the bytes the client checked */
export const nodeProver: Prover = (input, wasm, zkey) =>
  snarkjs.groth16.fullProve(input, wasm, zkey);

const files = (circuit: Circuit) => ({
  wasm: () => readFileSync(join(BUILD, artifactName(circuit, 'wasm'))),
  zkey: () => readFileSync(join(BUILD, artifactName(circuit, 'zkey'))),
});

let client: LongjingClient | undefined;
const node = () =>
  (client ??= createClient({
    artifacts: { request: files('request'), settlement: files('settlement') },
    prover: nodeProver,
  }));

export const proveRequest = (note: NoteFile, payload: string, model?: string) =>
  node().proveRequest(note, payload, model);

export const receive = (note: NoteFile, response: RequestResponse) =>
  node().receive(note, response);

export const proveWithdrawal = (
  note: NoteFile,
  recipient: string,
  claimedIndex?: bigint,
) => node().proveWithdrawal(note, recipient, claimedIndex);
