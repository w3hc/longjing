# Zero-Knowledge Proofs and Circuits

How Longjing's proofs, circuits and contract fit together. The protocol itself, and why it departs from the paper where it does, is specified in [SETTLEMENT.md](SETTLEMENT.md).

## Overview

Users deposit ETH once into a note, then make API requests that neither the operator nor an observer can link to the deposit or to each other. Each request carries a Groth16 proof that the note can pay for it, a Rate-Limit Nullifier and a re-randomized refund accumulator, and nothing else that identifies it. When users leave, they prove a withdrawal of what they didn't spend.

**Reference Implementation**: Claude is the reference upstream provider. The protocol doesn't depend on it, and any paid API can replace it ([PROVIDERS.md](PROVIDERS.md)).

## Core Concepts

### Notes

A note is one deposit. The client draws a secret key `k` and commits to it:

```
c = Poseidon(k)
```

`deposit(c)` stores the note under `c` and inserts the leaf `Poseidon(c, D)`, which the contract computes from `msg.value`. The leaf binds the amount D, so a proof can't claim more than was paid.

### Merkle Tree Anonymity Set

- **Structure**: 20 levels, up to 1,048,576 notes, kept onchain
- **Hash Function**: Poseidon
- **Roots**: the contract keeps the last 30; a request may use any of them
- **Closed notes**: an exiting, slashed or expired note's leaf is replaced with the empty value

### Rate-Limit Nullifiers (RLN)

Request `i` of a note carries an RLN signal, as in the paper:

- `a = Poseidon(k, i)`, nullifier `N = Poseidon(a)`, fresh for every index
- `y = k + a · x`, where `x = Poseidon(SHA-256(payload) mod p, ρ)` and `ρ` is a fresh nonce sent with the request
- Two signals with the same `N` and different `x` reveal `k = (y₁ · x₂ − y₂ · x₁) / (x₂ − x₁)`, and anyone holding `k` can slash the note

### The Refund Accumulator

Refunds accumulate in a Pedersen commitment on Baby Jubjub:

```
A = R·G + m·J + c·K + s·H
```

`R` is the sum of refunds, `m` the next index, `c` the note's commitment and `s` a blinding factor. `G, J, K, H` are hashed to the curve from the seeds `longjing/accumulator/{G,J,K,H}` ([src/longjing/accumulator.ts](../src/longjing/accumulator.ts)). The genesis accumulator is `c·K`. Every later one is signed by the server's refund key.

A request reveals `A_pub = A + s'·H` for a fresh `s'`, and the server answers with `A' = A_pub + v·G + J`, signed, where `v = C_MAX − C_actual`. `A'` opens to `(R + v, i + 1, c, s + s')`, so the server adds the refund and moves the index without seeing either.

## Architecture

```
┌──────────────────────────────── Client ────────────────────────────────┐
│ note file: k, (R, m, s), signature        pnpm prove / note.ts         │
│ request.circom proof, N, (x, y), A_pub    settlement.circom proof      │
└───────────────┬────────────────────────────────────────┬───────────────┘
                │ HTTPS, into the enclave                │ transactions
                ▼                                        ▼
┌──────────── Longjing server (NestJS, TEE) ─────┐  ┌──── LongjingCredits ────┐
│ 1. x = Poseidon(H(M), ρ)?                      │  │ deposit(c)              │
│ 2. worst case ≤ C_MAX                          │  │ isKnownRoot(root)       │
│ 3. proof against a recent root, C_MAX, the key │◀─┤ C_MAX, serverPublicKey  │
│ 4. store (N, x, y); reused N → slash(k)        │  │ initiateWithdrawal      │
│ 5. call the provider, v = C_MAX − cost         │  │ finalizeWithdrawal      │
│ 6. sign A' = A_pub + v·G + J                   │  │ slash(k)                │
│ watcher: WithdrawalInitiated → challenge       │◀─┤ claimExpired            │
└────────────────────────────────────────────────┘  └─────────────────────────┘
```

