# Longjing System Overview

## Introduction

Longjing is a privacy-preserving gateway for accessing external API services anonymously, using Zero-Knowledge proofs and Rate-Limit Nullifiers (RLN). Users deposit ETH once and make many untraceable requests without revealing their identity or linking requests together.

It is two things stacked together:

1. **An implementation of the original RLN protocol** from [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) by Davide Crapis & Vitalik Buterin: RLN signals, refund ticket accumulation, the solvency formula `(i + 1) · C_max ≤ D + R`, and dual staking (claimable RLN stake, burnable policy stake).
2. **A TEE gateway around it**: the server runs in an attested enclave, holds the upstream provider credentials, forwards requests through a generic provider layer, and hardens the metadata around each request.

The protocol is the shared foundation. What Longjing adds is the part the protocol leaves open: where the server runs, how a client can trust it, how any upstream API plugs in, and how the traffic around a valid proof is kept from leaking identity.

### What Longjing adds

- **TEE gateway**: Intel TDX with in-enclave TLS termination; attestation `report_data` binds both the ML-KEM public key and the TLS certificate, so a client can verify the endpoint before sending secrets ([ATTESTATION.md](./ATTESTATION.md), [TEE_SETUP.md](./TEE_SETUP.md)).
- **Generic provider layer**: dynamic provider registration, per-provider pricing and pre-request cost estimation; Claude is the reference provider ([PROVIDERS.md](./PROVIDERS.md)).
- **Metadata hardening**: `MetadataSanitizerInterceptor`, `TimingProtectionInterceptor`, response padding, cost quantization and ML-KEM encryption.
- **ZK-first contracts**: withdrawal, refund redemption and slashing are all verified with Groth16 proofs, so the secret key is never revealed onchain and gas costs stay constant.
- **Production infrastructure**: ETH/USD oracle, rate limiting, persistent nullifier storage.

### Deliberate trade-offs

- **Proof system**: **Groth16** (ZK-SNARK) instead of the **ZK-STARK** suggested in the proposal
  - Faster verification (~10-20ms vs ~100-500ms)
  - Smaller proofs (~200 bytes vs ~80-200KB)
  - Lower onchain gas costs (~280k vs ~1-5M)
  - Requires trusted setup (vs transparent)
  - Not post-quantum secure (vs quantum-resistant)
- **Decision**: Prioritized efficiency for near-term deployment; a STARK migration remains possible later

## Longjing and ethereum/zkapi

