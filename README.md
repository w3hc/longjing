[![Test](https://github.com/w3hc/longjing/actions/workflows/test.yml/badge.svg)](https://github.com/w3hc/longjing/actions/workflows/test.yml)
[![NestJS](https://img.shields.io/badge/NestJS-v12-E0234E?logo=nestjs)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.35-363636?logo=solidity)](https://soliditylang.org/)
[![Circom](https://img.shields.io/badge/Circom-2-1E1E1E)](https://docs.circom.io/)
[![pnpm](https://img.shields.io/badge/pnpm-10.23-F69220?logo=pnpm)](https://pnpm.io/)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js)](https://nodejs.org/)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

# Longjing

Anonymous, prepaid API access behind a TEE gateway. Deposit ETH once, then make API requests that can't be linked back to you — not by an eavesdropper, and not by the operator running the service.

Most paid API access today silently ties every request to a payment identity. There's no technical reason it has to. This project is an attempt to make unlinkable, prepaid API access a normal thing that exists — something anyone can run, fork, and build on.

Longjing implements the original Rate-Limit Nullifier (RLN) protocol from [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) by Davide Crapis & Vitalik Buterin, and wraps it in what the protocol alone doesn't give you:

- **A TEE gateway** — the server runs in an Intel TDX enclave, terminates TLS inside it, and binds its TLS and ML-KEM keys to the attestation quote, so clients can check what they're talking to before sending anything.
- **A generic provider layer** — any upstream API (LLMs or otherwise) plugs in behind the same proof, pricing and refund flow.
- **Metadata hardening** — header sanitizing, timing protection, response padding and cost quantization, so the traffic around a valid proof doesn't give the user away.

## Longjing and ethereum/zkapi

[ethereum/zkapi](https://github.com/ethereum/zkapi) is a separate implementation of the same proposal, built by Open Anonymity with the Ethereum Foundation. The two projects made different choices:

| | Longjing | ethereum/zkapi |
|---|---|---|
| **Double-spend protection** | Original RLN: reusing a ticket index leaks the secret key, and anyone can slash the RLN stake | State-anchor chain: each request consumes a one-time, server-signed state; replaying an old state is caught during a withdrawal challenge window |
| **Accounting** | Signed refund tickets accumulate client-side and are proven in-circuit (`(i + 1) · C_max ≤ D + R`) | Private balance carried in the signed state; net settlement in gwei at withdrawal or expiry |
| **Stakes** | Separate RLN stake (claimable) and policy stake (burnable) | No policy stake; policy penalties are a bounded balance deduction |
| **Withdrawal** | Direct ZK withdrawal, no server involvement | Instant mutual close with the server, or an escape hatch with a 24h challenge window |
| **Request path** | Client → TEE gateway → provider; the gateway holds the provider credentials | Browser → provider directly; the server authorizes leases and settles |
| **Stack** | Circom + snarkjs (Groth16, EdDSA), NestJS, Foundry | Rust + WASM (Groth16, Schnorr), browser SDK, Foundry |

If you want the simplified protocol with a browser SDK, use zkapi. If you want the original RLN design behind an attested gateway that can front any provider, that's what Longjing is for. See [OVERVIEW.md](docs/OVERVIEW.md#longjing-and-ethereumzkapi) for details.

> **Status:** working implementation, actively developed. Read [What this protects — and what it doesn't](#what-this-protects--and-what-it-doesnt) before relying on it for anything where your safety is at stake.

## How it works

1. **Deposit once.** You send ETH to a smart contract along with an identity commitment. This is the only step that touches your onchain identity.
2. **Prove, don't reveal.** For each request, your client generates a zero-knowledge proof that you have credits — without exposing your balance, your deposit, or your past requests. Your secret key never leaves your machine: the server never generates proofs that need it.
3. **Request anonymously.** You submit the API request with the proof and a one-time nullifier. The operator verifies the proof and forwards the request. It can't tell which depositor you are.
4. **Unlinkable by design.** Each request uses a fresh nullifier, so two requests from the same person can't be correlated with each other.
5. **Get unused credits back.** Refund tickets let you redeem what you didn't spend, onchain, with a proof your client generates (`pnpm prove refund`).

The operator sees valid proofs and the requests it forwards. It does **not** see who you are or link your requests together. That property is enforced by cryptography, not by a policy promise.

## Features

- **Anonymous API access** — make requests without revealing your identity
- **Unlinkable requests** — a unique nullifier per request prevents correlation
- **Prove solvency, not balance** — ZK proofs confirm you can pay without exposing how much you have or what you've spent
- **Multi-provider** — a provider abstraction any API can plug into; Claude ships as the reference provider
- **Trustless refunds** — automatic refund tickets for unused credits
- **TEE support** — runs on [dstack](https://github.com/Dstack-TEE/dstack) (Intel TDX, e.g. Phala Cloud), with keys derived in the enclave and an attestation clients can verify
- **Production circuits** — Groth16 verifiers for withdrawal, refund, and slashing proofs
- **Privacy-preserving storage** — SQLite-based Merkle tree designed not to retain linkage
- **Tested** — 580+ unit tests plus end-to-end integration tests with real proofs

## What this protects — and what it doesn't

Privacy tooling is only as honest as its threat model. Here's the real boundary, stated plainly.

**It protects:**
- The link between your payment identity and your individual requests
- The correlation between two requests made by the same person
- Your balance and spending history from the operator and from observers

**It does not, on its own, protect:**
- **The content of your request from the upstream API provider.** If you query an LLM, that provider still sees the plaintext prompt. Longjing hides *who* asked, not *what was asked* from the endpoint that answers it.
- **Network-layer identity.** Your IP can deanonymize you regardless of the proof. Use Tor or an equivalent if that's part of your threat model — this is not optional for adversaries who can watch the network.
- **Timing and metadata.** Request timing, frequency, and size can leak information. Batching and padding help; they don't make the problem disappear.
- **A compromised or malicious TEE.** TEE guarantees rest on hardware and vendor trust assumptions. A nation-state adversary is a different threat model than a curious operator, and this project does not claim to defeat the former.

If your safety depends on this, assume a sophisticated adversary and design accordingly — Tor, careful operational security, and an understanding that the upstream provider still sees your query. Don't treat "cryptographically unlinkable" as "safe." They are not the same sentence.

## Run it yourself

The most private deployment is the one where no third party — including this project's maintainer — is in the loop. Self-hosting is the intended path.

### Install

```
pnpm install
pnpm circuits:fetch
forge install
cp .env.template .env.local
```

### Test

```bash
# Unit tests
pnpm test

# End-to-end tests (requires Anvil running)
anvil                      # Terminal 1
pnpm test:e2e             # Terminal 2

# Contract tests (Foundry)
cd contracts && forge test -vv

# Proof round-trip (the circuit suites need circom on PATH)
pnpm test:proof

# Format and lint checks
pnpm format:check
pnpm lint:check
```

### Run locally

```
# Generate TLS certificates
mkdir -p secrets
openssl req -x509 -newkey rsa:4096 \
  -keyout secrets/tls.key \
  -out secrets/tls.cert \
  -days 365 -nodes \
  -subj "/CN=localhost"

# Start development server
pnpm start:dev
```

Server runs at `https://localhost:3000`, with the Swagger UI at its root. Outside production, keys come from the [dstack simulator](https://github.com/Dstack-TEE/dstack) when `DSTACK_SIMULATOR_ENDPOINT` is set; otherwise the refund signer uses a dev-only random key.

### Deploy to production

In production, Longjing runs on [dstack](https://github.com/Dstack-TEE/dstack) and derives every key inside the enclave with `GetKey`: the ML-KEM key, the refund signer, the TLS key and an identity key that signs a key manifest, served at `GET /attestation/manifest`. No one handles them, the operator included, and production refuses to start with key material in env. See [KEY_DERIVATION.md](docs/KEY_DERIVATION.md).

```
docker compose up   # docker-compose.yml mounts /var/run/dstack.sock
```

Clients check the deployment with `pnpm verify:attestation`. See [TEE_SETUP.md](docs/TEE_SETUP.md) and [PHALA_CONFIG.md](docs/PHALA_CONFIG.md) for production configurations. Running in a TEE is strongly recommended for any deployment serving users other than yourself — it's what lets users trust the operator without trusting you personally.

## Add your own provider

The provider layer is an abstraction — any upstream API plugs in the same way as the Claude provider. See [QUICK_START.md](docs/QUICK_START.md) to add a new provider in 10 steps.

## Documentation

**Core**
- [OVERVIEW.md](docs/OVERVIEW.md) — system architecture and status
- [QUICK_START.md](docs/QUICK_START.md) — add a new provider in 10 steps
- [LOCAL_SETUP.md](docs/LOCAL_SETUP.md) — local development setup
- [API_REFERENCE.md](docs/API_REFERENCE.md) — endpoints, request formats and client-side proving

**Zero-knowledge**
- [ZK.md](docs/ZK.md) — circuits and proofs
- [TRUSTED_SETUP_CEREMONY.md](docs/TRUSTED_SETUP_CEREMONY.md) — ceremony details and process
- [TESTING_GUIDE.md](docs/TESTING_GUIDE.md) — testing procedures

**Architecture**
- [PROVIDERS.md](docs/PROVIDERS.md) — provider abstraction design
- [SQLITE3.md](docs/SQLITE3.md) — database and privacy design
- [MLKEM.md](docs/MLKEM.md) — post-quantum key encapsulation
- [SIWE.md](docs/SIWE.md) — Sign-In with Ethereum

**Deployment**
- [TEE_SETUP.md](docs/TEE_SETUP.md) — production TEE deployment
- [ATTESTATION.md](docs/ATTESTATION.md) — verifying the attestation and the keys it binds
- [KEY_DERIVATION.md](docs/KEY_DERIVATION.md) — enclave-derived keys and the key manifest
- [GOVERNANCE.md](docs/GOVERNANCE.md) — Safe and timelock in front of the builds that can derive the keys
- [PHALA_CONFIG.md](docs/PHALA_CONFIG.md) — Phala Cloud setup
- [DOCKER.md](docs/DOCKER.md) — Docker environment

## Contributing

This is built to be run, forked, and improved by people other than its author — that's the point. Issues and pull requests welcome, especially ones that tighten the privacy guarantees, sharpen the threat-model docs, or lower the friction of self-hosting.

## License

LGPL-3.0

## Credits

Based on [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) by Davide Crapis & Vitalik Buterin.

## Contact

**Julien Béranger** ([GitHub](https://github.com/julienbrg))

- Element: [@julienbrg:matrix.org](https://matrix.to/#/@julienbrg:matrix.org)
- Farcaster: [julien-](https://warpcast.com/julien-)
- Telegram: [@julienbrg](https://t.me/julienbrg)