**In-TEE TLS termination:** in production, the HTTPS hop above ends inside the enclave. The TLS private key is derived in-enclave (dstack KMS) and the served certificate is bound into the attestation `report_data`, so clients can prove their TLS session ends inside the attested enclave, not at a gateway. Any proxy in front must run in TLS-passthrough mode. See [TEE_SETUP.md](TEE_SETUP.md#3-verify-tls-termination-inside-tee).

## Circuits

Both include [templates/accumulator.circom](../circuits/templates/accumulator.circom), which opens the accumulator and checks it is genesis or signed with EdDSA-Poseidon over `Poseidon(A.x, A.y)`. See [circuits/README.md](../circuits/README.md) for constraint counts.

### Request ([circuits/request.circom](../circuits/request.circom))

Proves that:

1. the leaf `Poseidon(Poseidon(k), D)` is in the tree under the public root
2. the accumulator is genesis (with `i = 0`) or signed, and opens to `(R, i, Poseidon(k), s)`
3. `A_pub = A + s'·H`
4. solvency holds: `(i + 1) · C_MAX ≤ D + R`, with `i < 2^32` and D, R, `C_MAX < 2^128`
5. the RLN signal at index `i` is correct

**Public signals**, in the order the verifier passes them:

```
nullifier, signalY, accumulatorX, accumulatorY,   // outputs
merkleRoot, maxCost, signalX,                     // inputs
serverPublicKeyX, serverPublicKeyY                // inputs
```

The server fills `maxCost` with the contract's `C_MAX` and the key with its own refund key, never with values from the request. The commitment, leaf, D, `i` and R stay private.

### Settlement ([circuits/settlement.circom](../circuits/settlement.circom))

Proves that, for a claimed index count `n`:

1. `Poseidon(k)` is the public commitment `c`
2. the accumulator is genesis or signed, and opens to `(R, m, c, s)` with `n ≥ m`
3. the payout `P = D + R − n · C_MAX` is not negative
4. the RLN signal at index `n` is correct, with `x` bound to the recipient

**Public signals**: `nullifier, signalY, payout` (outputs), then `commitment, deposit, maxCost, serverPublicKeyX, serverPublicKeyY, recipient, signalX`. The contract supplies the commitment, `notes[c].amount`, `C_MAX` and `x = Poseidon(Poseidon(recipient, chainId), contract)` itself. There is no Merkle path.

## Smart Contract

**File**: [contracts/src/LongjingCredits.sol](../contracts/src/LongjingCredits.sol)

```solidity
// Open a note worth msg.value, C_MAX ≤ D < 2^128; the leaf Poseidon(c, D) is computed onchain
function deposit(bytes32 commitment) external payable

// Whether a request proof may use this root (one of the last 30)
function isKnownRoot(bytes32 root) external view returns (bool)

// Start an exit paying P after CHALLENGE_WINDOW (3 days); removes the leaf
function initiateWithdrawal(
    bytes32 commitment,
    address recipient,
    EdDSAPublicKey calldata refundKey,   // any key ever accepted
    uint256[8] calldata proof,           // settlement.circom
    uint256 nullifier,
    uint256 signalY,
    uint256 payout
) external

// Pay the recipient once the window has passed; D − P goes to operatorBalance
function finalizeWithdrawal(bytes32 commitment) external

// Slash the note whose secret key is k: SLASH_BOUNTY to the caller, the rest to the operator
function slash(uint256 secretKey) external

// The operator's claims: an untouched note after NOTE_TTL, and its balance
function claimExpired(bytes32 commitment) external
function withdrawOperatorBalance() external
```

Pausing blocks `deposit` and `claimExpired`, never an exit or a slash. Changes to the verifier, `serverAddress` and the refund key wait `ADMIN_DELAY` (7 days), longer than an exit takes, and every refund key ever accepted stays valid for withdrawals.

## Backend Services

| Service | Purpose | Location |
|---------|---------|----------|
| **LongjingService** | Request handling: signal binding, proof, store, provider call, signed accumulator | [longjing.service.ts](../src/longjing/longjing.service.ts) |
| **ProofVerifierService** | Groth16 verification against a recent root, `C_MAX` and the refund key | [proof-verifier.service.ts](../src/longjing/proof-verifier.service.ts) |
| **SnarkjsProofService** | snarkjs integration for `request.circom` | [snarkjs-proof.service.ts](../src/longjing/snarkjs-proof.service.ts) |
| **BlockchainService** | Contract reads (roots, `C_MAX`, notes) and the `WithdrawalInitiated` feed | [blockchain.service.ts](../src/longjing/blockchain.service.ts) |
| **NullifierStoreService** | `(N, x, y)` in SQLite, and responses kept 10 minutes for retries | [nullifier-store.service.ts](../src/longjing/nullifier-store.service.ts) |
| **RefundSignerService** | Signs accumulators with EdDSA (Baby Jubjub + Poseidon) | [refund-signer.service.ts](../src/longjing/refund-signer.service.ts) |
| **SlashingService** | Recovers `k` from two signals and calls `slash(k)` | [slashing.service.ts](../src/longjing/slashing.service.ts) |
| **ExitWatcherService** | Records each exit's nullifier and slashes an understated one | [exit-watcher.service.ts](../src/longjing/exit-watcher.service.ts) |
| **EthRateOracleService** | ETH/USD rates from Kraken | [eth-rate-oracle.service.ts](../src/longjing/eth-rate-oracle.service.ts) |

The client side is [scripts/client/note.ts](../scripts/client/note.ts), behind `pnpm prove`. The server never proves anything that needs `k`. See [API_REFERENCE.md](API_REFERENCE.md) for the endpoints and the client guide.

## Cryptographic Primitives

### Poseidon Hash Function

Used for commitments, leaves, the Merkle tree, RLN and the signed message:

```typescript
import { buildPoseidon } from 'circomlibjs';
const poseidon = await buildPoseidon();
const hash = poseidon.F.toObject(poseidon([input1, input2]));
```

The contract's `PoseidonHasher` matches circomlib for one and two inputs. Its `hash3` chains two-input hashes, which is how `withdrawalSignalX` computes `x`.

### EdDSA Signatures (Baby Jubjub)

The server signs each accumulator with EdDSA-Poseidon, the variant circomlib's `EdDSAPoseidonVerifier` checks in both circuits:

```typescript
import { buildEddsa } from 'circomlibjs';

const eddsa = await buildEddsa();
const message = poseidon([A.x, A.y]);
const signature = eddsa.signPoseidon(privateKey, eddsa.F.e(message));
const valid = eddsa.verifyPoseidon(eddsa.F.e(message), signature, publicKey);
```

### Pedersen Commitments

The accumulator is a Pedersen commitment over four generators of the prime-order subgroup. It is binding as long as nobody knows a discrete log between the generators, which hashing them to the curve from public seeds rules out, and hiding thanks to the blinding factor.

### Cryptographic assumptions

Privacy and funds rest on different assumptions. Hash functions are designed to have no algebraic structure. Elliptic curves, pairings and lattices have structure, and AI-accelerated cryptanalysis may exploit it sooner than expected, well before a quantum computer does.

| Primitive | Used for | Assumption | If it breaks |
| --- | --- | --- | --- |
| Poseidon | Commitments, leaves, Merkle tree, RLN nullifiers and shares | Hash | **Privacy and funds.** A commitment or nullifier could reveal `k` or link requests, and a collision could fake a Merkle path |
| Pedersen, hiding | Re-randomized refund accumulator | None: perfectly hiding | Nothing. A published accumulator reveals nothing about `R`, the note or the index |
| Groth16, zero-knowledge | Request and settlement proofs | None: perfectly zero-knowledge | Nothing. Past proofs reveal nothing |
| Groth16, soundness | Request and settlement proofs | Pairings on BN254, plus an honest trusted setup (LJ-04, [#135](https://github.com/w3hc/longjing/issues/135)) | **Funds.** Anyone can forge a withdrawal of any note, other users' included |
| Pedersen, binding | Refund accumulator | Discrete log on Baby Jubjub | **Funds.** A user opens the accumulator to a larger `R`, capped by `P ≤ D` at their own deposit |
| EdDSA-Poseidon | The refund key signing accumulators | Discrete log on Baby Jubjub | **Funds.** A user forges accumulators, capped by `P ≤ D` at their own deposit |
| ECDSA | `serverAddress`, the Safe's signers | Discrete log on secp256k1 | **Operator funds.** A recovered `serverAddress` key takes the operator balance. A recovered Safe can only queue admin changes, which wait `ADMIN_DELAY`, so users can exit first |
| ML-KEM-1024 | Nothing yet: the key is attested but unused ([MLKEM.md](MLKEM.md)) | Lattices (Module-LWE) | Nothing today |

What follows:

- **A break of curves or pairings costs no privacy.** Nothing encrypted is ever posted onchain, the accumulator is perfectly hiding and the proofs are perfectly zero-knowledge, so no past request or withdrawal can be deanonymized later. Privacy depends only on Poseidon.
- **It does cost funds.** A Groth16 break is the worst case: the 7-day `ADMIN_DELAY` guards changes to a verifier, not a verifier that is itself broken.
- **Rotating the refund key doesn't revoke the old one.** Every refund key ever accepted stays valid for withdrawals, so that exits never depend on the operator. Recovering any past key is enough to forge accumulators.
- **The way out is hash-only soundness**: a STARK instead of Groth16, which is what the paper uses, and a hash-based signature for refunds. See [SETTLEMENT.md](SETTLEMENT.md#departures-from-the-paper).

## Cost Calculation

### Reference provider pricing: Claude (October 2026)

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

1. **Secret Key Protection**: users never reveal `k`. Two signals at one index reveal it, and the note is slashed
2. **Sequential Requests**: request `i` needs the accumulator signed for index `i`, so the indices a note uses form a prefix. That is what makes settling on the highest index sound
3. **Root Freshness**: the server accepts one of the contract's last 30 roots, and in production fails closed with a 503 when it can't read them
4. **Exit Challenges**: an exit's signal at its claimed index `n` collides with a request signal if `n` was already used, and the server slashes it within the window. If the server is offline for longer than the window, an understated exit goes through: that costs the operator, never another user
5. **Payout Bound**: every signed step adds at most `C_MAX` to R, so a payout never exceeds D. The contract checks `P ≤ D` itself as well
6. **Self-Slashing**: the slasher gets a fixed bounty, not the deposit, so an owner who slashes their own note recovers nothing they spent

## Privacy Guarantees

- **Request to deposit**: a request carries no commitment, leaf, deposit amount or index, and the server stores only `(N, x, y)`
- **Request to request**: nullifiers are fresh per index and the published accumulator is re-randomized every time, so two requests share no value
- **Anonymity set**: a request proves membership among every note in the tree, whatever its amount
- **Exit**: shows that a note closed, to which recipient and for what payout, so `D − P` is its net spending. It doesn't show which requests it made
- **Not covered**: timing and network metadata ([#99](https://github.com/w3hc/longjing/issues/99)), and whoever ran the single-party trusted setup could forge proofs ([#135](https://github.com/w3hc/longjing/issues/135))

## Testing

```bash
pnpm test           # unit tests, including witness-level circuit tests when circom is installed
pnpm test:proof     # circuit specs and real Groth16 proofs against the pinned keys
pnpm test:e2e       # contract, server and client on Anvil
(cd contracts && forge test)   # contract tests, with the real SettlementVerifier
pnpm demo           # the project's goals, checked end to end on Anvil
```

## Implementation Notes vs Original Proposal

The protocol follows [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104): RLN signals, the solvency formula `(i + 1) · C_max ≤ D + R` with a constant `C_max`, a homomorphic refund accumulator, and a stake forfeited on a double-spend. Each departure is listed, with its reason, in [SETTLEMENT.md](SETTLEMENT.md#departures-from-the-paper). The main ones: Groth16 instead of a STARK, one stake instead of two, a fixed slashing bounty, sequential requests per note, and a two-step withdrawal with a challenge window.

## Circuit Artifacts

Circuit artifacts are not tracked in Git. They are published as assets of the [`circuits-v2` release](https://github.com/w3hc/longjing/releases/tag/circuits-v2), and [`circuits/artifacts.json`](../circuits/artifacts.json) pins each one by sha256. Fetch them into `circuits/build/` with:

```bash
pnpm circuits:fetch
```

The script skips files that already match, and fails if a download does not match its pinned hash. CI and the Docker build run it.

`pnpm check:verifiers` then checks that each pinned verification key matches its zkey, that `SettlementVerifier.sol` embeds the settlement key, and that no key has δ = γ, which would let anyone forge proofs. CI runs it too.

Each circuit ships three files:

- `<circuit>_js/<circuit>.wasm` - Witness generator, for clients
- `<circuit>.zkey` - Proving key, for clients
- `<circuit>_verification_key.json` - Verification key. The server loads `request`'s, the only artifact the Docker image ships

The `request` and `settlement` keys come from the public [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) (`ppot_0080_17.ptau`, sha256 `f807e065…a367c`) plus a single local phase 2 contribution. That is enough for testnets; mainnet needs a multi-party phase 2 ceremony (see [TRUSTED_SETUP_CEREMONY.md](./TRUSTED_SETUP_CEREMONY.md)).

**To regenerate them** after changing a circuit:

```bash
cd circuits
circom request.circom --r1cs --wasm --sym -o build/
curl -O https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_17.ptau
npx snarkjs groth16 setup build/request.r1cs ppot_0080_17.ptau build/request_0000.zkey
npx snarkjs zkey contribute build/request_0000.zkey build/request.zkey --name="Contribution" -e="$(openssl rand -hex 32)"
npx snarkjs zkey export verificationkey build/request.zkey build/request_verification_key.json
```

Repeat for `settlement`, then export its Solidity verifier with `npx snarkjs zkey export solidityverifier`, rename `Groth16Verifier` to `SettlementVerifier`, keep the `verifySettlementProof` wrapper at the end of the contract and run `forge fmt` on it. Regenerate the Foundry fixtures with `scripts/testing/generate-settlement-fixtures.ts`.

After regenerating, publish the changed files as assets of a new release, then update the release URL and hashes in `circuits/artifacts.json` (`shasum -a 256 <file>`).

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
