# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Production refuses to start when `LongjingCredits.serverPublicKey` isn't the key the refund signer signs with, and logs a warning when `serverAddress` isn't the transaction signer ([#161](https://github.com/w3hc/longjing/issues/161)).
- Note settlement in `LongjingCredits` (LJ-01, LJ-02): `deposit(c)` computes the leaf `Poseidon(c, D)` from `msg.value`, `initiateWithdrawal` verifies a settlement proof paying `D + R − n · C_MAX` and opens a 3-day challenge window, `finalizeWithdrawal` pays the recipient and credits the rest to `operatorBalance`, and `slash(k)` pays a fixed `SLASH_BOUNTY` to whoever holds the revealed key. Pausing never blocks an exit or a slash, and a pending exit can't be claimed as expired. The contract keeps the last 30 roots, removes a closed note's leaf, and accepts every refund key it ever registered, rotated through the timelock ([#168](https://github.com/w3hc/longjing/issues/168)).
- An exit watcher: the server records each `WithdrawalInitiated` nullifier and slashes an exit whose claimed index a request already used ([#169](https://github.com/w3hc/longjing/issues/169)).
- `pnpm prove note | request | receive | withdrawal | slashing`, a client that keeps the secret key and the accumulator in a note file, proves requests and withdrawals, and checks each signed accumulator against the onchain key. An exit needs only the chain and this client ([#169](https://github.com/w3hc/longjing/issues/169), [#119](https://github.com/w3hc/longjing/issues/119)).
- `request.circom` and `settlement.circom`, the circuits of `docs/SETTLEMENT.md`. A request proves a leaf `Poseidon(Poseidon(k), D)`, a genesis or server-signed Pedersen accumulator re-randomized into a fresh public point, solvency against a constant `C_MAX` and the RLN signal at a private index, with no commitment, leaf, deposit or index among its public signals. A settlement proves the payout `D + R − n · C_MAX ≥ 0` for a claimed index count `n` no lower than the accumulator's, with its RLN signal bound to the recipient and no Merkle path. The generators are hashed to Baby Jubjub from public seeds (`src/longjing/accumulator.ts`). ([#167](https://github.com/w3hc/longjing/issues/167)).
- `circuits-v2` release with the `request` and `settlement` artifacts, every `circuits-v1.2` file unchanged, and `SettlementVerifier.sol`. `pnpm check:verifiers` covers both new circuits. Keys come from a single-party phase 2, for testnets only ([#167](https://github.com/w3hc/longjing/issues/167)).
- `docs/SETTLEMENT.md`, the design for settling credits and making requests unlinkable: the deposit amount bound into the leaf, a constant `C_max`, refunds accumulated in a server-signed commitment, withdrawal net of spending after a challenge window, slashing by revealed key with a fixed bounty, and no policy stake. ([#134](https://github.com/w3hc/longjing/issues/134)).
- `pnpm demo --gateway <url> --contract <address> --rpc <url>` runs the demo against an existing deployment instead of Anvil, paying from `DEMO_PRIVATE_KEY` ([#158](https://github.com/w3hc/longjing/issues/158)).
- `pnpm check:verifiers` fails on any pinned verification key where `vk_delta_2` equals `vk_gamma_2`, which would let anyone forge proofs from the public key alone. A fixture under `scripts/testing/fixtures/` shows it failing. Jest now also runs specs under `scripts/` ([#152](https://github.com/w3hc/longjing/issues/152)).

### Removed

- **Breaking:** `withdraw`, `redeemRefund`, `slashDoubleSpend`, `slashPolicyStake`, the policy stake, `setMinStakes`, `getDeposit` and `getAllIdentityCommitments` from `LongjingCredits`, with `WithdrawalVerifier`, `RefundRedemptionVerifier`, `DoubleSpendSlashingVerifier` and `BabyJubJub.sol`. The policy stake goes with LJ-17 ([#168](https://github.com/w3hc/longjing/issues/168)).
- **Breaking:** `POST /longjing/redeem-refund`, `POST /longjing/proofs/slashing` (LJ-19), `ZK_CIRCUIT`, the off-chain Merkle tree, `ProofGenService`, `SlashingProofService`, and the `api_request`, `api_request_local`, `withdrawal`, `refund_redemption` and `double_spend_slashing` circuits ([#169](https://github.com/w3hc/longjing/issues/169)).
- **Breaking:** `policy_violation.circom`, `PolicyViolationVerifier.sol`, `policyVerifier` and `Target.PolicyVerifier`. The circuit only passed its public inputs through, so anyone could prove any `(nullifier, idCommitment)` (LJ-08). `Target.ServerAddress` is now index 3 ([#133](https://github.com/w3hc/longjing/issues/133)).

### Changed

- **Breaking:** requests carry no identifier (LJ-03). `POST /longjing/request` takes `payload`, `nonce`, `nullifier`, `signal`, `proof`, `merkleRoot` and `accumulator`, and drops `maxCost`, `initialDeposit`, `ticketIndex`, `idCommitment` and `idCommitmentExpected`. The signal is `x = Poseidon(SHA-256(payload) mod p, ρ)`. The proof is checked against one of the contract's recent roots and its constant `C_MAX`, and the response returns `refund` and the next accumulator `A' = A_pub + v·G + J` signed by the refund key, instead of `actualCost` and a refund ticket. A request whose worst case exceeds `C_MAX` is refused, a provider error refunds all of `C_MAX` (LJ-12), and a retry of the same signal within 10 minutes gets the same response without a second provider call ([#169](https://github.com/w3hc/longjing/issues/169)).
- **Breaking:** the nullifier store keeps only `(nullifier, x, y)`. On startup it drops the timestamp, payload hash, ticket index and identity commitment columns and the `redeemed_refunds` table, then vacuums the file ([#169](https://github.com/w3hc/longjing/issues/169)).
- **Breaking:** `LongjingCredits` takes `C_MAX` and `SLASH_BOUNTY` in its constructor, keys notes by commitment (`getNote`, `getLeaves`, `isKnownRoot`), and its timelock targets are `SettlementVerifier`, `ServerAddress` and `RefundKey` ([#168](https://github.com/w3hc/longjing/issues/168)).
- `pnpm demo` checks the settlement design: solvency, both unlinkability goals and server-free withdrawal are now verified, with new checks for an understated exit and a closed note ([#169](https://github.com/w3hc/longjing/issues/169)).
- **Breaking:** with `NODE_ENV=production`, contract transactions, slashing included, are signed by a new enclave-derived transaction signer (`GetKey("longjing/tx-signer/v1", "secp256k1")`) instead of the identity key, which now only signs the key manifest. The key manifest gains `txSignerAddress`: fund it for gas and set it as the contract's `serverAddress`, through the timelock on an existing deployment (LJ-15) ([#130](https://github.com/w3hc/longjing/issues/130)).
- **Breaking:** `ANVIL_PRIVATE_KEY` is renamed `SERVER_TX_PRIVATE_KEY`. Production refuses it as key material, even under `ALLOW_KEYS_OUTSIDE_ENCLAVE` ([#130](https://github.com/w3hc/longjing/issues/130)).
- `pnpm demo` runs four actors (Alice, the operator, an observer and an attacker), reports each goal as verified, not met (with its issue) or not checked yet, and exits non-zero only when a goal expected to be verified is not. It drops the check that the proof is for the deposited secret, which passed only because requests publish `idCommitment` (LJ-03). It adds checks that report as not met the unlinkability of requests and refund redemptions, and solvency ([#134](https://github.com/w3hc/longjing/issues/134)). It also adds verified checks: double-spend slashing end to end from a wallet that is not `serverAddress`, a refund that can't be redeemed to another address, and no request body containing a secret key ([#158](https://github.com/w3hc/longjing/issues/158)).

### Fixed

- A second request on a kept-alive connection got a 500: the request sanitizer redefined the socket's non-configurable `remoteAddress` ([#169](https://github.com/w3hc/longjing/issues/169)).

## [0.4.1] - 2026-10-06

### Added

- README badges for CI, NestJS, TypeScript, Solidity, Circom, pnpm, Node.js and the license ([#120](https://github.com/w3hc/longjing/issues/120)).
- **Breaking:** a required `PROFILE` env var, `local` or `prod`, replaces `NODE_ENV` for every security gate. The server refuses to start without it, and `NODE_ENV=production` requires `PROFILE=prod`. See [LOCAL_SETUP.md](docs/LOCAL_SETUP.md#node_env) ([#122](https://github.com/w3hc/longjing/issues/122)).
- `PROFILE=prod` requires `ETHEREUM_RPC_URLS` and `ZK_CONTRACT_ADDRESS`, and refuses `ANVIL_RPC_URL`, `ANVIL_PRIVATE_KEY`, `DSTACK_SIMULATOR_ENDPOINT` and placeholder values: the Anvil keys and addresses, Anvil's first deployment address and `example.*` URLs (LJ-09) ([#122](https://github.com/w3hc/longjing/issues/122)).
- At startup, the server reads the RPC's `eth_chainId`: `PROFILE=local` refuses any chain but Anvil's 31337, `PROFILE=prod` refuses 31337 and an unreachable RPC ([#122](https://github.com/w3hc/longjing/issues/122)).
- `DeployLongjingCredits.s.sol` tests in `contracts/test/DeployLongjingCredits.t.sol` ([#122](https://github.com/w3hc/longjing/issues/122)).
- `pnpm check:verifiers` checks each pinned verification key against its zkey, and each Solidity verifier against that key, IC count included. CI runs it in the proof job (LJ-13) ([#128](https://github.com/w3hc/longjing/issues/128)).
- `test/onchain-proofs.e2e-spec.ts` submits a real withdrawal, refund redemption and double-spend slashing proof to the real contract on Anvil, and checks that a refund can't be redeemed twice (LJ-05) ([#128](https://github.com/w3hc/longjing/issues/128)).
- `api_request_local.circom`, `ApiRequestProof(20, 2)` with about 32K constraints instead of 110K, is the default `ZK_CIRCUIT` for `PROFILE=local`. Production still accepts only `api_request` ([#132](https://github.com/w3hc/longjing/issues/132)).
- Concurrency caps on proof verification and on proving for `POST /longjing/proofs/slashing`, set by `MAX_CONCURRENT_VERIFICATIONS` (default 8) and `MAX_CONCURRENT_PROOFS` (default 2). Work over a cap gets a 503 right away instead of being queued (LJ-07, LJ-19) ([#124](https://github.com/w3hc/longjing/issues/124)).
- Request DTOs check field elements (hex or decimal, bounded length) and cap `proof` and `payload` lengths, so malformed bodies get a 400 before any RPC or Groth16 work (LJ-07) ([#124](https://github.com/w3hc/longjing/issues/124)).
- `SECURITY.md`: how to report a vulnerability privately, which versions get fixes, and what is in scope ([#126](https://github.com/w3hc/longjing/issues/126)).
- `pnpm demo` runs one user from deposit to refund against Anvil, with real proofs and the real server, and prints a checklist of asserted checks: the proof's root matches the chain, a replay is rejected, the refund ticket verifies against the server's key, the balance grows by the refund, and a second redemption reverts. It exits non-zero on any failed check. `docs/TESTING_GUIDE.md` opens with it ([#139](https://github.com/w3hc/longjing/issues/139)).
- `pnpm prove request` builds a request proof on the client from the deposited secret, reading the Merkle path, the root and the deposit from the contract ([#139](https://github.com/w3hc/longjing/issues/139)).
- A Static Analysis workflow runs Slither on `contracts/src/` and circomspect on `circuits/` for every pull request touching either. `pnpm check:slither` and `pnpm check:circomspect` fail on any finding missing from `contracts/slither.baseline.json` or `circuits/circomspect.baseline.json`, and on any baseline entry that no longer matches a finding. Every baselined finding has a written reason ([#131](https://github.com/w3hc/longjing/issues/131)).

### Changed

- `docs/audits/` is gitignored, so audit reports stay local until they are ready to publish ([#120](https://github.com/w3hc/longjing/issues/120)).
- **Breaking:** with `PROFILE=prod`, contract transactions, slashing included, are signed by the enclave-derived identity key instead of `ANVIL_PRIVATE_KEY`, so the identity address needs ETH for gas. Slashing now shares the RPC and signer of `BlockchainService` ([#122](https://github.com/w3hc/longjing/issues/122)).
- **Breaking:** `DeployLongjingCredits.s.sol` reads `PROFILE`. `local` deploys to Anvil only with its defaults; `prod` requires `PRIVATE_KEY`, `SERVER_ADDRESS`, `SERVER_PUBKEY_X` and `SERVER_PUBKEY_Y`, and refuses chain 31337, the Anvil key and address and the dev refund-signer key (LJ-16) ([#122](https://github.com/w3hc/longjing/issues/122)).
- `PROFILE=local` reads only `ANVIL_RPC_URL`, `PROFILE=prod` only `ETHEREUM_RPC_URLS`: neither falls back to the other ([#122](https://github.com/w3hc/longjing/issues/122)).
- `docker-compose.yml` sets `PROFILE=prod` as a literal and passes `ETHEREUM_RPC_URLS` and `ZK_CONTRACT_ADDRESS`; `docker-compose.dev.yml` sets `PROFILE=local` ([#122](https://github.com/w3hc/longjing/issues/122)).
- Circuit artifacts are fetched from the `circuits-v1.1` release: the same circuits and zkeys as `circuits-v1`, with the `refund_redemption`, `withdrawal` and `double_spend_slashing` verification keys re-exported from their zkeys (LJ-13) ([#128](https://github.com/w3hc/longjing/issues/128)).
- `POST /longjing/redeem-refund` requires exactly 8 proof elements and 8 public signals (LJ-11) ([#128](https://github.com/w3hc/longjing/issues/128)).
- E2E suites run one at a time, since they share one Anvil chain and deployer ([#128](https://github.com/w3hc/longjing/issues/128)).
- `LongjingService` defaults to `claude-fable-5-1`, priced at $10 input and $50 output per million tokens, instead of Sonnet 4.6 ([#138](https://github.com/w3hc/longjing/issues/138)).
- **Breaking:** circuit artifacts are fetched from the `circuits-v1.2` release. The `api_request`, `api_request_local`, `withdrawal` and `refund_redemption` keys come from a single-party phase 2 on `ppot_0080_17.ptau`, and `WithdrawalVerifier` and `RefundRedemptionVerifier` embed the new keys, so the contract must be redeployed. Run `pnpm circuits:fetch` again ([#132](https://github.com/w3hc/longjing/issues/132)).
- Claude pricing lives in one table, `src/pricing/claude-pricing.ts`, read by `LongjingService`, the request DTO, `CLAUDE_CONFIG` and `ClaudeProvider`. The provider's supported models are exactly the priced ones, and its rates, cache rates included, come from the requested model (LJ-14) ([#125](https://github.com/w3hc/longjing/issues/125)).
- **Breaking:** `PROFILE` is merged into `NODE_ENV`, which is now required and is one of `development`, `test` or `production`. `development` and `test` are local, `production` is production, and the startup checks are unchanged. Drop `PROFILE` from your env, and deploy with `NODE_ENV=development` or `NODE_ENV=production` ([#139](https://github.com/w3hc/longjing/issues/139)).
- `test/app.e2e-spec.ts` runs the same steps as `pnpm demo`: it deploys the contract before the app starts, proves and redeems with the deposited secret, and checks that a replay and a second redemption fail. The mock refund proof and its catch-all are gone ([#139](https://github.com/w3hc/longjing/issues/139)).
- The container runs as the unprivileged `node` user, which owns only `/app/data` (LJ-22) ([#127](https://github.com/w3hc/longjing/issues/127)).
- `docker-compose.yml` pins the v0.4.0 image ([#127](https://github.com/w3hc/longjing/issues/127)).

### Removed

- `api_credit_proof.circom`, `api_credit_proof_simple.circom`, the unused `ZKProofService`, and `pnpm setup:circuit`, which only set up `api_credit_proof` (LJ-23) ([#132](https://github.com/w3hc/longjing/issues/132)).
- The unused SIWE module, `POST /auth/nonce`, `docs/SIWE.md` and the `siwe` dependency. Its guard protected no route and skipped domain, nonce and time binding (LJ-20) ([#127](https://github.com/w3hc/longjing/issues/127)).

### Fixed

- `BlockchainService` imports the `LongjingCredits` ABI as an array: the namespace import wrapped it in an object, so building the contract failed with `abi is not iterable` and contract interaction was always disabled ([#122](https://github.com/w3hc/longjing/issues/122)).
- **Breaking:** `withdraw`, `redeemRefund`, `slashDoubleSpend` and `slashPolicyViolation` read public signals in the order snarkjs emits them, outputs first. They read inputs first before, so every genuine proof reverted (LJ-05) ([#128](https://github.com/w3hc/longjing/issues/128)).
- `DoubleSpendSlashingVerifier` embeds the key of `double_spend_slashing_final.zkey`, and its assembly reads `calldata` arguments: it held an older setup's key and read `memory` arguments with `calldataload`, so it rejected every proof ([#128](https://github.com/w3hc/longjing/issues/128)).
- The refund relay keeps proof elements as `bigint`: `Number()` lost their precision. `SLASHING_ABI` takes `uint256[5]` for `slashPolicyViolation`, as the contract does (LJ-11) ([#128](https://github.com/w3hc/longjing/issues/128)).
- `generateDoubleSpendProof`, behind `POST /longjing/proofs/slashing`, proves with `double_spend_slashing` instead of the `api_credit_proof_test` circuit (LJ-11) ([#128](https://github.com/w3hc/longjing/issues/128)).
- `LongjingService` model IDs use hyphens (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`): the dotted IDs made every real Claude API request fail with a 404 `not_found_error` ([#138](https://github.com/w3hc/longjing/issues/138)).
- With `PROFILE=prod`, `POST /longjing/request` returns 503 when the onchain Merkle root or slashed status can't be read: both checks were silently skipped, so a client could prove membership in a tree of its own. Roots are compared by value, so a decimal root matches the onchain hex (LJ-09) ([#123](https://github.com/w3hc/longjing/issues/123)).
- `api_request` requires the nullifiers of active refund tickets to be strictly increasing: one ticket could fill all 10 slots and count 10 times toward the balance (LJ-06) ([#132](https://github.com/w3hc/longjing/issues/132)).
- `api_request` verifies refund tickets with `EdDSAPoseidonVerifier`, the variant `RefundSignerService` signs with: it used `EdDSAMiMCVerifier`, so no server-issued refund could count toward solvency. The circuit tests now get their tickets from `RefundSignerService` (LJ-10) ([#132](https://github.com/w3hc/longjing/issues/132)).
- `withdrawal` and `refund_redemption` constrain `recipient` explicitly. The binding relied on snarkjs adding a constraint per public input (LJ-23) ([#132](https://github.com/w3hc/longjing/issues/132)).
- One client can no longer lock out the rest. `ThrottlerMetadataGuard` keyed on `req.ip`, which `RequestSanitizerMiddleware` pins to `0.0.0.0`, so every client shared one bucket of 10 requests per minute. It is removed, without bringing back IP tracking, and `RequestFingerprintThrottler` strips the rate limit headers instead, on 429s too (LJ-07) ([#124](https://github.com/w3hc/longjing/issues/124)).
- `POST /longjing/proofs/slashing` no longer echoes `secretKey` back in `metadata` (LJ-19) ([#124](https://github.com/w3hc/longjing/issues/124)).
- `POST /longjing/request` rejects a `model` with no pricing with a 400: it was forwarded upstream, then billing threw, so the operator paid and no refund was issued (LJ-14) ([#125](https://github.com/w3hc/longjing/issues/125)).
- `POST /longjing/request` rejects a `maxCost` below the worst-case cost, payload bytes plus 32 tokens in and 4096 tokens out, with a 400 before the nullifier is used, and clamps the refund at zero. The server could sign negative refund tickets (LJ-12) ([#125](https://github.com/w3hc/longjing/issues/125)).
- A failed upstream call releases the request's nullifier, so the ticket index can be retried: it was burned with no refund (LJ-12) ([#125](https://github.com/w3hc/longjing/issues/125)).
- `ClaudeProvider` cost estimates divided per-1K rates by a million, so `/longjing/estimate-cost` came out 1000× too low ([#125](https://github.com/w3hc/longjing/issues/125)).
- The README, `OVERVIEW.md`, `ZK.md`, `TEE_SETUP.md` and `TESTING_GUIDE.md` state request unlinkability as a design goal: every request still publishes `idCommitment`, so the operator can link it to its deposit ([#134](https://github.com/w3hc/longjing/issues/134)). The README threat model adds the single-party trusted setup ([#135](https://github.com/w3hc/longjing/issues/135)) ([#126](https://github.com/w3hc/longjing/issues/126)).
- `API_REFERENCE.md` documents the quantized `usage` the server returns (`unitClass`, `unitType`, `costClass`) instead of token counts, says the server's wallet pays the gas on `/longjing/redeem-refund`, and shows a full snarkjs proof in the request example ([#126](https://github.com/w3hc/longjing/issues/126)).
- `SQLITE3.md` shows the real `nullifiers` schema and says the store keeps `id_commitment`, `payload_hash` and `ticket_index` per request ([#126](https://github.com/w3hc/longjing/issues/126)).
- `MLKEM.md` says no endpoint accepts ML-KEM ciphertext yet: the key is derived and attested for future use ([#126](https://github.com/w3hc/longjing/issues/126)).
- `.env.template` no longer mentions `/longjing/proofs/*`: only `/longjing/proofs/slashing` remains ([#126](https://github.com/w3hc/longjing/issues/126)).
- `DOCKER.md` explains why the compose file at a release tag pins the previous release's image, and the follow-up commit that pins the new digest ([#126](https://github.com/w3hc/longjing/issues/126)).
- `TRUSTED_SETUP_CEREMONY.md` states how the `circuits-v1` keys still in use were produced: both phases on one machine ([#126](https://github.com/w3hc/longjing/issues/126)).
- `pnpm.overrides` raise `ws` 8.x to 8.21.0 and `jayson` to 5, which drops `uuid` and `stream-json`, so `pnpm audit --prod` reports only the unpatched `elliptic` advisory (LJ-18) ([#127](https://github.com/w3hc/longjing/issues/127)).
- The cost-estimate cache evicts expired entries and holds at most 1000: its keys come from request contents, so it grew without bound (LJ-21) ([#127](https://github.com/w3hc/longjing/issues/127)).
- `SanitizedLogger.error` emits only framework contexts in production, like `log` and `warn` (LJ-22) ([#127](https://github.com/w3hc/longjing/issues/127)).
- Dev CORS no longer combines `*` with credentials, and helmet drops the deprecated `xssFilter` (LJ-22) ([#127](https://github.com/w3hc/longjing/issues/127)).

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
