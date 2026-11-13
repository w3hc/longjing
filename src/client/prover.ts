export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

export interface FullProof {
  proof: Groth16Proof;
  publicSignals: string[];
}

/**
 * Computes the witness and the Groth16 proof, as snarkjs.groth16.fullProve
 * does, from the circuit's wasm and zkey bytes. The secret key is in the
 * input: a prover runs on the user's device, never on a server.
 */
export type Prover = (
  input: Record<string, unknown>,
  wasm: Uint8Array,
  zkey: Uint8Array,
) => Promise<FullProof>;
