# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `docker-compose.yml` pins the `v0.3.0` image, `ghcr.io/w3hc/longjing@sha256:d7beb7b690a6a2841530ceb26d18095005af1dd65fa34cc473971657bb096577`, in place of the placeholder ([#112](https://github.com/w3hc/longjing/issues/112)).

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
