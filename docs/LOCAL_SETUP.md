# Local Setup (Without Docker)

This guide covers running Longjing locally on your machine without Docker, ideal for development and debugging.

## Prerequisites

- Node.js 20+ installed
- pnpm 10.23+ installed
- OpenSSL (for generating TLS certificates)

## Installation

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Fetch the circuit artifacts** into `circuits/build/`, checked against the hashes in `circuits/artifacts.json`:
   ```bash
   pnpm circuits:fetch
   ```

## Configuration

### 1. Environment Variables

Create your local environment file:

```bash
cp .env.template .env.local
```

Edit `.env.local` and configure:

```bash
NODE_ENV=development
KMS_URL=https://your-kms.example.com/release

# Example app secret — replace with whatever your API needs
MY_API_KEY=<your-api-key>

# Blockchain RPC Configuration
# For local development with Anvil:
ZK_CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
ANVIL_RPC_URL=http://127.0.0.1:8545

# For production Ethereum mainnet (comma-separated list - API will randomly pick one):
# ETHEREUM_RPC_URLS=https://eth.drpc.org,https://rpc.mevblocker.io/fullprivacy,https://rpc.flashbots.net,https://ethereum-rpc.publicnode.com

# Optional: ML-KEM-1024 Admin Keypair (DEVELOPMENT ONLY - for non-TEE environments)
# In production, keys are generated INSIDE the TEE automatically
# ADMIN_MLKEM_PUBLIC_KEY=<your-public-key>
# ADMIN_MLKEM_PRIVATE_KEY=<your-private-key>
```

**Note:**
- **Production (TEE)**: ML-KEM keys are automatically generated inside the TEE on first startup. The private key never leaves the secure enclave.
- **Development (non-TEE)**: You can optionally provide pre-generated keys via environment variables for testing. Generate them with `pnpm ts-node scripts/generate-admin-keypair.ts`.
- ML-KEM encryption utilities are available in `src/encryption/mlkem-encryption.service.ts` but not currently exposed via endpoints.

### 2. Generate TLS Certificates

For local HTTPS development, generate self-signed certificates:

```bash
mkdir -p secrets
openssl req -x509 -newkey rsa:4096 -keyout secrets/tls.key -out secrets/tls.cert -days 365 -nodes -subj "/CN=localhost"
```

**Note**: The application uses HTTPS in development mode and HTTP in production (where Phala handles TLS termination).

## Running the Application

### Development Mode (with hot reload)

```bash
pnpm start:dev
```

The server will start with hot reload enabled. Any changes to source files will automatically restart the server.

### Production Mode (locally)

Build and run in production mode:

```bash
pnpm build
pnpm start:prod
```

**Note**: Production mode expects HTTP (not HTTPS) by default, as it's designed to run behind a TLS termination proxy.

### Debug Mode

Run with Node.js debugger attached:

```bash
pnpm start:debug
```

Then attach your debugger (e.g., VS Code) to port 9229.

## Accessing the Application

### API Documentation

Open your browser and navigate to:

```
https://localhost:3000
```

**Important**: Accept the self-signed certificate warning in your browser.

The Swagger UI provides interactive API documentation with all available endpoints.

### API Endpoints

Key endpoints:

- `GET /` - Swagger UI documentation
- `GET /health` - Health check
- `POST /longjing/request` - Submit anonymous Claude API request
- `POST /longjing/redeem-refund` - Redeem refund ticket
- `GET /longjing/server-pubkey` - Get server's EdDSA public key

See [API_REFERENCE.md](./API_REFERENCE.md) for complete endpoint documentation.

## Development Workflow

### Linting

Check code style:

```bash
pnpm lint
```

Auto-fix issues:

```bash
pnpm lint --fix
```

### Formatting

Format code with Prettier:

```bash
pnpm format
```

### Testing

Run unit tests:

```bash
pnpm test
```

Run tests in watch mode:

```bash
pnpm test:watch
```

Run tests with coverage:

```bash
pnpm test:cov
```

Run end-to-end tests:

```bash
pnpm test:e2e
```

### Full Quality Check

Run all checks (format, lint, test, build):

```bash
pnpm dance
```

This runs:
1. Format check and auto-fix
2. Linting with auto-fix
3. Unit tests
4. E2E tests
5. Production build
6. Outdated dependency check

## Project Structure

```
longjing/
├── src/
│   ├── main.ts              # Application entry point
│   ├── app.module.ts        # Root module
│   ├── config/              # Configuration services
│   ├── longjing/              # ZK proof endpoints
│   ├── auth/                # Authentication (SIWE)
│   ├── filters/             # Exception filters
│   └── logging/             # Custom loggers
├── test/                    # E2E tests
├── scripts/                 # Utility scripts
├── secrets/                 # TLS certificates (local only)
├── docs/                    # Documentation
└── dist/                    # Compiled output
```

## Environment Modes

The application behaves differently based on `NODE_ENV`:

### Development Mode (`NODE_ENV=development`)

- Uses HTTPS with self-signed certificates
- Detailed logging with stack traces
- CORS enabled for all origins (`*`)
- Hot reload enabled with `pnpm start:dev`
- Swagger UI accessible

### Production Mode (`NODE_ENV=production`)

- Uses HTTP (expects TLS termination proxy)
- Sanitized logging (no sensitive data)
- CORS disabled by default
- Optimized build with only production dependencies
- Swagger UI still accessible (consider disabling in production)

## Troubleshooting

### Port 3000 already in use

If port 3000 is already occupied:

1. Find the process using the port:
   ```bash
   lsof -i :3000
   ```

2. Kill the process:
   ```bash
   kill -9 <PID>
   ```

Or change the port in [src/main.ts](../src/main.ts#L60).

### Module not found errors

Clear cache and reinstall:

```bash
rm -rf node_modules dist
pnpm install
```

### TLS certificate errors

Regenerate certificates:

```bash
rm -rf secrets
mkdir -p secrets
openssl req -x509 -newkey rsa:4096 -keyout secrets/tls.key -out secrets/tls.cert -days 365 -nodes -subj "/CN=localhost"
```

### TypeScript compilation errors

Check TypeScript version and rebuild:

```bash
pnpm install
pnpm build
```

## Next Steps

After running locally:

1. **Test the API**: Use Swagger UI or curl to test endpoints
2. **Review ZK system**: See [ZK.md](./ZK.md) for the zero-knowledge proof system
3. **Deploy**: See [DOCKER.md](./DOCKER.md) or [PHALA_CONFIG.md](./PHALA_CONFIG.md) for deployment

## Related Documentation

- [Main README](../README.md) - Project overview
- [Docker Setup](./DOCKER.md) - Run with Docker
- [Phala Deployment](./PHALA_CONFIG.md) - Deploy to Phala Cloud TEE
- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [ZK System Guide](./ZK.md) - Zero-knowledge proof system
