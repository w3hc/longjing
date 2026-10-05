# Testing Guide

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

# E2E tests (requires Anvil)
anvil                      # Terminal 1
pnpm test:e2e             # Terminal 2

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

The tests run with `PROFILE=local` and deploy their own contract with it, so they need nothing from your shell:

- `ZK_CONTRACT_ADDRESS`, `ANVIL_RPC_URL`, `ANVIL_PRIVATE_KEY` and `ETHEREUM_RPC_URLS` are cleared before the app starts, so a sourced `.env.local` cannot point it at another contract.
- `ANTHROPIC_API_KEY` is kept: without it the service answers with mock responses, as in CI; with it, requests go to the Claude API. Until [#138](https://github.com/w3hc/longjing/issues/138) is fixed, real requests fail with a 500, so run `env -u ANTHROPIC_API_KEY pnpm test:e2e`.

### Main Flow Test (`test/app.e2e-spec.ts`)

Tests the complete user flow:

**Step 1: Alice deposits 1 ETH**
- Generates identity commitment using Poseidon hash
- Deploys contract via Foundry script
- Makes deposit transaction
- Verifies deposit onchain

**Step 2: Alice uses the service**
- Generates ZK proof using `generate-proof.ts`
- Makes API request with proof
- Receives Claude API response
- Gets refund ticket with EdDSA signature

**Step 3: Alice gets refund**
- Attempts to redeem refund onchain with a mock proof
- Verifies refund ticket structure
- Does not yet check that the mock proof is rejected, nor redeem with a real proof: see [#139](https://github.com/w3hc/longjing/issues/139)

The suites share one Anvil chain and deployer, so they run one at a time.

### On-chain Proofs Test (`test/onchain-proofs.e2e-spec.ts`)

Deploys the real contract and verifiers, and submits one real proof per circuit:
- Withdrawal: proves `withdrawal.circom` against the on-chain Merkle root and withdraws the deposit to a fresh address
- Refund: signs a ticket with the dev refund-signer key, redeems it with a `refund_redemption.circom` proof, and checks that a second redemption reverts with `RefundAlreadyRedeemed`
- Double spend: proves `double_spend_slashing.circom` from two signals with the same nullifier, and checks that the slasher gets the RLN stake

`policy_violation` has no zkey, so it has no real-proof test. [#133](https://github.com/w3hc/longjing/issues/133) removes it.

### Proof Generation Test (`test/proof-generation.e2e-spec.ts`)

Tests ZK proof generation internals:
- Withdrawal proof generation
- Refund proof generation
- Double-spend slashing proof generation
- RLN primitives (nullifiers, commitments)
- Proof format compatibility with Solidity
- Performance benchmarks

## Contract Tests

Foundry-based tests for Solidity smart contracts.

```bash
cd contracts
forge test -vv
```

**Test coverage:**
- Deposit functionality
- Merkle tree updates
- Withdrawal verification
- Refund redemption
- Slashing mechanisms
- Access control

## Testing Scripts

Helper scripts for manual testing and debugging.

### Generate ZK Proof

```bash
npx ts-node scripts/testing/generate-proof.ts <secretKey> <ticketIndex> [payload]
```

Generates a complete ZK proof for testing API requests, with the signal x bound to `payload`.

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

### E2E Tests Validate:
- ✅ Complete deposit → service → refund flow
- ✅ Real blockchain interaction (via Anvil)
- ✅ Contract deployment and verification
- ✅ ZK proof generation and API integration
- ⏳ Mock refund proof rejection and real refund redemption ([#139](https://github.com/w3hc/longjing/issues/139))

### Contract Tests Validate:
- ✅ Smart contract state transitions
- ✅ Access control mechanisms
- ✅ Merkle tree correctness
- ✅ Gas optimization
- ✅ Edge cases and reverts

### Proof Generation Tests Validate:
- ✅ Withdrawal proof correctness
- ✅ Refund proof correctness
- ✅ Slashing proof correctness
- ✅ RLN signal generation
- ✅ Secret key recovery from double-spend
- ✅ Proof format compatibility

## Zero-Knowledge Properties

The test suite validates these ZK properties:

### Anonymity
- Identity commitments hide secret keys
- Merkle tree provides k-anonymity (k = number of deposits)
- Server cannot link requests to deposit addresses

### Rate Limiting
- Each nullifier can only be used once
- Nullifiers computed as `Hash(Hash(secretKey, ticketIndex))`
- No centralized tracking needed

### Slashing
- Two signals with same nullifier reveal secret key
- RLN equation: `signalY = secretKey + a * signalX`
- Economic deterrent via stake slashing

### Refund Security
- EdDSA signatures are unforgeable
- Server's public key verified onchain
- Refunds can only be redeemed once

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

Production circuits are in `circuits/`:
- `withdrawal.circom` - Merkle membership + solvency proof
- `refund_redemption.circom` - Refund ticket verification
- `double_spend_slashing.circom` - Double-spend detection

To test with real circuits:
1. Compile circuits: `bash scripts/setup/compile-production-circuits.sh`
2. Run trusted setup: `pnpm setup:circuit`
3. E2E tests automatically use generated artifacts

### Performance Testing

The proof generation test includes performance benchmarks:
- Proof generation should complete in < 5 seconds
- Concurrent proof generation is supported
- Memory usage is tracked

### Security Testing

Key security validations:
- Mock proofs are rejected (contract tests; e2e coverage tracked in [#139](https://github.com/w3hc/longjing/issues/139))
- Nullifier uniqueness enforced
- Double-spend attempts detected
- Invalid proof structures rejected
- Rate limiting works correctly

## Test Data Management

E2E tests are stateless:
- Each test run generates fresh data
- No test artifacts are committed
- Anvil provides clean blockchain state
- In-memory database for API server

## Next Steps

- [API_REFERENCE.md](./API_REFERENCE.md) - Full API documentation
- [ZK.md](./ZK.md) - Zero-knowledge proof architecture
- [OVERVIEW.md](./OVERVIEW.md) - System architecture and status
- [TRUSTED_SETUP_CEREMONY.md](./TRUSTED_SETUP_CEREMONY.md) - Ceremony requirements
