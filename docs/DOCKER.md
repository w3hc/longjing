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

   Configure production settings:
   ```bash
   NODE_ENV=production
   KMS_URL=https://your-kms.example.com/release
   ADMIN_MLKEM_PUBLIC_KEY=<your-public-key>
   ADMIN_MLKEM_PRIVATE_KEY=<your-private-key>
   ```

2. **Generate ML-KEM keypair** (if not already done):
   ```bash
   pnpm ts-node scripts/generate-admin-keypair.ts
   ```

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
docker buildx build --platform linux/amd64 -t YOUR_DOCKERHUB_USERNAME/longjing:latest --push .
```

Example:
```bash
docker buildx build --platform linux/amd64 -t julienberanger/longjing:latest --push .
```

## Configuration

### Environment Variables

Both modes use the following environment variables (configured in `docker-compose.yml` and `docker-compose.dev.yml`):

- `NODE_ENV`: Set to `development` or `production`
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

Production configuration using pre-built image:

```yaml
version: '3.8'

services:
  longjing:
    image: julienberanger/longjing:latest
    pull_policy: always
    ports:
      - "3000:3000"
    volumes:
      - /var/run/dstack.sock:/var/run/dstack.sock  # Required for TEE attestation on Phala
    environment:
      - NODE_ENV=${NODE_ENV}
      - KMS_URL=${KMS_URL}
      - ADMIN_MLKEM_PUBLIC_KEY=${ADMIN_MLKEM_PUBLIC_KEY}
      - ADMIN_MLKEM_PRIVATE_KEY=${ADMIN_MLKEM_PRIVATE_KEY}
    restart: unless-stopped
```

**Note**: The `/var/run/dstack.sock` volume mount is required when deploying to Phala Network or other DStack-based TEE infrastructure. Without it, the application will run in mock mode.

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
