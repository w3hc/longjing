# Testing Guide

## Prove it in 3 commands

```bash
anvil        # terminal 1
pnpm demo    # terminal 2
```

Then read the goal table. `pnpm demo` checks each of Longjing's goals against Anvil, with real proofs and the real server, and reports each one as **verified**, **not met** (with its issue) or **not checked yet**:

Four actors take part:

- **Alice**, an honest user
- **The operator**, who runs the gateway and sees every request and its own database
- **An observer**, who sees only the chain
- **An attacker**, who holds deposits and cheats

The steps:

1. Deploy `LongjingCredits` with `NODE_ENV=development`
2. Start the server pointed at it
3. Alice deposits 0.01 ETH and sends a request, proved on her machine with the client `pnpm prove` runs
4. Alice retries the request and gets the same accumulator back, then sends a second request from the signed accumulator
5. The operator tries to link Alice's two requests to each other and to her deposit, from the request bodies and, on Anvil, from its own nullifier database. The observer checks that the contract logged nothing while they were served
6. The attacker deposits and sends two requests at the same index. The server refuses the second; a wallet that is not `serverAddress` recovers the key from the two signals and calls `slash(k)`
7. The attacker deposits again, makes two requests, and exits claiming one. The operator finds the exit's nullifier in its database and slashes the note within the window
8. Alice exits: the attacker can't redirect her proof to another recipient. With the server stopped, she initiates the withdrawal with her own proof, and it pays `D + R − 2 · C_max` after the window
9. Alice's closed note can make no request, and no request body contained a secret key

The table reads:

