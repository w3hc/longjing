# Sign-In with Ethereum (SIWE)

This document explains how to use the SIWE authentication system in Longjing.

## Overview

Longjing implements a minimalistic SIWE authentication system using **NestJS Guards** that allows users to authenticate using their Ethereum wallet. The system uses:

- **Guard-based authentication** - NestJS Guards validate SIWE signatures on protected endpoints
- **Header-based credentials** - SIWE message and signature sent via HTTP headers
- **Stateless nonce-based authentication** - No JWT tokens, no persistent sessions
- **In-memory nonce storage** - Ephemeral, TEE-friendly (no data persistence)
- **5-minute time window** - Nonces expire after 5 minutes
- **Single-use nonces** - Each nonce can only be used once

## API Endpoints

### 1. Generate Nonce

**Endpoint:** `POST /auth/nonce`

Generates a cryptographically secure random nonce that must be included in the SIWE message.

**Request:**
```bash
curl -k -X POST https://localhost:3000/auth/nonce
```

**Response:**
```json
{
  "nonce": "d4c595490e15489574ca06494154cbedd156db6629224481221c04f83ac32d9e",
  "issuedAt": "2026-03-17T16:00:00.000Z",
  "expiresAt": "2026-03-17T16:05:00.000Z"
}
```

### 2. Access Protected Endpoints

Protected endpoints require SIWE authentication via HTTP headers. The `SiweGuard` automatically validates credentials.

**Example: Protected Hello Endpoint**

**Endpoint:** `POST /hello`

**Request:**
```bash
curl -k -X POST https://localhost:3000/hello \
  -H 'x-siwe-message: localhost wants you to sign in with your Ethereum account:
0xYourAddress


URI: https://localhost:3000
Version: 1
Chain ID: 1
Nonce: your-nonce-here
Issued At: 2026-03-17T16:49:38.495Z' \
  -H 'x-siwe-signature: 0x...'
```

**Response (Success - 200):**
```json
{
  "message": "Hello, authenticated user!",
  "address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
}
```

**Response (Unauthorized - 401):**
```json
{
  "statusCode": 401,
  "message": "Invalid SIWE signature or expired nonce"
}
```

**Note:** The SIWE message in the header should be properly formatted (use literal newlines or escape them depending on your HTTP client).

## Authentication Flow

```
┌─────────┐                    ┌─────────────┐                    ┌─────────┐
│ Client  │                    │   Longjing    │                    │ Wallet  │
└────┬────┘                    └──────┬──────┘                    └────┬────┘
     │                                │                                │
     │  1. POST /auth/nonce           │                                │
     │───────────────────────────────>│                                │
     │                                │                                │
     │  2. {nonce, issuedAt, ...}     │                                │
     │<───────────────────────────────│                                │
     │                                │                                │
     │  3. Create SIWE message        │                                │
     │    with nonce                  │                                │
     │────────────────────────────────┼───────────────────────────────>│
     │                                │                                │
     │  4. Sign message               │                                │
     │<───────────────────────────────┼────────────────────────────────│
     │                                │                                │
     │  5. POST /hello (or other      │                                │
     │     protected endpoint)        │                                │
     │     Headers:                   │                                │
     │     x-siwe-message: ...        │                                │
     │     x-siwe-signature: ...      │                                │
     │───────────────────────────────>│                                │
     │                                │                                │
     │                                │  6. SiweGuard intercepts       │
     │                                │  7. Verify signature           │
     │                                │  8. Check nonce validity       │
     │                                │  9. Delete nonce (single-use)  │
     │                                │ 10. Attach address to request  │
     │                                │                                │
     │ 11. Response with address      │                                │
     │<───────────────────────────────│                                │
     │                                │                                │
```

**Note:** Any endpoint protected with `@UseGuards(SiweGuard)` can be accessed this way.

## Step-by-Step Guide

### Using JavaScript/Node.js

1. **Install dependencies:**
```bash
npm install siwe ethers
```

