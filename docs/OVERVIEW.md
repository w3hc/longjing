# Longjing System Overview

## Introduction

Longjing is a privacy-preserving gateway for accessing external API services anonymously, using Zero-Knowledge proofs and Rate-Limit Nullifiers (RLN). Users deposit ETH once and make many untraceable requests without revealing their identity or linking requests together.

It is two things stacked together:

1. **An implementation of the original RLN protocol** from [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) by Davide Crapis & Vitalik Buterin: RLN signals, the solvency formula `(i + 1) · C_max ≤ D + R` with a constant `C_max`, refunds accumulated in a server-signed homomorphic commitment, and a stake forfeited on a double-spend. The policy stake is dropped, and every other departure is listed in [SETTLEMENT.md](./SETTLEMENT.md#departures-from-the-paper).
2. **A TEE gateway around it**: the server runs in an attested enclave, holds the upstream provider credentials, forwards requests through a generic provider layer, and hardens the metadata around each request.

The protocol is the shared foundation. What Longjing adds is the part the protocol leaves open: where the server runs, how a client can trust it, how any upstream API plugs in, and how the traffic around a valid proof is kept from leaking identity.

### What Longjing adds

- **TEE gateway**: Intel TDX with in-enclave TLS termination; attestation `report_data` binds the ML-KEM, identity and refund signer public keys, the TLS certificate and a client nonce, so a client can verify the endpoint before sending secrets ([ATTESTATION.md](./ATTESTATION.md), [TEE_SETUP.md](./TEE_SETUP.md)).
- **Generic provider layer**: dynamic provider registration, per-provider pricing and pre-request cost estimation. Longjing is a template for any upstream API, and Claude is only the reference provider ([PROVIDERS.md](./PROVIDERS.md), [QUICK_START.md](./QUICK_START.md)). Today `POST /longjing/request` still calls Claude directly from `LongjingService` instead of going through the provider registry, so a new provider also has to be wired into that path.
- **Metadata hardening**: `MetadataSanitizerInterceptor`, `TimingProtectionInterceptor`, response padding, cost quantization and ML-KEM encryption.
- **ZK-first settlement**: a withdrawal is a Groth16 proof of `D + R − n · C_max` that the user generates, so exiting needs neither the server nor the secret key onchain.
- **Production infrastructure**: ETH/USD oracle, rate limiting, persistent nullifier storage.

### Deliberate trade-offs

- **Proof system**: **Groth16** (ZK-SNARK) instead of the **ZK-STARK** suggested in the proposal
  - Faster verification (~10-20ms vs ~100-500ms)
  - Smaller proofs (~200 bytes vs ~80-200KB)
  - Lower onchain gas costs (~280k vs ~1-5M)
  - Requires trusted setup (vs transparent)
  - Soundness rests on pairings, a structured assumption that a quantum computer breaks and that AI-accelerated cryptanalysis may weaken sooner (vs hashes only)
- **Decision**: Prioritized efficiency for near-term deployment; a STARK migration remains possible later. A pairing break costs funds, not privacy: Groth16 is perfectly zero-knowledge, so past proofs stay private, but anyone could forge a withdrawal of any note. See [ZK.md](./ZK.md#cryptographic-assumptions)

## Longjing and ethereum/zkapi

[ethereum/zkapi](https://github.com/ethereum/zkapi) is a separate implementation of the same proposal, built by Open Anonymity in collaboration with the Ethereum Foundation. Its current version (v2) deliberately departs from RLN; Longjing keeps it.

### Protocol

| | Longjing | ethereum/zkapi (v2) |
|---|---|---|
| **Nullifier construction** | RLN line: `y = k + a·x` with `a = Poseidon(k, i)`; two signals on the same ticket index reveal `k` | One-time state anchor: each request consumes the current private state and emits one nullifier |
| **Double-spend response** | Anyone who recovers `k` slashes the note onchain and gets a fixed bounty | The server keeps every seen nullifier; a replayed old state is challenged during the escape-hatch window |
| **Balance tracking** | Refunds accumulate in a server-signed Pedersen commitment, re-randomized on every request; the request circuit proves the solvency formula over it | Private balance commitment inside a server-signed state (Schnorr); no ticket indices or refund history |
| **Stakes and policy** | One stake, the whole deposit; policy is enforced by withholding the next accumulator | No policy stake; a policy penalty is an optional bounded deduction from the private balance |
| **Settlement** | A ZK withdrawal of `D + R − n · C_max`, with no server involvement, after a 3-day challenge window in which an exit that understates usage is slashed; once a note's 365-day TTL has passed, the operator can claim it, and time spent paused doesn't count toward it | Net settlement in gwei when the note closes: instant mutual close with a server signature, or an escape hatch with a 24h challenge window; expired notes can be claimed by the server |
| **Merkle tree** | 20 levels | 32 levels, note-bound commitments |

### Architecture

| | Longjing | ethereum/zkapi (v2) |
|---|---|---|
| **Request path** | Client → TEE gateway → upstream provider; the gateway holds provider credentials and executes the call | Browser → inference provider directly; the server issues leases and handles settlement |
| **Trust in the server** | Enclave attestation bound to the TLS and ML-KEM keys | Protocol-level guarantees; the operator runs ordinary services |
| **Providers** | Generic provider abstraction (pricing, cost estimation, registration) | Inference providers, OpenAI-compatible local client |
| **Stack** | Circom + snarkjs, NestJS backend, Foundry contracts | Rust operator services (`serverd`, `indexerd`, `challenged`), Rust/WASM browser SDK, Foundry contracts |

Both projects are experimental and both evolve; this comparison reflects ethereum/zkapi as of October 2026.

**Trust Assumptions**: verifier, server address and refund key changes wait 7 days behind a timelock, as do new compose hashes on the `DstackApp` (see [GOVERNANCE.md](./GOVERNANCE.md)). Production still needs a multi-party trusted setup ([#135](https://github.com/w3hc/longjing/issues/135)) and an independent review. See security considerations below.

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
- Code is designed so it *cannot* link payments to requests (ZK nullifiers destroy linkage)
- Regulatory demand: "We cannot comply: the system is cryptographically designed to prevent it"

**The complexity is justified**: ZK gives cryptographic unlinkability that survives regulatory pressure, not just operational privacy. A request carries no identifier and the server stores only `(N, x, y)`, so there is nothing to hand over (see [Key Privacy Guarantees](#key-privacy-guarantees)).

## Architecture

The system consists of three main layers. [ZK.md](./ZK.md) describes each in detail, and [SETTLEMENT.md](./SETTLEMENT.md) specifies the protocol.

### 1. Smart Contract Layer (Ethereum)

**Contract**: [`LongjingCredits.sol`](../contracts/src/LongjingCredits.sol)

- **Notes**: `deposit(c)` opens a note worth `msg.value` and inserts the leaf `Poseidon(c, D)`, computed onchain. The contract keeps the 20-level tree and its last 30 roots
- **Settlement**: `initiateWithdrawal` verifies a settlement proof and starts a 3-day challenge window; `finalizeWithdrawal` pays the recipient and credits `D − P` to the operator
- **Slashing**: `slash(k)` closes the note of whoever's secret key is known, paying a fixed `SLASH_BOUNTY` to the caller and the rest to the operator
- **Expiry**: `claimExpired` lets the operator claim a note untouched for 365 days, never one that is exiting
- **Admin**: verifier, server address and refund key changes wait 7 days; pausing blocks deposits and expiry claims, never an exit or a slash

### 2. Zero-Knowledge Circuit Layer

1. **Request Circuit** ([request.circom](../circuits/request.circom)): membership of `Poseidon(Poseidon(k), D)`, a genesis or signed accumulator re-randomized into a fresh public point, solvency `(i + 1) · C_max ≤ D + R`, and the RLN signal at the private index. ~37K constraints. The server verifies every request with it.
2. **Settlement Circuit** ([settlement.circom](../circuits/settlement.circom)): the payout `D + R − n · C_max ≥ 0` for a claimed index count `n` no lower than the accumulator's, with the RLN signal at `n` bound to the recipient. ~22K constraints. The contract verifies every withdrawal with it.

Double-spend slashing needs no circuit: two signals at one index reveal `k`, and the contract checks `Poseidon(k)` itself.

### 3. Backend Services Layer (NestJS)

| Service | File | Purpose |
|---------|------|---------|
| **LongjingService** | [longjing.service.ts](../src/longjing/longjing.service.ts) | Request handling: signal binding, proof, store, provider call, signed accumulator |
| **ProofVerifierService** | [proof-verifier.service.ts](../src/longjing/proof-verifier.service.ts) | Groth16 verification against a recent root, `C_max` and the refund key |
| **NullifierStoreService** | [nullifier-store.service.ts](../src/longjing/nullifier-store.service.ts) | `(N, x, y)` in SQLite, and responses kept 10 minutes for retries |
| **RefundSignerService** | [refund-signer.service.ts](../src/longjing/refund-signer.service.ts) | Signs accumulators with EdDSA, verified in-circuit |
| **ExitWatcherService** | [exit-watcher.service.ts](../src/longjing/exit-watcher.service.ts) | Records each exit's nullifier and slashes an understated exit |
| **SlashingService** | [slashing.service.ts](../src/longjing/slashing.service.ts) | Recovers `k` from two signals and calls `slash(k)` |
| **BlockchainService** | [blockchain.service.ts](../src/longjing/blockchain.service.ts) | Contract reads and the transaction signer |
| **EthRateOracleService** | [eth-rate-oracle.service.ts](../src/longjing/eth-rate-oracle.service.ts) | ETH/USD rates |

The client side is [scripts/client/note.ts](../scripts/client/note.ts), behind `pnpm prove`. The server never proves anything that needs the secret key.

## Request Flow

### One-Time Setup

1. The client draws a secret key `k` and keeps it in a note file
2. It computes the commitment `c = Poseidon(k)`
3. It deposits D with `deposit(c)`

### Making an Anonymous Request

1. The client proves request `i` from its accumulator `(R, i, c, s)`, a fresh blinding `s'` and a fresh nonce `ρ`
2. It sends the payload, `ρ`, the nullifier, the signal `(x, y)`, the proof, the root and `A_pub`
3. The server checks `x = Poseidon(H(payload), ρ)`, that the worst case fits in `C_max`, the root against the contract and the proof
4. It stores `(N, x, y)`; a second signal under the same `N` reveals `k`, and the note is slashed
5. It calls the provider and computes the refund `v = C_max − C_actual`, clamped to `[0, C_max]`
6. It returns the response and `A' = A_pub + v·G + J`, signed
7. The client checks `A'` and its signature against the onchain key, and moves to `(R + v, i + 1, c, s + s')`

### Leaving

1. The client proves a withdrawal of `D + R − n · C_max`, bound to a recipient, and calls `initiateWithdrawal`
2. During the 3-day window, the server checks the exit's nullifier against its store, and slashes the note if index `n` was already used
3. After the window, anyone calls `finalizeWithdrawal` and the recipient is paid

### Key Privacy Guarantees

1. **Request to deposit**: a request carries no commitment, leaf, deposit amount or index, and the server stores only `(N, x, y)`
2. **Request to request**: the nullifier is fresh per index and the published accumulator is re-randomized every time
3. **Balance**: the proof shows solvency without revealing D or R; an exit reveals the note's net spending `D − P`, not its requests
4. **Server-free exit**: a withdrawal needs the chain, the note file and `pnpm prove`, nothing from the server
5. **Expiry**: pausing can't be used to wait out the TTL; the expiry clock stops while paused, and a note that is exiting can't be claimed

These hold against the operator and observers by cryptography. They don't cover timing and network metadata ([#99](https://github.com/w3hc/longjing/issues/99)), or whoever ran the single-party trusted setup ([#135](https://github.com/w3hc/longjing/issues/135)).

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

Anyone can compute the secret key and call `slash(k)`, which pays them `SLASH_BOUNTY` and the operator the rest of the note.

### The Refund Accumulator

The server signs each accumulator `A = R·G + m·J + c·K + s·H` with EdDSA over Poseidon, which both circuits verify. The client re-randomizes it before every request, so the server adds refunds and advances the index without ever seeing the same point twice. See [ZK.md](./ZK.md#the-refund-accumulator).

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
| **Replay attacks** | Nullifiers stored server-side; a retry of the same signal gets the cached response |
| **Balance draining** | The proof shows `(i + 1) · C_max ≤ D + R`, with D bound to the deposit |
| **Server withholding an accumulator** | The note can make no further request, but exits without the server, losing at most `C_max` |
| **Sybil attacks** | Each deposit requires real ETH stake |
| **ToS violations** | The server refuses service or withholds the next accumulator; it can't take the deposit |
| **Understated exit** | The exit's signal collides with a served request's, which reveals `k`; the note is slashed during the window |
| **Self-slashing** | The slasher gets a fixed bounty, not the deposit, so it recovers no spending |

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
   - **Note**: Server cannot correlate prompts to identities, but prompts are visible to the upstream provider

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
| **Withdrawal** | ~$5-15 (gas cost, two transactions) | Once per note |

**Example**: Deposit $50 → make requests, each charged `C_max` and refunded `C_max − C_actual` into the accumulator → withdraw `D + R − n · C_max`, the unspent balance, after the window.

### Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| **Proof generation** | 2-5 seconds | Client-side (browser/Node.js) |
| **Proof verification** | 10-20ms | Server-side (SnarkJS) |
| **Proof size** | 200-300 bytes | Groth16 constant size |
| **Deposit gas cost** | ~1.2M gas | One-time per note; 20 Poseidon hashes onchain |
| **Withdrawal gas** | ~0.9M + ~65k gas | `initiateWithdrawal` verifies a proof and removes the leaf, `finalizeWithdrawal` pays |
| **Max depositors** | ~1M | Depth-20 Merkle tree |

### Gas Optimization Notes

- **No per-request onchain cost**: refunds accumulate off-chain and settle once, at withdrawal
- **L2 deployment**: Consider Arbitrum/Optimism for 10-100x cheaper deposits
- **Merkle proofs**: 20 hashes verified onchain per deposit (Poseidon in assembly)

## System Components

### Core System

**Zero-Knowledge Layer**
- ZK circuit design (Circom) - Groth16 with RLN
- Proof verification (SnarkJS) - ~10-20ms server-side
- Smart contract (Solidity) - LongjingCredits.sol with note settlement and an onchain 20-level tree
- Nullifier store - SQLite persistent storage with privacy guarantees

**Backend Services (NestJS)**
- API endpoints with HTTPS/TLS
- Accumulator signing (EdDSA, in-circuit verification) and an exit watcher
- ETH/USD oracle (Kraken + Chainlink fallback)
- Rate limiting without IP tracking: shape checks, request fingerprint, per-nullifier limits and concurrency caps on verification and proving
- Comprehensive test suite

**Provider Abstraction**
- Multi-provider architecture with dynamic pricing
- Claude as the reference provider (claude-fable-5-1 by default)
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
- Request proofs verified by the server against a recent onchain root
- Withdrawal proofs verified onchain (secret key never revealed)
- Slashing needs no proof: the contract checks `Poseidon(k)` against the note
- Proper pairing checks using EVM precompiles

### Production Requirements

**Before Testnet**:

1. **Trusted setup ceremony**: replace the single-party phase 2 of `request` and `settlement` with a public multi-party one ([#135](https://github.com/w3hc/longjing/issues/135))
2. **Withdrawal page**: a self-contained page that exits from the user's wallet ([#157](https://github.com/w3hc/longjing/issues/157))
3. **Independent review**: circuits, contract and backend, none reviewed since the settlement redesign

**Trust Assumptions**:

- **Admin control**: the contract owner can change the verifier, the server address and the refund key, but only 7 days after a public proposal, longer than an exit takes
- **Challenge availability**: if the server is offline longer than the 3-day window, an understated exit goes through; that costs the operator, never another user
- **Deposit linkability**: a deposit publicly links the paying wallet to the note's commitment, and an exit links the commitment to its recipient

## Roadmap

### Phase 1: SDK & Testnet Launch (Next)
- [ ] **w3pk Wallet SDK integration**
  - Client-side proof generation (WASM/SnarkJS)
  - Note files and accumulator management
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
  - Anonymous requests to the configured provider (chat with Claude in the reference setup)
  - Balance and accumulator visualization
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