| Goal | Status | Issue |
|---|---|---|
| A deposit is recorded onchain, bound into its leaf | verified | |
| A request proof is against a recent onchain root | verified | |
| A retry returns the same accumulator, a reused index is refused | verified | |
| The accumulator grows by C_max − C_actual, signed by the key registered onchain | verified | |
| A request can't be linked to the deposit | verified | |
| Two requests can't be linked to each other | verified | |
| A request's refund never appears onchain | verified | |
| A withdrawal pays only the recipient in its proof | verified | |
| Solvency is enforced: an exit pays D + R − n · C_max | verified | |
| Anyone holding k slashes, and the caller gets the bounty, not the stake | verified | |
| An exit that understates usage is slashed during the window | verified | |
| A closed note can't make requests | verified | |
| The client sends nothing that contains the secret key | verified | |
| The client verifies the attestation before sending anything | not checked yet | [#99](https://github.com/w3hc/longjing/issues/99) |
| Protocol, pricing and refunds work with any provider | not checked yet | |
| A depositor can withdraw without the server | verified | |
| Every depositor can exit if the operator and every host disappear | not met, no withdrawal page yet | [#157](https://github.com/w3hc/longjing/issues/157), [#135](https://github.com/w3hc/longjing/issues/135) |

The demo exits non-zero only when a goal expected to be verified is not. Known gaps are reported, not hidden, and a gap that starts passing prints a note to update its expected status in [scripts/demo/demo.ts](../scripts/demo/demo.ts). A passing run says nothing about the goals it reports as not met or not checked yet.

On Anvil, the server answers with mock responses: `ANTHROPIC_API_KEY` is ignored, so the demo costs nothing, and the challenge window passes with `evm_increaseTime`.

### Against a deployment

```bash
DEMO_PRIVATE_KEY=0x... pnpm demo --gateway https://<gateway> --contract 0x<LongjingCredits> --rpc https://<rpc> [--deposit 0.01]
```

The demo skips the deployment and the local server, and pays the deposits from the `DEMO_PRIVATE_KEY` wallet (at least `C_MAX` each). Before you run it:

- The requests reach the provider and cost what they cost.
- The attacker's deposit goes to the operator, minus the bounty paid to the slasher: the `DEMO_SLASHER_PRIVATE_KEY` wallet, or the `DEMO_PRIVATE_KEY` wallet if that is unset.
- Alice's exit is initiated but not finalized: call `finalizeWithdrawal` after the 3-day window.
- The operator's database checks, and the understated exit, run only on Anvil, where the server runs in the demo's process.
- The demo doesn't verify the attestation yet, so it can't tell that the gateway runs in an enclave with `NODE_ENV=production`.

## Overview

This guide covers testing for the Longjing system, including:

- **Unit Tests**: Jest-based tests for individual components
- **E2E Tests**: Full flow integration tests with real blockchain and proofs
- **Contract Tests**: Foundry tests for Solidity smart contracts
- **Proof Generation**: Testing ZK proof generation and verification

## Quick Start

```bash
# Unit tests
pnpm test

# Demo and E2E tests (require Anvil)
anvil                      # Terminal 1
pnpm demo                  # Terminal 2
pnpm test:e2e

# Contract tests
cd contracts && forge test -vv

# Format and lint checks
pnpm format:check
pnpm lint:check
```

## Unit Tests

Jest-based tests for individual services and components.

```bash
# Run all unit tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:cov
```

**Coverage includes:**
- API controllers and services
- ZK proof generation and verification
- Merkle tree operations
- EdDSA signature handling
- Database operations
- Rate limiting and nullifier tracking

## End-to-End Tests

Comprehensive integration tests that verify the complete flow from deposit to refund.

### Prerequisites

1. **Start Anvil** (local blockchain):
   ```bash
   anvil
   ```

2. **Verify Anvil is running**:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
     http://127.0.0.1:8545
   ```

### Running E2E Tests

```bash
pnpm test:e2e
```

Jest sets `NODE_ENV=test`, and the tests deploy their own contract with it, so they need nothing from your shell:

- `ZK_CONTRACT_ADDRESS`, `ANVIL_RPC_URL`, `SERVER_TX_PRIVATE_KEY` and `ETHEREUM_RPC_URLS` are cleared before the app starts, so a sourced `.env.local` cannot point it at another contract.
- The main flow test clears `ANTHROPIC_API_KEY`, so the service answers with mock responses and the run costs nothing.

### Settlement Test (`test/app.e2e-spec.ts`)

The contract, the server and the client of `pnpm prove`, on Anvil. The contract is deployed before the app starts, so the server checks roots and `C_MAX` against the chain, and the server has a transaction signer, so it slashes.

**Alice: two requests, then an honest exit**
- `GET /longjing/server-pubkey` returns the refund key registered onchain
- A first request from the genesis accumulator, then a retry that gets the same accumulator back, then a second request from the signed accumulator
- The request body holds no commitment, deposit or secret key
- An exit pays `D + R − 2 · C_MAX` after the window, and the closed note can make no request

**Bob: a double-spend**
- Two requests at the same index: the second is refused, and the server slashes the note

**Carol: an exit that understates usage**
- Two requests served, an exit claiming one: the server's watcher slashes the note within the window, and finalizing reverts

## Contract Tests

Foundry-based tests for Solidity smart contracts.

```bash
cd contracts
forge test -vv
```

**Test coverage**, with the real `SettlementVerifier` on proofs from [settlement.json](../contracts/test/fixtures/settlement.json) (regenerate with `scripts/testing/generate-settlement-fixtures.ts`):
- Deposits, the leaf `Poseidon(c, D)`, Merkle paths and the root history
- Initiate and finalize: an honest exit, an exit from genesis, wrong recipient, inflated payout, wrong deposit, unknown refund key
- Slashing: an understated exit within the window, a self-slash paying only the bounty, a bounty capped at D
- Each note paying out at most D in total
- Pausing never blocks an exit or a slash, and `claimExpired` is blocked while a note exits
- The timelock, including refund key rotation

## Testing Scripts

Helper scripts for manual testing and debugging.

### The Client

```bash
pnpm prove note <note.json> <rpcUrl> <contract>
pnpm prove request <note.json> <payload>
pnpm prove receive <note.json> <response.json>
pnpm prove withdrawal <note.json> <recipient> [n]
pnpm prove slashing <signals.json>
```

The client the demo and the e2e test use, documented in [API_REFERENCE.md](./API_REFERENCE.md#client-implementation-guide).

### Compute Poseidon Hash

```bash
npx ts-node scripts/testing/compute-poseidon.ts <input>
```

Computes Poseidon hash for identity commitments.

### Verify TEE Attestation

```bash
pnpm verify:attestation <url-or-file>
```

Verifies Intel TDX attestation quotes from Phala deployments.

## CI/CD Testing

GitHub Actions workflow (`.github/workflows/test.yml`) runs:

1. Linter checks
2. Unit tests
3. Build verification
4. Contract tests (Foundry)
5. Anvil startup
6. E2E tests

All tests must pass before merging PRs.

## What Each Test Proves

### Unit Tests Validate:
- ✅ Individual service logic
- ✅ ZK proof structure validation
- ✅ Database operations
- ✅ Rate limiting mechanisms
- ✅ EdDSA signature generation

### Settlement Test Validates:
- ✅ Requests from a genesis then a signed accumulator, with nothing that identifies the note
- ✅ A retry gets the same accumulator, a second signal at a used index gets the note slashed
- ✅ An honest exit pays `D + R − n · C_MAX`, an understated one is slashed within the window
- ✅ A closed note can make no request

### Contract Tests Validate:
- ✅ Smart contract state transitions
- ✅ Access control mechanisms
- ✅ Merkle tree correctness
- ✅ Gas optimization
- ✅ Edge cases and reverts

### Circuit Tests Validate:
- ✅ Honest requests and settlements, from genesis and from a signed accumulator
- ✅ Over-budget requests, foreign accumulators, forged signatures, `n < m` and negative payouts rejected
- ✅ No request public signal reveals the commitment, the leaf, the deposit or the index
- ✅ Real Groth16 proofs against the pinned keys, bound to their recipient and payout

## Zero-Knowledge Properties

The test suite validates these ZK properties:

### Anonymity
- A request proves membership among every note in the tree, whatever its amount
- No public signal and no stored column holds the commitment, the leaf, D or the index
- The published accumulator is re-randomized on every request

### Rate Limiting
- Each nullifier can only be used once
- Nullifiers computed as `Poseidon(Poseidon(k, i))`, fresh for every index
- No centralized tracking needed

### Slashing
- Two signals with same nullifier reveal secret key
- RLN equation: `signalY = secretKey + a * signalX`
- Anyone holding `k` slashes the note and gets a fixed bounty

### Refund Security
- The server signs each accumulator with EdDSA, and both circuits check the signature against the refund key
- The client checks every accumulator against the key registered onchain before using it
- A withdrawal pays at most D, whatever was signed

## Troubleshooting

### Anvil Not Running
```
Error: Anvil is not running
```
**Solution:** Start Anvil in a separate terminal: `anvil`

### E2E Tests Timeout
```
Timeout waiting for Anvil
```
**Solution:** Ensure Anvil is accessible at `http://127.0.0.1:8545`

### Contract Deployment Fails
```
Failed to deploy contract
```
**Solution:**
- Check Anvil is running
- Verify Foundry is installed: `forge --version`
- Check contract compilation: `cd contracts && forge build`

### Proof Generation Fails
```
Circuit artifacts not found
```
**Solution:** Fetch the circuit artifacts into `circuits/build/` with `pnpm circuits:fetch`

### Jest Won't Exit
```
Jest did not exit one second after test run
```
**Solution:** This is expected with `forceExit: true` in jest-e2e.json (handles background processes)

## Advanced Testing

### Testing with Real Circuits

The production circuits are `circuits/request.circom` and `circuits/settlement.circom`. `pnpm test:proof` compiles both with circom, checks their witnesses, and proves against the pinned keys. To regenerate the keys, see [ZK.md](./ZK.md#circuit-artifacts).

### Security Testing

Key security validations:
- Mock proofs are rejected (contract tests)
- Nullifier uniqueness enforced
- Double-spend attempts detected
- Invalid proof structures rejected
- Rate limiting works correctly

## Test Data Management

The demo and the E2E tests are stateless:
- Each run deploys a fresh contract on the running Anvil chain
- No test artifacts are committed
- The API server's database lives in memory (E2E) or a temporary directory (demo)

## Next Steps

- [API_REFERENCE.md](./API_REFERENCE.md) - Full API documentation
- [ZK.md](./ZK.md) - Zero-knowledge proof architecture
- [OVERVIEW.md](./OVERVIEW.md) - System architecture and status
- [TRUSTED_SETUP_CEREMONY.md](./TRUSTED_SETUP_CEREMONY.md) - Ceremony requirements