2. **Complete example:**
```javascript
import { SiweMessage } from 'siwe';
import { Wallet } from 'ethers';

// Your wallet
const wallet = new Wallet('0x...');

// Step 1: Get nonce from server
const nonceResponse = await fetch('https://localhost:3000/auth/nonce', {
  method: 'POST',
});
const { nonce } = await nonceResponse.json();

// Step 2: Create SIWE message
const siweMessage = new SiweMessage({
  domain: 'localhost',
  address: wallet.address,
  uri: 'https://localhost:3000',
  version: '1',
  chainId: 1,
  nonce: nonce,
  issuedAt: new Date().toISOString(),
});

const message = siweMessage.prepareMessage();

// Step 3: Sign the message
const signature = await wallet.signMessage(message);

// Step 4: Access protected endpoint with headers
const response = await fetch('https://localhost:3000/hello', {
  method: 'POST',
  headers: {
    'x-siwe-message': message,
    'x-siwe-signature': signature,
  },
});

const result = await response.json();
console.log(result); // { message: "Hello, authenticated user!", address: "0x..." }
```

### Using w3pk (WebAuthn Passkey Wallet)

[w3pk](https://github.com/ju/w3pk) is a WebAuthn-based wallet SDK with native SIWE support. It provides passwordless authentication using biometrics.

```javascript
import { createWeb3Passkey } from 'w3pk';

// Initialize w3pk
const w3pk = createWeb3Passkey();

// Register or login user (triggers biometric prompt)
await w3pk.register({ username: 'user@example.com' });
// or
await w3pk.login();

// Step 1: Get nonce from Longjing
const nonceResponse = await fetch('https://localhost:3000/auth/nonce', {
  method: 'POST',
});
const { nonce } = await nonceResponse.json();

// Step 2: Get user's address
const address = w3pk.user?.address;

// Step 3: Create SIWE message
const siweMessage = `${window.location.host} wants you to sign in with your Ethereum account:
${address}


URI: ${window.location.origin}
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${new Date().toISOString()}`;

// Step 4: Sign with w3pk using SIWE method (triggers biometric prompt)
const { signature } = await w3pk.signMessage(siweMessage, {
  signingMethod: 'SIWE'  // EIP-4361 compliant
});

// Step 5: Access protected endpoint with Longjing
const response = await fetch('https://localhost:3000/hello', {
  method: 'POST',
  headers: {
    'x-siwe-message': siweMessage,
    'x-siwe-signature': signature,
  },
});

const result = await response.json();
console.log(result); // { message: "Hello, authenticated user!", address: "0x..." }
```

**Benefits of w3pk:**
- ✅ No seed phrases or passwords - uses device biometrics
- ✅ Native SIWE support with `signingMethod: 'SIWE'`
- ✅ Non-custodial - keys secured by WebAuthn
- ✅ Works across devices with passkey sync
- ✅ Session management built-in

### Using MetaMask (Browser)

```javascript
// Step 1: Get nonce
const nonceResponse = await fetch('https://localhost:3000/auth/nonce', {
  method: 'POST',
});
const { nonce } = await nonceResponse.json();

// Step 2: Create SIWE message
const siweMessage = new SiweMessage({
  domain: window.location.host,
  address: ethereum.selectedAddress,
  uri: window.location.origin,
  version: '1',
  chainId: 1,
  nonce: nonce,
  issuedAt: new Date().toISOString(),
});

const message = siweMessage.prepareMessage();

// Step 3: Request signature from MetaMask
const signature = await ethereum.request({
  method: 'personal_sign',
  params: [message, ethereum.selectedAddress],
});

// Step 4: Access protected endpoint with headers
const response = await fetch('https://localhost:3000/hello', {
  method: 'POST',
  headers: {
    'x-siwe-message': message,
    'x-siwe-signature': signature,
  },
});

const result = await response.json();
console.log(result);
```

### Using Etherscan Signing Tool

**Step 1:** Get a fresh nonce
```bash
curl -k -X POST https://localhost:3000/auth/nonce
```

Response:
```json
{
  "nonce": "d4c595490e15489574ca06494154cbedd156db6629224481221c04f83ac32d9e",
  "issuedAt": "2026-03-17T16:00:00.000Z",
  "expiresAt": "2026-03-17T16:05:00.000Z"
}
```

**Step 2:** Create the SIWE message (using the `siwe` library or manually)

Use the exact format with your EIP-55 checksummed address:
```
localhost wants you to sign in with your Ethereum account:
0xYourChecksummedAddress


URI: https://localhost:3000
Version: 1
Chain ID: 1
Nonce: d4c595490e15489574ca06494154cbedd156db6629224481221c04f83ac32d9e
Issued At: 2026-03-17T16:00:00.000Z
```

**Step 3:** Sign with Etherscan
1. Go to https://etherscan.io/verifiedSignatures
2. Click "Sign Message"
3. Paste the complete SIWE message from Step 2
4. Connect your wallet and sign

**Step 4:** Access protected endpoint
```bash
curl -k -X POST https://localhost:3000/hello \
  -H 'x-siwe-message: localhost wants you to sign in with your Ethereum account:
0xYourChecksummedAddress


URI: https://localhost:3000
Version: 1
Chain ID: 1
Nonce: d4c595490e15489574ca06494154cbedd156db6629224481221c04f83ac32d9e
Issued At: 2026-03-17T16:00:00.000Z' \
  -H 'x-siwe-signature: 0xYourSignatureFromEtherscan...'
```

## SIWE Message Format

The SIWE message **must** follow this exact format:

```
localhost wants you to sign in with your Ethereum account:
0xYourEthereumAddress


URI: https://localhost:3000
Version: 1
Chain ID: 1
Nonce: your-nonce-here
Issued At: 2026-03-17T16:49:38.495Z
```

**Important notes:**
- There are **three newlines** after the Ethereum address (`\n\n\n`)
- The message format is case-sensitive
- All fields must be present in this exact order
- The `Issued At` timestamp **must match** the `issuedAt` from the nonce response
- The Ethereum address **must be EIP-55 checksummed** (correct capitalization)

When sending via JSON, escape the newlines:
```json
{
  "message": "localhost wants you to sign in with your Ethereum account:\n0xAddress\n\n\nURI: https://localhost:3000\nVersion: 1\nChain ID: 1\nNonce: abc\nIssued At: 2026-03-17T16:49:38.495Z"
}
```

## Common Issues

### 1. "401 Unauthorized" Response

**Possible causes:**
- **Missing headers** - `x-siwe-message` and `x-siwe-signature` headers are required
- **Expired nonce** - Nonces expire after 5 minutes
- **Used nonce** - Each nonce can only be used once
- **Invalid signature** - The signature doesn't match the message
- **Message format mismatch** - The signed message doesn't exactly match the format

**Solution:** Always get a fresh nonce and sign it immediately, then include both headers in your request.

### 2. Newline Handling in Headers

**Cause:** Different HTTP clients handle newlines differently in headers.

**Solution:**
- In curl, use literal newlines in single-quoted headers
- In JavaScript fetch, include literal newlines in the string
- If your client doesn't support multi-line headers, you may need to escape them as `\n`

✅ Correct (curl):
```bash
curl -H 'x-siwe-message: line 1
line 2'
```

✅ Correct (JavaScript):
```javascript
headers: {
  'x-siwe-message': 'line 1\nline 2'
}
```

### 3. Wrong Number of Newlines

**Cause:** SIWE requires **three newlines** (`\n\n\n`) after the address, not two.

**Solution:** Use the `siwe` library's `prepareMessage()` method to generate the correct format.

### 4. Testing with Old Nonces

**Cause:** Reusing a nonce from a previous test or example.

**Solution:** Always call `POST /auth/nonce` to get a fresh nonce before each test.

### 5. "Invalid EIP-55 address" Error

**Cause:** The Ethereum address doesn't have the correct checksum capitalization.

**Example of incorrect address:**
- ❌ `0x502fb0dff6a2adbf43468c9888d1a26943eac6d1` (all lowercase)
- ✅ `0x502fb0dFf6A2adbF43468C9888D1A26943eAC6D1` (checksummed)

**Solution:** Use a checksummed address. You can:
1. Get it from your wallet (MetaMask, etc.)
2. Use Etherscan to look up your address
3. Use `ethers.getAddress()` to checksum it:
```javascript
import { getAddress } from 'ethers';
const checksummed = getAddress('0x502fb0dff6a2adbf43468c9888d1a26943eac6d1');
// Returns: 0x502fb0dFf6A2adbF43468C9888D1A26943eAC6D1
```

### 6. Timestamp Mismatch

**Cause:** The `Issued At` timestamp in the SIWE message doesn't match the `issuedAt` from the nonce response.

**Solution:** Use the **exact** `issuedAt` value from the nonce response in your SIWE message. Don't use `new Date().toISOString()` or create your own timestamp.

## Security Considerations

### TEE Context

This SIWE implementation is designed for TEE environments:

1. **No persistent storage** - Nonces are stored in-memory only
2. **No JWT secrets** - No shared secrets that could be extracted
3. **Ephemeral by design** - Server restart clears all nonces
4. **No session tracking** - Each verification is independent

### Nonce Management

- Nonces are **single-use** - Deleted immediately after verification
- Nonces **expire after 5 minutes** - Time-limited window
- Nonces are **cryptographically random** - 32 bytes (256 bits) of entropy
- Expired nonces are **automatically cleaned up** - Prevents memory bloat

### Address Verification

- Signatures are verified using `siwe` library's built-in verification
- The recovered address must match the address in the SIWE message
- Verification failures return no information about the failure reason (security by obscurity)

### Rate Limiting

Protected endpoints (including those with `SiweGuard`) and `/auth/nonce` are protected by the global rate limiter:
- 10 requests per minute per IP address
- Prevents brute-force attacks and DoS

### Guard-Based Architecture

- **`SiweGuard`** - NestJS Guard that implements `CanActivate`
- Extracts credentials from `x-siwe-message` and `x-siwe-signature` headers
- Verifies signature using SIWE library
- Validates nonce (existence, expiration, single-use)
- Attaches verified address to `request.user.address`
- Throws `UnauthorizedException` (401) on any validation failure

**Usage in controllers:**
```typescript
import { UseGuards, Request } from '@nestjs/common';
import { SiweGuard } from './auth/siwe.guard';

@UseGuards(SiweGuard)
@Post('protected')
async protectedEndpoint(@Request() req) {
  // req.user.address contains the verified Ethereum address
  return { address: req.user.address };
}
```

## Testing

Run the test suite:
```bash
pnpm test
```

The tests verify:
- SiweService and SiweGuard are properly injected
- SiweGuard throws `UnauthorizedException` when headers are missing
- SiweGuard throws `UnauthorizedException` for invalid signatures
- Protected endpoints return authenticated address when valid
- Nonce generation works correctly
- Nonce expiration is enforced

## Swagger UI

The SIWE endpoints are documented in the Swagger UI at:
```
https://localhost:3000
```

You can test the endpoints directly from the browser using the interactive API documentation.

## Example Response Times

Typical response times on a TEE-enabled server:

- `POST /auth/nonce`: ~10ms
- `POST /hello`: ~50-100ms (signature verification is CPU-intensive)

## Production Considerations

### Domain Configuration

In production, update the SIWE message to use your actual domain:

```javascript
const siweMessage = new SiweMessage({
  domain: 'your-domain.com', // Update this
  address: wallet.address,
  uri: 'https://your-domain.com', // Update this
  version: '1',
  chainId: 1, // Or your desired chain ID
  nonce: nonce,
  issuedAt: new Date().toISOString(),
});
```

### CORS Configuration

Update CORS settings in [src/main.ts](../src/main.ts) to allow your frontend domain:

```typescript
app.enableCors({
  origin: 'https://your-frontend.com', // Update in production
  credentials: true,
});
```

### HTTPS in Production

The server uses HTTPS with TLS termination inside the TEE. In production:
- Certificates are generated inside the enclave
- Private keys never leave the enclave
- Verify the attestation report before sending sensitive data

### Chain ID

The default chain ID is `1` (Ethereum Mainnet). Update this based on your needs:
- `1` - Ethereum Mainnet
- `11155111` - Sepolia Testnet
- `10` - Optimism
- `137` - Polygon
- etc.

## Further Reading

- [SIWE Specification](https://eips.ethereum.org/EIPS/eip-4361)
- [SIWE Library Documentation](https://docs.login.xyz/)
- [Ethereum Signature Verification](https://docs.ethers.org/v6/api/utils/#signMessage)
