# Zero-Knowledge Proofs and Circuits

This document provides a comprehensive overview of the Zero-Knowledge (ZK) proof system and circuit implementation for the Longjing project.

## Overview

The Longjing system enables privacy-preserving access to any external API service using Zero-Knowledge proofs, Rate-Limit Nullifiers (RLN), and Ethereum smart contracts. Users deposit ETH once and make thousands of anonymous API calls without revealing their identity or linking requests together.

**Reference Implementation**: Claude API integration is provided as a complete example.

## Core Concepts

### Rate-Limit Nullifiers (RLN)

RLN is a cryptographic primitive that prevents double-spending while preserving privacy:

- **Nullifier**: A unique identifier for each request: `nullifier = Poseidon(a)` where `a = Poseidon(secretKey, ticketIndex)`
- **Signal**: A proof of authenticity: `y = secretKey + a * x` where `x = SHA-256(payload) mod p` (UTF-8 payload, p the BN254 scalar field order); the server rejects any request whose `x` does not match its payload
- **Double-Spend Detection**: If the same `ticketIndex` is reused with different messages, the secret key can be recovered algebraically

### Identity Commitment

Each user has a secret key `k` and generates an identity commitment:

```
ID = Poseidon(k)
```

This commitment is stored in the Merkle tree anonymity set onchain, allowing users to prove membership without revealing their identity.

### Merkle Tree Anonymity Set

- **Structure**: 20 levels deep, supporting up to 1,048,576 identities
- **Hash Function**: Poseidon (ZK-friendly)
- **Storage**: Onchain root, off-chain tree construction
- **Purpose**: Enables privacy-preserving membership proofs

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Side                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │
│  │ Secret Key k │───▶│ ZK Prover    │───▶│ Proof π_req  │   │
│  │ Refund Tix   │   │ (Circom)     │   │ Nullifier    │   │
│  └──────────────┘   └──────────────┘   │ Signal (x,y) │   │
│                                         └──────┬───────┘   │
└────────────────────────────────────────────────┼───────────┘
                                                  │
                                                  │ HTTPS
                                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                     Longjing Server (NestJS)                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. Nullifier Check (Double-spend detection)         │   │
│  │    - NullifierStoreService                          │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 2. Proof Verification (Groth16 ZK-SNARK)            │   │
│  │    - ProofVerifierService                           │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 3. Execute Claude API Request                       │   │
│  │    - Anthropic SDK                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 4. Calculate Cost in ETH                            │   │
│  │    - EthRateOracleService (Kraken API)              │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 5. Issue Refund Ticket                              │   │
│  │    - RefundSignerService (EdDSA)                    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                                │
                                │ Web3 RPC
                                ▼
