# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- In-enclave TLS termination in production: the key is derived via the dstack KMS or loaded from `TLS_KEY_PATH` / `TLS_CERT_PATH` in enclave storage, and startup fails closed without it unless `ALLOW_EXTERNAL_TLS_TERMINATION=true` ([#81](https://github.com/w3hc/zk-api/issues/81)).
- `verify-attestation` checks the served TLS certificate against attestation `report_data`.

### Changed

- Attestation `report_data` is now `SHA-256(mlkem_public_key) || SHA-256(tls_leaf_cert_der)`; the second half was previously zero.
