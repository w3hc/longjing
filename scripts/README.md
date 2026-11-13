# Scripts Directory

Utility scripts organized by purpose: client proving, the demo, setup, deployment, and testing.

## Directory Structure

```
scripts/
├── client/         # Client-side proving, and the browser build
├── demo/           # Checks each goal and reports its status
├── setup/          # Circuit compilation and trusted setup
├── deploy/         # Contract generation and deployment
└── testing/        # Manual testing and verification utilities
```

## Client Scripts

### `client/prove.ts`

The client side of a note, built on [client/note.ts](client/note.ts), which runs the browser client's module ([src/client/note.ts](../src/client/note.ts)) with the circuit files from `circuits/build` and snarkjs in the same process. The secret key and the accumulator opening stay in a note file on the user's machine:

- `pnpm prove note <note.json> <rpcUrl> <contract>`: a new note, and the commitment to deposit
- `pnpm prove request <note.json> <payload>`: the body for `POST /longjing/request`, against a recent onchain root
- `pnpm prove send <note.json> <gateway-url> [--socks <host:port>]`: verifies the gateway's attestation with a fresh nonce, then sends the pending request over the attested TLS session and folds the response into the note. It sends nothing when the attestation doesn't verify, and through Tor it uses a new circuit per request
- `pnpm prove receive <note.json> <response.json>`: checks the server's signed accumulator and moves the note to its next index
- `pnpm prove withdrawal <note.json> <recipient> [n]`: the arguments for `initiateWithdrawal`, with no server involved
- `pnpm prove slashing <signals.json>`: the secret key two signals with the same nullifier reveal, for `slash(k)`

Usage is in the file's header and in [docs/API_REFERENCE.md](../docs/API_REFERENCE.md#client-implementation-guide).

### `client/build-browser.ts`

`pnpm build:browser` bundles the browser client into `build/browser/`: `longjing-client.js` (global `Longjing`), `longjing-client.mjs` and their `SHA256SUMS`. The release workflow publishes the three. See [docs/API_REFERENCE.md](../docs/API_REFERENCE.md#browser-client).

### `src/client/gateway.ts` and `client/transport.ts`

The only way the client reaches the gateway. `openGateway` fetches `GET /attestation` with a fresh nonce, checks it with `checkAttestation`, and only then returns a `post` pinned to the attested TLS certificate; it throws `AttestationRefused` having sent nothing otherwise. `nodeTransport` opens one connection per request, offers the hybrid post-quantum TLS groups, checks the certificate before writing, and optionally goes through Tor's SOCKS port with fresh credentials per connection. See [docs/INTEGRATION_GUIDELINES.md](../docs/INTEGRATION_GUIDELINES.md).

## Demo

### `demo/demo.ts`

`pnpm demo` checks each of Longjing's goals and prints one line per goal: verified, not met (with its issue) or not checked yet. It runs against Anvil, or against an existing deployment with `--gateway`, `--contract` and `--rpc`. It exits non-zero only when a goal expected to be verified is not. See [docs/TESTING_GUIDE.md](../docs/TESTING_GUIDE.md#prove-it-in-3-commands).

## Setup Scripts

Scripts for circuit compilation and trusted setup ceremony.

### `setup/compile-production-circuits.sh`

Compiles the settlement circuit and exports `SettlementVerifier.sol`.

### `setup/run-trusted-setup.sh`

Runs a local, single-machine setup for `request` and `settlement`, for experiments only.

## Deploy Scripts

Scripts for generating Solidity contracts.

### `deploy/generate-poseidon-contract.js`

Generates Poseidon hash contract for on-chain verification.

## Testing Scripts

Manual testing utilities and verification tools.

### `testing/local-gateway.ts`

Deploys `LongjingCredits` on Anvil with `NODE_ENV=development` and starts the gateway pointed at it, for the demo and the browser e2e test.

### `testing/verify-attestation.ts`

Client-side TEE attestation verification for Intel TDX quotes from Phala Network deployments.

**Purpose:** Verify that a Longjing server is running in a genuine Intel TDX TEE environment.

**Usage:**
```bash
pnpm verify:attestation https://your-server/attestation
pnpm verify:attestation https://<address>.onion/attestation --socks 127.0.0.1:9050
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

Computes a Poseidon hash, such as a note's commitment.

### `testing/generate-settlement-fixtures.ts`

Writes `contracts/test/fixtures/settlement.json`, real settlement proofs the Foundry tests verify with the real `SettlementVerifier`. Run it after changing the settlement circuit or its keys.

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

See [test/app.e2e-spec.ts](../test/app.e2e-spec.ts) for the settlement test.