┌─────────────────────────────────────────────────────────────┐
│              Ethereum Mainnet (Smart Contract)              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ LongjingCredits.sol                                    │   │
│  │  - deposit()         : Add funds + ID commitment    │   │
│  │  - withdraw()        : Reclaim unused funds         │   │
│  │  - redeemRefund()    : Claim refund tickets         │   │
│  │  - slashDoubleSpend(): Extract k, reward slasher    │   │
│  │  - slashPolicyStake(): Burn policy stake (trusted)  │   │
│  │  - Merkle Tree       : Identity anonymity set       │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**In-TEE TLS termination:** in production, the HTTPS hop above ends inside the enclave. The TLS private key is derived in-enclave (dstack KMS) and the served certificate is bound into the attestation `report_data`, so clients can prove their TLS session ends inside the attested enclave, not at a gateway. Any proxy in front must run in TLS-passthrough mode. See [TEE_SETUP.md](TEE_SETUP.md#3-verify-tls-termination-inside-tee).

## Implementation Status

### ✅ Completed: Real ZK Proof Verification

The ZK proof system now supports **cryptographically valid Groth16 SNARK verification** using snarkjs.

**Previous (Mock):** Only validated proof JSON structure
**Current (Real):** Full cryptographic verification with trusted setup

**Key Changes:**
- New [SnarkjsProofService](../src/longjing/snarkjs-proof.service.ts) for real proof generation/verification
- Updated [ProofVerifierService](../src/longjing/proof-verifier.service.ts) to use cryptographic verification
- `ZK_CIRCUIT` selects the circuit; production only accepts `api_request` and refuses to start without its verification key, and other profiles default to `api_request_local`

**Files:**
- Production circuit: [circuits/api_request.circom](../circuits/api_request.circom) (~110K constraints)
- Local circuit: [circuits/api_request_local.circom](../circuits/api_request_local.circom) (~32K constraints)
- Test circuit: `api_credit_proof_test` (~676 constraints), opt-in
- All three come from `pnpm circuits:fetch`

## ZK Circuit Design

### Test Circuit (Development)

**Artifacts**: `circuits/build/api_credit_proof_test*`, fetched with `pnpm circuits:fetch`

A simplified circuit, used only with `ZK_CIRCUIT=api_credit_proof_test`. [scripts/testing/generate-proof.ts](../scripts/testing/generate-proof.ts) and `ProofGenService.generateWithdrawalProof` still prove with it. It checks no Merkle membership, solvency or refund signature, so production refuses it.

**Inputs:**
- `secretKey` (private) - User's secret key
- `ticketIndex` (private) - Request ticket index
- `signalX` (public) - RLN signal X component
- `idCommitmentExpected` (public) - Expected identity commitment

**Outputs:**
- `nullifier` - Unique request nullifier
- `signalY` - RLN signal Y component
- `idCommitment` - Identity commitment

**Performance:**
- Constraints: ~676 non-linear
- Proving time: ~100-500ms
- Verification time: ~5-20ms

### Production Circuit

**File**: [circuits/api_request.circom](../circuits/api_request.circom), with the template in [circuits/templates/api_request_proof.circom](../circuits/templates/api_request_proof.circom)

The circuit the server verifies requests with in production. It proves four key properties:

1. **Membership**: User's identity commitment is in the Merkle tree
2. **Refund Summation**: All refund tickets carry a valid Poseidon EdDSA signature, the variant `RefundSignerService` signs with, and the nullifiers of active tickets are strictly increasing, so one ticket can't be counted twice. Clients sort their tickets by nullifier
3. **Solvency**: User has sufficient balance: `(ticketIndex + 1) × maxCost ≤ initialDeposit + totalRefunds`
4. **RLN**: Generates nullifier and signal for double-spend prevention

**Circuit Parameters**:
- `TREE_DEPTH = 20`: Merkle tree depth (1,048,576 capacity)
- `MAX_REFUNDS = 10`: Maximum refund tickets per proof

**Public signals**, in the order the verifier passes them:

```
nullifier, signalY, idCommitment, merkleRoot,               // outputs
merkleRootExpected, maxCost, signalX,                       // inputs
serverPublicKeyX, serverPublicKeyY                          // inputs
```

The server fills `serverPublicKeyX/Y` with its own refund-signing key, never with a value from the request, so a proof whose refund tickets were signed by any other key fails verification.

### Local Circuit

**File**: [circuits/api_request_local.circom](../circuits/api_request_local.circom)

The same statement and public signals as `api_request`, with `MAX_REFUNDS = 2`: about 32K constraints instead of 110K. It is the default outside production, where proving and the setup stay fast on a laptop. Production refuses it.

## Smart Contract

**File**: [contracts/src/LongjingCredits.sol](../contracts/src/LongjingCredits.sol)

Manages deposits, withdrawals, slashing, and the Merkle root.

**Key Functions**:

```solidity
// Deposit ETH and join anonymity set
function deposit(bytes32 idCommitment) external payable

// Withdraw the deposit with a withdrawal.circom proof
// publicSignals: nullifier, signalY, idCommitment, merkleRoot, signalX, merkleRootExpected, recipient
function withdraw(
    bytes32 idCommitment,
    address payable recipient,
    uint256[8] calldata proof,
    uint256[7] calldata publicSignals
) external

// Redeem a refund ticket with a refund_redemption.circom proof
// publicSignals: nullifier, signalY, idCommitment, signalX, refundValueClaimed, serverPublicKeyX, serverPublicKeyY, recipient
function redeemRefund(
    bytes32 idCommitment,
    bytes32 nullifier,
    uint256 refundValue,
    address payable recipient,
    uint256[8] calldata proof,
    uint256[8] calldata publicSignals
) external

// Slash a double-spender with a double_spend_slashing.circom proof
// publicSignals: idCommitment, nullifier, secretKeyClaimed, nullifierExpected
function slashDoubleSpend(
    bytes32 secretKey,
    bytes32 nullifier,
    bytes32 idCommitment,
    uint256[8] calldata proof,
    uint256[4] calldata publicSignals
) external

// Burn a policy violator's policy stake (server only, no proof)
function slashPolicyStake(bytes32 nullifier, bytes32 idCommitment) external

// Check if nullifier has been used (double-spend or refund redemption)
function isNullifierUsed(bytes32 nullifier) external view returns (bool)
```

**Dual Staking**:
- **RLN Stake**: Claimable by anyone who proves double-spending
- **Policy Stake**: Burned (not transferred) by the server for ToS violations. No proof backs it: the server address is trusted, and the 7-day timelock on changing it is the only guard

## Backend Services

### Core Services

| Service | Purpose | Location |
|---------|---------|----------|
| **LongjingService** | Main orchestrator for chat requests | [src/longjing/longjing.service.ts](../src/longjing/longjing.service.ts) |
| **ProofGenService** | RLN primitives (Poseidon, nullifier/signal generation) | [src/longjing/proof-gen.service.ts](../src/longjing/proof-gen.service.ts) |
| **ProofVerifierService** | ZK proof verification | [src/longjing/proof-verifier.service.ts](../src/longjing/proof-verifier.service.ts) |
| **ZKProofService** | Full snarkjs integration for Groth16 proofs | [src/longjing/zkproof.service.ts](../src/longjing/zkproof.service.ts) |
| **BlockchainService** | Ethers.js contract interface, Merkle tree sync | [src/longjing/blockchain.service.ts](../src/longjing/blockchain.service.ts) |
| **MerkleTreeService** | Off-chain Merkle tree with Poseidon hash | [src/longjing/merkle-tree.service.ts](../src/longjing/merkle-tree.service.ts) |
| **NullifierStoreService** | Tracks used nullifiers (SQLite persistent storage) | [src/longjing/nullifier-store.service.ts](../src/longjing/nullifier-store.service.ts) |
| **EthRateOracleService** | Fetches ETH/USD rates from Kraken | [src/longjing/eth-rate-oracle.service.ts](../src/longjing/eth-rate-oracle.service.ts) |
| **RefundSignerService** | Signs refund tickets with EdDSA (Babyjubjub + Poseidon) | [src/longjing/refund-signer.service.ts](../src/longjing/refund-signer.service.ts) |

### API Endpoints

See [API_REFERENCE.md](API_REFERENCE.md) for request and response formats.

- `POST /longjing/request`: anonymous API request with a ZK proof; returns the response and a signed refund ticket
- `GET /longjing/server-pubkey`: the EdDSA public key that signs refund tickets
- `POST /longjing/redeem-refund`: submits a refund redemption proof, generated by the client, onchain
- `POST /longjing/proofs/slashing`: proof that slashes a double-spender, from the publicly recoverable secret key

Withdrawal and refund redemption proofs need the user's secret key, so they are generated on the client, never by the server.

## Protocol Flow

### 1. Registration (One-time)

```typescript
// Client-side
const secretKey = generateRandomKey();
const idCommitment = poseidon([secretKey]);

// Onchain
await longjingCredits.deposit(idCommitment, { value: parseEther('0.01') });
```

### 2. Making Requests (Repeatable)

```typescript
// Generate proof
const proof = await generateProof({
  secretKey,
  merkleProof: await contract.getMerkleProof(idCommitment),
  refundTickets: previousRefunds,
  ticketIndex: nextIndex,
  maxCost: parseEther('0.001')
});

// Compute RLN signal
const a = poseidon([secretKey, ticketIndex]);
const nullifier = poseidon([a]);
const x = BigInt('0x' + createHash('sha256').update(payload, 'utf8').digest('hex')) % p;
const y = secretKey + a * x;

// Submit request
const response = await fetch('/longjing/request', {
  method: 'POST',
  body: JSON.stringify({
    payload,
    proof,
    nullifier,
    signal: { x, y },
    maxCost, merkleRoot, initialDeposit, ticketIndex, idCommitment, idCommitmentExpected,
  })
});

// Store refund ticket
refundTickets.push(response.refundTicket);
ticketIndex++;
```

### 3. Double-Spend Detection

If a user reuses the same `ticketIndex` with different messages:

```typescript
// Server detects: same nullifier, different signal x
const signal1 = { x: x1, y: y1 };
const signal2 = { x: x2, y: y2 };  // x2 ≠ x1

// Extract secret key: k = (y1*x2 - y2*x1) / (x2 - x1)
const k = (y1 * x2 - y2 * x1) / (x2 - x1);

// Submit to smart contract
await longjingCredits.slashDoubleSpend(k, nullifier, signal1, signal2);
```

## Cryptographic Primitives

### Poseidon Hash Function

Used for all hash operations in the ZK circuit:

```typescript
import { buildPoseidon } from 'circomlibjs';
const poseidon = await buildPoseidon();
const hash = poseidon([input1, input2, ...]);
```

### EdDSA Signatures (Babyjubjub)

Used for refund ticket signing with circuit-compatible cryptography:

```typescript
import { buildEddsa, buildBabyjub, buildPoseidon } from 'circomlibjs';

const eddsa = await buildEddsa();
const babyJub = await buildBabyjub();
const poseidon = await buildPoseidon();

// Generate keypair
const privateKey = Buffer.from(crypto.randomBytes(32));
const publicKey = eddsa.prv2pub(privateKey);

// Sign message with Poseidon hash
const message = poseidon([nullifier, value, timestamp]);
const signature = eddsa.signPoseidon(privateKey, babyJub.F.e(message));

// Signature contains: { R8: [R8x, R8y], S }

// Verify signature
const isValid = eddsa.verifyPoseidon(
  babyJub.F.e(message),
  signature,
  publicKey
);
```

**Why Babyjubjub + Poseidon?**
- **Circuit Efficiency**: SHA256 requires ~25,000 constraints. Babyjubjub EdDSA + Poseidon use only ~1,500 constraints
- **ZK-Friendly**: Designed specifically for ZK-SNARKs on the BN128 curve
- **Compatible**: Matches the `EdDSAVerifier` circuit from circomlib used in our ZK proofs

### Field Arithmetic

All operations occur in a finite field:

```typescript
const F = poseidon.F;

// Convert to field element
const aF = F.e(a);
const bF = F.e(b);

// Perform operation
const result = F.add(aF, F.mul(bF, cF));

// Convert back to bigint
const output = F.toObject(result);
```

## Cost Calculation

### Claude API Pricing (October 2026)

Single source: [`src/pricing/claude-pricing.ts`](../src/pricing/claude-pricing.ts). The request DTO, `LongjingService`, `ClaudeProvider` and `/longjing/estimate-cost` all read it, and a model outside it is rejected.

| Model | Input ($/M tokens) | Output ($/M tokens) |
|-------|-------------------|---------------------|
| claude-fable-5-1 | $10 | $50 |
| claude-opus-4-6 | $5 | $25 |
| claude-sonnet-4-6 | $3 | $15 |
| claude-haiku-4-5 | $1 | $5 |

### ETH Conversion

```typescript
async function calculateCostInETH(
  inputTokens: number,
  outputTokens: number,
  model: string
): Promise<bigint> {
  const pricing = CLAUDE_PRICING[model];
  const costUSD = (inputTokens / 1_000_000) * pricing.input
                + (outputTokens / 1_000_000) * pricing.output;

  const ethUsdRate = await getEthUsdRate();  // From Kraken API
  const costETH = costUSD / ethUsdRate;

  return BigInt(Math.ceil(costETH * 1e18));  // Convert to wei
}
```

### Example Costs

Assuming ETH = $2,000:

| Scenario | Input Tokens | Output Tokens | Model | Cost (USD) | Cost (ETH) |
|----------|--------------|---------------|-------|------------|------------|
| Simple Q&A | 100 | 400 | Opus 4.6 | $0.0105 | 0.00000525 |
| Code Generation | 500 | 2000 | Sonnet 4.6 | $0.0465 | 0.00002325 |
| Document Analysis | 10,000 | 1,000 | Haiku 4.5 | $0.015 | 0.0000075 |

## Security Considerations

1. **Secret Key Protection**: Users must never reveal their secret key `k`
2. **Signal Randomness**: Each `signalX` must be cryptographically random
3. **Nullifier Uniqueness**: Each ticket index can only be used once
4. **Merkle Proof Freshness**: Clients must use the current onchain Merkle root. In production, the server rejects a request with 503 when it can't read that root or the nullifier's slashed status
5. **Proof Replay**: Nullifiers are tracked onchain to prevent replay attacks
6. **Server Accountability**: Policy stake is burned (not claimed), so the operator can't profit from a false ban. It can still burn any stake without a proof

## Privacy Guarantees

These are the design goals. At v0.4.1, the `api_request` circuit outputs `idCommitment` as a public signal, so the first, second and last are not met, and the balance is not hidden from whoever looks the deposit up. Tracked in [#134](https://github.com/w3hc/longjing/issues/134).

- ⚠️ **Identity Privacy**: Requests cannot be linked to identity commitment (not yet: `idCommitment` is public)
- ⚠️ **Request Unlinkability**: Each request uses unique nullifier (not yet: every request carries the same `idCommitment`)
- ⚠️ **Balance Privacy**: ZK proof hides actual balance (the deposit is public onchain under `idCommitment`)
- ⚠️ **Cryptographic Enforcement**: No trusted parties required, apart from whoever ran the single-party trusted setup ([#135](https://github.com/w3hc/longjing/issues/135))
- ⚠️ **Anonymity Set**: Users are indistinguishable within all depositors (not yet: `idCommitment` identifies the leaf)

## Testing

### Unit Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- longjing.service.spec.ts

# Run with coverage
npm test -- --coverage
```

### Integration Tests

Test the full proof generation and verification flow:

```bash
npx ts-node scripts/test-proof-verification.ts
```

### Circuit Compilation

```bash
cd circuits
circom api_request.circom --r1cs --wasm --sym
```

## Production Readiness

### ✅ Completed

- [x] ZK circuit design (Circom)
- [x] Smart contract (Solidity)
- [x] Backend services (NestJS)
- [x] API endpoints
- [x] Unit tests (267 tests passing)
- [x] Documentation
- [x] ETH/USD oracle integration
- [x] Refund ticket signing (EdDSA with Babyjubjub + Poseidon)
- [x] RLN cryptographic primitives
- [x] Merkle tree service
- [x] Blockchain service
- [x] Anthropic SDK integration

### ⚠️ TODO for Production

- [ ] Complete trusted setup ceremony (Powers of Tau, proving/verification keys)
- [x] Replace in-memory nullifier store with persistent database (SQLite)
- [x] Implement proper EdDSA with Babyjubjub curve (circuit-compatible)
- [ ] Implement proper key management (HSM/KMS) for EdDSA signing key
- [ ] Add event listener for onchain Deposit events
- [ ] Deploy contract to testnet/mainnet
- [ ] Independent review (contract + circuit + backend)
- [ ] Rate limiting per IP/nullifier
- [ ] Monitoring and alerting for double-spend attempts
- [ ] Gas optimization
- [ ] MEV protection for slashing transactions

## Implementation Notes vs Original Proposal

This implementation follows the [original ZK API Credits proposal](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) with key differences:

### Proof System Choice
- **Original**: ZK-STARK (post-quantum secure, no trusted setup)
- **Current**: Groth16 (ZK-SNARK)
  - Rationale: ~10-20x faster verification, ~400x smaller proofs, lower gas costs
  - Trade-off: Requires trusted setup, not post-quantum
  - Migration path: Can switch to STARKs/PLONK in v2

### Circuit Architecture
- **Original**: Single large circuit for all operations
- **Current**: Three domain-specific circuits
  - `withdrawal.circom` - Merkle membership + identity ownership
  - `refund_redemption.circom` - EdDSA signature batch verification
  - `double_spend_slashing.circom` - RLN secret key extraction
  - Benefits: Smaller trusted setups, faster proving, modular upgrades

### Merkle Tree
- **Original**: "Contract inserts ID into on-chain Merkle Tree"
- **Current**: Backend maintains tree, contract stores root
  - Issue: Creates server dependency for withdrawals
  - Planned: Implement onchain incremental Merkle tree

### Trust Assumptions
For production deployment, address these trust dependencies:
1. **Onchain Merkle tree** - Users can withdraw without server
2. **Server key rotation** - Update EdDSA public key with timelock
3. **Admin timelocks** - Verifier and server address changes already wait 7 days; extend to the remaining parameters
4. **Emergency withdrawal** - Automatic after server downtime period

See [OVERVIEW.md](./OVERVIEW.md#implementation-alignment-with-original-proposal) for complete comparison.

## Circuit Artifacts

Circuit artifacts are not tracked in Git. They are published as assets of the [`circuits-v2` release](https://github.com/w3hc/longjing/releases/tag/circuits-v2), and [`circuits/artifacts.json`](../circuits/artifacts.json) pins each one by sha256. Fetch them into `circuits/build/` with:

```bash
pnpm circuits:fetch
```

The script skips files that already match, and fails if a download does not match its pinned hash. CI and the Docker build run it.

`pnpm check:verifiers` then checks that each pinned verification key matches its zkey, that each Solidity verifier embeds that key, and that no key has δ = γ, which would let anyone forge proofs. CI runs it too.

The server verifies requests with `api_request`. Its artifacts:

- `api_request_js/api_request.wasm` - Witness generator, for clients
- `api_request.zkey` - Proving key, for clients
- `api_request_verification_key.json` - Verification key, the only artifact the server loads and the only one the Docker image ships

`api_request_local` ships the same three files under its own name, for local development.

`request` and `settlement` are the circuits of [SETTLEMENT.md](./SETTLEMENT.md), with the same three files each. Nothing uses them yet: the server still verifies `api_request`, and the contract still verifies `withdrawal`. `contracts/src/SettlementVerifier.sol` is generated from `settlement.zkey` for the contract to adopt.

The `api_request`, `api_request_local`, `withdrawal`, `refund_redemption`, `request` and `settlement` keys come from the public [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) (`ppot_0080_17.ptau`, sha256 `f807e065…a367c`) plus a single local phase 2 contribution. That is enough for testnets; mainnet needs a multi-party phase 2 ceremony (see [TRUSTED_SETUP_CEREMONY.md](./TRUSTED_SETUP_CEREMONY.md)).

**To regenerate them** after changing the circuit:

```bash
cd circuits
circom api_request.circom --r1cs --wasm --sym -o build/
curl -O https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_17.ptau
npx snarkjs groth16 setup build/api_request.r1cs ppot_0080_17.ptau build/api_request_0000.zkey
npx snarkjs zkey contribute build/api_request_0000.zkey build/api_request.zkey --name="Contribution" -e="$(openssl rand -hex 32)"
npx snarkjs zkey export verificationkey build/api_request.zkey build/api_request_verification_key.json
```

Repeat for `api_request_local`, `withdrawal`, `refund_redemption`, `request` and `settlement`. For `withdrawal`, `refund_redemption` and `settlement`, also export the Solidity verifier with `npx snarkjs zkey export solidityverifier`, rename `Groth16Verifier` to `WithdrawalVerifier`, `RefundRedemptionVerifier` or `SettlementVerifier`, run `forge fmt` on it, and keep the `verifyWithdrawalProof`, `verifyRefundProof` or `verifySettlementProof` wrapper at the end of the contract.

After regenerating, publish the changed files as assets of a new release, then update the release URL and hashes in `circuits/artifacts.json` (`shasum -a 256 <file>`).

**Test Circuit:** `circuits/build/api_credit_proof_test.zkey` and `circuits/build/verification_key.json`, used only with `ZK_CIRCUIT=api_credit_proof_test`.

## References

- [ZK API Credits Proposal](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) - Davide Crapis & Vitalik Buterin (Original specification)
- [Rate-Limit Nullifiers Documentation](https://rate-limiting-nullifier.github.io/rln-docs/)
- [Circom Documentation](https://docs.circom.io/)
- [SnarkJS](https://github.com/iden3/snarkjs)
- [Poseidon Hash](https://www.poseidon-hash.info/)
- [Anthropic API Pricing](https://www.anthropic.com/api)
- [Kraken API](https://docs.kraken.com/api/)

## License

GPL-3.0
