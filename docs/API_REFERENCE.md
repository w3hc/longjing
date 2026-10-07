# Longjing API Reference

Complete API reference for the Longjing privacy-preserving system for accessing external API services.

**Reference Implementation**: This documentation uses Claude API as an example. The same patterns apply to any external API service integration.

## Base URL

```
https://localhost:3000  (development)
https://your-domain.com  (production)
```

**Development Note:** Use `-k` flag with curl to accept self-signed certificates in local development.

## Table of Contents

- [Longjing API Reference](#longjing-api-reference)
  - [Base URL](#base-url)
  - [Table of Contents](#table-of-contents)
  - [App Endpoints](#app-endpoints)
    - [POST /longjing/request](#post-longjingrequest)
    - [POST /longjing/estimate-cost](#post-longjingestimate-cost)
    - [GET /longjing/server-pubkey](#get-longjingserver-pubkey)
  - [TEE Attestation Endpoints](#tee-attestation-endpoints)
    - [GET /attestation](#get-attestation)
    - [GET /attestation/manifest](#get-attestationmanifest)
  - [Available for Future Implementation](#available-for-future-implementation)
  - [Health Check Endpoints](#health-check-endpoints)
    - [GET /health](#get-health)
    - [GET /health/ready](#get-healthready)
    - [GET /health/live](#get-healthlive)
  - [Error Responses](#error-responses)
  - [Protocol Flow](#protocol-flow)
    - [Complete Request Flow](#complete-request-flow)
  - [Client Implementation Guide](#client-implementation-guide)
    - [Prerequisites](#prerequisites)
    - [1. Create a note and deposit](#1-create-a-note-and-deposit)
    - [2. Make requests](#2-make-requests)
    - [3. Withdraw, without the server](#3-withdraw-without-the-server)
    - [4. Slash a double-spend](#4-slash-a-double-spend)
  - [Cost Calculation](#cost-calculation)
    - [Claude API Pricing (March 2026)](#claude-api-pricing-march-2026)
    - [Example Calculations](#example-calculations)
  - [Security Best Practices](#security-best-practices)
  - [Support](#support)
  - [References](#references)
  - [License](#license)

---

## App Endpoints

### POST /longjing/request

Submit an anonymous API request (example: Claude API) with a zero-knowledge proof that the note behind it can pay, as [SETTLEMENT.md](SETTLEMENT.md) specifies. Nothing in the request identifies the note, its deposit or its ticket index.

**Authentication:** None (anonymity is provided by the ZK proof)

**Request Body:**

```typescript
{
  payload: string;              // The message/prompt for the external API
  nonce: string;                // ρ, a fresh field element
  nullifier: string;            // N = Poseidon(Poseidon(k, i)), fresh for every index
  signal: {
    x: string;                  // x = Poseidon(SHA-256(payload) mod p, ρ)
    y: string;                  // y = k + a · x
  };
  proof: string;                // Groth16 proof of request.circom (JSON string)
  merkleRoot: string;           // One of the contract's recent roots
  accumulator: {                // A_pub, the re-randomized accumulator the proof outputs
    x: string;
    y: string;
  };
  model?: string;               // One of claude-fable-5-1, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 (default: claude-fable-5-1); anything else is a 400
}
```

**Response:**

```typescript
{
  response: string;             // External API's response, padded
  refund: string;               // v = C_MAX − actual cost, in wei, clamped to [0, C_MAX]
  accumulator: {                // A' = A_pub + v·G + J, the note's next accumulator
    x: string;
    y: string;
    signature: {                // EdDSA-Poseidon over Poseidon(A'.x, A'.y), by the refund key
      R8x: string;
      R8y: string;
      S: string;
    };
  };
  usage: {
    // Quantized classes, not exact counts: exact token counts and costs would make requests linkable
    unitClass: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';
    unitType: string;           // e.g. "tokens"
    costClass: 'micro' | 'small' | 'medium' | 'large' | 'xlarge';
  };
}
```

**Status Codes:**
- `200 OK` - Request processed. A retry of the same `(nullifier, signal)` within 10 minutes gets the same body back, without a second provider call
- `400 Bad Request` - Invalid parameters (a field element that isn't hex or decimal, an oversized `proof` or `payload`), `signal.x` doesn't match the payload and nonce, or the request's worst case exceeds `C_MAX`
- `401 Unauthorized` - Invalid ZK proof, or a root the contract hasn't recorded recently
- `403 Forbidden` - Nullifier already used, double-spend detected, or rate limit exceeded
- `429 Too Many Requests` - Rate limit exceeded (generic message for privacy)
- `502 Bad Gateway` - The provider call failed. The body carries `refund` (all of `C_MAX`) and the signed `accumulator`, so the note moves on without losing value
- `503 Service Unavailable` - Too many proof verifications in flight, or the onchain state (roots, `C_MAX`) can't be read

**Example:**

```bash
# Request: pnpm prove request prints this body
curl -k -X POST https://localhost:3000/longjing/request \
  -H "Content-Type: application/json" \
  -d '{
    "payload": "What does 苟全性命於亂世，不求聞達於諸侯。mean?",
    "nonce": "1834...",
    "nullifier": "1209...",
    "signal": { "x": "7731...", "y": "4402..." },
    "proof": "{\"pi_a\":[\"123...\",\"456...\",\"1\"],\"pi_b\":[[\"789...\",\"012...\",\"1\"],[\"345...\",\"678...\",\"1\"]],\"pi_c\":[\"901...\",\"234...\",\"1\"],\"protocol\":\"groth16\"}",
    "merkleRoot": "1546...",
    "accumulator": { "x": "9921...", "y": "3307..." },
    "model": "claude-fable-5-1"
  }'

# Response
{
  "response": "It is from Zhuge Liang's Chu Shi Biao...",
  "refund": "250000000000000",
  "accumulator": {
    "x": "1188...",
    "y": "6094...",
    "signature": { "R8x": "0x1234...", "R8y": "0x5678...", "S": "0x9abc..." }
  },
  "usage": {
    "unitClass": "small",
    "unitType": "tokens",
    "costClass": "micro"
  }
}
```

**Security Notes:**

1. **Unique Nullifiers**: Each nullifier can only be used once. Reusing it:
   - with the same signal: a retry, answered from the 10-minute cache, then refused
   - with another signal: a double-spend. The two signals reveal `k`, and the server slashes the note with `slash(k)`

2. **ZK Proof Requirements** (`request.circom`): the proof shows that
   - the leaf `Poseidon(Poseidon(k), D)` is in the tree under `merkleRoot`, so D is what was deposited
   - the accumulator is the genesis one or signed by the refund key, and opens to `(R, i, Poseidon(k), s)`
   - `accumulator` is that accumulator re-randomized, `A + s'·H`
   - solvency holds: `(i + 1) · C_MAX ≤ D + R`
   - the RLN signal at index `i` is correct

   The server checks it against `[nullifier, signal.y, accumulator, merkleRoot, C_MAX, signal.x, refund key]`, with `C_MAX` and the key from the contract and its own enclave. The commitment, leaf, D, `i` and R stay private.

3. **Cost Protection**: a request's worst case, priced on the payload's UTF-8 byte length plus 32 tokens of input and 4096 output tokens at the model's rates, must fit in `C_MAX`, or it gets a 400 before the nullifier is used.

4. **Sequential requests**: request `i` needs the accumulator the response to request `i − 1` signed, so a note serves one request at a time. Use several notes for parallel requests.

5. **Rate Limiting**: Nothing is keyed on the client's IP, which `RequestSanitizerMiddleware` hides (see [`src/guards/`](../src/guards/)):
   - **Shape checks**: malformed bodies get a 400 before any RPC or Groth16 work
   - **Request fingerprint**: 10 requests/minute per unique request content, without rate limit headers
   - **Per-nullifier**: 3 requests/minute per nullifier
   - **Concurrency caps**: at most `MAX_CONCURRENT_VERIFICATIONS` (default 8) proofs verified at once; over the cap, a 503

**See Also:** [SETTLEMENT.md](SETTLEMENT.md), [ZK System Guide](ZK.md), [Testing Guide](TESTING_GUIDE.md)

---

### POST /longjing/estimate-cost

Estimate the cost of an API request before making a deposit. Returns estimated cost in USD and wei, plus a recommended deposit amount with safety margin.

**Authentication:** None (public endpoint)

**Provider Support:** The API uses a provider abstraction layer that supports multiple external services. Each provider has hardcoded pricing configuration that is automatically seeded into the database when the provider is registered.

**Request Body:**

```json
{
  "provider": "claude",           // Provider ID (e.g., 'claude', 'openai', 'mistral')
  "endpoint": "/v1/messages",     // Optional: specific endpoint
  "estimatedUnits": 1000,         // Estimated usage units
  "unitType": "tokens",           // Optional: 'tokens', 'calls', 'bytes', etc.
  "metadata": {                   // Optional: provider-specific hints
    "model": "claude-3-5-sonnet",
    "maxTokens": 2048
  }
}
```

**Response:**

```json
{
  "provider": "claude",
  "endpoint": "/v1/messages",
  "estimatedCostUSD": 0.01,
  "estimatedCostWei": "5000000000000000",
  "recommendedDepositWei": "6000000000000000",  // +20% safety margin
  "breakdown": {
    "baseCostUSD": 0.01,
    "safetyMarginUSD": 0.002,
    "currentEthRateUSD": 2000
  },
  "confidence": 0.85,
  "pricingModel": "per-token",
  "timestamp": "2026-04-06T20:00:00Z"
}
```

**Status Codes:**
- `200 OK` - Cost estimate calculated successfully
- `404 Not Found` - Provider not found or not supported

**Example:**

```bash
# Estimate cost for Claude API request
curl -k -X POST https://localhost:3000/longjing/estimate-cost \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "claude",
    "estimatedUnits": 5000,
    "unitType": "tokens"
  }'

# Use recommendedDepositWei for smart contract deposit
```

**Important Notes:**

- Results are cached for 5 minutes
- The `recommendedDepositWei` includes a 20% safety margin to account for estimation uncertainty
- Actual costs may vary based on real usage
- No authentication required - this is a public estimation tool
- ⚠️ **Note**: Rate limiting recommended for production deployments
- **Pricing Configuration**: Provider pricing is hardcoded in provider implementations and auto-seeded to the database on registration. Pricing updates require code deployment. See [PROVIDERS.md](PROVIDERS.md) for details.

---

### GET /longjing/server-pubkey

Get the refund key the server signs accumulators with. It must match `serverPublicKey` in the contract, which `pnpm prove receive` checks against.

**Authentication:** None

**Response:**

```typescript
{
  x: string;  // Public key x coordinate (hex)
  y: string;  // Public key y coordinate (hex)
}
```

**Example:**

```bash
# Request
curl -k https://localhost:3000/longjing/server-pubkey

# Response
{
  "x": "0x1a2b3c4d...",
  "y": "0x9e8f7d6c..."
}
```

**Use Case:** Clients check that the key served matches the one registered onchain, and the one in the attestation manifest.

---

## TEE Attestation Endpoints

### GET /attestation

Returns a TEE attestation quote whose `report_data` commits to every public key the service uses (ML-KEM, identity, refund signer) and to the in-enclave TLS certificate, followed by the client's nonce. This prevents key substitution and replays. See [ATTESTATION.md](ATTESTATION.md#report_data).

**Authentication:** None (public endpoint)

**Query:**

- `nonce` (optional): 32 random bytes as 64 hex characters, with or without `0x`, bound in `report_data[32..64]`. A malformed nonce gets a 400.

**Response:**

```typescript
{
  platform: 'phala' | 'intel-tdx' | 'amd-sev-snp' | 'aws-nitro' | 'mock';
  quote: string;              // Base64-encoded attestation quote
  reportData: string;         // Hex-encoded key commitment || nonce (64 bytes)
  measurement: string;        // Hex-encoded TEE measurement (MRTD/PCR0/etc.)
  eventLog?: string;          // dstack event log (JSON array), to replay RTMR0–3
  timestamp: string;          // ISO 8601 timestamp
  nonce: string | null;       // 0x-hex nonce bound in report_data, or null
  keys: {
    mlkemPublicKey: string;                          // Base64 ML-KEM-1024 key
    identityPublicKey: string | null;                // 0x-hex secp256k1 key
    refundSignerPublicKey: { x: string; y: string } | null; // Baby Jubjub
    tlsCertificate: string | null;                   // Base64 DER
  };
  instructions: string;       // Platform-specific verification instructions
}
```

**Example Response (Phala):**

```json
{
  "platform": "phala",
  "quote": "AgABACsAIAAAAAA...base64...==",
  "reportData": "a1b2c3d4e5f67890abcdef...7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
  "measurement": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "eventLog": "[{\"imr\":0,\"event_type\":...,\"digest\":\"...\"}, ...]",
  "timestamp": "2026-04-18T12:00:00.000Z",
  "nonce": "0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
  "keys": {
    "mlkemPublicKey": "AgABACsAIAAA...base64...==",
    "identityPublicKey": "0x04...",
    "refundSignerPublicKey": { "x": "0x...", "y": "0x..." },
    "tlsCertificate": "MIIB...base64...=="
  },
  "instructions": "Verify this quote using Phala verification service..."
}
```

**Security:** Clients MUST verify:
1. `platform` is not 'mock' (real TEE required)
2. `reportData` and the quote's `report_data` equal the value rebuilt from `keys` and their own nonce
3. `keys.tlsCertificate` is the certificate of their TLS session
4. `eventLog` replays to RTMR0–3 of the quote
5. Platform-specific quote signature (see [ATTESTATION.md](ATTESTATION.md#verification))

**Verification Script:**

```bash
# Automated verification, with a fresh nonce
pnpm verify:attestation https://your-server/attestation

# Or fetch with your own nonce and verify it manually
curl "https://your-server/attestation?nonce=$(openssl rand -hex 32)" > attestation.json
# See docs/ATTESTATION.md for full verification guide
```

**Documentation:**
- [docs/ATTESTATION.md](ATTESTATION.md) - Complete verification guide
- [docs/TEE_SETUP.md](TEE_SETUP.md) - Platform deployment guides

---

### GET /attestation/manifest

Returns the EIP-712 key manifest, signed by the enclave-derived identity key, that binds the app id, the ML-KEM public key, the refund signer's Baby Jubjub public key and the TLS certificate, with the `GetKey` signature chains.

**Authentication:** None (public endpoint)

The ML-KEM public key has no endpoint of its own: read it from `keys.mlkemPublicKey` in `GET /attestation`, after checking that `report_data` commits to it.

**Documentation:**
- [docs/KEY_DERIVATION.md](KEY_DERIVATION.md) - Key derivation and the manifest
- [docs/MLKEM.md](MLKEM.md) - ML-KEM encryption guide

---

## Available for Future Implementation

The following endpoints have been removed from the API but their underlying utilities remain in the codebase:

- **ML-KEM Encrypted Storage Endpoints** (`/secret/store`, `/secret/access`) - The `MlKemEncryptionService` is still available in `src/encryption/` for future implementation

These can be re-enabled by creating new controllers that use the existing services.

---

## Health Check Endpoints

### GET /health

General health check endpoint.

**Response:**

```typescript
{
  status: 'ok';
  timestamp: string;  // ISO 8601 timestamp
}
```

---

### GET /health/ready

Readiness probe for orchestration systems (Kubernetes, etc.). With `NODE_ENV=production` it returns 503 until `LongjingCredits` answers at `ZK_CONTRACT_ADDRESS`, as every `/longjing` endpoint does.

**Response:**

```typescript
{
  status: 'ready';
  timestamp: string;  // ISO 8601 timestamp
}
```

**Status Codes:**
- `200 OK` - Service is ready
- `503 Service Unavailable` - Service is not ready

---

### GET /health/live

Liveness probe for orchestration systems.

**Response:**

```typescript
{
  status: 'alive';
}
```

**Status Codes:**
- `200 OK` - Service is alive
- `503 Service Unavailable` - Service should be restarted

---

## Error Responses

All endpoints return consistent error responses:

```typescript
{
  statusCode: number;
  message: string;
  error?: string;  // Error type (BadRequest, Unauthorized, Forbidden, etc.)
}
```

**Common Status Codes:**

| Code | Meaning | Common Causes |
|------|---------|---------------|
| 400 | Bad Request | Invalid parameters, missing fields |
| 401 | Unauthorized | Invalid ZK proof |
| 403 | Forbidden | Nullifier reused, double-spend detected, per-nullifier rate limit |
| 502 | Bad Gateway | The provider call failed; the body carries the full refund and the signed accumulator |
| 404 | Not Found | Resource does not exist |
| 429 | Too Many Requests | Request fingerprint rate limit exceeded |
| 500 | Internal Server Error | Unexpected server error |
| 503 | Service Unavailable | Blockchain or external API unavailable, or a concurrency cap is full |

**Example Error:**

```json
{
  "statusCode": 403,
  "message": "Double-spend detected. Your secret key has been extracted and you will be slashed.",
  "error": "Forbidden"
}
```

---

## Protocol Flow

### Complete Request Flow

```
Client (note file: k, accumulator opening)            Server                 LongjingCredits
──────────────────────────────────────────            ──────                 ───────────────
k = random, c = Poseidon(k)
deposit(c) with D ───────────────────────────────────────────────────────────▶ leaf = Poseidon(c, D)

For request i:
  prove request.circom with the accumulator
  (R, i, c, s), a fresh s' and a fresh ρ
  POST /longjing/request ───────────────────────────▶ x = Poseidon(H(M), ρ)?
                                                       root recent? ◀────────── isKnownRoot
                                                       verify proof with C_MAX
                                                       store (N, x, y)
                                                       call the provider
                                                       v = C_MAX − cost
  A' = A_pub + v·G + J, signed ◀───────────────────── sign A'
  check A' and the signature,
  opening = (R + v, i + 1, c, s + s')

To leave:
  prove settlement.circom: P = D + R − n · C_MAX
  initiateWithdrawal ──────────────────────────────────────────────────────────▶ verify, remove leaf
                                                       watch WithdrawalInitiated ◀──
                                                       N at n already used? slash(k)
  after 3 days: finalizeWithdrawal ────────────────────────────────────────────▶ pay P
```

---

## Client Implementation Guide

`pnpm prove` ([scripts/client/prove.ts](../scripts/client/prove.ts)) is a reference client, built on [scripts/client/note.ts](../scripts/client/note.ts). It keeps the secret key and the accumulator opening in a note file, written with mode 600: keep that file, as it is what you exit with.

### Prerequisites

```bash
pnpm install
pnpm circuits:fetch   # request and settlement artifacts
```

### 1. Create a note and deposit

```bash
pnpm prove note alice.json http://127.0.0.1:8545 0xContract
# { "commitment": "0x..." }
cast send 0xContract "deposit(bytes32)" 0x<commitment> --value 0.01ether
```

The deposit is the note's D, at least `C_MAX` and below 2^128 wei.

### 2. Make requests

```bash
pnpm prove request alice.json "What does 苟全性命於亂世 mean?" > body.json
curl -k -X POST https://localhost:3000/longjing/request \
  -H "Content-Type: application/json" -d @body.json > response.json
pnpm prove receive alice.json response.json
```

`receive` checks that the accumulator adds up to the refund and is signed by the key registered onchain, then moves the note to its next index. If a response is lost, `pnpm prove request` prints the same body again for a retry. A 502 body is received the same way.

### 3. Withdraw, without the server

```bash
pnpm prove withdrawal alice.json 0xRecipient > exit.json
# initiateWithdrawal(commitment, recipient, refundKey, proof, nullifier, signalY, payout) from exit.json
# then, after CHALLENGE_WINDOW (3 days), anyone can call:
cast send 0xContract "finalizeWithdrawal(bytes32)" 0x<commitment>
```

The payout is `D + R − n · C_MAX`, where `n` is the number of indices the note used, one more if a response was lost. A lower `n` is slashed during the window.

### 4. Slash a double-spend

Two signals with the same nullifier reveal the secret key:

```bash
pnpm prove slashing signals.json   # { "signal1": {x, y}, "signal2": {x, y} }
cast send 0xContract "slash(uint256)" <secretKey>
```

The caller gets `SLASH_BOUNTY`, the operator the rest of the note.

---

## Cost Calculation

### Claude API Pricing (October 2026)

| Model | Input ($/M tokens) | Output ($/M tokens) |
|-------|-------------------|---------------------|
| claude-fable-5-1 | $10 | $50 |
| claude-opus-4-6 | $5 | $25 |
| claude-sonnet-4-6 | $3 | $15 |
| claude-haiku-4-5 | $1 | $5 |

### Example Calculations

Assuming ETH = $2,000:

**Simple Q&A (Opus 4.6)**
- Input: 100 tokens = 100/1M × $5 = $0.0005
- Output: 400 tokens = 400/1M × $25 = $0.01
- Total: $0.0105 = 0.00000525 ETH = 5,250,000,000,000 wei

**Code Generation (Sonnet 4.6)**
- Input: 500 tokens = 500/1M × $3 = $0.0015
- Output: 2000 tokens = 2000/1M × $15 = $0.03
- Total: $0.0315 = 0.00001575 ETH = 15,750,000,000,000 wei

---

## Security Best Practices

1. **Protect Your Secret Key**
   - Store in secure key management system
   - Never transmit over network
   - Never log or print
   - Use hardware security module (HSM) for production

2. **Keep Your Note File**
   - It holds the secret key and the accumulator opening, and it is what you exit with
   - Losing the opening costs your refunds, not the deposit: exit from genesis with an `n` at least as large as the requests you made

3. **One Request at a Time per Note**
   - Wait for each response, and run `pnpm prove receive` before the next request
   - Two requests from the same accumulator share a nullifier, which reveals your key and gets the note slashed
   - Use several notes for parallel requests

4. **Check What the Server Signs**
   - `pnpm prove receive` refuses an accumulator that doesn't add up to the refund or isn't signed by the key registered onchain

5. **Claim Every Index at Exit**
   - A withdrawal that understates the requests made is slashed during the challenge window

---

## Support

- **Documentation:** [docs/](.)
- **ZK System Guide:** [ZK.md](ZK.md)
- **Testing Guide:** [TESTING_GUIDE.md](TESTING_GUIDE.md)
- **Smart Contract:** [contracts/src/LongjingCredits.sol](../contracts/src/LongjingCredits.sol)
- **Issues:** GitHub repository

---

## References

- [ZK API Usage Credits Proposal](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) - Davide Crapis & Vitalik Buterin
- [Rate-Limit Nullifiers Documentation](https://rate-limiting-nullifier.github.io/rln-docs/)
- [Circom Documentation](https://docs.circom.io/)
- [SnarkJS](https://github.com/iden3/snarkjs)
- [Anthropic API Pricing](https://www.anthropic.com/api)

---

## License

GPL-3.0
