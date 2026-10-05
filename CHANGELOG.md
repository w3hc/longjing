# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- README badges for CI, NestJS, TypeScript, Solidity, Circom, pnpm, Node.js and the license ([#120](https://github.com/w3hc/longjing/issues/120)).
- **Breaking:** a required `PROFILE` env var, `local` or `prod`, replaces `NODE_ENV` for every security gate. The server refuses to start without it, and `NODE_ENV=production` requires `PROFILE=prod`. See [LOCAL_SETUP.md](docs/LOCAL_SETUP.md#profiles) ([#122](https://github.com/w3hc/longjing/issues/122)).
- `PROFILE=prod` requires `ETHEREUM_RPC_URLS` and `ZK_CONTRACT_ADDRESS`, and refuses `ANVIL_RPC_URL`, `ANVIL_PRIVATE_KEY`, `DSTACK_SIMULATOR_ENDPOINT` and placeholder values: the Anvil keys and addresses, Anvil's first deployment address and `example.*` URLs (LJ-09) ([#122](https://github.com/w3hc/longjing/issues/122)).
- At startup, the server reads the RPC's `eth_chainId`: `PROFILE=local` refuses any chain but Anvil's 31337, `PROFILE=prod` refuses 31337 and an unreachable RPC ([#122](https://github.com/w3hc/longjing/issues/122)).
- `DeployLongjingCredits.s.sol` tests in `contracts/test/DeployLongjingCredits.t.sol` ([#122](https://github.com/w3hc/longjing/issues/122)).

### Changed

- `docs/audits/` is gitignored, so audit reports stay local until they are ready to publish ([#120](https://github.com/w3hc/longjing/issues/120)).
- **Breaking:** with `PROFILE=prod`, contract transactions, slashing included, are signed by the enclave-derived identity key instead of `ANVIL_PRIVATE_KEY`, so the identity address needs ETH for gas. Slashing now shares the RPC and signer of `BlockchainService` ([#122](https://github.com/w3hc/longjing/issues/122)).
- **Breaking:** `DeployLongjingCredits.s.sol` reads `PROFILE`. `local` deploys to Anvil only with its defaults; `prod` requires `PRIVATE_KEY`, `SERVER_ADDRESS`, `SERVER_PUBKEY_X` and `SERVER_PUBKEY_Y`, and refuses chain 31337, the Anvil key and address and the dev refund-signer key (LJ-16) ([#122](https://github.com/w3hc/longjing/issues/122)).
- `PROFILE=local` reads only `ANVIL_RPC_URL`, `PROFILE=prod` only `ETHEREUM_RPC_URLS`: neither falls back to the other ([#122](https://github.com/w3hc/longjing/issues/122)).
- `docker-compose.yml` sets `PROFILE=prod` as a literal and passes `ETHEREUM_RPC_URLS` and `ZK_CONTRACT_ADDRESS`; `docker-compose.dev.yml` sets `PROFILE=local` ([#122](https://github.com/w3hc/longjing/issues/122)).
- `LongjingService` defaults to `claude-fable-5-1`, priced at $10 input and $50 output per million tokens, instead of Sonnet 4.6 ([#138](https://github.com/w3hc/longjing/issues/138)).

### Fixed

- `BlockchainService` imports the `LongjingCredits` ABI as an array: the namespace import wrapped it in an object, so building the contract failed with `abi is not iterable` and contract interaction was always disabled ([#122](https://github.com/w3hc/longjing/issues/122)).
- `LongjingService` model IDs use hyphens (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`): the dotted IDs made every real Claude API request fail with a 404 `not_found_error` ([#138](https://github.com/w3hc/longjing/issues/138)).

## [0.4.0] - 2026-10-05

### Added

- `pnpm prove refund` generates a refund redemption proof on the client from a refund ticket, so the secret key never leaves the user's machine ([#97](https://github.com/w3hc/longjing/issues/97)).
- `LongjingAppOwner` and `DeployGovernance.s.sol` put a Safe and a 7-day `TimelockController` in front of Longjing's `DstackApp`: a new compose hash can derive the keys only after a public delay, while a guardian can remove one at once. See [GOVERNANCE.md](docs/GOVERNANCE.md) ([#96](https://github.com/w3hc/longjing/issues/96)).
- `pnpm governance:propose-release` checks an `app-compose.json` against `docker-compose.yml` and writes the Safe files that schedule and execute a release: add its compose hash, remove every other one ([#96](https://github.com/w3hc/longjing/issues/96)).
- `pnpm verify:attestation --app <DstackApp>` checks the app's governance on chain: the key manifest names that app, a timelock of at least `--min-delay` owns it, `requireTcbUpToDate` is set and the running compose hash is allowed. It lists every compose hash ever added ([#96](https://github.com/w3hc/longjing/issues/96)).
- `GET /attestation` takes an optional `nonce` (32 bytes, hex) and binds it in `report_data[32..64]`, so a client can tell a quote was generated for its request. A malformed nonce gets a 400. The response also returns the `nonce`, the `keys` that `report_data` commits to and, on dstack, the `eventLog` ([#95](https://github.com/w3hc/longjing/issues/95)).
- `replayRtmrs` and `verifyEventLog` in `src/attestation/tdx-quote.ts` replay RTMR0–3 from the dstack event log, and check that each runtime event, such as `compose-hash`, matches its digest. They are tested against the quote and event log shipped with the dstack simulator ([#95](https://github.com/w3hc/longjing/issues/95)).
- `verifyKeyBinding` in `src/attestation/key-binding.ts` checks an attestation on the client: the `report_data` rebuilt from the returned keys and nonce, the quote, the event log, the TLS certificate and the key manifest. `pnpm verify:attestation` uses it with a fresh nonce ([#95](https://github.com/w3hc/longjing/issues/95)).
- `GET /attestation/manifest` serves an EIP-712 key manifest, signed by an enclave-derived identity key, that binds the app id, the ML-KEM public key, the refund signer's Baby Jubjub public key and the TLS certificate, with the `GetKey` signature chains. See [KEY_DERIVATION.md](docs/KEY_DERIVATION.md) ([#93](https://github.com/w3hc/longjing/issues/93)).

### Changed

- The Swagger UI reports version 0.4.0 instead of 0.1.0 ([#97](https://github.com/w3hc/longjing/issues/97)).
- The docs describe only the endpoints Longjing serves: `/mlkem/pubkey`, `/longjing/chat`, `/longjing/merkle-root` and `POST /hello` are gone from them, `POST /auth/nonce`, `GET /attestation/manifest` and `POST /longjing/proofs/slashing` are documented, the client guide uses the `api_request` circuit inputs, and broken links are fixed ([#97](https://github.com/w3hc/longjing/issues/97)).
- **Breaking:** `report_data[0..32]` is one length-prefixed SHA-256 over the label `longjing-report-v1`, the ML-KEM public key, the identity public key, the refund signer public key and the TLS certificate hash, in place of `SHA-256(ek) || SHA-256(tls_cert_der)`. Clients checking the old layout must rebuild it as in [ATTESTATION.md](docs/ATTESTATION.md#report_data) ([#95](https://github.com/w3hc/longjing/issues/95)).
- The ML-KEM, refund signer, identity and TLS keys are derived inside the enclave with the dstack v1 `GetKey` API (dstack ≥ 0.6.0), through a small client for `/var/run/dstack.sock`. The refund signer key changes, so `LongjingCredits` must be redeployed with the `serverPublicKey` the manifest reports ([#93](https://github.com/w3hc/longjing/issues/93)).
- `docker-compose.yml` pins the `v0.3.0` image, `ghcr.io/w3hc/longjing@sha256:d7beb7b690a6a2841530ceb26d18095005af1dd65fa34cc473971657bb096577`, in place of the placeholder ([#112](https://github.com/w3hc/longjing/issues/112)).

### Removed

- **Breaking:** `POST /longjing/proofs/withdrawal` and `POST /longjing/proofs/refund`, which took the user's `secretKey`. The refund one also signed a mock refund ticket. Withdrawal proving on the client is tracked in [#119](https://github.com/w3hc/longjing/issues/119) ([#97](https://github.com/w3hc/longjing/issues/97)).
- The `pnpm dance` and `pnpm dance:full` scripts, and the stray `test-proof-end-to-end.js` ([#97](https://github.com/w3hc/longjing/issues/97)).
- The `/sealed-storage` ML-KEM key file, the v0 `TappdClient` fallback and the `tappd.sock` mount ([#93](https://github.com/w3hc/longjing/issues/93)).
- The legacy `TeePlatformService`, which shelled out to `snpguest` with files in `/tmp`, faked a Nitro document and fell back to `none`. `SecretsService` attests through `AttestationService`. `docker-compose.yml` no longer passes `TEE_PLATFORM` through ([#94](https://github.com/w3hc/longjing/issues/94)).

### Security

- The server no longer receives the user's secret key to generate proofs, so it can no longer link the requests of a user who proves withdrawals or refunds ([#97](https://github.com/w3hc/longjing/issues/97)).
- `report_data` commits to the refund signer's public key, so a client can check that refund tickets are signed inside the attested enclave ([#95](https://github.com/w3hc/longjing/issues/95)).
- Production refuses to start with `ADMIN_MLKEM_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `TLS_KEY_PATH` or `TLS_CERT_PATH` in env, when dstack key derivation fails, or with `DSTACK_SIMULATOR_ENDPOINT` set. `docker-compose.yml` sets `NODE_ENV=production` as a literal and no longer passes `ADMIN_MLKEM_*` through, so the operator cannot inject keys or switch the checks off. The only opt-out, `ALLOW_KEYS_OUTSIDE_ENCLAVE=true`, must be a compose literal, so using it changes the attested hash ([#93](https://github.com/w3hc/longjing/issues/93)).
- Production attests only through dstack, and refuses to start without the dstack socket, with `DSTACK_SIMULATOR_ENDPOINT` set, or with `TEE_PLATFORM` naming another platform. Before serving, it generates a first quote and checks that it carries the requested `report_data`. Outside production, an unknown `TEE_PLATFORM` throws instead of falling back to the mock ([#94](https://github.com/w3hc/longjing/issues/94)).

## [0.3.0] - 2026-10-04

### Added

- CI now runs `forge fmt --check`, the Prettier format check (`pnpm format:check`) and lint without `--fix` (`pnpm lint:check`), and a `proof` job that installs circom 2.2.2, compiles the circuits and generates and verifies real Groth16 proofs (`pnpm test:proof`). Contract checks moved to their own `contracts` job ([#91](https://github.com/w3hc/longjing/issues/91)).
- Notes in `LongjingCredits` expire `NOTE_TTL` (365 days) after their deposit. Once `noteExpiry()` has passed, the operator can call `claimExpired()` to collect what's left on a note whose user disappeared; until then, the user can still withdraw. Time spent paused doesn't count toward the TTL, and `claimExpired()` is blocked while paused, so the owner can't pause to block exits and then sweep expired notes as in ethereum/zkapi ([#90](https://github.com/w3hc/longjing/issues/90)).
- `ZK_CIRCUIT` selects the circuit the server verifies requests with: `api_request` (the default in production) or `api_credit_proof_test` (the default elsewhere) ([#88](https://github.com/w3hc/longjing/issues/88)).
- `api_request` artifacts (witness generator, proving key, verification key), set up from the public Perpetual Powers of Tau plus a single local contribution; the Docker image now ships the verification key ([#88](https://github.com/w3hc/longjing/issues/88)).
- `pnpm circuits:fetch` downloads the circuit artifacts from the `circuits-v1` release into `circuits/build/` and checks each one against the sha256 pinned in `circuits/artifacts.json`. CI and the Docker build run it ([#89](https://github.com/w3hc/longjing/issues/89)).
- In-enclave TLS termination in production: the key is derived via the dstack KMS or loaded from `TLS_KEY_PATH` / `TLS_CERT_PATH` in enclave storage, and startup fails closed without it unless `ALLOW_EXTERNAL_TLS_TERMINATION=true` ([#81](https://github.com/w3hc/zk-api/issues/81)).
- `verify-attestation` checks the served TLS certificate against attestation `report_data`.

### Security

- `docker-compose.yml` pins the image by digest instead of `julienberanger/longjing:latest` with `pull_policy: always`, so the attested compose hash commits to the code that runs. The Dockerfile pins `node:20-alpine` by digest, installs pnpm from corepack, and drops pnpm's timestamped state files, so the image builds reproducibly; CI builds it twice and fails if the digests differ. A new `release.yml` builds each `v*` tag, pushes it to `ghcr.io/w3hc/longjing`, attests its build provenance and publishes the digest in the release notes. The compose file holds a placeholder until the first release is pinned ([#92](https://github.com/w3hc/longjing/issues/92)).
- The server now verifies requests with the `api_request` circuit in production instead of the test circuit, which checked no Merkle membership, solvency or refund signature. It refuses to start in production if the verification key is missing or the test circuit is configured, instead of logging "Using mock proofs" and running on. `serverPublicKeyX/Y` became public inputs of `api_request.circom`, and the verifier fills them with the server's own refund-signing key, so a prover can no longer sign their own refund tickets ([#88](https://github.com/w3hc/longjing/issues/88)).
- `api_request.circom`, `api_credit_proof.circom` and `api_credit_proof_simple.circom` now range-check every solvency operand with `Num2Bits`: `ticketIndex` to 32 bits, and `maxCost`, `initialDeposit` and refund values to 128 bits. A prover can no longer pick operands whose product wraps around the field and pass the solvency check with too little balance. The proving and verification keys in `circuits/build/` need a new trusted setup ([#87](https://github.com/w3hc/longjing/issues/87)).
- `api_request.circom` now enforces `numRefunds ≤ MAX_REFUNDS`, gates each refund slot with a `LessThan` constraint instead of a ternary on a signal, and forces turned-off slots to a zero value, so a prover can no longer inflate the refund sum. The circuit compiles again under circom 2.2 ([#86](https://github.com/w3hc/longjing/issues/86)).
- The server now rejects requests whose RLN signal `x` is not `SHA-256(payload) mod p`, so a proof and signal can no longer be replayed with another payload, and clients can no longer pick `x` freely. Double-spend detection compares `x` numerically ([#85](https://github.com/w3hc/longjing/issues/85)).
- Verifier and server address changes in `LongjingCredits` now go through a 7-day timelock: the owner calls `proposeChange`, anyone can watch the `ChangeProposed` event, and `executeChange` only succeeds once `ADMIN_DELAY` has elapsed, giving users time to exit first. `cancelChange` drops a queued change ([#84](https://github.com/w3hc/longjing/issues/84)).

### Changed

- Node 24 instead of Node 20 in the Docker images and CI, on the same `node:24-alpine` digest as wulong. Every dependency is bumped to its latest version, aligned with wulong where they share one: NestJS 12, TypeScript 6, `@anthropic-ai/sdk` 0.131, `better-sqlite3` 13. NestJS 12 ships as ESM only, so the test scripts run Jest with `--experimental-vm-modules`. `tsconfig.json` now matches wulong's: `rootDir` replaces the deprecated `baseUrl`, and `types` and `strict: false` are set explicitly since TypeScript 6 changed their defaults ([#110](https://github.com/w3hc/longjing/issues/110)).
- Formatted the contracts with `forge fmt` ([#91](https://github.com/w3hc/longjing/issues/91)).
- Attestation `report_data` is now `SHA-256(mlkem_public_key) || SHA-256(tls_leaf_cert_der)`; the second half was previously zero.
- Renamed the project from zk-api to Longjing ([#83](https://github.com/w3hc/zk-api/issues/83)): package `longjing`, Docker image `julienberanger/longjing`, routes under `/longjing/*`, NestJS module `LongjingModule` in `src/longjing/`, contract `LongjingCredits`, and SQLite file `longjing.db`.
- The development refund-signer seed is now `longjing-refund-signer-dev-key`, with the matching public key in `DeployLongjingCredits.s.sol`; contracts deployed with the old dev key need redeploying.
- `README.md` and `docs/OVERVIEW.md` now position Longjing as an implementation of the original RLN protocol plus a TEE gateway, and compare it with [ethereum/zkapi](https://github.com/ethereum/zkapi).

### Removed

- `circuits/build/` is no longer tracked in Git, which drops 50 files (189 MB) from every new checkout. Only the 16 artifacts the code loads are published; `.r1cs`, `.sym`, intermediate `_0000.zkey` and `.ptau` files are not ([#89](https://github.com/w3hc/longjing/issues/89)).
- `setWithdrawalVerifier`, `setRefundVerifier`, `setSlashingVerifier`, `setPolicyVerifier` and `setServerAddress`, replaced by the timelocked `proposeChange` / `executeChange` flow.

### Fixed

- `src/longjing/contracts/LongjingCredits.abi.json` is regenerated from the contract; it was missing `redeemRefund` and described an outdated `slashDoubleSpend` signature.
