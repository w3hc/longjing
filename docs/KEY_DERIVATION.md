# Enclave-Derived Keys

How Longjing obtains its long-lived private keys so that they exist only inside the attested enclave, and no one, the operator included, can obtain them. Tracks [#93](https://github.com/w3hc/longjing/issues/93). The design follows [Wulong's](https://github.com/julienbrg/wulong/blob/main/docs/KEY_DERIVATION.md).

## Table of Contents

- [Summary](#summary)
- [Derivation](#derivation)
- [Key manifest](#key-manifest)
- [Verification](#verification)
- [Production policy](#production-policy)
- [Development](#development)
- [Rotation and the contract](#rotation-and-the-contract)
- [Sources](#sources)

## Summary

Longjing derives its keys at boot from the [dstack](https://github.com/Dstack-TEE/dstack) KMS with the v1 guest API `GetKey`. They are never generated elsewhere, stored or passed through env:

| Key | `GetKey` domain | Algorithm | Used for |
| --- | --- | --- | --- |
| ML-KEM-1024 decapsulation key | `longjing/mlkem-1024/v1` | `ed25519` (used as a 32-byte seed) | Decrypting what clients encrypt to the server |
| Refund signer | `longjing/refund-signer/babyjub/v1` | `ed25519` (used as a 32-byte seed) | Signing refund tickets (EdDSA on Baby Jubjub), checked by the circuits against `LongjingCredits.serverPublicKey` |
| Identity key | `longjing/identity/v1` | `secp256k1` | Signing the [key manifest](#key-manifest) |
| TLS key | `GetTlsKey` | — | In-enclave TLS termination |

`GetKey` is deterministic in `(app_id, domain, algorithm)`: every instance of the app, on every restart, gets the same keys, so nothing needs to be persisted or backed up. The KMS releases the app's root key only to a CVM whose boot measurements match the app's on-chain policy (allowed compose hash, allowed OS image), so only code the app owner has registered on chain can derive them.

This replaces three weaker sources:

- `ADMIN_MLKEM_PRIVATE_KEY` and `OPERATOR_PRIVATE_KEY` in env, which whoever generated or deployed them knew.
- The "sealed" ML-KEM key under `/sealed-storage`, encrypted with `SHA-256("<TEE_PLATFORM>:<TEE_MEASUREMENT>")`, both read from env. Anyone who knew those two strings could unseal it.
- The v0 tappd API, where `GetKey` ignores the algorithm and lets the caller steer the signature-chain claim.

## Derivation

All keys use the dstack **v1** guest API (`POST /v1/GetKey` on `/var/run/dstack.sock`, dstack ≥ 0.6.0), specified in [guest-api-v1.md](https://github.com/Dstack-TEE/dstack/blob/master/docs/guest-api-v1.md#key-derivation):

```text
key = HKDF-SHA256(
  salt = "dstack-guest-v1",
  IKM  = app root secp256k1 key (released by the KMS to this app only),
  info = LP("dstack-guest-v1-key") || LP(algorithm) || LP(domain),
  L    = 32)
```

where `LP(x) = uint32_be(len(x)) || x`. The client is [`src/keys/dstack-v1.client.ts`](../src/keys/dstack-v1.client.ts), and [`KeyDerivationService`](../src/keys/key-derivation.service.ts) derives the keys.

### ML-KEM-1024

ML-KEM key generation takes a 64-byte seed `d || z` ([FIPS 203](https://csrc.nist.gov/pubs/fips/203/final)), so the 32 bytes from `GetKey` are expanded:

```text
s        = GetKey("longjing/mlkem-1024/v1", "ed25519").key
seed     = HKDF-SHA256(salt = "longjing", IKM = s,
                       info = LP("longjing-mlkem-1024-seed-v1"), L = 64)
(ek, dk) = mlkem.deriveKeyPair(seed)
```

`ed25519` is requested only because its 32 bytes are used as an opaque seed. The ed25519 key itself is never used.

### Refund signer

Refund tickets are EdDSA signatures on Baby Jubjub over `Poseidon(idCommitment, nullifier, value, timestamp)`, verified inside `api_request.circom` and `refund_redemption.circom`. A Baby Jubjub private key is any 32 bytes, which circomlibjs hashes before use:

```text
s           = GetKey("longjing/refund-signer/babyjub/v1", "ed25519").key
private_key = HKDF-SHA256(salt = "longjing", IKM = s,
                          info = LP("longjing-refund-signer-babyjub-v1"), L = 32)
(x, y)      = eddsa.prv2pub(private_key)
```

### Identity key

```text
identity = GetKey("longjing/identity/v1", "secp256k1").key
```

v1 guarantees the 32 bytes are a valid secp256k1 scalar, so they are used directly as the private key. The identity key only signs the manifest, never anything a client sends.

### TLS key

The TLS key and certificate come from `GetTlsKey` on `dstack.sock`, with the private key generated inside the CVM. `report_data` binds the certificate, see [TEE_SETUP.md](./TEE_SETUP.md#3-verify-tls-termination-inside-tee).

## Key manifest

The identity key signs an [EIP-712](https://eips.ethereum.org/EIPS/eip-712) manifest:

```solidity
// domain: { name: "Longjing", version: "1" }
struct KeyManifest {
    address appId;              // the DstackApp contract address
    bytes32 mlkemPublicKeyHash; // SHA-256(ek)
    bytes32 refundSignerX;      // Baby Jubjub public key, as serverPublicKey
    bytes32 refundSignerY;
    bytes32 tlsCertificateHash; // SHA-256(TLS leaf certificate DER), or zero
    uint64  epoch;              // key generation, 1 for now
}
```

`GET /attestation/manifest` returns the manifest and its signature, the EIP-712 domain and types, the full ML-KEM public key, the identity address and public key, the refund signer public key, and the `GetKey` signature chains of the identity and refund signer keys. It answers 503 when the keys were not derived from dstack, which happens only in development.

The `report_data` layout is unchanged, `SHA-256(ek) || SHA-256(tls_leaf_cert_der)`.

## Verification

1. **Attestation**: fetch `GET /attestation`, verify the TDX quote, and check that `report_data` commits to the ML-KEM public key and to the certificate of your TLS session.
2. **Code**: replay the event log into RTMR3 and read `compose_hash` and `app_id`. Check that `compose_hash` belongs to a published Longjing release, see [DOCKER.md](./DOCKER.md#releases).
3. **Manifest**: fetch `GET /attestation/manifest`, recover the EIP-712 signer and check that it is the identity address, that `appId` is the one from step 2, and that `mlkemPublicKeyHash` and `tlsCertificateHash` match step 1.
4. **Signature chains**: check that the identity and refund signer chains lead to the KMS root anchored in the `DstackKms` contract.
5. **Contract**: check that `LongjingCredits.serverPublicKey` equals `(refundSignerX, refundSignerY)`.

## Production policy

With `NODE_ENV=production`:

- Startup fails if `GetKey` fails, or if `DSTACK_SIMULATOR_ENDPOINT` is set, since the simulator's root key is public.
- Startup fails if `ADMIN_MLKEM_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `TLS_KEY_PATH` or `TLS_CERT_PATH` is set ([`key-policy.ts`](../src/keys/key-policy.ts)).
- `docker-compose.yml` sets `NODE_ENV=production` as a literal, and passes none of the above through `${...}` substitution, so the operator cannot set them on a dstack CVM.

`ALLOW_KEYS_OUTSIDE_ENCLAVE=true` lifts both checks, for TEE platforms without dstack. It must be written as a literal in `docker-compose.yml`, never as `${...}`, so using it changes the attested compose hash and is visible to every verifier. Under it, the refund signer needs `OPERATOR_PRIVATE_KEY`.

## Development

Without `/var/run/dstack.sock`, outside production, the keys fall back to `ADMIN_MLKEM_PUBLIC_KEY` / `ADMIN_MLKEM_PRIVATE_KEY` and `OPERATOR_PRIVATE_KEY`, or a deterministic dev refund key, and there is no manifest.

To exercise derivation locally, run the [dstack simulator](https://github.com/Dstack-TEE/dstack/tree/master/sdk/simulator) and point Longjing at it:

```bash
DSTACK_SIMULATOR_ENDPOINT=/path/to/simulator/dstack.sock pnpm start:dev
curl -k https://localhost:3000/attestation/manifest
```

## Rotation and the contract

The derived refund signer is a new key, and `LongjingCredits.serverPublicKey` is set only in the constructor. Moving a deployment to derived keys means:

1. Deploy the new image on dstack.
2. Read `refundSigner.x` and `refundSigner.y` from `GET /attestation/manifest`.
3. Deploy `LongjingCredits` with them, and point `ZK_CONTRACT_ADDRESS` at it.

Changing a domain, a label or the derivation itself rotates every key the same way. The pinned values in [`key-derivation.service.spec.ts`](../src/keys/key-derivation.service.spec.ts) catch that.

## Sources

- [Get a key](https://docs.phala.com/phala-cloud/key-management/get-a-key), Phala Cloud docs
- [dstack guest API v1](https://github.com/Dstack-TEE/dstack/blob/master/docs/guest-api-v1.md)
- [Wulong `KEY_DERIVATION.md`](https://github.com/julienbrg/wulong/blob/main/docs/KEY_DERIVATION.md) and [`dstack-v1.client.ts`](https://github.com/julienbrg/wulong/blob/main/src/keys/dstack-v1.client.ts)
- [FIPS 203](https://csrc.nist.gov/pubs/fips/203/final), [EIP-712](https://eips.ethereum.org/EIPS/eip-712)
