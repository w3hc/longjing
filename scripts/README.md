# Scripts Directory

Utility scripts organized by purpose: setup, deployment, and testing.

## Directory Structure

```
scripts/
├── setup/          # Circuit compilation and trusted setup
├── deploy/         # Contract generation and deployment
└── testing/        # Manual testing and verification utilities
```

## Setup Scripts

Scripts for circuit compilation and trusted setup ceremony.

### `setup/compile-production-circuits.sh`

Compiles production ZK circuits with Groth16 proofs.

### `setup/run-trusted-setup.sh`

Runs the trusted setup ceremony for production circuits.

### `setup/setup-trusted-setup.ts`

TypeScript wrapper for trusted setup configuration.

**Usage:**
```bash
pnpm setup:circuit
```

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

Computes Poseidon hash for identity commitments (used by e2e tests).

### `testing/generate-admin-keypair.ts`

Generates ML-KEM-1024 admin keypair for secret management.

### `testing/generate-proof.ts`

Generates ZK proofs for testing (used by e2e test suite).

## Running Tests

Instead of individual test scripts, use the comprehensive e2e test suite:

```bash
# Start local blockchain
anvil

# Run end-to-end tests
pnpm test:e2e

# Run all quality checks
pnpm dance
```

See [test/app.e2e-spec.ts](../test/app.e2e-spec.ts) for the main flow test.
