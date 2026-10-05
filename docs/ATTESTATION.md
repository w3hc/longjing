# TEE Attestation Verification Guide

This guide explains how to verify Longjing's TEE attestation quotes to ensure you're communicating with authentic TEE hardware before sending sensitive data.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [report_data](#report_data)
- [Verification](#verification)
- [Platform-Specific Verification](#platform-specific-verification)
- [Client Implementation](#client-implementation)
- [Security Best Practices](#security-best-practices)

## Overview

Longjing implements **application attestation** using the `report_data` field of the quote. It commits to every public key the service uses (the ML-KEM key, the identity key and the refund signer key) and to the TLS certificate served from inside the enclave, followed by a nonce chosen by the client. This prevents man-in-the-middle attacks where an attacker substitutes their own key, and replays of an old quote.

### What Gets Verified

1. **Platform Authenticity**: Quote is signed by real TEE hardware (Phala/dstack in production)
2. **Code Measurement**: RTMR0–3, replayed from the event log, match the published values, and RTMR3's `compose-hash` event names a published release
3. **Key Binding**: `report_data` commits to the ML-KEM, identity and refund signer public keys and to the TLS certificate of your session
4. **Freshness**: `report_data` carries the nonce you just sent

### Attack Prevention

**Without key binding:**
```
❌ Attacker intercepts traffic
❌ Serves their own ML-KEM key, or signs refund tickets outside the enclave
❌ Replays valid TEE quote from real server
❌ Client encrypts secrets to attacker's key, or trusts forged refunds
```

**With key binding and a nonce:**
```
✅ report_data = SHA-256(label, ML-KEM key, identity key, refund signer key, TLS cert) || nonce
✅ TEE hardware signs the quote including report_data
✅ Client rebuilds report_data from the returned keys and its own nonce
✅ Attacker cannot forge a quote for other keys or a new nonce (no TEE hardware)
✅ Attack prevented
```

## Quick Start

### Automated Verification

The easiest way to verify attestation:

```bash
# Verify localhost (development)
pnpm verify:attestation

# Verify remote server
pnpm verify:attestation https://your-longjing.phala.network/attestation

# Verify from file (cannot prove freshness)
pnpm verify:attestation attestation.json
```

**What the script checks:**
- ✅ Platform is not 'mock' (real TEE)
- ✅ `report_data` commits to the returned keys and to a fresh random nonce
- ✅ The TLS certificate of the session is the bound one
- ✅ The event log replays to RTMR0–3 of the quote
- ✅ `GET /attestation/manifest` signs the same keys
- ✅ Quote structure is valid

### Manual Verification

```bash
SERVER_URL="https://your-server:443"
NONCE=$(openssl rand -hex 32)

# Fetch the attestation with your nonce
curl -k "$SERVER_URL/attestation?nonce=$NONCE" > attestation.json

# The last 32 bytes of report_data must be your nonce
[ "$(jq -r '.reportData[64:]' attestation.json)" = "$NONCE" ] || exit 1

# Then rebuild the first 32 bytes from .keys, see report_data below
```

## report_data

`report_data` is the 64-byte, user-controlled field of the quote that the TEE hardware signs. Longjing builds it in [`report-data.ts`](../src/attestation/report-data.ts):

```
report_data[0..32]  = SHA-256( LP("longjing-report-v1")
                             || LP(mlkem_public_key)
                             || LP(identity_public_key)
                             || LP(refund_signer_x || refund_signer_y)
                             || LP(SHA-256(tls_leaf_cert_der)) )
report_data[32..64] = client nonce, or 32 zero bytes
```

- `LP(x)` is `x` prefixed with its length as a 4-byte big-endian integer, so no two inputs encode the same way.
- `mlkem_public_key` is the 1568-byte ML-KEM-1024 encapsulation key.
- `identity_public_key` is the 65-byte uncompressed secp256k1 key that signs the key manifest.
- `refund_signer_x || refund_signer_y` is the Baby Jubjub public key that signs refund tickets, each coordinate as 32 big-endian bytes.
- A key that was not derived from dstack (development only), or a TLS certificate that is not served from inside the enclave, is an empty term: `LP(empty)` is four zero bytes.

`GET /attestation` returns every input under `keys`, the nonce it bound under `nonce`, and on dstack the event log under `eventLog`:

```json
{
  "platform": "phala",
  "quote": "<base64 TDX quote>",
  "reportData": "<128 hex chars>",
  "nonce": "0x<64 hex chars>",
  "keys": {
    "mlkemPublicKey": "<base64>",
    "identityPublicKey": "0x04...",
    "refundSignerPublicKey": { "x": "0x...", "y": "0x..." },
    "tlsCertificate": "<base64 DER>"
  },
  "eventLog": "[{\"imr\":0,\"event_type\":...,\"digest\":\"...\"}, ...]"
}
```

The nonce is optional, 32 bytes as 64 hex characters with or without `0x`. A malformed one gets a 400. Without one, the second half of `report_data` is zero and the quote proves nothing about freshness.

The ML-KEM, identity and refund signer keys are derived inside the enclave from the dstack KMS, see [KEY_DERIVATION.md](./KEY_DERIVATION.md).

## Verification

[`verifyKeyBinding`](../src/attestation/key-binding.ts) runs every check below except the quote signature and the comparison with published values:

1. Send a fresh 32-byte random nonce: `GET /attestation?nonce=<hex>`.
2. Rebuild `report_data` from `keys` and your nonce, and check it equals both `reportData` and the `report_data` inside the quote (offset 568 of a TDX quote).
3. Check that `keys.tlsCertificate` is the certificate your TLS session presented. A null certificate means TLS terminates outside the enclave.
4. Replay RTMR0–3 from `eventLog` ([`replayRtmrs`](../src/attestation/tdx-quote.ts)): each RTMR starts at 48 zero bytes and every event extends it as `RTMR = SHA-384(RTMR || digest)`. Check the result equals RTMR0–3 of the quote. A dstack runtime event (type `0x08000001`) must also carry `digest = SHA-384(event_type as u32 LE || ":" || event || ":" || event_payload)`, so its payload, the `compose-hash` for one, can be trusted.
5. Check that `GET /attestation/manifest` commits to the same keys and is signed by `keys.identityPublicKey`.
6. Verify the quote signature with the platform's verification service, and compare the measurements and the `compose-hash` against the published release.

## Platform-Specific Verification

After verifying the key binding, perform platform-specific cryptographic verification.

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
- ✅ RTMR0–3 match the event log, and the `compose-hash` event matches the published release

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
- ✅ user_data field matches `reportData` from the attestation JSON

**Documentation:**
- https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html

## Client Implementation

### JavaScript/TypeScript Client

```typescript
import { randomBytes, X509Certificate } from 'crypto';
import { verifyKeyBinding } from 'longjing/src/attestation/key-binding';

async function verifyServerAttestation(
  serverUrl: string,
  servedCertificate?: Buffer, // DER of the certificate your TLS session saw
): Promise<void> {
  const nonce = randomBytes(32);
  const attestation = await fetch(
    `${serverUrl}/attestation?nonce=${nonce.toString('hex')}`,
  ).then((r) => r.json());

  if (attestation.platform === 'mock') {
    throw new Error('Server is not running in a TEE');
  }

  const keyManifest = await fetch(`${serverUrl}/attestation/manifest`).then(
    (r) => r.json(),
  );
  const failures = verifyKeyBinding(attestation, {
    nonce,
    servedCertificate,
    keyManifest,
  });
  if (failures.length > 0) {
    throw new Error(`Key binding failed: ${failures.join('; ')}`);
  }

  // Then verify the quote signature, e.g. with Phala's verification service,
  // and compare RTMR0–3 and the compose hash against the published release
}
```

### Python Client

```python
import base64, hashlib, secrets, struct
import requests

def lp(data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + data

def report_data(keys: dict, nonce: bytes) -> bytes:
    ek = base64.b64decode(keys['mlkemPublicKey'])
    identity = bytes.fromhex(keys['identityPublicKey'][2:]) if keys['identityPublicKey'] else b''
    rs = keys['refundSignerPublicKey']
    refund = (int(rs['x'], 16).to_bytes(32, 'big') + int(rs['y'], 16).to_bytes(32, 'big')) if rs else b''
    cert = keys['tlsCertificate']
    cert_hash = hashlib.sha256(base64.b64decode(cert)).digest() if cert else b''
    commitment = hashlib.sha256(
        lp(b'longjing-report-v1') + lp(ek) + lp(identity) + lp(refund) + lp(cert_hash)
    ).digest()
    return commitment + nonce

def verify_server_attestation(server_url: str) -> dict:
    nonce = secrets.token_bytes(32)
    attestation = requests.get(f"{server_url}/attestation", params={'nonce': nonce.hex()}).json()
    if attestation['platform'] == 'mock':
        raise ValueError("Server is not in a TEE")

    expected = report_data(attestation['keys'], nonce)
    if bytes.fromhex(attestation['reportData']) != expected:
        raise ValueError("report_data does not commit to the returned keys and nonce")
    quote = base64.b64decode(attestation['quote'])
    if quote[568:632] != expected:
        raise ValueError("The quote report_data does not match")

    # Then replay RTMR0–3 from attestation['eventLog'] and verify the quote signature
    return attestation['keys']
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

3. **Verify the key binding**
   - This is the critical security check
   - Prevents key substitution attacks, including a refund signer outside the enclave

4. **Check measurement hash**
   - Compare against published/expected measurement
   - Ensures you're talking to the correct code

5. **Enforce freshness**
   - Send a fresh random nonce and check it is in `report_data`
   - Prevents replay attacks; the `timestamp` field is not signed and proves nothing

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

4. **Attest through dstack**
   - Production attests only through dstack and refuses to start otherwise, including with `TEE_PLATFORM=mock`
   - Leave `TEE_PLATFORM` unset in production

### Common Pitfalls

❌ **DON'T: Skip key binding verification**
```typescript
// WRONG - vulnerable to MITM
const pubkey = await fetch(`${url}/mlkem/pubkey`);
encrypt(data, pubkey);  // ❌ No attestation check
```

✅ **DO: Verify the key binding**
```typescript
// CORRECT
await verifyAttestation(url);  // ✅ Checks report_data and the nonce
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

✅ **DO: Bind a fresh nonce**
```typescript
// CORRECT
const nonce = randomBytes(32);
const attestation = await fetch(`${url}/attestation?nonce=${nonce.toString('hex')}`)
  .then((r) => r.json());
if (verifyKeyBinding(attestation, { nonce }).length === 0) {  // ✅ Fresh quote
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
1. Run `pnpm verify:attestation` to diagnose
2. Check server logs for attestation generation errors
3. Review platform-specific troubleshooting in [TEE_SETUP.md](TEE_SETUP.md)
4. File issues at https://github.com/w3hc/longjing/issues
