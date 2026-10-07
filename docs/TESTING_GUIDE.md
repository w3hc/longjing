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
- **An attacker**, who holds a deposit and cheats

The steps:

1. Deploy `LongjingCredits` with `NODE_ENV=development`
2. Start the server pointed at it
3. Alice deposits 0.2 ETH and sends a request (`pnpm prove request`)
4. The attacker replays Alice's request
5. Alice proves her refund (`pnpm prove refund`). The attacker tries to redeem it to their own address, both as is and with the proof's recipient signal rewritten. Then Alice redeems it to a fresh address and tries again
6. Alice sends a second request
7. The operator tries to link Alice's two requests to each other and to her deposit, from the request bodies and, on Anvil, from its own nullifier database
8. The observer tries to link Alice's refund redemption to her deposit from the onchain events, and checks that the contract still holds every active stake
9. The attacker deposits and reuses a ticket index with a different payload. The operator recovers the attacker's secret key from the two signals (`pnpm prove slashing`) and calls `slashDoubleSpend` from a wallet that is not `serverAddress`
10. Alice checks that no request body contains a secret key

At v0.4.1 the table reads:

| Goal | Status | Issue |
|---|---|---|
| A deposit is recorded onchain | verified | |
| A request proof is against the onchain root | verified | |
| A nullifier is accepted once, a replay is rejected | verified | |
| A refund is `maxCost − actualCost`, signed by the key registered onchain, redeemable once | verified | |
| A request can't be linked to the deposit | not met: every request publishes `idCommitment` and `initialDeposit`, and the operator's database stores `idCommitment` next to the nullifier | [#134](https://github.com/w3hc/longjing/issues/134) |
| Two requests can't be linked to each other | not met, same fields | [#134](https://github.com/w3hc/longjing/issues/134) |
| A refund redemption onchain can't be linked to the deposit | not met: `RefundRedeemed` publishes `idCommitment` | [#134](https://github.com/w3hc/longjing/issues/134) |
| A refund can only be redeemed to the recipient in its proof | verified | |
| Solvency is enforced | not met: after one refund, the contract holds less than the active stakes (LJ-01). D bound to the deposit (LJ-02) is not checked | [#134](https://github.com/w3hc/longjing/issues/134) |
| A double-spend reveals `k` and anyone with the proof can slash the RLN stake | verified | |
| The client sends nothing that contains the secret key | verified | |
| The client verifies the attestation before sending anything | not checked yet | [#99](https://github.com/w3hc/longjing/issues/99) |
| Protocol, pricing and refunds work with any provider | not checked yet | |
| A depositor can withdraw without the server | not met, no check yet | [#119](https://github.com/w3hc/longjing/issues/119), [#157](https://github.com/w3hc/longjing/issues/157) |
| Every depositor can exit if the operator and every host disappear | not met, no check yet | [#157](https://github.com/w3hc/longjing/issues/157), [#135](https://github.com/w3hc/longjing/issues/135) |

The demo exits non-zero only when a goal expected to be verified is not. Known gaps are reported, not hidden, and a gap that starts passing prints a note to update its expected status in [scripts/demo/demo.ts](../scripts/demo/demo.ts). A passing run says nothing about the goals it reports as not met or not checked yet.

On Anvil, the server answers with mock responses: `ANTHROPIC_API_KEY` is ignored, so the demo costs nothing.

### Against a deployment

```bash
DEMO_PRIVATE_KEY=0x... pnpm demo --gateway https://<gateway> --contract 0x<LongjingCredits> --rpc https://<rpc> [--deposit 0.2]
```

The demo skips the deployment and the local server, proves with `api_request`, and pays two deposits from the `DEMO_PRIVATE_KEY` wallet (at least `0.1` ETH each, so two requests fit under `maxCost = 0.05` ETH). Before you run it:

- The requests reach the provider and cost what they cost.
- The attacker's deposit goes to the slasher: the `DEMO_SLASHER_PRIVATE_KEY` wallet, or the `DEMO_PRIVATE_KEY` wallet if that is unset. Alice's deposit stays locked until withdrawal works ([#119](https://github.com/w3hc/longjing/issues/119)).
- A server with a transaction signer slashes the double-spend itself before it answers. The demo then checks for the `DoubleSpendSlashed` event instead of slashing from the slasher wallet.
- The operator's database check runs only on Anvil, where the server runs in the demo's process.
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

### Main Flow Test (`test/app.e2e-spec.ts`)

The same steps as `pnpm demo`, as Jest assertions. The contract is deployed before the app starts, so the server checks the proof's root against the chain.

**Alice deposits with her secret**
- Deposits 0.2 ETH under `Poseidon(secretKey)` and checks that the deposit is active on chain

**Proves membership with that secret against the on-chain root**
- Checks that `GET /longjing/server-pubkey` returns the refund key registered on chain
- Runs `pnpm prove request` with the deposited secret, and checks that the proof's root is the contract's root

**Accepts the nullifier once and rejects a replay**
- `POST /longjing/request` answers 200 with a refund ticket worth `maxCost` minus the actual cost
- The same request again answers 403 `Nullifier already used`

**Signs the refund ticket with serverPublicKey**
- Verifies the ticket's EdDSA signature on the client, against the server's public key

**Redeems the refund once with a real proof, and rejects a second redemption**
- Runs `pnpm prove refund`, redeems the ticket on chain to a fresh address, and checks that its balance equals the refund
- Checks that a second redemption reverts with `RefundAlreadyRedeemed`

The suites share one Anvil chain and deployer, so they run one at a time.

### On-chain Proofs Test (`test/onchain-proofs.e2e-spec.ts`)

Deploys the real contract and verifiers, and submits one real proof per circuit:
- Withdrawal: proves `withdrawal.circom` against the on-chain Merkle root and withdraws the deposit to a fresh address
- Refund: signs a ticket with the dev refund-signer key, redeems it with a `refund_redemption.circom` proof, and checks that a second redemption reverts with `RefundAlreadyRedeemed`
- Double spend: proves `double_spend_slashing.circom` from two signals with the same nullifier, and checks that the slasher gets the RLN stake

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

### Prove a Request or a Refund

```bash
pnpm prove request <input.json>
pnpm prove refund <input.json>
```

The client-side provers the demo and the main flow test use. The input formats are in [scripts/client/prove.ts](../scripts/client/prove.ts).

### Generate a Test-Circuit Proof

```bash
npx ts-node scripts/testing/generate-proof.ts <secretKey> <ticketIndex> [payload]
```

Proves with the simplified `api_credit_proof_test` circuit against a zero Merkle root. The server only accepts it with `ZK_CIRCUIT=api_credit_proof_test`.

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

### Main Flow Test Validates:
- ✅ A deposit, a request and a refund by the same user, with the same secret
- ✅ The request proof's Merkle root is the on-chain root
- ✅ A nullifier is accepted once, and a replay is rejected
- ✅ The refund ticket signature verifies against the server's public key, which is the one registered on chain
- ✅ A real refund proof redeems the ticket, and the recipient's balance grows by the refund
- ✅ A second redemption reverts

### On-chain Proofs Test Validates:
- ✅ One real proof per circuit accepted by the deployed verifiers: withdrawal, refund redemption, double-spend slashing
- ✅ A second refund redemption reverts
- ✅ The slasher receives the RLN stake

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
- Server cannot link requests to deposit addresses: a design goal, not tested, and not true at v0.4.1, since `idCommitment` is a public signal ([#134](https://github.com/w3hc/longjing/issues/134))

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
2. Run trusted setup: `bash scripts/setup/run-trusted-setup.sh`
3. E2E tests automatically use generated artifacts

### Performance Testing

The proof generation test includes performance benchmarks:
- Proof generation should complete in < 5 seconds
- Concurrent proof generation is supported
- Memory usage is tracked

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
