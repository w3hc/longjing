# Scripts Directory

Utility scripts organized by purpose: client proving, the demo, setup, deployment, and testing.

## Directory Structure

```
scripts/
├── client/         # Client-side proving
├── demo/           # Checks each goal and reports its status
├── setup/          # Circuit compilation and trusted setup
├── deploy/         # Contract generation and deployment
└── testing/        # Manual testing and verification utilities
```

## Client Scripts

### `client/prove.ts`

Generates proofs on the client, so the secret key never leaves the user's machine:

- `pnpm prove request <input.json>`: a request proof against the on-chain Merkle root, printed as the body for `POST /longjing/request`
- `pnpm prove refund <input.json>`: a refund redemption proof for a refund ticket
- `pnpm prove slashing <input.json>`: a double-spend slashing proof from two signals with the same nullifier. It needs no secret key, so anyone holding the two signals can make it

The input formats are in the file's header.

## Demo

### `demo/demo.ts`

`pnpm demo` checks each of Longjing's goals and prints one line per goal: verified, not met (with its issue) or not checked yet. It runs against Anvil, or against an existing deployment with `--gateway`, `--contract` and `--rpc`. It exits non-zero only when a goal expected to be verified is not. See [docs/TESTING_GUIDE.md](../docs/TESTING_GUIDE.md#prove-it-in-3-commands).

## Setup Scripts

Scripts for circuit compilation and trusted setup ceremony.

### `setup/compile-production-circuits.sh`

Compiles production ZK circuits with Groth16 proofs.

### `setup/run-trusted-setup.sh`

Runs the trusted setup ceremony for production circuits.

## Deploy Scripts

Scripts for generating Solidity contracts.

### `deploy/add-verifier-wrappers.sh`

Adds Groth16 verifier wrapper contracts to Solidity.

### `deploy/generate-poseidon-contract.js`

Generates Poseidon hash contract for on-chain verification.

## Testing Scripts

Manual testing utilities and verification tools.

### `testing/verify-attestation.ts`

Client-side TEE attestation verification for Intel TDX quotes from Phala Network deployments.

**Purpose:** Verify that a Longjing server is running in a genuine Intel TDX TEE environment.

**Usage:**
```bash
pnpm verify:attestation https://your-server/attestation
```

**What it verifies:**
- ✅ Platform is Intel TDX (not mock)
- ✅ TDX quote structure is valid
- ✅ Certificate chain is present
- ✅ Timestamp is fresh (< 5 minutes)
- ✅ MRTD measurement extraction

**What it does NOT verify** (requires Intel DCAP or Phala verification service):
- ❌ Full cryptographic signature verification
- ❌ TCB (Trusted Computing Base) status
- ❌ Certificate revocation lists
- ❌ Comparison against known good measurement

See [docs/TEE_SETUP.md](../docs/TEE_SETUP.md) for production verification.

### `testing/compute-poseidon.ts`

Computes Poseidon hash for identity commitments.

### `testing/generate-admin-keypair.ts`

Generates ML-KEM-1024 admin keypair for secret management.

### `testing/generate-proof.ts`

Generates proofs with the simplified `api_credit_proof_test` circuit, against a zero Merkle root. The server refuses them unless it runs with `ZK_CIRCUIT=api_credit_proof_test`. For a proof the server accepts, use `pnpm prove request`.

## Running Tests

Instead of individual test scripts, use the demo and the e2e test suite:

```bash
# Start local blockchain
anvil

# Check each goal and report its status
pnpm demo

# Run end-to-end tests
pnpm test:e2e

# Run format and lint checks
pnpm format:check
pnpm lint:check
```

See [test/app.e2e-spec.ts](../test/app.e2e-spec.ts) for the main flow test.
