/**
 * The Web Worker that proves for the browser client, so the page stays
 * responsive. Bundled with snarkjs into a string that browser.ts starts from
 * a Blob URL: it needs no file next to the page and works from file://.
 */

import * as snarkjs from 'snarkjs';
import type { FullProof } from './prover';

// Its declarations don't cover fullProve on bytes
const { groth16 } = snarkjs as unknown as {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: Uint8Array,
      zkey: Uint8Array,
    ): Promise<FullProof>;
  };
};

interface ProveMessage {
  input: Record<string, unknown>;
  wasm: Uint8Array;
  zkey: Uint8Array;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ProveMessage>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = ({ data }) => {
  groth16
    .fullProve(data.input, data.wasm, data.zkey)
    .then((result) => scope.postMessage({ result }))
    .catch((error: unknown) =>
      scope.postMessage({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
};
