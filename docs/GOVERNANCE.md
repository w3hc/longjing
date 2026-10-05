# Governance

Longjing's keys are derived from the dstack KMS, which releases them only to builds whose compose hash is allowed on Longjing's `DstackApp` contract ([KEY_DERIVATION.md](./KEY_DERIVATION.md#summary)). Whoever can call `addComposeHash` can therefore ship a build that prints the keys. This document sets who that is and how slowly they can act, so that every addition is public for a full delay before it can boot.

- [Roles](#roles)
- [Contracts](#contracts)
- [Setup](#setup)
- [Releases](#releases)
- [Emergency removal](#emergency-removal)
- [Verifying](#verifying)
- [Limits](#limits)

## Roles

| Actor | Can | Delay |
| --- | --- | --- |
| [Safe](https://safe.global/) multisig | Propose, execute and cancel timelock operations | — |
| `TimelockController` | Any call to the `DstackApp` through `LongjingAppOwner`: add or remove compose hashes, upgrade, change settings, hand the app over. Change its own roles and delay, and the guardian | 7 days by default |
| Guardian (the Safe by default) | `removeComposeHash` only | None |

Adding a compose hash always takes the full delay. Removing one can be immediate, since it only ever shrinks the set of builds that can derive the keys.

## Contracts

The Foundry project in [`contracts/`](../contracts) holds:

- [`LongjingAppOwner.sol`](../contracts/src/LongjingAppOwner.sol): the `DstackApp` owner. `execute(bytes)` forwards any call from the timelock, `removeComposeHash` is the guardian's emergency path, `setGuardian` is timelocked, and `acceptOwnership` completes the app's two-step handover.
- [`DeployGovernance.s.sol`](../contracts/script/DeployGovernance.s.sol): deploys an OpenZeppelin `TimelockController` and the `LongjingAppOwner`. The Safe is the only proposer, executor and canceller, and the timelock administers itself, so changing its roles or delay is also delayed.

```bash
cd contracts
forge test --match-path "test/{LongjingAppOwner,DeployGovernance}.t.sol"
```

## Setup

On Base, against the on-chain `DstackKms`, once the `DstackApp` exists and runs the first release:

1. **Deploy** the timelock and owner:
   ```bash
   cd contracts
   DSTACK_APP=0x... SAFE=0x... forge script script/DeployGovernance.s.sol \
     --rpc-url $BASE_RPC_URL --broadcast --verify
   ```
   `GUARDIAN` defaults to the Safe, `TIMELOCK_DELAY` to 604800 seconds. Verify the contracts on Basescan, so anyone can check they are this source.
2. **Tighten** the app while the current owner still can: `setRequireTcbUpToDate(true)`, and remove every compose hash but the running one.
3. **Hand over**: the current owner calls `transferOwnership(<LongjingAppOwner>)`, then anyone calls `LongjingAppOwner.acceptOwnership()`. From then on, only the timelock can add builds.
4. **Check** with `pnpm verify:attestation <url> --app <DstackApp> --from-block <app creation block>`.

## Releases

A release can derive the keys only once its compose hash is added, and each addition removes the previous hashes in the same timelock batch: a withdrawn version would otherwise stay bootable with the same keys ([dstack#1297](https://github.com/Dstack-TEE/dstack/issues/1297)).

1. **Tag** `vX.Y.Z`. [`release.yml`](../.github/workflows/release.yml) builds the image reproducibly and publishes its digest in the release notes ([DOCKER.md](./DOCKER.md#releases)).
2. **Pin** the digest in `docker-compose.yml` and merge it.
3. **Get the `app-compose.json`** Phala Cloud will deploy for that compose file (`phala` CLI or dashboard). Its SHA-256 is the compose hash.
4. **Propose** the batch:
   ```bash
   pnpm governance:propose-release app-compose.json --app <DstackApp> --from-block <n>
   ```
   It checks the file embeds this repository's `docker-compose.yml` with the image pinned by digest, reads the allowed hashes on chain, and writes two [Safe Transaction Builder](https://help.safe.global/en/articles/40841-transaction-builder) files: `release-<hash>-schedule.json` (`scheduleBatch`: add the new hash, remove every other allowed one) and `release-<hash>-execute.json` (`executeBatch`).
5. **Schedule**: import the schedule file in the Safe and collect signatures. Publish the operation id the script prints, with the release, so users can review the source, rebuild the digest and stop using the server during the delay.
6. **Execute** after the delay with the execute file, then deploy ([PHALA_CONFIG.md](./PHALA_CONFIG.md#updating-deployment)).

Until step 6, the new build cannot boot. After it, the previous build cannot either.

## Emergency removal

If a build must stop, for example a vulnerable release, the guardian calls `LongjingAppOwner.removeComposeHash(<hash>)` directly from the Safe. It takes effect on the next boot or key request: running instances keep the keys they already derived until they restart, so stop them too. The guardian cannot add anything back; a fixed release goes through [Releases](#releases).

The timelock can change the guardian with `setGuardian`, or disable the path with `setGuardian(0x0)`.

## Verifying

```bash
pnpm verify:attestation https://<longjing>/attestation \
  --app <DstackApp> --from-block <app creation block> \
  [--rpc <url>] [--min-delay <seconds>]
```

It fails unless:

- the key manifest names that `DstackApp`,
- the app is owned by a `LongjingAppOwner` for that app, whose timelock delay is at least `--min-delay` (7 days by default),
- `requireTcbUpToDate` is set,
- the compose hash in the event log is allowed.

It warns about a pending ownership transfer, a timelock with another admin, no guardian, several allowed hashes and implementation upgrades, and lists every compose hash ever added, with the blocks it was added and removed at. The compose hash is read from the event log once it replays to the quote's RTMRs ([ATTESTATION.md](./ATTESTATION.md#verification)). The script checks the owner's interface, not its bytecode: check it is the verified `LongjingAppOwner` source on Basescan once.

## Limits

- The Safe signers, together, can add any build after the delay. The delay makes this public, not impossible.
- `DstackApp` is upgradeable by its owner, so the timelock can also replace its logic, with the same delay. `Upgraded` events are listed by the verifier.
- Freezing the set of builds for good needs `renounceOwnership()` through the timelock, after which nothing can be added or removed ([dstack#1293](https://github.com/Dstack-TEE/dstack/issues/1293)). Only worth it for a finished, audited version.
- The `DstackKms` owner (Phala) and the KMS itself stay in the trust set.