[ethereum/zkapi](https://github.com/ethereum/zkapi) is a separate implementation of the same proposal, built by Open Anonymity in collaboration with the Ethereum Foundation. Its current version (v2) deliberately departs from RLN; Longjing keeps it.

### Protocol

| | Longjing | ethereum/zkapi (v2) |
|---|---|---|
| **Nullifier construction** | RLN line: `y = k + a·x` with `a = Poseidon(k, i)`; two signals on the same ticket index reveal `k` | One-time state anchor: each request consumes the current private state and emits one nullifier |
| **Double-spend response** | Anyone who recovers `k` slashes the RLN stake onchain | The server keeps every seen nullifier; a replayed old state is challenged during the escape-hatch window |
| **Balance tracking** | Refund tickets (EdDSA) accumulate client-side; the request circuit proves the solvency formula over them | Private balance commitment inside a server-signed state (Schnorr); no ticket indices or refund history |
| **Stakes and policy** | Separate RLN stake (claimable) and policy stake (burnable via a policy-violation proof) | No policy stake; a policy penalty is an optional bounded deduction from the private balance |
| **Settlement** | Refunds redeemed onchain; withdrawal is a direct ZK proof with no server involvement | Net settlement in gwei when the note closes: instant mutual close with a server signature, or an escape hatch with a 24h challenge window; expired notes can be claimed by the server |
| **Merkle tree** | 20 levels | 32 levels, note-bound commitments |

### Architecture

| | Longjing | ethereum/zkapi (v2) |
|---|---|---|
| **Request path** | Client → TEE gateway → upstream provider; the gateway holds provider credentials and executes the call | Browser → inference provider directly; the server issues leases and handles settlement |
| **Trust in the server** | Enclave attestation bound to the TLS and ML-KEM keys | Protocol-level guarantees; the operator runs ordinary services |
| **Providers** | Generic provider abstraction (pricing, cost estimation, registration) | Inference providers, OpenAI-compatible local client |
| **Stack** | Circom + snarkjs, NestJS backend, Foundry contracts | Rust operator services (`serverd`, `indexerd`, `challenged`), Rust/WASM browser SDK, Foundry contracts |

Both projects are experimental and both evolve; this comparison reflects ethereum/zkapi as of October 2026.

**Trust Assumptions**: For production deployment, the system requires: (1) server key rotation mechanism, (2) timelock on the remaining admin functions (verifier and server address changes already wait 7 days), (3) trusted setup ceremonies (development setup complete, production needs 50+ participants), and (4) independent review. See security considerations below.

## TEE Deployment: Why This Matters

Longjing is **designed to run in a Trusted Execution Environment (TEE)** such as:
- AMD SEV-SNP (Secure Encrypted Virtualization)
- Intel TDX (Trust Domain Extensions)
- AWS Nitro Enclaves
- Phala Network (TDX/SGX infrastructure)

### The TEE + ZK Advantage

**Without TEE (session-based approach)**:
- User pays → Server issues session token → Requests authenticated
- Server *can* link payments to requests (chooses not to via policy)
- Vulnerable to regulatory demands: "Show us who made request X"

**With TEE Only**:
- Server operator cannot read memory (hardware isolation)
- But the *code* can still correlate payments to requests
- Regulatory demand: "Your code can link them, so extract that data"

**With TEE + ZK (this system)**:
- Server operator cannot read memory (TEE isolation)
- Code *cannot* link payments to requests (ZK nullifiers destroy linkage)
- Regulatory demand: "We mathematically cannot comply—the system is cryptographically designed to prevent it"

**The complexity is justified**: ZK provides cryptographic unlinkability that survives regulatory pressure, not just operational privacy.

## Architecture

The system consists of three main layers:

### 1. Smart Contract Layer (Ethereum)

**Contract**: [`LongjingCredits.sol`](../contracts/src/LongjingCredits.sol)

The smart contract manages the economic guarantees and serves as the source of truth for:

- **Deposits & Withdrawals**: Users deposit ETH along with an identity commitment (Poseidon hash of their secret key)
- **Merkle Tree**: Maintains an onchain Merkle tree of all identity commitments (anonymity set)
- **Dual Staking Mechanism**:
  - 50% RLN stake: Claimable by anyone who proves double-spending
  - 50% Policy stake: Burnable by operator for ToS violations (not claimable to prevent false accusations)
- **Refund Redemption**: Users can redeem server-signed refund tickets onchain
- **Slashing**: Automatic punishment when someone proves you reused a ticket

**Key Functions**:
- `deposit(bytes32 identityCommitment)`: Deposit ETH with anonymous identity
- `withdraw(address recipient, uint256 amount)`: Withdraw available balance
- `redeemRefund(...)`: Redeem server-signed refund ticket
- `slashDoubleSpend(...)`: Submit proof of double-spending to claim RLN stake
- `slashPolicy(...)`: Operator burns policy stake for ToS violations

### 2. Zero-Knowledge Circuit Layer

The system uses four specialized ZK circuits (Groth16) for different operations:

**Production Circuits**:

1. **API Request Circuit** ([api_request.circom](../circuits/api_request.circom))
   - Proves full solvency formula: `(i + 1) · C_max ≤ D + R`
   - Verifies Merkle tree membership + EdDSA refund signatures + RLN
   - Used for anonymous API requests with balance verification
   - 20-level tree, max 10 refund tickets
   - ~112K constraints; the server's refund-signing key is a public input, filled in by the server
   - The server verifies every request with it in production (`ZK_CIRCUIT=api_request`)

2. **Withdrawal Circuit** ([withdrawal.circom](../circuits/withdrawal.circom))
   - 11,749 constraints, 11,773 wires
   - Proves Merkle tree membership + RLN signal generation
   - Verifier: [WithdrawalVerifier.sol](../contracts/src/WithdrawalVerifier.sol)

3. **Refund Redemption Circuit** ([refund_redemption.circom](../circuits/refund_redemption.circom))
   - 10,170 constraints, 10,173 wires
   - Proves EdDSA signature validity on refund tickets
   - Verifier: [RefundRedemptionVerifier.sol](../contracts/src/RefundRedemptionVerifier.sol)

4. **Double-Spend Slashing Circuit** ([double_spend_slashing.circom](../circuits/double_spend_slashing.circom))
   - 1,357 constraints, 1,361 wires
   - Proves secret key extraction from dual RLN signals
   - Verifier: [DoubleSpendSlashingVerifier.sol](../contracts/src/DoubleSpendSlashingVerifier.sol)

5. **Policy Violation Circuit** ([policy_violation.circom](../circuits/policy_violation.circom))
   - 837 constraints, 843 wires
   - Proves server knows RLN signal from actual request
   - Binds nullifier ↔ idCommitment ↔ violation evidence
   - Prevents arbitrary policy stake burning (C-4 security fix)
   - Verifier: [PolicyViolationVerifier.sol](../contracts/src/PolicyViolationVerifier.sol)

**Test Circuit**: [`circuits/api_credit_proof_test.circom`](../circuits/api_credit_proof_test.circom) (development only; production refuses to start with it)

The ZK circuits prove critical properties in zero-knowledge:

1. **Membership**: User's identity commitment exists in the Merkle tree (k-anonymity among all depositors)
2. **Refund Validity**: All accumulated refund tickets have valid EdDSA signatures from the operator
3. **Solvency**: Current balance ≥ maxCost of this request
   ```
   balance = initial_deposit + sum(refund_tickets) - sum(spent)
   ```
4. **RLN Signal**: Generates unique nullifier and signal for double-spend prevention
   ```
   a = Poseidon(secretKey, ticketIndex)
   nullifier = Poseidon(a)
   x = SHA-256(message) mod p
   y = secretKey + a * x
   ```

**Circuit Parameters**:
- Merkle tree depth: 20 (supports ~1M depositors)
- Max refund tickets: 10 (configurable)
- Proof system: Groth16 (fast verification, ~200-300 bytes)
- Hash function: Poseidon (ZK-friendly, much cheaper than SHA256 in circuits)
- Proof generation: ~2-5 seconds (client-side)
- Proof verification: ~10-20ms (server-side)

**Trusted Setup**:
- Powers of Tau: 2^15 (32,768 constraints) - sufficient for all circuits
- Withdrawal circuit: `withdrawal_final.zkey` (5.1MB proving key)
- Refund redemption: `refund_redemption_final.zkey` (5.6MB proving key)
- Double-spend slashing: `double_spend_slashing_final.zkey` (613KB proving key)
- Production requires multi-party ceremony (50+ participants)
- Setup script: [run-trusted-setup.sh](../scripts/run-trusted-setup.sh)

See [ZK.md](./ZK.md) for detailed circuit documentation and [TRUSTED_SETUP_CEREMONY.md](./TRUSTED_SETUP_CEREMONY.md) for ceremony details.

### 3. Backend Services Layer (NestJS)

The backend orchestrates proof verification, API execution, and refund signing:

**Core ZK Services**

| Service | File | Purpose |
|---------|------|---------|
| **LongjingService** | [longjing.service.ts](../src/longjing/longjing.service.ts) | Main request orchestrator |
| **ProofVerifierService** | [proof-verifier.service.ts](../src/longjing/proof-verifier.service.ts) | Groth16 proof verification (~10-20ms) |
| **NullifierStoreService** | [nullifier-store.service.ts](../src/longjing/nullifier-store.service.ts) | SQLite persistent nullifier storage |
| **RefundSignerService** | [refund-signer.service.ts](../src/longjing/refund-signer.service.ts) | EdDSA refund ticket signing (in-circuit verified) |
| **MerkleTreeService** | [merkle-tree.service.ts](../src/longjing/merkle-tree.service.ts) | Onchain Merkle tree synchronization |
| **BlockchainService** | [blockchain.service.ts](../src/longjing/blockchain.service.ts) | Ethereum contract interactions |
| **EthRateOracleService** | [eth-rate-oracle.service.ts](../src/longjing/eth-rate-oracle.service.ts) | ETH/USD pricing (Kraken + Chainlink fallback) |

**Provider Abstraction** (Multi-API Support)

| Service | Purpose |
|---------|---------|
| **ProviderRegistryService** | Dynamic provider registration and routing |
| **PricingOracleService** | Cost calculation with 1-hour cache |
| **CostEstimationService** | Pre-request cost estimation |
| **ClaudeProvider** | Reference implementation (claude-sonnet-4-5-20250929) |

See [PROVIDERS.md](./PROVIDERS.md) for adding new providers.

**Security & Privacy**

| Service | Purpose |
|---------|---------|
| **SiweService** | Sign-In with Ethereum authentication |
| **MlkemEncryptionService** | Post-quantum encryption (ML-KEM-768) |
| **TeePlatformService** | TEE attestation verification |
| **SecretService** | Secure secret management (TEE/KMS) |
| **MetadataSanitizerInterceptor** | Remove identifying headers from logs |
| **TimingProtectionInterceptor** | Constant-time responses (prevent timing attacks) |

## Request Flow

### One-Time Setup

1. User generates random secret key `k`
2. Computes identity commitment: `idCommitment = Poseidon(k)`
3. Deposits ETH to contract with `idCommitment`
4. User is now part of the anonymity set

### Making an Anonymous Request

```
┌─────────┐                ┌─────────────┐                ┌──────────┐
│  User   │                │  Backend    │                │ Contract │
└────┬────┘                └──────┬──────┘                └────┬─────┘
     │                            │                            │
     │ 1. Generate ZK proof       │                            │
     │    - Merkle proof          │                            │
     │    - Previous refunds      │                            │
     │    - RLN signal            │                            │
     │                            │                            │
     │ 2. POST /longjing/request  │                            │
     │    {proof, nullifier,      │                            │
     │     signal, maxCost}       │                            │
     ├───────────────────────────>│                            │
     │                            │                            │
     │                            │ 3. Verify proof            │
     │                            │    (Groth16)               │
     │                            │                            │
     │                            │ 4. Check nullifier         │
     │                            │    not used                │
     │                            │                            │
     │                            │ 5. Store nullifier         │
     │                            │                            │
     │                            │ 6. Call Claude API         │
     │                            │                            │
     │                            │ 7. Calculate actual        │
     │                            │    cost (tokens * price)   │
     │                            │                            │
     │                            │ 8. Sign refund ticket      │
     │                            │    (EdDSA)                 │
     │                            │                            │
     │ 9. Response + refund       │                            │
     │    ticket                  │                            │
     │<───────────────────────────┤                            │
     │                            │                            │
     │ 10. Accumulate tickets     │                            │
     │     for next request       │                            │
     │                            │                            │
     │ ... many requests ...      │                            │
     │                            │                            │
     │ 11. Redeem refunds         │                            │
     │     onchain               │                            │
     ├────────────────────────────┼───────────────────────────>│
     │                            │                            │
     │                            │                            │ 12. Verify EdDSA
     │                            │                            │     signature
     │                            │                            │
     │                            │                            │ 13. Credit balance
     │                            │                            │
     │ 14. ETH sent to recipient  │                            │
     │<───────────────────────────┼────────────────────────────┤
```

### Key Privacy Guarantees

1. **Identity Privacy** (Deposit Unlinkability)
   - ZK proof proves membership without revealing which leaf in the Merkle tree
   - k-anonymity scales with depositor count (~1M max with depth-20 tree)
   - Onchain deposits can't be linked to API requests

2. **Request Unlinkability** (Cross-Request Privacy)
   - Each request uses a unique nullifier: `nullifier = Poseidon(Poseidon(secretKey, ticketIndex))`
   - Server stores nullifiers but can't link them: nullifier₁, nullifier₂, nullifier₃...
   - No way to determine if requests came from the same user

3. **Balance Privacy** (Range Proof)
   - ZK proof only reveals: `balance ≥ maxCost`
   - Server never learns actual balance or deposit amount
   - Prevents profiling users by spending patterns

4. **Double-Spend Prevention** (RLN)
   - Each ticket index can be used exactly once
   - Reusing a ticket with different message reveals secret key via linear algebra
   - Anyone can compute: `k = (y₁×x₂ - y₂×x₁) / (x₂ - x₁)` and claim RLN stake
   - Cryptographic guarantee, not policy enforcement

5. **Trustless Withdrawals** (Server Independence)
   - Users can always withdraw, even if the server is down, censoring, or malicious
   - Withdrawal requires only a ZK proof of ownership (prove you know the secret key)
   - No server signatures, no server approval, no server interaction needed
   - The contract's `withdraw()` function ([LongjingCredits.sol:228-271](../contracts/src/LongjingCredits.sol#L228-L271)) verifies the proof onchain
   - Merkle proofs are available via public `getMerkleProof()` function (no server dependency)
   - Your funds are always in your control - the server cannot prevent withdrawals

**Cryptographic Unlinkability**: These properties survive regulatory pressure because the system is mathematically incapable of linking requests to users, even if compelled. TEE deployment ensures the operator can't read memory or tamper with the code.

## Cryptographic Primitives

### Rate-Limit Nullifiers (RLN)

RLN is a cryptographic primitive that allows one-time use of tickets while preserving privacy:

**Signal Generation**:
```
a = Poseidon(secretKey, ticketIndex)
nullifier = Poseidon(a)
x = SHA-256(message) mod p
y = secretKey + a × x
```

**Properties**:
- Different messages with same ticket → reveals secret key
- Server can verify: `nullifier` hasn't been seen before
- Server stores: `(nullifier, x, y)` for double-spend detection

**Double-Spend Detection**:
If someone submits two requests with same `ticketIndex`:
```
Signal 1: y₁ = k + a×x₁
Signal 2: y₂ = k + a×x₂

Solve for k:
k = (y₁×x₂ - y₂×x₁) / (x₂ - x₁)
```

Anyone can compute the secret key and submit a slashing transaction to claim the RLN stake.

### EdDSA Refund Tickets

The server signs refund tickets with EdDSA (verifiable in ZK circuits):

**Ticket Structure**:
```typescript
{
  nullifier: string,      // From this request
  value: bigint,         // Refund amount in wei
  timestamp: number,     // Unix timestamp
  signature: {          // EdDSA signature
    R8: [string, string],
    S: string
  }
}
```

**In-Circuit Verification**: The ZK circuit verifies EdDSA signatures on all accumulated refund tickets, ensuring the server actually authorized them.

### Poseidon Hash

- **Purpose**: ZK-friendly hash function (much cheaper in circuits than SHA256)
- **Usage**: Identity commitments, nullifiers, RLN signals
- **Parameters**: Rate = 2, capacity = 1 (standard configuration)

## Security Model

### Threat Model

**Trusted**:
- Smart contract (after audit)
- ZK circuit (after trusted setup ceremony)
- Cryptographic primitives (Poseidon, EdDSA, Groth16)

**Semi-Trusted**:
- Server operator (can censor but can't steal funds or break privacy)

**Adversaries**:
- Network observers (ISP, server operator)
- Other users
- Blockchain analysts

### Attack Vectors & Mitigations

| Attack | Mitigation |
|--------|-----------|
| **Double-spending** | RLN reveals secret key → automatic slashing |
| **Proof forgery** | Groth16 soundness guarantee (computationally infeasible) |
| **Replay attacks** | Nullifiers stored server-side, checked onchain for refunds |
| **Balance draining** | ZK proof ensures balance ≥ maxCost before request |
| **Server refusing refunds** | Overpayment is minor per request, accumulate and redeem onchain |
| **Sybil attacks** | Each deposit requires real ETH stake |
| **ToS violations** | Policy stake can be burned (separate from RLN stake) |

### Privacy Limitations & Best Practices

While the system provides strong cryptographic privacy guarantees, users should be aware of these limitations:

1. **Network-level privacy**
   - **Risk**: IP addresses visible to server operator
   - **Mitigation**: Use Tor, VPN, or mixnets for network-level anonymity
   - **TEE deployment**: Prevents operator from logging IPs

2. **Timing correlation**
   - **Risk**: Request timing patterns could correlate with onchain deposits
   - **Mitigation**: Space out requests, use random delays
   - **Decentralized relay networks**: Mixnets can further reduce timing correlation

3. **Anonymity set size**
   - **Risk**: Privacy scales with number of depositors (k-anonymity)
   - **Capacity**: Supports up to ~1M depositors (20-level tree)
   - **Recommendation**: Wait for larger anonymity set before depositing large amounts

4. **Message content**
   - **Risk**: Prompt content could reveal identity ("As the CEO of FooBar Inc...")
   - **Mitigation**: Sanitize prompts, avoid PII
   - **Note**: Server cannot correlate prompts to identities, but prompts are visible to API provider (Claude/OpenAI)

5. **Browser/device fingerprinting**
   - **Risk**: Unique browser fingerprints could link requests
   - **Mitigation**: Use Tor Browser, randomize user agents
   - **Implementation**: `MetadataSanitizerInterceptor` removes identifying headers server-side

## Cost Economics

### User Costs

| Cost Type | Estimate | Frequency |
|-----------|----------|-----------|
| **Initial Deposit** | ~$5-20 (gas cost) | One-time per identity |
| **API Request** | 1-5% overpayment | Per request (due to ETH/USD fluctuation) |
| **Refund Redemption** | ~$3-10 (gas cost) | Batch after ~100 requests |

**Example**: Deposit $50 → Make 500 requests at $0.10 each → Redeem ~$0.50 overpayment → Net cost: $55.50 (3% overhead from gas + overpayment)

### Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| **Proof generation** | 2-5 seconds | Client-side (browser/Node.js) |
| **Proof verification** | 10-20ms | Server-side (SnarkJS) |
| **Proof size** | 200-300 bytes | Groth16 constant size |
| **Deposit gas cost** | ~150k gas | One-time per identity |
| **Refund redemption gas** | ~80k gas | Batch redemption recommended |
| **Max depositors** | ~1M | Depth-20 Merkle tree |

### Gas Optimization Notes

- **Batch refunds**: Redeem after accumulating 50-100 tickets to amortize gas
- **L2 deployment**: Consider Arbitrum/Optimism for 10-100x cheaper deposits
- **Merkle proofs**: 20 hashes verified onchain per deposit (Poseidon in assembly)

## System Components

### Core System

**Zero-Knowledge Layer**
- ZK circuit design (Circom) - Groth16 with RLN
- Proof verification (SnarkJS) - ~10-20ms server-side
- Smart contract (Solidity) - LongjingCredits.sol with dual staking
- Merkle tree service - 20-level tree, supports ~1M depositors
- Nullifier store - SQLite persistent storage with privacy guarantees

**Backend Services (NestJS)**
- API endpoints with HTTPS/TLS
- Refund ticket signing (EdDSA, in-circuit verification)
- ETH/USD oracle (Kraken + Chainlink fallback)
- Rate limiting (hybrid: fingerprint + per-nullifier)
- Comprehensive test suite

**Provider Abstraction**
- Multi-provider architecture with dynamic pricing
- Claude provider (claude-sonnet-4-5-20250929)
  - $3/M input tokens, $15/M output tokens
  - Cache-aware pricing (90% read discount)
  - Token counting and cost estimation
- Cost estimation endpoint (public, no auth required)
- Pricing database (SQLite) with audit trail
- See [PROVIDERS.md](./PROVIDERS.md) and [QUICK_START.md](./QUICK_START.md)

### Security Considerations

This is a research implementation of the protocol described in the [Ethresear.ch proposal](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104).

**ZK Proof Verification**:
- Real Groth16 verifiers (generated by snarkJS)
- Withdrawal proofs verified on-chain (secret key never revealed)
- Double-spend slashing proofs verified on-chain (RLN math in circuit)
- Refund redemption proofs verified on-chain (EdDSA signatures in circuit)
- Proper pairing checks using EVM precompiles

**Known Limitation: EdDSA Signature Verification**

The contract's EdDSA signature verification for refund tickets performs basic validation only (see [LongjingCredits.sol:600-661](../contracts/src/LongjingCredits.sol#L600-L661)):
- Verifies signature components are in valid range
- Verifies points are on Baby Jubjub curve
- Does not perform full cryptographic verification (requires >30M gas, exceeds block limit)

This relies on economic incentives:
- Only the trusted server can create signatures
- Nullifiers prevent double-spending of refunds
- Users can challenge invalid signatures and slash the server's stake
- Invalid refunds would be detectable and provably fraudulent

**For production use**, implement one of:
1. ZK proof of EdDSA signature verification (verify signatures in circuit) - already implemented in refund_redemption.circom
2. Optimized precompiles or assembly implementations
3. BLS signatures with BLS12-381 precompiles (EIP-2537)
4. Signature aggregation to verify multiple refunds at once

### Production Requirements

**Before Testnet**:

1. **Production circuits**
   - Compiled: `withdrawal.circom` (11,749 constraints)
   - Compiled: `refund_redemption.circom` (11,156 constraints)
   - Compiled: `double_spend_slashing.circom` (1,357 constraints)
   - Generated: `.r1cs`, `.wasm`, and `.zkey` for each circuit
   - Exported: Solidity verifier contracts to `contracts/src/`
   - Compilation script: `scripts/compile-production-circuits.sh`

2. **Trusted setup ceremony**
   - Powers of Tau ceremony (2^15 = 32,768 constraints)
   - Phase 2 setup for all three circuits
   - Proving keys: `withdrawal_final.zkey`, `refund_redemption_final.zkey`, `double_spend_slashing_final.zkey`
   - Setup script: `scripts/run-trusted-setup.sh`
   - Production requires multi-party ceremony (50+ participants)

3. **Contract integration**
   - Production Groth16 verifiers integrated into LongjingCredits.sol
   - Wrapper functions added for proof format conversion
   - Public signal mappings updated for all three circuits
   - Real ZK proof verification active on all operations

4. **Merkle tree infrastructure**
   - Proper 20-level incremental Merkle tree using Poseidon hash
   - Matches circuit's `MerkleTreeChecker` structure exactly
   - Public `getMerkleProof()` function for client-side proof generation
   - Full node storage in `treeNodes` mapping for correct proof generation
   - See [LongjingCredits.sol:620-719](../contracts/src/LongjingCredits.sol#L620-L719)

5. **Independent review**
   - Circuit review
   - Contract review
   - Trusted setup verification

**Trust Assumptions**:

- `getMerkleProof()` is public onchain (no server dependency for withdrawals)
- **Admin control**: Contract owner can change verifiers and the server address (which can slash policy stakes), but only 7 days after a public `ChangeProposed` event, so users can withdraw first
- **Deposit linkability**: First deposit publicly links wallet address to identity commitment

## Roadmap

### Phase 1: SDK & Testnet Launch (Next)
- [ ] **w3pk Wallet SDK integration**
  - Client-side proof generation (WASM/SnarkJS)
  - Refund ticket accumulation and management
  - Balance tracking and nullifier coordination
  - TypeScript helpers for deposits and withdrawals
- [ ] **Deploy to Sepolia**
  - Production-grade trusted setup ceremony
  - Circuit parameter validation
  - Gas cost optimization and stress testing
  - Faucet for testing deposits
- [ ] **Spin up a UI**
  - Wallet connection (MetaMask, WalletConnect)
  - Deposit/withdraw interface
  - Anonymous chat with Claude
  - Balance and refund ticket visualization
  - Network switcher (Sepolia/Mainnet)
- [ ] **Beta testing**
  - Real user integration testing
  - Independent review (circuit + contract + backend)
  - Performance tuning and monitoring
  - Documentation and tutorials

### Phase 2: Mainnet Launch
- [ ] **Deploy to Ethereum Mainnet**
  - Final trusted setup (reuse Sepolia parameters if validated)
  - Contract deployment and verification
  - HSM/KMS integration for EdDSA signing key
  - Multi-RPC endpoint redundancy
- [ ] **Production infrastructure**
  - Multi-network support in UI
  - Monitoring, alerting, and incident response
  - Load balancing and autoscaling
  - Rate limiting and DDoS protection

### Phase 3: Decentralized Deployment
- [ ] **Deploy to Phala Network (TEE)**
  - TEE attestation integration
  - Decentralized compute verification
  - Cross-chain state synchronization
  - Secret injection via Phala's secure runtime
- [ ] **Alternative TEE platforms**
  - AWS Nitro Enclaves
  - Intel TDX / AMD SEV-SNP
  - Comparison and performance benchmarking

### Phase 4: Multi-Provider Expansion
- [ ] **Add new API providers**
  - OpenAI (GPT-4, GPT-4o)
  - Mistral AI
  - Generic HTTP proxy mode
- [ ] **w3pk integration**
  - ML-KEM encrypted document injection
  - Private context management (PDFs, code, etc.)
  - Multi-turn conversations with TEE storage

## References

- [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) - Original proposal by Davide Crapis & Vitalik Buterin
- [Rate-Limit Nullifiers](https://rate-limiting-nullifier.github.io/rln-docs/) - RLN documentation
- [Circom Documentation](https://docs.circom.io/) - Circuit development
- [SnarkJS](https://github.com/iden3/snarkjs) - ZK proof generation and verification
- [Poseidon Hash](https://eprint.iacr.org/2019/458.pdf) - ZK-friendly hash function
