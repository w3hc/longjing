# Docker Setup

This guide covers running Longjing using Docker in both development and production modes.

## Prerequisites

- Docker Desktop installed with Docker Compose V2
- Port 3000 available on your host machine

## Quick Start

### Development Mode (with hot reload)

```bash
docker compose -f docker-compose.dev.yml up
```

### Production Mode (optimized build)

```bash
docker compose up
```

## Development Mode

Development mode uses hot reload and mounts your local code as a volume for live changes.

### Setup

1. **Create environment file** (optional for dev):
   ```bash
   cp .env.template .env.local
   ```

   The dev compose file has sensible defaults, but you can override in `.env`:
   ```bash
   NODE_ENV=development
   KMS_URL=http://localhost:8001/prpc/PhactoryAPI.GetRuntimeInfo
   ```

2. **Start development container**:
   ```bash
   docker compose -f docker-compose.dev.yml up
   ```

   Or run in detached mode:
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```

### Features

- Uses [Dockerfile.dev](../Dockerfile.dev)
- Runs `pnpm start:dev` with hot reload
- Code changes are reflected immediately (volume mounted)
- Sets `NODE_ENV=development`
- Application available at `https://localhost:3000`
- TLS certificates generated automatically in container

### Stop Development Mode

```bash
docker compose -f docker-compose.dev.yml down
```

### View Logs

```bash
docker compose -f docker-compose.dev.yml logs -f
```

## Production Mode

Production mode uses a multi-stage build to create an optimized image.

### Setup

1. **Create production environment file**:
   ```bash
   cp .env.template .env.prod
   ```

   Configure production settings (`NODE_ENV=production` refuses placeholders such as the `example.com` URL):
   ```bash
   KMS_URL=https://kms.your-domain.com/release
   ETHEREUM_RPC_URLS=https://eth.drpc.org,https://rpc.flashbots.net
   ZK_CONTRACT_ADDRESS=0x...
   ```

   No key material: the keys are derived inside the enclave, and production refuses to start with it in env. See [KEY_DERIVATION.md](KEY_DERIVATION.md).

   Copy the generated keys to `.env.prod`.

3. **Update docker-compose.yml** to use `.env.prod`:
   ```yaml
   env_file:
     - .env.prod
   ```

   Or source environment variables manually before running.

### Run Production Mode

```bash
docker compose up
```

Or run in detached mode:

```bash
docker compose up -d
```

### Features

- Uses [Dockerfile](../Dockerfile) (multi-stage build)
- Builds optimized production bundle
- Only production dependencies installed
- Sets `NODE_ENV=production`
- Application available at `http://localhost:3000`
- Uses HTTP (designed for TLS termination proxy like Phala)

### Stop Production Mode

```bash
docker compose down
```

### View Logs

```bash
docker compose logs -f
```

## Building Custom Images

### Build Development Image

```bash
docker build -f Dockerfile.dev -t longjing:dev .
```

### Build Production Image

```bash
docker build -t longjing:latest .
```

### Build for Different Platforms

For Phala Cloud or other AMD64 environments (from Apple Silicon):

```bash
docker buildx build --platform linux/amd64 -t longjing:local .
```

