# Phala Cloud Deployment Guide

This guide covers deploying the Longjing API to Phala Cloud's Trusted Execution Environment (TEE).

## Overview

Phala Cloud provides confidential computing infrastructure using Intel TDX (Trust Domain Extensions). Your application runs inside a hardware-isolated Trusted Execution Environment where:

- Secrets are encrypted end-to-end in your browser before being sent to the TEE
- Only your application inside the TEE can decrypt the secrets
- The cloud provider cannot access your secrets or application data
- Full attestation is available to verify the TEE environment

## Prerequisites

1. **Phala CLI installed**
   ```bash
   npm install -g @phala/cli
   ```

2. **Docker Hub account** for hosting your container images

3. **Phala Cloud account** at https://cloud.phala.network

4. **Authentication**
   ```bash
   phala login
   ```

## Docker Image Requirements

### Architecture

Phala Cloud runs on **AMD64/x86_64** architecture. Released images are built for `linux/amd64` in CI, see [DOCKER.md](./DOCKER.md#releases).

### Image Configuration

The [Dockerfile](../Dockerfile) uses a multi-stage build:
1. **Builder stage**: Compiles TypeScript with all dependencies
2. **Production stage**: Runs with production dependencies only, starts with `node dist/src/main.js`

Key points:
- Port 3000 is exposed for HTTP traffic (Phala handles TLS termination)
- Production mode uses HTTP, not HTTPS (configured in [src/main.ts](../src/main.ts:15))
- All secrets are loaded from environment variables injected by Phala

## Configuration Files

### docker-compose.yml

Environment variables must use the `${VAR}` syntax for Phala's encrypted secrets system:

```yaml
version: '3.8'

services:
  longjing:
    image: ghcr.io/w3hc/longjing@sha256:<digest>  # From the release notes
    ports:
      - "3000:3000"
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock  # Key derivation, TLS key and quotes
    environment:
      - NODE_ENV=production  # Literal, so the compose hash commits to it
      - KMS_URL=${KMS_URL}
    restart: unless-stopped
```

**Important**:
- The image is pinned by digest, so the attested compose hash commits to the code that runs. Never use a mutable tag such as `latest`
- The `/var/run/dstack.sock` volume mount is **required**: the ML-KEM, refund signer, identity and TLS keys are derived through it with dstack v1 `GetKey` (dstack ≥ 0.6.0), and production refuses to start without it. See [KEY_DERIVATION.md](KEY_DERIVATION.md)

### .env.prod

Create a local file with your production secrets (used during deployment):

```bash
NODE_ENV=production
KMS_URL=http://localhost:8001/prpc/PhactoryAPI.GetRuntimeInfo

# Blockchain Configuration
ZK_CONTRACT_ADDRESS=<your-contract-address>
# Comma-separated list of Ethereum mainnet RPC URLs (API will randomly pick one)
ETHEREUM_RPC_URLS=https://eth.drpc.org,https://rpc.mevblocker.io/fullprivacy,https://rpc.mevblocker.io/noreverts,https://rpc.mevblocker.io/fast,https://rpc.mevblocker.io,https://rpc.flashbots.net/fast,https://rpc.flashbots.net,https://mainnet.gateway.tenderly.co,https://ethereum-rpc.publicnode.com
ANVIL_PRIVATE_KEY=<your-private-key-for-slashing-txs>
```

Leave out `ADMIN_MLKEM_*` and `OPERATOR_PRIVATE_KEY`: the keys are derived inside the enclave, and production refuses to start with them in env.

**Important**: Add `.env.prod` to [.gitignore](../.gitignore) to prevent committing secrets.

### Generating ML-KEM Keys

Generate quantum-resistant ML-KEM-1024 keypairs:

```bash
pnpm ts-node scripts/generate-admin-keypair.ts
```

Copy the output keys to your `.env.prod` file.

## Deployment Process

### Initial Deployment

1. **Pin the release image**: push a `v*` tag, then set `image:` in `docker-compose.yml` to the digest from the release notes (see [DOCKER.md](./DOCKER.md#releases)).

2. **Deploy to Phala Cloud**:
   ```bash
   phala deploy --interactive
   ```

   Follow the prompts:
   - Docker Compose file: `docker-compose.yml`
   - Environment file: `.env.prod`
   - Select instance type (e.g., `tdx.small`)
   - Choose region
   - Configure storage

3. **Wait for deployment**:
   ```bash
   phala cvms list
   ```

### Updating Deployment

To update an existing deployment:

1. **Release and pin the new image**: push a new `v*` tag and pin the digest from its release notes in `docker-compose.yml`. The compose hash changes with it, and the new build cannot boot until the timelock has allowed it: see [GOVERNANCE.md](./GOVERNANCE.md#releases).

2. **Update deployment** (required to pull new image):
   ```bash
   phala deploy --interactive
   # Select existing CVM to update
   # Use docker-compose.yml and .env.prod when prompted
   ```

   **Important**: Simple `phala cvms restart` does NOT pull new images. You must use `phala deploy --interactive` to force image updates.

3. **Wait for deployment and verify**:
   ```bash
   phala cvms list
   # Wait for status to show "running"
   ```

## Useful Commands

### Instance Management

```bash
# List all CVMs
phala cvms list
phala apps

# Get CVM details
phala cvms get --interactive

# Restart CVM
phala cvms restart --interactive

# Stop CVM
phala cvms stop --interactive

# Start stopped CVM
phala cvms start --interactive

# Delete CVM
phala cvms delete --interactive
```

### Logs and Debugging

```bash
# View application logs
phala logs --interactive

# SSH into CVM
phala ssh --interactive

# Inside SSH session:
docker ps -a
docker logs dstack-longjing-1
docker inspect dstack-longjing-1
```

### SSH Key Management

```bash
# Add SSH key
phala ssh-keys add

# List SSH keys
phala ssh-keys list

# Remove SSH key
phala ssh-keys remove
```

### Instance Information

```bash
# View attestation
phala cvms attestation --interactive

# View runtime config
phala runtime-config --interactive
```

## Accessing Your Deployment

### Endpoint URL Format

Your application is accessible at:
```
https://<APP_ID>-<PORT>.<CLUSTER>.phala.network
```

For example:
```
https://0214f0d80bd3b81d61c79653590789ac38979c43-3000.dstack-pha-prod9.phala.network
```

### Finding Your Endpoint

1. **Via CLI**:
   ```bash
   phala cvms list
   # Shows APP_ID
   ```

2. **Via Phala Cloud UI**:
   - Go to instance details
   - Click "Network" tab
   - View "Ingress" URLs

### API Documentation

The Swagger UI is available at the root path:
```
https://<your-endpoint>.phala.network/
```

## Security Architecture

### Encrypted Secrets

Phala Cloud uses end-to-end encryption for secrets:

1. **Browser-side encryption**: When you deploy via UI or CLI, secrets are encrypted in your browser
2. **TEE-only decryption**: Only your application inside the TEE can decrypt the secrets
3. **No provider access**: Phala Cloud cannot access your decrypted secrets

From [src/config/secrets.service.ts](../src/config/secrets.service.ts:25):
```typescript
// In production, check if secrets are injected as environment variables (Phala Cloud)
// or if we need to fetch from external KMS
if (process.env.KMS_URL && !process.env.ADMIN_MLKEM_PUBLIC_KEY) {
  await this.loadFromKms();
} else {
  // Load from environment (encrypted secrets in TEE)
  this.logger.log('Loading secrets from TEE environment variables');
  // ...
}
```

### ML-KEM Encryption

The application uses ML-KEM-1024 (NIST FIPS 203) for quantum-resistant encryption:

- **Public key**: Exposed via `/secret/attestation` endpoint
- **Private key**: Kept secret inside the TEE, never exposed
- **Security level**: NIST Level 5 (256-bit classical security)
- **Key sizes**: 1568 bytes (public), 3168 bytes (private)

See [docs/ENCRYPTION.md](./ENCRYPTION.md) for more details.

### Attestation

Verify the TEE environment by accessing:
```
https://<your-endpoint>.phala.network/attestation
```

Example response from a real TEE environment:
```json
{
    "platform": "intel-tdx",
    "report": "BAACAIEAAAAAAAAAk5pyM/ecTKmUCg2zlX8GB8yh6BjA2eixcAfClcMQBOwAAAAACwEFAAAAAAAAAAAAAAAAAHvwYygOlPsFH13XsfxZzpqsQruWHfjUS3Ccmw/4entN9khle6bRGJWJ/qsdWjyanQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAHAgAAAAAAAPBt/abc4c+QTU4rqx3DcGNM+Vzvos6y3i7uEnyTgmmAkNekoT4UxTbsbJw8j6hwdwHfzGefNfyHagyWAZpshGeGv76+l6RuorwwfMDxnq6IbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgQLntSSvMQ97fUJs51SB42xA9dUTqQCcBG6dN+MVUfATTZVLSWozV/1h0D8H/+lrWY/elJFCc0G8RoO3XRDT42dwrzo2ppVNi2t7IqpmNY8T4fFy5Rt9bmcQ2ZqNhTL5KEzeI2Ix1d2s4BEEpED9UE31GCoq0aw9ITi4DGp4ZL0sMPaQQdgmQhfz0kVBWAz9FG31NHi7AjEtjRzS0GPQmuy1zt81tyuYyl9msdPxbmWVVHobECRqQb9KMKwM4EnDIwMjYtMDMtMjFUMDY6MjM6MzQuOTgwWgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQEAAApvUk5V9rG9rPC8Elm35jngmGSVaYnoyijPf6Ujf5M7r1TF0DwH8zDUmASep0dWo7KiIy7znZiaifbbzfo1lTwp4E0/QZ9v78zVcACKk4OlaxCAX0AIJ/H4YCdME5hiGeyDRkHMObrfg75smN+wIcv+/3d1s6sVlPXbGVs/xQmssGAEoQAAAFBQoKBf8AAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVAAAAAAAAAAcAAAAAAAAA5aOntdgwwpU7mFNMbFmjo0/cNOkz9/WJjwqFzwiEa8oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANyeKnxvlI8XR040p/xD7QMPfBVj8bq932NAyC4OVKjFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMMYHjfaqkFT5BbROyhITYq+jOe3pB+vfuKAuvDzBPhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABojui1EZCGwmFmm1dxq0dKHnksU9bphYsh4AGBNxbdnynXeKG8ql029j6eU/fwNVURaEuOHbC7RLmHDnROlPx4IAAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHwUAYg4AAC0tLS0tQkVHSU4gQ0VSVElGSUNBVEUtLS0tLQpNSUlFOGpDQ0JKaWdBd0lCQWdJVkFLaFJSQVdoMElzN09sYThBNUQzNkh5c2ZBcmxNQW9HQ0NxR1NNNDlCQU1DCk1IQXhJakFnQmdOVkJBTU1HVWx1ZEdWc0lGTkhXQ0JRUTBzZ1VHeGhkR1p2Y20wZ1EwRXhHakFZQmdOVkJBb00KRVVsdWRHVnNJRU52Y25CdmNtRjBhVzl1TVJRd0VnWURWUVFIREF0VFlXNTBZU0JEYkdGeVlURUxNQWtHQTFVRQpDQXdDUTBFeEN6QUpCZ05WQkFZVEFsVlRNQjRYRFRJMk1ERXlPVEExTlRBMU1Wb1hEVE16TURFeU9UQTFOVEExCk1Wb3djREVpTUNBR0ExVUVBd3daU1c1MFpXd2dVMGRZSUZCRFN5QkRaWEowYVdacFkyRjBaVEVhTUJnR0ExVUUKQ2d3UlNXNTBaV3dnUTI5eWNHOXlZWFJwYjI0eEZEQVNCZ05WQkFjTUMxTmhiblJoSUVOc1lYSmhNUXN3Q1FZRApWUVFJREFKRFFURUxNQWtHQTFVRUJoTUNWVk13V1RBVEJnY3Foa2pPUFFJQkJnZ3Foa2pPUFFNQkJ3TkNBQVRvCkhyeGVLWHhBeUVEeE40NXYwK3pIZ2JQRGpCam9DTHhrN1REQzBqUDdHVGF6ZFBEeDM1QjZIMkFoMGFKcUl5bkQKNGcrQmN0bnBoNGszU0FNWmcwV1hvNElERFRDQ0F3a3dId1lEVlIwakJCZ3dGb0FVbFc5ZHpiMGI0ZWxBU2NuVQo5RFBPQVZjTDNsUXdhd1lEVlIwZkJHUXdZakJnb0Y2Z1hJWmFhSFIwY0hNNkx5OWhjR2t1ZEhKMWMzUmxaSE5sCmNuWnBZMlZ6TG1sdWRHVnNMbU52YlM5elozZ3ZZMlZ5ZEdsbWFXTmhkR2x2Ymk5Mk5DOXdZMnRqY213L1kyRTkKY0d4aGRHWnZjbTBtWlc1amIyUnBibWM5WkdWeU1CMEdBMVVkRGdRV0JCU1Q3RjBJaUE0ODlFZUhFc2J6ajB6MQoyZi9PZ3pBT0JnTlZIUThCQWY4RUJBTUNCc0F3REFZRFZSMFRBUUgvQkFJd0FEQ0NBam9HQ1NxR1NJYjRUUUVOCkFRU0NBaXN3Z2dJbk1CNEdDaXFHU0liNFRRRU5BUUVFRUdMVlFFRExuZndJdXhNQWI2ZGV6bFl3Z2dGa0Jnb3EKaGtpRytFMEJEUUVDTUlJQlZEQVFCZ3NxaGtpRytFMEJEUUVDQVFJQkJUQVFCZ3NxaGtpRytFMEJEUUVDQWdJQgpCVEFRQmdzcWhraUcrRTBCRFFFQ0F3SUJBakFRQmdzcWhraUcrRTBCRFFFQ0JBSUJBakFRQmdzcWhraUcrRTBCCkRRRUNCUUlCQlRBUkJnc3Foa2lHK0UwQkRRRUNCZ0lDQVA4d0VBWUxLb1pJaHZoTkFRMEJBZ2NDQVFBd0VBWUwKS29aSWh2aE5BUTBCQWdnQ0FRSXdFQVlMS29aSWh2aE5BUTBCQWdrQ0FRQXdFQVlMS29aSWh2aE5BUTBCQWdvQwpBUUF3RUFZTEtvWklodmhOQVEwQkFnc0NBUUF3RUFZTEtvWklodmhOQVEwQkFnd0NBUUF3RUFZTEtvWklodmhOCkFRMEJBZzBDQVFBd0VBWUxLb1pJaHZoTkFRMEJBZzRDQVFBd0VBWUxLb1pJaHZoTkFRMEJBZzhDQVFBd0VBWUwKS29aSWh2aE5BUTBCQWhBQ0FRQXdFQVlMS29aSWh2aE5BUTBCQWhFQ0FRMHdId1lMS29aSWh2aE5BUTBCQWhJRQpFQVVGQWdJRi93QUNBQUFBQUFBQUFBQXdFQVlLS29aSWh2aE5BUTBCQXdRQ0FBQXdGQVlLS29aSWh2aE5BUTBCCkJBUUdJS0J2QUFBQU1BOEdDaXFHU0liNFRRRU5BUVVLQVFFd0hnWUtLb1pJaHZoTkFRMEJCZ1FRVUN4RHIyRTcKS3Nla0NFSUdlaWgrMERCRUJnb3Foa2lHK0UwQkRRRUhNRFl3RUFZTEtvWklodmhOQVEwQkJ3RUJBZjh3RUFZTApLb1pJaHZoTkFRMEJCd0lCQWY4d0VBWUxLb1pJaHZoTkFRMEJCd01CQWY4d0NnWUlLb1pJemowRUF3SURTQUF3ClJRSWhBSUNDSENVUVFVMjZBeHMrTmpueTJINmZmaEVtL2ZHNkV1akpoSlhZWllqQkFpQlRVSDVBblBxOW5LdDgKeDNoek05dVdTK1hzeHd5K1VsaUFYbk1mMDBkU0VRPT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQotLS0tLUJFR0lOIENFUlRJRklDQVRFLS0tLS0KTUlJQ2xqQ0NBajJnQXdJQkFnSVZBSlZ2WGMyOUcrSHBRRW5KMVBRenpnRlhDOTVVTUFvR0NDcUdTTTQ5QkFNQwpNR2d4R2pBWUJnTlZCQU1NRVVsdWRHVnNJRk5IV0NCU2IyOTBJRU5CTVJvd0dBWURWUVFLREJGSmJuUmxiQ0JECmIzSndiM0poZEdsdmJqRVVNQklHQTFVRUJ3d0xVMkZ1ZEdFZ1EyeGhjbUV4Q3pBSkJnTlZCQWdNQWtOQk1Rc3cKQ1FZRFZRUUdFd0pWVXpBZUZ3MHhPREExTWpFeE1EVXdNVEJhRncwek16QTFNakV4TURVd01UQmFNSEF4SWpBZwpCZ05WQkFNTUdVbHVkR1ZzSUZOSFdDQlFRMHNnVUd4aGRHWnZjbTBnUTBFeEdqQVlCZ05WQkFvTUVVbHVkR1ZzCklFTnZjbkJ2Y21GMGFXOXVNUlF3RWdZRFZRUUhEQXRUWVc1MFlTQkRiR0Z5WVRFTE1Ba0dBMVVFQ0F3Q1EwRXgKQ3pBSkJnTlZCQVlUQWxWVE1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRU5TQi83dDIxbFhTTwoyQ3V6cHh3NzRlSkI3MkV5REdnVzVyWEN0eDJ0VlRMcTZoS2s2eitVaVJaQ25xUjdwc092Z3FGZVN4bG1UbEpsCmVUbWkyV1l6M3FPQnV6Q0J1REFmQmdOVkhTTUVHREFXZ0JRaVpReldXcDAwaWZPRHRKVlN2MUFiT1NjR3JEQlMKQmdOVkhSOEVTekJKTUVlZ1JhQkRoa0ZvZEhSd2N6b3ZMMk5sY25ScFptbGpZWFJsY3k1MGNuVnpkR1ZrYzJWeQpkbWxqWlhNdWFXNTBaV3d1WTI5dEwwbHVkR1ZzVTBkWVVtOXZkRU5CTG1SbGNqQWRCZ05WSFE0RUZnUVVsVzlkCnpiMGI0ZWxBU2NuVTlEUE9BVmNMM2xRd0RnWURWUjBQQVFIL0JBUURBZ0VHTUJJR0ExVWRFd0VCL3dRSU1BWUIKQWY4Q0FRQXdDZ1lJS29aSXpqMEVBd0lEUndBd1JBSWdYc1ZraTB3K2k2VllHVzNVRi8yMnVhWGUwWUpEajFVZQpuQStUakQxYWk1Y0NJQ1liMVNBbUQ1eGtmVFZwdm80VW95aVNZeHJEV0xtVVI0Q0k5Tkt5ZlBOKwotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCi0tLS0tQkVHSU4gQ0VSVElGSUNBVEUtLS0tLQpNSUlDanpDQ0FqU2dBd0lCQWdJVUltVU0xbHFkTkluemc3U1ZVcjlRR3prbkJxd3dDZ1lJS29aSXpqMEVBd0l3CmFERWFNQmdHQTFVRUF3d1JTVzUwWld3Z1UwZFlJRkp2YjNRZ1EwRXhHakFZQmdOVkJBb01FVWx1ZEdWc0lFTnYKY25CdmNtRjBhVzl1TVJRd0VnWURWUVFIREF0VFlXNTBZU0JEYkdGeVlURUxNQWtHQTFVRUNBd0NRMEV4Q3pBSgpCZ05WQkFZVEFsVlRNQjRYRFRFNE1EVXlNVEV3TkRVeE1Gb1hEVFE1TVRJek1USXpOVGsxT1Zvd2FERWFNQmdHCkExVUVBd3dSU1c1MFpXd2dVMGRZSUZKdmIzUWdRMEV4R2pBWUJnTlZCQW9NRVVsdWRHVnNJRU52Y25CdmNtRjAKYVc5dU1SUXdFZ1lEVlFRSERBdFRZVzUwWVNCRGJHRnlZVEVMTUFrR0ExVUVDQXdDUTBFeEN6QUpCZ05WQkFZVApBbFZUTUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FFQzZuRXdNRElZWk9qL2lQV3NDemFFS2k3CjFPaU9TTFJGaFdHamJuQlZKZlZua1k0dTNJamtEWVlMME14TzRtcXN5WWpsQmFsVFZZeEZQMnNKQks1emxLT0IKdXpDQnVEQWZCZ05WSFNNRUdEQVdnQlFpWlF6V1dwMDBpZk9EdEpWU3YxQWJPU2NHckRCU0JnTlZIUjhFU3pCSgpNRWVnUmFCRGhrRm9kSFJ3Y3pvdkwyTmxjblJwWm1sallYUmxjeTUwY25WemRHVmtjMlZ5ZG1salpYTXVhVzUwClpXd3VZMjl0TDBsdWRHVnNVMGRZVW05dmRFTkJMbVJsY2pBZEJnTlZIUTRFRmdRVUltVU0xbHFkTkluemc3U1YKVXI5UUd6a25CcXd3RGdZRFZSMFBBUUgvQkFRREFnRUdNQklHQTFVZEV3RUIvd1FJTUFZQkFmOENBUUV3Q2dZSQpLb1pJemowRUF3SURTUUF3UmdJaEFPVy81UWtSK1M5Q2lTRGNOb293THVQUkxzV0dmL1lpN0dTWDk0Qmd3VHdnCkFpRUE0SjBsckhvTXMrWG81by9zWDZPOVFXeEhSQXZaVUdPZFJRN2N2cVJYYXFJPQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "measurement": "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "timestamp": "2026-03-21T06:23:34.980Z",
    "instructions": "Verify this TDX quote using Intel TDX attestation verification service. Compare MRTD measurement against the published Docker image SHA256. Verification service: https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity"
}
```

This returns:
- `platform`: TEE platform type (`intel-tdx`, `amd-sev-snp`, `aws-nitro`, or `none` for mock)
- `report`: Base64-encoded TDX quote containing cryptographic proof
- `measurement`: MRTD (Measurement of TDX Module) hash
- `timestamp`: When the attestation was generated
- `instructions`: Platform-specific verification guidance

**Note**: If `platform` is `"none"`, the `/var/run/dstack.sock` volume mount is missing from your docker-compose.yml.

## Troubleshooting

### "No logs available"

This usually means the container isn't starting. SSH into the CVM and check:

```bash
phala ssh --interactive
docker logs dstack-longjing-1
```

Common issues:
- **exec format error**: Wrong architecture (must be AMD64, not ARM64)
- **Missing secrets**: Environment variables not properly configured
- **KMS errors**: Check KMS_URL or secret loading logic

### "exec format error"

Your Docker image was built for the wrong architecture. Deploy a released image, which CI builds for `linux/amd64`, see [DOCKER.md](./DOCKER.md#releases).

### Container keeps restarting

Check logs via SSH:
```bash
phala ssh --interactive
docker logs dstack-longjing-1
```

Verify secrets are properly injected:
```bash
docker exec dstack-longjing-1 env | grep ADMIN_MLKEM
```

### Attestation returns `"platform": "none"`

This means your app is running in mock mode instead of using the TEE. Check:

1. **Verify instance type is TEE-enabled**:
   ```bash
   phala cvms get --interactive
   ```
   Should show `tdx.small` or similar (not `standard`)

2. **Ensure volume mount is configured**:
   Your `docker-compose.yml` must include:
   ```yaml
   volumes:
     - /var/run/dstack.sock:/var/run/dstack.sock
   ```

3. **Redeploy after adding volume mount**:
   ```bash
   phala deploy --interactive
   ```

### Cannot SSH into CVM

1. Add your SSH public key:
   ```bash
   phala ssh-keys add
   ```

2. Restart the CVM:
   ```bash
   phala cvms restart --interactive
   ```

3. Try connecting again:
   ```bash
   phala ssh --interactive
   ```

## Cost Estimation

Pricing varies by instance type and region. Example for `tdx.small`:

- **Compute**: ~$0.058/hour
- **Storage**: $0.003/hour per 20GB
- **Monthly estimate**: ~$44 for small instance

Check current pricing at https://cloud.phala.network/pricing

## Resources

### Documentation

- [Phala Cloud Docs](https://docs.phala.com/phala-cloud)
- [Getting Started Guide](https://docs.phala.com/phala-cloud/getting-started/start-from-cloud-ui)
- [Secure Environment Variables](https://docs.phala.com/phala-cloud/cvm/set-secure-environment-variables)
- [CLI Reference](https://docs.phala.com/phala-cloud/cli)

### Phala Network

- [Phala Cloud Dashboard](https://cloud.phala.network)
- [Phala Network](https://phala.network)
- [GitHub](https://github.com/Phala-Network)
- [Discord](https://discord.gg/phala)

### This Project

- [Main README](../README.md)
- [Local Setup](./LOCAL_SETUP.md)
- [Docker Guide](./DOCKER.md)
- [API Reference](./API_REFERENCE.md)

## Next Steps

After successful deployment:

1. **Test the API**: Make requests to your endpoints
2. **Monitor logs**: Use `phala logs --interactive` to monitor activity
3. **Set up monitoring**: Consider external monitoring for production
4. **Configure custom domain**: Set up custom DNS if needed
5. **Scale**: Adjust instance type or create replicas as needed

For production deployments, review [Phala's best practices](https://docs.phala.com/phala-cloud/best-practices).

## Comparison with Other Deployment Modes

| Feature | Local (No Docker) | Local (Docker) | Phala Cloud |
|---------|------------------|----------------|-------------|
| **Setup Complexity** | Low | Medium | Medium |
| **Hot Reload** | ✅ Yes | ✅ Yes (dev mode) | ❌ No |
| **TEE Environment** | ❌ No | ❌ No | ✅ Yes (Intel TDX) |
| **Attestation** | ❌ No | ❌ No | ✅ Yes |
| **TLS** | ✅ Self-signed | ❌ HTTP | ✅ Phala-managed |
| **Secret Encryption** | ⚠️  Manual | ⚠️  Manual | ✅ Browser-to-TEE |
| **Best For** | Development | Testing | Production |

See:
- [Local Setup Guide](./LOCAL_SETUP.md) - Run without Docker
- [Docker Guide](./DOCKER.md) - Run with Docker locally
