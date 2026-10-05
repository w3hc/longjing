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
    - [POST /longjing/redeem-refund](#post-longjingredeem-refund)
    - [GET /longjing/server-pubkey](#get-longjingserver-pubkey)
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
    - [1. Generate Identity](#1-generate-identity)
    - [2. Deposit to Smart Contract](#2-deposit-to-smart-contract)
    - [3. Generate ZK Proof](#3-generate-zk-proof)
    - [4. Make API Request](#4-make-api-request)
    - [5. Redeem Refund Tickets](#5-redeem-refund-tickets)
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

Submit anonymous external API request with Zero-Knowledge proof of solvency (example: Claude API).

**Authentication:** None (anonymity is provided by ZK proof)

**Request Body:**

```typescript
{
  payload: string;              // The message/prompt for external API
  proof: string;                // Groth16 ZK proof (JSON string)
  nullifier: string;            // Unique nullifier for this request
  signal: {
    x: string;                  // RLN signal x = SHA-256(payload) mod p
    y: string;                  // RLN signal y component
  };
  maxCost: string;              // Maximum cost willing to pay (in wei)
  merkleRoot: string;           // Merkle root from on-chain state
  initialDeposit: string;       // Initial deposit amount (in wei)
  ticketIndex: string;          // Ticket index for this request
  idCommitment: string;         // Identity commitment (Hash of secret key)
  model?: string;               // Example: claude-opus-4.6, claude-sonnet-4.6, claude-haiku-4.5 (default: sonnet)
}
```

**Response:**

```typescript
{
  response: string;             // External API's response
  actualCost: string;           // Actual cost in wei
  refundTicket: {
    nullifier: string;          // Nullifier of this request
    value: string;              // Refund amount (maxCost - actualCost) in wei
    timestamp: number;          // Unix timestamp
    signature: {
      R8x: string;              // EdDSA signature component
      R8y: string;              // EdDSA signature component
      S: string;                // EdDSA signature component
    };
  };
  usage: {
    inputTokens: number;        // Tokens in request
    outputTokens: number;       // Tokens in response
  };
}
```

**Status Codes:**
- `200 OK` - Request processed successfully
- `400 Bad Request` - Invalid request parameters, or `signal.x` does not match the payload hash
- `401 Unauthorized` - Invalid ZK proof
- `403 Forbidden` - Nullifier already used, double-spend detected, or rate limit exceeded
- `429 Too Many Requests` - Rate limit exceeded (generic message for privacy)
- `500 Internal Server Error` - Server error

**Example:**

```bash
# Request
curl -k -X POST https://localhost:3000/longjing/request \
  -H "Content-Type: application/json" \
  -d '{
    "payload": "What does 苟全性命於亂世，不求聞達於諸侯。mean?",
    "proof": "{\"pi_a\":[\"123...\",\"456...\"],\"pi_b\":[[\"789...\"]],\"pi_c\":[\"012...\"]}",
    "nullifier": "12345678901234567890123456789012",
    "signal": {
      "x": "98765432109876543210987654321098",
      "y": "11111111111111111111111111111111"
    },
    "maxCost": "1000000000000000",
    "merkleRoot": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "initialDeposit": "10000000000000000",
    "ticketIndex": "0",
    "idCommitment": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "model": "claude-sonnet-4.6"
  }'

# Response
{
  "response": "Quantum computing is a type of computation that harnesses quantum mechanical phenomena...",
  "actualCost": "750000000000000",
  "refundTicket": {
    "nullifier": "12345678901234567890123456789012",
    "value": "250000000000000",
    "timestamp": 1710857400,
    "signature": {
      "R8x": "0x1234...",
      "R8y": "0x5678...",
      "S": "0x9abc..."
    }
  },
  "usage": {
    "inputTokens": 50,
    "outputTokens": 300
  }
}
```

**Security Notes:**

1. **Unique Nullifiers**: Each nullifier can only be used once. Reusing a nullifier triggers:
   - Same message: Replay attack → Request rejected
   - Different message: Double-spend → Secret key extracted → RLN stake slashed

2. **ZK Proof Requirements**: The proof must demonstrate:
   - Identity commitment is in the Merkle tree (membership: `merkleRoot`)
   - Sufficient balance for this request (solvency: `(ticketIndex+1)*maxCost ≤ initialDeposit`)
   - All previous refund tickets are valid (EdDSA signatures)
   - Correct RLN signal generation (nullifier = Hash(a), y = k + a*x)
   - All public inputs are cryptographically bound to the proof

3. **Cost Protection**: Set `maxCost` to protect against unexpected price changes

4. **Rate Limiting**: Three layers of protection (see [`src/guards/`](../src/guards/)):
   - **Request fingerprint**: 10 requests/minute per unique request content (privacy-preserving)
   - **Per-nullifier**: 3 requests/minute per user identity
   - **Metadata hiding**: Rate limit details concealed to prevent tracking

**See Also:** [ZK System Guide](ZK.md), [Testing Guide](TESTING_GUIDE.md)

---

### POST /longjing/redeem-refund

Redeem a signed refund ticket onchain.

**Authentication:** None (refund ticket signature authenticates)

**Request Body:**

```typescript
{
  idCommitment: string;         // User's identity commitment
  nullifier: string;            // Nullifier from the API request
  value: string;                // Refund amount in wei
  timestamp: number;            // Timestamp from refund ticket
  signature: {
    R8x: string;                // EdDSA signature components
    R8y: string;
    S: string;
  };
  recipient: string;            // Ethereum address to receive refund
}
```

**Response:**

```typescript
{
  success: boolean;
  transactionHash: string;      // Ethereum transaction hash
  message: string;              // Human-readable message
}
```

**Status Codes:**
- `200 OK` - Refund redeemed successfully
- `400 Bad Request` - Invalid refund ticket or signature
- `403 Forbidden` - Refund already redeemed or nullifier slashed
- `503 Service Unavailable` - Blockchain service not available

**Example:**

```bash
# Request
curl -k -X POST https://localhost:3000/longjing/redeem-refund \
  -H "Content-Type: application/json" \
  -d '{
    "idCommitment": "0xabcd...",
    "nullifier": "12345678901234567890123456789012",
    "value": "250000000000000",
    "timestamp": 1710857400,
    "signature": {
      "R8x": "0x1234...",
      "R8y": "0x5678...",
      "S": "0x9abc..."
    },
    "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
  }'

# Response
{
  "success": true,
  "transactionHash": "0xdef456...",
  "message": "Refund of 250000000000000 wei redeemed successfully"
}
```

**Important Notes:**

- Refund tickets can only be redeemed once
- The smart contract verifies the EdDSA signature onchain
- If the nullifier was slashed for double-spending, redemption will fail
- Redemption requires onchain gas fees (paid by caller)

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

Get the server's EdDSA public key for verifying refund ticket signatures.

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

**Use Case:** Clients can verify refund ticket signatures off-chain before attempting to redeem onchain.

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

### GET /mlkem/pubkey

Returns the server's ML-KEM-1024 public key for quantum-resistant encryption.

**Authentication:** None (public endpoint)

**Response:**

```typescript
{
  publicKey: string;  // Base64-encoded ML-KEM-1024 public key (1568 bytes)
  algorithm: 'ML-KEM-1024';
}
```

**Example Response:**

```json
{
  "publicKey": "AgABACsAIAAA...base64...==",
  "algorithm": "ML-KEM-1024"
}
```

**Usage:**
1. Fetch `/attestation` and verify it (see above)
2. Verify this key equals `attestation.keys.mlkemPublicKey`, which `report_data` commits to
3. Only then use this public key for encryption

**Documentation:**
- [docs/MLKEM.md](MLKEM.md) - ML-KEM encryption guide

---

## Available for Future Implementation

The following endpoints have been removed from the API but their underlying utilities remain in the codebase:

- **ML-KEM Encrypted Storage Endpoints** (`/secret/store`, `/secret/access`) - The `MlKemEncryptionService` is still available in `src/encryption/` for future implementation
- **Authentication Endpoint** (`POST /auth/nonce`) - The SIWE authentication service and guard are still available in `src/auth/` for future implementation

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

Readiness probe for orchestration systems (Kubernetes, etc.).

**Response:**

```typescript
{
  status: 'ready' | 'not ready';
  checks: {
    tee?: boolean;
    encryption?: boolean;
  };
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
| 404 | Not Found | Resource does not exist |
| 429 | Too Many Requests | Request fingerprint rate limit exceeded |
| 500 | Internal Server Error | Unexpected server error |
| 503 | Service Unavailable | Blockchain or external API unavailable |

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
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       │ 1. Generate secret key (once)
       ▼
   secretKey = random()
   idCommitment = Hash(secretKey)
       │
       │ 2. Deposit to smart contract
       ▼
   longjingCredits.deposit(idCommitment, { value: 0.01 ETH })
       │
       │ 3. For each request:
       ▼
   Generate ZK proof:
     - Merkle proof of membership
     - Sum of previous refunds
     - Solvency: (ticketIndex + 1) × maxCost ≤ deposit + refunds
       │
       │ 4. Compute RLN signal
       ▼
   a = Hash(secretKey, ticketIndex)
   nullifier = Hash(a)
   x = SHA-256(payload) mod p
   y = secretKey + a × x
       │
       │ 5. Submit request
       ▼
   POST /longjing/request
   {
     payload: "What does 苟全性命於亂世，不求聞達於諸侯。mean?",
     proof: {...},
     nullifier: nullifier,
     signal: { x, y },
     maxCost: "1000000000000000"
   }
       │
       ▼
┌──────────────────────────────┐
│      Server Verification     │
├──────────────────────────────┤
│ 1. Check nullifier reuse     │
│ 2. Verify ZK proof           │
│ 3. Execute Claude API call   │
│ 4. Calculate actual cost     │
│ 5. Sign refund ticket        │
└──────┬───────────────────────┘
       │
       │ 6. Return response + refund ticket
       ▼
   {
     response: "...",
     actualCost: "750000000000000",
     refundTicket: { signature: {...} }
   }
       │
       │ 7. Store refund ticket
       ▼
   refundTickets.push(refundTicket)
   ticketIndex++
       │
       │ 8. After multiple requests, redeem refunds
       ▼
   POST /longjing/redeem-refund
   { nullifier, value, signature, recipient }
       │
       ▼
   Smart contract verifies signature
   → Transfers refund to recipient
```

---

## Client Implementation Guide

### Prerequisites

```bash
npm install circomlibjs snarkjs ethers
```

### 1. Generate Identity

```typescript
import { buildPoseidon } from 'circomlibjs';
import { randomBytes } from 'crypto';

// Generate secret key (store securely!)
const secretKey = BigInt('0x' + randomBytes(32).toString('hex'));

// Create identity commitment
const poseidon = await buildPoseidon();
const idCommitment = poseidon([secretKey]);

console.log('Secret Key:', secretKey.toString(16));
console.log('ID Commitment:', poseidon.F.toString(idCommitment, 16));
```

### 2. Deposit to Smart Contract

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://mainnet.infura.io/v3/YOUR_KEY');
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const longjingCredits = new ethers.Contract(
  LONGJING_CREDITS_ADDRESS,
  LONGJING_CREDITS_ABI,
  wallet
);

const tx = await longjingCredits.deposit(idCommitment, {
  value: ethers.parseEther('0.01')
});

await tx.wait();
console.log('Deposit successful!');
```

### 3. Generate ZK Proof

```typescript
import { groth16 } from 'snarkjs';

async function generateProof(
  secretKey: bigint,
  merkleProof: any,
  refundTickets: any[],
  ticketIndex: number,
  maxCost: bigint,
  payload: string
) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Compute RLN values
  const a = poseidon([secretKey, ticketIndex]);
  const nullifier = poseidon([a]);
  const x = BigInt('0x' + createHash('sha256').update(payload, 'utf8').digest('hex')) % F.p;
  const y = F.add(secretKey, F.mul(a, x));

  // Circuit inputs
  const inputs = {
    secretKey: secretKey.toString(),
    pathElements: merkleProof.pathElements,
    pathIndices: merkleProof.pathIndices,
    refundValues: refundTickets.map(t => t.value),
    refundSignatures: refundTickets.map(t => [t.signature.R8x, t.signature.R8y, t.signature.S]),
    ticketIndex: ticketIndex,
    merkleRoot: merkleProof.root,
    maxCost: maxCost.toString(),
    initialDeposit: INITIAL_DEPOSIT.toString(),
    signalX: F.toString(x),
    serverPubKeyX: SERVER_PUBKEY_X,
    serverPubKeyY: SERVER_PUBKEY_Y
  };

  // Generate proof
  const { proof, publicSignals } = await groth16.fullProve(
    inputs,
    'circuits/api_credit_proof.wasm',
    'circuits/api_credit_proof.zkey'
  );

  return {
    proof: JSON.stringify(proof),
    nullifier: F.toString(nullifier),
    signal: {
      x: F.toString(x),
      y: F.toString(y)
    }
  };
}
```

### 4. Make API Request

```typescript
const { proof, nullifier, signal } = await generateProof(
  secretKey,
  merkleProof,
  refundTickets,
  ticketIndex,
  ethers.parseEther('0.001'),
  'What does 苟全性命於亂世，不求聞達於諸侯。mean?'
);

const response = await fetch('https://api.longjing.example/longjing/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    payload: 'What does 苟全性命於亂世，不求聞達於諸侯。mean?',
    proof,
    nullifier,
    signal,
    maxCost: ethers.parseEther('0.001').toString(),
    model: 'claude-sonnet-4.6'
  })
});

const result = await response.json();
console.log('Response:', result.response);
console.log('Cost:', ethers.formatEther(result.actualCost), 'ETH');

// Store refund ticket for next request
refundTickets.push(result.refundTicket);
ticketIndex++;
```

### 5. Redeem Refund Tickets

```typescript
// Redeem accumulated refunds
for (const ticket of refundTickets) {
  const response = await fetch('https://api.longjing.example/longjing/redeem-refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idCommitment: idCommitment.toString(),
      nullifier: ticket.nullifier,
      value: ticket.value,
      timestamp: ticket.timestamp,
      signature: ticket.signature,
      recipient: YOUR_ETHEREUM_ADDRESS
    })
  });

  const result = await response.json();
  console.log('Refund redeemed:', result.transactionHash);
}
```

---

## Cost Calculation

### Claude API Pricing (March 2026)

| Model | Input ($/M tokens) | Output ($/M tokens) |
|-------|-------------------|---------------------|
| claude-opus-4.6 | $5 | $25 |
| claude-sonnet-4.6 | $3 | $15 |
| claude-haiku-4.5 | $1 | $5 |

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

2. **Never Reuse Nullifiers**
   - Track `ticketIndex` carefully
   - Increment after each request
   - Store state persistently

3. **Verify Refund Signatures**
   - Check server's EdDSA signature before redeeming
   - Compare against server public key

4. **Set Reasonable Max Cost**
   - Estimate token usage
   - Add safety margin (20-50%)
   - Refunds are automatic

5. **Monitor Double-Spend Attempts**
   - If secret key is compromised, withdraw immediately
   - Watch for suspicious nullifier patterns

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
