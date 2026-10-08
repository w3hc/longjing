[![Test](https://github.com/w3hc/longjing/actions/workflows/test.yml/badge.svg)](https://github.com/w3hc/longjing/actions/workflows/test.yml)
[![NestJS](https://img.shields.io/badge/NestJS-v12-E0234E?logo=nestjs)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.35-363636?logo=solidity)](https://soliditylang.org/)
[![Circom](https://img.shields.io/badge/Circom-2-1E1E1E)](https://docs.circom.io/)

# Longjing

Longjing provides anonymous, prepaid access to third-party APIs. A user deposits ETH once and subsequently submits requests that neither the operator nor an observer can link to the deposit or to one another.

It implements the Rate-Limit Nullifier (RLN) protocol described in [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) (Crapis and Buterin), and serves it from a gateway running in an attested Intel TDX enclave.

## Status

v0.5.0 is a testnet release. Do not deposit funds you can't afford to lose.

- **Keys:** the circuit keys come from a single-party trusted setup, so whoever ran it could forge proofs. They are for testnets only until a public ceremony replaces them ([#135](https://github.com/w3hc/longjing/issues/135)).
- **Audit:** the code has had internal reviews only, no external audit.
- **Exit:** withdrawing needs the `pnpm prove` client. The standalone withdrawal page is not built yet ([#157](https://github.com/w3hc/longjing/issues/157)).
- **Network:** request timing, size and the client's network identity are not protected yet ([#99](https://github.com/w3hc/longjing/issues/99)).

## Design

1. **Deposit.** The user deposits ETH together with a commitment to a secret key. The contract binds the amount into the note's Merkle leaf.
2. **Request.** For each request, the client proves in zero knowledge that the note is solvent, `(i + 1) · C_max ≤ D + R`, and publishes a one-time RLN signal. The request carries no commitment, leaf, deposit amount or ticket index.
3. **Refund.** Each response adds `C_max − C_actual` to a server-signed accumulator, which the client re-randomizes before every request.
4. **Withdrawal.** The user proves a withdrawal of `D + R − n · C_max`. The contract pays it after a three-day challenge window, without the server's involvement.
5. **Slashing.** Reusing a ticket index reveals the secret key, and anyone holding it may slash the note.

The secret key and the accumulator never leave the client. Every key the gateway relies on, except the upstream provider's API key, is derived in the enclave and bound to its attestation. Departures from the paper are recorded in [SETTLEMENT.md](docs/SETTLEMENT.md).

### Install

```
pnpm install
pnpm circuits:fetch
forge install
cp .env.template .env
```

### Test

```bash
# Unit tests
pnpm test

# Check each goal and report it as verified, not met or not checked yet (requires Anvil running)
anvil                      # Terminal 1
pnpm demo                  # Terminal 2

# End-to-end tests (requires Anvil running)
pnpm test:e2e

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

## Deployment

In production, Longjing runs on [dstack](https://github.com/Dstack-TEE/dstack) and derives every key inside the enclave. The trusted setup, contract, enclave and governance are deployed in a fixed order, described in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Threat model

Longjing is intended to protect the link between a deposit and its requests, the link between two requests, and the user's balance.

It does not protect:

- the content of a request from the upstream provider;
- the user's network identity, for which Tor or an equivalent is required;
- request timing and size, which may still correlate requests ([#99](https://github.com/w3hc/longjing/issues/99));
- against a compromised TEE or its hardware vendor;
- against whoever performed the trusted setup, while it remains single-party.

Privacy rests on hashes alone, while funds also rest on elliptic curves and pairings: a break of those could cost funds but not privacy. See [ZK.md](docs/ZK.md#cryptographic-assumptions).

## Longjing compared to ethereum/zkapi

[ethereum/zkapi](https://github.com/ethereum/zkapi) implements the same proposal under different design choices.

| | Longjing | ethereum/zkapi |
|---|---|---|
| Double-spend protection | RLN: a reused ticket index reveals the secret key | Chain of one-time, server-signed states |
| Accounting | Server-signed refund accumulator; solvency proven in-circuit | Private balance carried in the signed state |
| Withdrawal | Zero-knowledge proof, 3-day challenge window, no server | Mutual close with the server, or an escape hatch with a 24-hour window |
| Request path | Client → TEE gateway → provider | Browser → provider directly |
| Stack | Circom, Groth16, NestJS, Foundry | Rust, WASM, Groth16, Foundry |

Longjing retains the original RLN design and places it behind an attested gateway able to front any provider. ethereum/zkapi offers a simplified protocol with a browser SDK. Further detail is given in [OVERVIEW.md](docs/OVERVIEW.md#longjing-and-ethereumzkapi).

## Documentation

**Core**
- [OVERVIEW.md](docs/OVERVIEW.md) — system architecture and status
- [SETTLEMENT.md](docs/SETTLEMENT.md) — settlement and unlinkability design, and departures from the paper
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
- [MLKEM.md](docs/MLKEM.md) — lattice-based key encapsulation (attested, not used yet)

**Deployment**
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — production deployment, in order
- [TEE_SETUP.md](docs/TEE_SETUP.md) — production TEE deployment
- [ATTESTATION.md](docs/ATTESTATION.md) — verifying the attestation and the keys it binds
- [KEY_DERIVATION.md](docs/KEY_DERIVATION.md) — enclave-derived keys and the key manifest
- [GOVERNANCE.md](docs/GOVERNANCE.md) — Safe and timelock in front of the builds that can derive the keys
- [PHALA_CONFIG.md](docs/PHALA_CONFIG.md) — Phala Cloud setup
- [DOCKER.md](docs/DOCKER.md) — Docker environment

**Security**
- [SECURITY.md](SECURITY.md) — reporting a vulnerability and supported versions

## Contributing

Contributions of any size are welcome, from a typo fix to a new provider. If something is unclear, broken or missing, open an issue: questions count too. Pull requests that tighten the privacy guarantees, sharpen the threat model or make self-hosting easier are especially appreciated. Not sure where to start? The [open issues](https://github.com/w3hc/longjing/issues) are a good place, or just say hi on one of the channels below.

## Contact

**Julien Béranger** ([GitHub](https://github.com/julienbrg))

- Element: [@julienbrg:matrix.org](https://matrix.to/#/@julienbrg:matrix.org)
- Farcaster: [julien-](https://warpcast.com/julien-)
- Telegram: [@julienbrg](https://t.me/julienbrg)

## Credits

Based on [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) by Davide Crapis & Vitalik Buterin.

## License

LGPL-3.0