/**
 * The browser build of the client, published with each release as
 * longjing-client.js (global `Longjing`) and longjing-client.mjs. Built by
 * scripts/client/build-browser.ts. See docs/API_REFERENCE.md#browser-client.
 */

import workerSource from 'longjing:prover-worker';
import {
  ClientConfig,
  createClient as createCoreClient,
  LongjingClient,
} from './note';
import type { FullProof, Prover } from './prover';

export {
  commitmentOf,
  depositTx,
  finalizeWithdrawalTx,
  initiateWithdrawalTx,
  newNote,
  NOTE_ABI,
  nullifierAt,
  verifyAccumulatorSignature,
} from './note';
export type {
  ClientConfig,
  LongjingClient,
  NoteFile,
  RequestBody,
  RequestResponse,
  Signature,
  TransactionRequest,
  WithdrawalArgs,
} from './note';
export {
  ARTIFACT_HASHES,
  ARTIFACT_RELEASE,
  ArtifactMismatch,
  artifactName,
  loadArtifact,
} from './artifacts';
export type { Artifacts, ArtifactSource, CircuitArtifacts } from './artifacts';
export {
  AttestationRefused,
  checkAttestation,
  fetchTransport,
  openGateway,
} from './gateway';
export type { Gateway, GatewayTransport } from './gateway';
export type { FullProof, Groth16Proof, Prover } from './prover';

/**
 * Proves in a new Web Worker, started from the bundled source, and ends it
 * once the proof is done
 */
export const workerProver: Prover = (input, wasm, zkey) =>
  new Promise<FullProof>((resolve, reject) => {
    const url = URL.createObjectURL(
      new Blob([workerSource], { type: 'text/javascript' }),
    );
    const worker = new Worker(url);
    const done = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onmessage = ({
      data,
    }: MessageEvent<{ result?: FullProof; error?: string }>) => {
      done();
      if (data.result) resolve(data.result);
      else reject(new Error(data.error ?? 'The prover worker failed'));
    };
    worker.onerror = (event) => {
      done();
      reject(new Error(event.message || 'The prover worker failed'));
    };
    worker.postMessage({ input, wasm, zkey });
  });

/**
 * A client for a page: proofs run in a Web Worker unless `prover` is given,
 * which a context without Worker must do
 */
export function createClient(
  config: Omit<ClientConfig, 'prover'> & { prover?: Prover },
): LongjingClient {
  let prover = config.prover;
  if (!prover) {
    if (typeof Worker !== 'function') {
      throw new Error('No Web Worker here: pass a prover');
    }
    prover = workerProver;
  }
  return createCoreClient({ ...config, prover });
}