Images that get deployed are not built by hand: see [Releases](#releases).

## Configuration

### Environment Variables

Both modes use the following environment variables (configured in `docker-compose.yml` and `docker-compose.dev.yml`):

- `NODE_ENV`: `development`, `test` or `production`, required. See [LOCAL_SETUP.md](LOCAL_SETUP.md#node_env)
- `ETHEREUM_RPC_URLS`, `ZK_CONTRACT_ADDRESS`: required with `NODE_ENV=production`
- `KMS_URL`: KMS service endpoint (default: `http://localhost:8001/prpc/PhactoryAPI.GetRuntimeInfo`)

To modify these, edit the respective `docker-compose` file before running.

### Ports

By default, the application runs on port 3000. To change this, modify the `ports` section in the docker-compose files:

```yaml
ports:
  - "8080:3000"  # Maps host port 8080 to container port 3000
```

## Docker Compose Configuration Files

### docker-compose.dev.yml

Development configuration with volume mounting:

```yaml
version: '3.8'

services:
  longjing:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - KMS_URL=http://localhost:8001/prpc/PhactoryAPI.GetRuntimeInfo
    volumes:
      - .:/app
      - /app/node_modules
    restart: unless-stopped
```

### docker-compose.yml

Production configuration using a released image, pinned by digest:

```yaml
version: '3.8'

services:
  longjing:
    image: ghcr.io/w3hc/longjing@sha256:<digest>
    ports:
      - "3000:3000"
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock  # Key derivation, TLS key and quotes
    environment:
      - NODE_ENV=production  # A literal, so the compose hash commits to it
      - KMS_URL=${KMS_URL}
      - ETHEREUM_RPC_URLS=${ETHEREUM_RPC_URLS}
      - ZK_CONTRACT_ADDRESS=${ZK_CONTRACT_ADDRESS}
    restart: unless-stopped
```

**Note**: The `/var/run/dstack.sock` volume mount is required: the keys are derived through it, and production refuses to start without it. `NODE_ENV` is a literal rather than `${NODE_ENV}`, so the operator cannot switch production checks off. See [KEY_DERIVATION.md](KEY_DERIVATION.md#production-policy).

## Releases

On dstack, the attestation commits to the compose file, not to the image contents. A mutable tag such as `latest` would let whoever controls the registry ship different code under the same attested compose hash, so `docker-compose.yml` pins the image by digest, and that digest is built in CI from a tagged commit.

### Release → digest → compose hash

1. Push a `v*` tag. [`release.yml`](../.github/workflows/release.yml) builds the image for `linux/amd64`, pushes it to `ghcr.io/w3hc/longjing:<tag>`, attests its build provenance, and adds its digest to the GitHub release notes.
2. Pin that digest in `docker-compose.yml`:
   ```yaml
   image: ghcr.io/w3hc/longjing@sha256:<digest>
   ```
3. Deploy. The compose hash, which dstack extends into RTMR3, now commits to that exact image.

### Why the pin lags one release

A commit can't contain the digest of an image built from itself: the digest exists only once CI has built the tagged commit. So the `docker-compose.yml` at a release tag still pins the **previous** release's image. At `v0.4.1`, for example, it pins the `v0.4.0` digest.

The new digest is pinned in a follow-up commit on `main`, after the release:

1. Wait for `release.yml` to finish, and copy the digest from the release notes.
2. Check it, as described in [Checking a digest](#checking-a-digest).
3. Open a pull request that changes only the `image:` line of `docker-compose.yml` to `ghcr.io/w3hc/longjing@sha256:<new digest>`, and merge it.

Until that commit lands, don't deploy the compose file from the release tag expecting the new release: it boots the previous image, and its attested compose hash is the previous release's. Deploy from the follow-up commit instead, or set the digest from the release notes yourself, knowing the compose hash then differs from any committed one. Before trusting a deployment, check that the digest in its compose file matches the release you expect.

### Checking a digest

The build is reproducible: the base image is pinned by digest, pnpm comes from corepack at the version and hash in `package.json`, dependencies come from the lockfile, circuit artifacts are checked against the sha256 in `circuits/artifacts.json`, pnpm's timestamped state files are removed, and file timestamps are clamped to the tagged commit's time. CI builds every pull request twice and fails if the digests differ. To check a release yourself:

```bash
git checkout v0.2.2
export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH \
  --output type=oci,dest=longjing.tar,rewrite-timestamp=true \
  --metadata-file metadata.json .
jq -r '."containerimage.digest"' metadata.json
```

It must print the digest in the release notes and in `docker-compose.yml`. The build needs a `docker-container` builder (`docker buildx create --use`). You can also check the provenance attestation:

```bash
gh attestation verify oci://ghcr.io/w3hc/longjing@sha256:<digest> --repo w3hc/longjing
```

## Troubleshooting

### Command not found: docker-compose

If you see `zsh: command not found: docker-compose`, use `docker compose` (with a space) instead of `docker-compose` (with a hyphen). Docker Compose V2 is now integrated into the Docker CLI.

### Port already in use

If port 3000 is already in use, either stop the conflicting service or change the port mapping in the docker-compose file:

```yaml
ports:
  - "8080:3000"  # Use host port 8080 instead
```

Or find and kill the process using port 3000:

```bash
# Find process
lsof -i :3000

# Kill process
kill -9 <PID>
```

### Container won't start

View logs to diagnose:

```bash
docker compose logs -f
```

Common issues:
- Missing environment variables
- Invalid ML-KEM keys
- Port conflicts

### Volume permission issues (Linux)

If you encounter permission issues with mounted volumes:

```bash
docker compose -f docker-compose.dev.yml down
docker volume prune
docker compose -f docker-compose.dev.yml up
```

### Rebuilding after code changes

Development mode auto-reloads, but for production:

```bash
docker compose down
docker compose build --no-cache
docker compose up
```

### exec format error

This means the Docker image was built for the wrong architecture. Rebuild with:

```bash
docker buildx build --platform linux/amd64 -t longjing:latest .
```

### TEE attestation returns "platform": "none"

If deploying to Phala Network and attestation shows mock mode:

1. **Add volume mount** to docker-compose.yml:
   ```yaml
   volumes:
     - /var/run/dstack.sock:/var/run/dstack.sock
   ```

2. **Verify instance type** is TEE-enabled (e.g., `tdx.small`)

3. **Redeploy** with updated configuration

See [PHALA_CONFIG.md](./PHALA_CONFIG.md#troubleshooting) for detailed TEE troubleshooting.

## Performance Considerations

### Development Mode

- Volume mounting can be slow on macOS/Windows
- Consider using Docker Desktop's "VirtioFS" for better performance
- Hot reload watches all files in mounted volume

### Production Mode

- Multi-stage build reduces final image size
- Only production dependencies included
- No source files or dev tools in final image
- Optimized for deployment

## Related Documentation

- [Main README](../README.md) - Project overview
- [Local Setup](./LOCAL_SETUP.md) - Run without Docker
- [Phala Deployment](./PHALA_CONFIG.md) - Deploy to Phala Cloud TEE
- [API Reference](./API_REFERENCE.md) - Complete API documentation
