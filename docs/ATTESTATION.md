# TEE Attestation Verification Guide

This guide explains how to verify Longjing's TEE attestation quotes to ensure you're communicating with authentic TEE hardware before sending sensitive data.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Understanding report_data Binding](#understanding-report_data-binding)
- [Platform-Specific Verification](#platform-specific-verification)
- [Client Implementation](#client-implementation)
- [Security Best Practices](#security-best-practices)

## Overview

Longjing implements **application attestation** using the `report_data` field to bind the ML-KEM encryption key to the TEE quote. This prevents man-in-the-middle attacks where an attacker could substitute their own encryption key.

### What Gets Verified

1. **Platform Authenticity**: Quote is signed by real TEE hardware (AMD SEV-SNP, Intel TDX, AWS Nitro, or Phala)
2. **Code Measurement**: The running code matches expected measurement (MRTD/PCR0/etc.)
3. **Key Binding**: The ML-KEM public key is cryptographically bound to the quote via `SHA-256(pubkey)` in `report_data`
4. **Freshness**: Quote timestamp is recent (not a replay attack)

### Attack Prevention

**Without `report_data` binding:**
```
❌ Attacker intercepts traffic
❌ Serves their own ML-KEM public key
❌ Replays valid TEE quote from real server
❌ Client encrypts secrets to attacker's key
```

**With `report_data` binding:**
```
✅ report_data = SHA-256(mlkem_public_key) || 0x00...00
✅ TEE hardware signs the quote including report_data
✅ Client verifies: quote.reportData == SHA-256(fetched_pubkey)
✅ Attacker cannot forge quote with different key (no TEE hardware)
✅ Attack prevented
```

## Quick Start

### Automated Verification

The easiest way to verify attestation:

```bash
# Verify localhost (development)
pnpm test:attestation

# Verify remote server
pnpm test:attestation https://your-longjing.phala.network/attestation

# Verify from file
pnpm test:attestation attestation.json
```

**What the script checks:**
- ✅ Platform is not 'mock' (real TEE)
- ✅ `report_data` matches `SHA-256(mlkem_public_key)`
- ✅ Quote structure is valid
- ✅ Timestamp is fresh (within 5 minutes)

### Manual Verification (Bash)

```bash
#!/bin/bash
set -e

SERVER_URL="https://your-server:443"

# 1. Fetch attestation quote
curl -k "$SERVER_URL/attestation" > attestation.json

# 2. Fetch ML-KEM public key
curl -k "$SERVER_URL/mlkem/pubkey" > pubkey.json

# 3. Extract values
PLATFORM=$(jq -r '.platform' attestation.json)
REPORT_DATA=$(jq -r '.reportData' attestation.json)
PUBKEY=$(jq -r '.publicKey' pubkey.json)

# 4. Check platform
if [ "$PLATFORM" = "mock" ]; then
  echo "❌ Server is NOT in a TEE!"
  exit 1
fi
echo "✅ Platform: $PLATFORM"

# 5. Verify report_data binding
EXPECTED=$(echo -n "$PUBKEY" | base64 -d | sha256sum | cut -d' ' -f1)
EXPECTED_PADDED="${EXPECTED}$(printf '0%.0s' {1..64})"

if [ "$REPORT_DATA" = "$EXPECTED_PADDED" ]; then
  echo "✅ report_data matches ML-KEM public key"
else
  echo "❌ report_data MISMATCH - DO NOT TRUST"
  exit 1
fi

# 6. Platform-specific verification (optional but recommended)
# See Platform-Specific Verification section below
```

## Understanding report_data Binding

### What is report_data?

The `report_data` field is a **user-controlled input** to the TEE attestation quote that gets signed by the hardware. All major TEE platforms support it:

| Platform | Field Name | Size | Location |
|----------|-----------|------|----------|
| **Phala** | `report_data` | 64 bytes | TDX quote via `tdxQuote()` |
| **Intel TDX** | `REPORT_DATA` | 64 bytes | TDX quote structure offset 536 |
| **AMD SEV-SNP** | `REPORT_DATA` | 64 bytes | SNP report structure offset 80 |
| **AWS Nitro** | `user_data` | Up to 512 bytes | NSM attestation document |

### How Longjing Uses It

```typescript
// Server-side (src/attestation/attestation.service.ts)
function buildReportData(mlkemPublicKey: Buffer): Buffer {
  const hash = createHash('sha256').update(mlkemPublicKey).digest(); // 32 bytes
  return Buffer.concat([hash, Buffer.alloc(32)]);                    // → 64 bytes
}

// When generating quote:
// 1. ML-KEM key pair is generated INSIDE the TEE by TeeKeyManagerService
const mlkemPublicKey = this.keyManager.getPublicKeyBytes();

// 2. Public key is bound to attestation via report_data
const reportData = buildReportData(mlkemPublicKey);
const quote = await platform.generateQuote(reportData);

// Result:
// quote.reportData = "a1b2c3d4..." (SHA-256 of public key)
//                    + "0000000000..." (zero padding)
//                    = 128 hex characters (64 bytes)
```

### Security: TEE-Generated Keys

**Critical security feature:** The ML-KEM key pair is **generated inside the TEE**, not loaded from environment variables.

```typescript
// src/attestation/tee-key-manager.service.ts
private async initializeTeeKeys() {
  // Generate key pair INSIDE the TEE
  const [publicKey, privateKey] = this.mlkem.generateKeyPair();

  // Seal private key using platform-specific mechanisms
  const sealedPrivateKey = await this.sealPrivateKey(privateKey);
  await fs.writeFile(SEALED_KEY_PATH, sealedPrivateKey);

  // Private key NEVER leaves the TEE
  // Only the public key is exported for client use
}
```

**Why this matters:**
- ✅ **Private key never known to operator** - Generated inside the secure enclave
- ✅ **No environment variable exposure** - Keys don't exist in deployment configs
- ✅ **Cryptographic proof** - Attestation binds the TEE-generated public key via report_data
- ✅ **Trustless decryption** - Only the attested TEE can decrypt messages

**Trust model:**
- **Before:** "Trust the operator not to access `ADMIN_MLKEM_PRIVATE_KEY` environment variable"
- **After:** "Don't trust anyone - verify the private key is sealed in the TEE via attestation"

### Client Verification

```typescript
// Client-side verification (TypeScript)
import { createHash } from 'crypto';

async function verifyAttestation(serverUrl: string): Promise<boolean> {
  // 1. Fetch attestation
  const attestation = await fetch(`${serverUrl}/attestation`).then(r => r.json());

  // 2. Check platform
  if (attestation.platform === 'mock') {
    throw new Error('Server not in TEE');
  }

  // 3. Fetch ML-KEM public key
  const { publicKey } = await fetch(`${serverUrl}/mlkem/pubkey`).then(r => r.json());
  const pubkeyBytes = Buffer.from(publicKey, 'base64');

  // 4. Compute expected report_data
  const hash = createHash('sha256').update(pubkeyBytes).digest();
  const expectedReportData = Buffer.concat([hash, Buffer.alloc(32)]).toString('hex');

  // 5. Verify match
  if (attestation.reportData.toLowerCase() !== expectedReportData.toLowerCase()) {
    throw new Error('report_data mismatch - possible MITM attack');
  }

  console.log('✅ report_data binding verified');

  // 6. Platform-specific quote verification (optional)
  // See platform-specific sections below

  return true;
}
```

## Platform-Specific Verification

After verifying `report_data` binding, perform platform-specific cryptographic verification.

### Phala Network

**Recommended: Use Phala's Verification Service**

```bash
# Extract quote
QUOTE=$(jq -r '.quote' attestation.json)

# Verify with Phala Trust Center
curl -X POST https://verifier.phala.network/verify \
  -H "Content-Type: application/json" \
  -d "{\"quote\": \"$QUOTE\"}" | jq .

# Response:
# {
#   "valid": true,
#   "tcb_status": "UpToDate",
#   "measurement": "a1b2c3d4...",
#   "rtmr": {
#     "rtmr0": "...",
#     "rtmr1": "...",
#     "rtmr2": "...",
#     "rtmr3": "..."
#   }
# }
```

**What to check:**
- ✅ `valid: true` - Quote signature is valid
- ✅ `tcb_status: "UpToDate"` - TEE firmware is up-to-date
- ✅ `measurement` or `rtmr2` matches published value

**Documentation:**
- https://docs.phala.com/phala-cloud/attestation/verify-your-application

### Intel TDX (Native)

**Using Intel DCAP Verification**

```bash
# Extract quote
jq -r '.quote' attestation.json | base64 -d > quote.dat

# Verify with Intel DCAP library (requires installation)
# https://github.com/intel/SGXDataCenterAttestationPrimitives

# Basic structure check
hexdump -C quote.dat | head -20

# Check TEE type (should be 0x00000081 for TDX)
dd if=quote.dat bs=1 skip=4 count=4 2>/dev/null | od -An -tx4

# Extract MRTD (measurement)
dd if=quote.dat bs=1 skip=112 count=48 2>/dev/null | xxd -p -c 48
```

**What to check:**
- ✅ TEE type = `0x00000081` (TDX)
- ✅ MRTD matches published measurement
- ✅ Certificate chain verifies to Intel root CA

**Documentation:**
- https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity

### AMD SEV-SNP

**Using AMD Verification Tools**

```bash
# Extract report
jq -r '.quote' attestation.json | base64 -d > report.bin

# Verify with snpguest
snpguest verify report.bin --platform amd-sev-snp

# Extract measurement
dd if=report.bin bs=1 skip=144 count=48 2>/dev/null | xxd -p -c 48
```

**What to check:**
- ✅ Signature verifies against AMD KDS
- ✅ MEASUREMENT field matches published value
- ✅ TCB version is acceptable

**Documentation:**
- https://www.amd.com/en/developer/sev.html

### AWS Nitro

**Using AWS Nitro Verification**

```bash
# Extract attestation document (CBOR format)
jq -r '.quote' attestation.json | base64 -d > attestation.cbor

# Parse with Python cbor2
python3 <<EOF
import cbor2

with open('attestation.cbor', 'rb') as f:
    doc = cbor2.load(f)

print(f"Module ID: {doc['module_id']}")
print(f"PCR0: {doc['pcrs'][0].hex()}")
print(f"PCR1: {doc['pcrs'][1].hex()}")
print(f"PCR2: {doc['pcrs'][2].hex()}")
print(f"Timestamp: {doc['timestamp']}")
EOF
```

**What to check:**
- ✅ Certificate chain verifies to AWS Nitro root CA
- ✅ PCR0 matches published enclave measurement
- ✅ user_data field matches `report_data` from attestation JSON

**Documentation:**
- https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html

## Client Implementation

### JavaScript/TypeScript Client

```typescript
import { createHash } from 'crypto';

interface AttestationQuote {
  platform: 'phala' | 'intel-tdx' | 'amd-sev-snp' | 'aws-nitro' | 'mock';
  quote: string;
  reportData: string;
  measurement: string;
  timestamp: string;
}

async function verifyServerAttestation(serverUrl: string): Promise<void> {
  // Step 1: Fetch attestation
  const attestation: AttestationQuote = await fetch(`${serverUrl}/attestation`)
    .then(r => r.json());

  // Step 2: Reject mock/development platforms
  if (attestation.platform === 'mock') {
    throw new Error('Server is not running in a TEE');
  }

  // Step 3: Fetch ML-KEM public key
  const { publicKey } = await fetch(`${serverUrl}/mlkem/pubkey`)
    .then(r => r.json());

  // Step 4: Verify report_data binding
  const pubkeyBytes = Buffer.from(publicKey, 'base64');
  const hash = createHash('sha256').update(pubkeyBytes).digest();
  const expectedReportData = Buffer.concat([hash, Buffer.alloc(32)]).toString('hex');

  if (attestation.reportData.toLowerCase() !== expectedReportData.toLowerCase()) {
    throw new Error(
      'report_data does not match ML-KEM public key. ' +
      'Possible man-in-the-middle attack!'
    );
  }

  // Step 5: Check timestamp freshness (within 5 minutes)
  const attestationTime = new Date(attestation.timestamp).getTime();
  const now = Date.now();
  const ageSeconds = (now - attestationTime) / 1000;

  if (ageSeconds > 300) {
    throw new Error('Attestation is too old (possible replay attack)');
  }

  if (ageSeconds < -60) {
    throw new Error('Attestation timestamp is in the future');
  }

  // Step 6: Platform-specific verification (optional but recommended)
  await verifyPlatformQuote(attestation);

  console.log('✅ Server attestation verified successfully');
  console.log(`   Platform: ${attestation.platform}`);
  console.log(`   Measurement: ${attestation.measurement.substring(0, 32)}...`);
}

async function verifyPlatformQuote(attestation: AttestationQuote): Promise<void> {
  switch (attestation.platform) {
    case 'phala':
      // Verify with Phala verification service
      const response = await fetch('https://verifier.phala.network/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote: attestation.quote })
      });
      const result = await response.json();

      if (!result.valid || result.tcb_status !== 'UpToDate') {
        throw new Error(`Phala verification failed: ${result.tcb_status}`);
      }
      break;

    case 'intel-tdx':
    case 'amd-sev-snp':
    case 'aws-nitro':
      // Implement platform-specific verification or skip for basic checks
      console.warn(`Platform-specific verification not implemented for ${attestation.platform}`);
      break;
  }
}

// Usage
verifyServerAttestation('https://your-longjing.phala.network')
  .then(() => {
    // Safe to send sensitive data
    console.log('Server verified, proceeding with encrypted request...');
  })
  .catch(error => {
    console.error('❌ Server verification failed:', error.message);
    // DO NOT send sensitive data
  });
```

### Python Client

```python
import requests
import hashlib
import base64
from datetime import datetime, timedelta

def verify_server_attestation(server_url):
    # 1. Fetch attestation
    attestation = requests.get(f"{server_url}/attestation").json()

    # 2. Check platform
    if attestation['platform'] == 'mock':
        raise ValueError("Server is not in a TEE")

    # 3. Fetch ML-KEM public key
    pubkey_response = requests.get(f"{server_url}/mlkem/pubkey").json()
    pubkey = base64.b64decode(pubkey_response['publicKey'])

    # 4. Verify report_data binding
    hash_digest = hashlib.sha256(pubkey).hexdigest()
    expected_report_data = hash_digest + ('0' * 64)

    if attestation['reportData'].lower() != expected_report_data.lower():
        raise ValueError("report_data mismatch - possible MITM attack")

    # 5. Check timestamp freshness
    attestation_time = datetime.fromisoformat(attestation['timestamp'].replace('Z', '+00:00'))
    age = datetime.now(attestation_time.tzinfo) - attestation_time

    if age > timedelta(minutes=5):
        raise ValueError("Attestation too old")

    if age < timedelta(minutes=-1):
        raise ValueError("Attestation timestamp in future")

    # 6. Platform-specific verification (optional)
    if attestation['platform'] == 'phala':
        verify_phala_quote(attestation['quote'])

    print(f"✅ Server attestation verified")
    print(f"   Platform: {attestation['platform']}")
    print(f"   Measurement: {attestation['measurement'][:32]}...")
    return True

def verify_phala_quote(quote):
    response = requests.post(
        'https://verifier.phala.network/verify',
        json={'quote': quote}
    )
    result = response.json()

    if not result.get('valid') or result.get('tcb_status') != 'UpToDate':
        raise ValueError(f"Phala verification failed: {result.get('tcb_status')}")

# Usage
try:
    verify_server_attestation('https://your-longjing.phala.network')
    print("Safe to send sensitive data")
except Exception as e:
    print(f"❌ Verification failed: {e}")
```

## Security Best Practices

### For Client Developers

1. **Always verify before sending secrets**
   ```typescript
   await verifyAttestation(serverUrl);  // MUST succeed
   // Only then:
   const encrypted = await encryptWithMLKEM(data, publicKey);
   ```

2. **Reject mock platforms in production**
   ```typescript
   if (attestation.platform === 'mock') {
     throw new Error('Production requires real TEE');
   }
   ```

3. **Verify report_data binding**
   - This is the critical security check
   - Prevents key substitution attacks

4. **Check measurement hash**
   - Compare against published/expected measurement
   - Ensures you're talking to the correct code

5. **Enforce freshness**
   - Reject quotes older than 5 minutes
   - Prevents replay attacks

6. **Use platform-specific verification**
   - Phala: Use verification service
   - TDX/SNP/Nitro: Use DCAP/KDS/AWS verification

### For Server Operators

1. **Publish expected measurements**
   ```bash
   # Extract and publish your measurement
   curl https://your-server/attestation | jq -r '.measurement'
   # → Publish this hash in your docs/README
   ```

2. **Monitor attestation failures**
   - Log when attestation generation fails
   - Alert on unusual patterns

3. **Keep TEE firmware updated**
   - Intel TDX: Follow Intel security advisories
   - AMD SEV-SNP: Apply AMD firmware updates
   - AWS Nitro: Enclaves auto-update
   - Phala: Dstack updates

4. **Use production platforms**
   ```bash
   # Force real TEE (never use mock in production)
   TEE_PLATFORM=auto  # Let it auto-detect real hardware
   ```

### Common Pitfalls

❌ **DON'T: Skip report_data verification**
```typescript
// WRONG - vulnerable to MITM
const pubkey = await fetch(`${url}/mlkem/pubkey`);
encrypt(data, pubkey);  // ❌ No attestation check
```

✅ **DO: Verify report_data binding**
```typescript
// CORRECT
await verifyAttestation(url);  // ✅ Checks report_data
const pubkey = await fetch(`${url}/mlkem/pubkey`);
encrypt(data, pubkey);
```

❌ **DON'T: Trust old quotes**
```typescript
// WRONG - replay attack vulnerability
if (cachedAttestation.platform !== 'mock') {  // ❌ Could be hours old
  sendSecrets();
}
```

✅ **DO: Check freshness**
```typescript
// CORRECT
const attestation = await fetchAttestation();  // ✅ Fresh quote
if (Date.now() - new Date(attestation.timestamp) < 300000) {
  sendSecrets();
}
```

## Additional Resources

- [Phala Application Attestation Blog Post](https://phala.network/posts/application-attestation-in-tee)
- [Intel TDX Attestation Overview](https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/attestation.html)
- [AMD SEV-SNP Attestation Documentation](https://www.amd.com/system/files/TechDocs/56860.pdf)
- [AWS Nitro Enclaves Attestation](https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html)
- [Longjing TEE Setup Guide](TEE_SETUP.md)

## Support

For attestation verification issues:
1. Run `pnpm test:attestation` to diagnose
2. Check server logs for attestation generation errors
3. Review platform-specific troubleshooting in [TEE_SETUP.md](TEE_SETUP.md)
4. File issues at https://github.com/your-org/longjing/issues
