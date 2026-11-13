[![Test](https://github.com/w3hc/longjing/actions/workflows/test.yml/badge.svg)](https://github.com/w3hc/longjing/actions/workflows/test.yml)
[![NestJS](https://img.shields.io/badge/NestJS-v12-E0234E?logo=nestjs)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.35-363636?logo=solidity)](https://soliditylang.org/)
[![Circom](https://img.shields.io/badge/Circom-2-1E1E1E)](https://docs.circom.io/)

# Longjing

Longjing provides anonymous, prepaid access to third-party APIs. A user deposits ETH once and subsequently submits requests that neither the operator nor an observer can link to the deposit or to one another.

It implements the Rate-Limit Nullifier (RLN) protocol described in [ZK API Usage Credits: LLMs and Beyond](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) (Crapis and Buterin), and serves it from a gateway running in an attested Intel TDX enclave.

Longjing is a template: the protocol, pricing and refund logic don't depend on the upstream API, and anyone can plug in their own provider, an LLM or any other paid API. Claude is the reference provider, not a requirement. [QUICK_START.md](docs/QUICK_START.md) adds a provider in 10 steps. Today `POST /longjing/request` still calls Claude directly from `LongjingService` instead of going through the provider registry, so a new provider also has to be wired into that path.

## Status

v0.5.0 is a testnet release. Do not deposit funds you can't afford to lose.

- **Keys:** the circuit keys come from a single-party trusted setup, so whoever ran it could forge proofs. They are for testnets only until a public ceremony replaces them ([#135](https://github.com/w3hc/longjing/issues/135)).
- **Audit:** the code has had internal reviews only, no external audit.
- **Exit:** a standalone page, `withdraw.html`, withdraws a note with only the chain, an RPC, the note file and the settlement circuit files ([Withdraw without the service](#withdraw-without-the-service)). It proves with the single-party `circuits-v2` keys, and no release carries it yet: the next release attaches it. Until then, build it with `pnpm build:browser`, or exit with `pnpm prove withdrawal`.
- **Network:** the gateway serves the API at an onion service inside the enclave, whose address the attestation binds, and the reference client verifies the attestation before it sends anything ([ONION_SERVICE.md](docs/ONION_SERVICE.md)). A client that reaches it through Tor, with a circuit per request, hides its network identity ([INTEGRATION_GUIDELINES.md](docs/INTEGRATION_GUIDELINES.md)). No deployment serves it yet ([#191](https://github.com/w3hc/longjing/issues/191)), and request timing and size are not protected ([#189](https://github.com/w3hc/longjing/issues/189)).

## Design

1. **Deposit.** The user deposits ETH together with a commitment to a secret key. The contract binds the amount into the note's Merkle leaf.
2. **Request.** For each request, the client proves in zero knowledge that the note is solvent, `(i + 1) · C_max ≤ D + R`, and publishes a one-time RLN signal. The request carries no commitment, leaf, deposit amount or ticket index.
3. **Refund.** Each response adds `C_max − C_actual` to a server-signed accumulator, which the client re-randomizes before every request.
4. **Withdrawal.** The user proves a withdrawal of `D + R − n · C_max`. The contract pays it after a three-day challenge window, without the server's involvement.
5. **Slashing.** Reusing a ticket index reveals the secret key, and anyone holding it may slash the note.

The secret key and the accumulator never leave the client. Every key the gateway relies on, except the upstream provider's API key, is derived in the enclave and bound to its attestation. Departures from the paper are recorded in [SETTLEMENT.md](docs/SETTLEMENT.md).

## Install

```
pnpm install
pnpm circuits:fetch
forge install
cp .env.template .env
```

## Test

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

## Run

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

## Deploy

In production, Longjing runs on [dstack](https://github.com/Dstack-TEE/dstack) and derives every key inside the enclave. The trusted setup, contract, enclave and governance are deployed in a fixed order, described in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Withdraw without the service

If the gateway and its operator are gone, you exit with the chain alone. You need:

- your note file, the JSON that `pnpm prove note` or a page wrote: it holds the secret key and the accumulator opening;
- the `LongjingCredits` address;
- an RPC URL and the key of an account that pays the gas, or a browser wallet;
- `withdraw.html`, attached to each release from the next one on, or `build/browser/withdraw.html` after `pnpm build:browser`; check a downloaded copy against the release's `SHA256SUMS`;
- `settlement.wasm` and `settlement.zkey` from the [`circuits-v2`](https://github.com/w3hc/longjing/releases/tag/circuits-v2) release or any mirror. The page checks them against the sha256 it pins, which match [`circuits/artifacts.json`](circuits/artifacts.json), and refuses any other file.

Open `withdraw.html` from disk: it needs no build, no server and no other host. Load the note and read it, pick the two circuit files, save the key of the new address the page made for the payout, and press "Prove and initiate". The page proves the exit in your browser and sends `initiateWithdrawal`, which pays `D + R − n · C_max` once the 3-day challenge window ends. Then open the page again, with the commitment (or the note) and the contract address, and press "Finalize": anyone can send `finalizeWithdrawal`, also while the contract is paused. The page keeps nothing in browser storage: the contract holds the exit.

`n` is the number of requests the note made, filled from the note. Add one if a request's response was lost, since an exit that claims fewer requests than were served is slashed during the window.

The payout goes to a new address by default, since `initiateWithdrawal` publishes the recipient next to the note's commitment, and an address that has already sent or received funds links the exit to that history. An address that has never sent a transaction also keeps its public key behind a hash, so the payout isn't exposed if ECDSA weakens. The recipient never signs: the proof binds it, and the account that pays the gas sends both transactions. You can enter an address of your own instead, and the page warns when it has sent a transaction or holds funds.

Reading your note asks the RPC for `getNote(commitment)`, which tells the RPC provider which note your IP address cares about. Use a node of your own, with CORS enabled for the page, or an RPC reached through Tor. The exit itself is public: `initiateWithdrawal` names the commitment and the recipient.

## Threat model

Longjing is intended to protect the link between a deposit and its requests, the link between two requests, and the user's balance.

It does not protect:

- the content of a request from the upstream provider;
- the user's network identity, unless the client reaches the gateway's onion service through Tor with a circuit per request ([INTEGRATION_GUIDELINES.md](docs/INTEGRATION_GUIDELINES.md));
- request timing and size, which may still correlate requests ([#189](https://github.com/w3hc/longjing/issues/189));
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
- [QUICK_START.md](docs/QUICK_START.md) — add your own upstream provider in 10 steps
- [LOCAL_SETUP.md](docs/LOCAL_SETUP.md) — local development setup
- [API_REFERENCE.md](docs/API_REFERENCE.md) — endpoints, request formats and client-side proving
- [INTEGRATION_GUIDELINES.md](docs/INTEGRATION_GUIDELINES.md) — calling the API from an app, an agent or Tor Browser without linking requests

**Zero-knowledge**
- [ZK.md](docs/ZK.md) — circuits and proofs
- [TRUSTED_SETUP_CEREMONY.md](docs/TRUSTED_SETUP_CEREMONY.md) — ceremony details and process
- [TESTING_GUIDE.md](docs/TESTING_GUIDE.md) — testing procedures

**Architecture**
- [PROVIDERS.md](docs/PROVIDERS.md) — provider abstraction design
- [SQLITE3.md](docs/SQLITE3.md) — database and privacy design
- [MLKEM.md](docs/MLKEM.md) — ML-KEM in the TLS key exchange, and why there is no application-layer encryption

**Deployment**
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — production deployment, in order
- [TEE_SETUP.md](docs/TEE_SETUP.md) — production TEE deployment
- [ATTESTATION.md](docs/ATTESTATION.md) — verifying the attestation and the keys it binds
- [KEY_DERIVATION.md](docs/KEY_DERIVATION.md) — enclave-derived keys and the key manifest
- [ONION_SERVICE.md](docs/ONION_SERVICE.md) — the attested onion service run inside the enclave
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