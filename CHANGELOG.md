# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- In-enclave TLS termination in production: the key is derived via the dstack KMS or loaded from `TLS_KEY_PATH` / `TLS_CERT_PATH` in enclave storage, and startup fails closed without it unless `ALLOW_EXTERNAL_TLS_TERMINATION=true` ([#81](https://github.com/w3hc/zk-api/issues/81)).
- `verify-attestation` checks the served TLS certificate against attestation `report_data`.

### Security

- Verifier and server address changes in `LongjingCredits` now go through a 7-day timelock: the owner calls `proposeChange`, anyone can watch the `ChangeProposed` event, and `executeChange` only succeeds once `ADMIN_DELAY` has elapsed, giving users time to exit first. `cancelChange` drops a queued change ([#84](https://github.com/w3hc/longjing/issues/84)).

### Changed

- Attestation `report_data` is now `SHA-256(mlkem_public_key) || SHA-256(tls_leaf_cert_der)`; the second half was previously zero.
- Renamed the project from zk-api to Longjing ([#83](https://github.com/w3hc/zk-api/issues/83)): package `longjing`, Docker image `julienberanger/longjing`, routes under `/longjing/*`, NestJS module `LongjingModule` in `src/longjing/`, contract `LongjingCredits`, and SQLite file `longjing.db`.
- The development refund-signer seed is now `longjing-refund-signer-dev-key`, with the matching public key in `DeployLongjingCredits.s.sol`; contracts deployed with the old dev key need redeploying.
- `README.md` and `docs/OVERVIEW.md` now position Longjing as an implementation of the original RLN protocol plus a TEE gateway, and compare it with [ethereum/zkapi](https://github.com/ethereum/zkapi).

### Removed

- `setWithdrawalVerifier`, `setRefundVerifier`, `setSlashingVerifier`, `setPolicyVerifier` and `setServerAddress`, replaced by the timelocked `proposeChange` / `executeChange` flow.

### Fixed

- `src/longjing/contracts/LongjingCredits.abi.json` is regenerated from the contract; it was missing `redeemRefund` and described an outdated `slashDoubleSpend` signature.
