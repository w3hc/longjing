# Deployment

## Production deployment

> **No deployment should hold value yet.** The Groth16 keys of the `request` and `settlement` circuits come from a single-party setup, so whoever ran it could forge proofs and drain the contract ([LJ-04](./audits/2026-10-internal-audit.md), [#135](https://github.com/w3hc/longjing/issues/135)). Nothing has been audited since the settlement redesign either: the [internal audit](./audits/2026-10-internal-audit.md) covers v0.4.0. Deploy on a testnet, or on mainnet with amounts you can afford to lose.

The steps depend on each other: the contract's constructor needs keys that exist only once the enclave has booted, and the enclave needs the contract's address before it boots. Once the contracts belong to the timelock, every change waits 7 days, and a `LongjingCredits` change 14. Done out of order, a step means redeploying the contract or waiting through the timelock, so follow them in this order.

0. [Run the trusted setup](#0-run-the-trusted-setup)
1. [Pin the ZK artifacts](#1-pin-the-zk-artifacts)
2. [Pin the image](#2-pin-the-image)
3. [Pick the contract address](#3-pick-the-contract-address)
4. [Boot the enclave](#4-boot-the-enclave)
5. [Read the manifest](#5-read-the-manifest)
6. [Deploy LongjingCredits](#6-deploy-longjingcredits)
7. [Fund the transaction signer](#7-fund-the-transaction-signer)
8. [Hand over to the timelock](#8-hand-over-to-the-timelock)
9. [Check the deployment](#9-check-the-deployment)
10. [Publish](#10-publish)

### 0. Run the trusted setup

A deployment meant to hold value needs `request` and `settlement` keys from a public multi-party phase 2 with a published transcript ([#135](https://github.com/w3hc/longjing/issues/135)). The `circuits-v2` keys come from one contribution, by the maintainer, and are for testnets only ([TRUSTED_SETUP_CEREMONY.md](./TRUSTED_SETUP_CEREMONY.md#for-this-project)).

The ceremony comes first because its keys end up in two places that are slow to change once deployed. The image loads `request.zkey` and its verification key, so a new key means a new release, behind the 7-day timelock. `SettlementVerifier` embeds the settlement verification key, so a new key means a verifier change behind the timelock and `ADMIN_DELAY`, 14 days, and every depositor switching to the new `settlement.zkey`.

### 1. Pin the ZK artifacts

```bash
pnpm circuits:fetch    # checks every file against the sha256 in circuits/artifacts.json
pnpm check:verifiers   # SettlementVerifier.sol embeds the pinned verification key
```

The artifacts come from the [`circuits-v2`](https://github.com/w3hc/longjing/releases/tag/circuits-v2) release, and [`circuits/artifacts.json`](../circuits/artifacts.json) pins their hashes. After a ceremony, `artifacts.json` points at the release holding its keys, `SettlementVerifier.sol` is regenerated from them, and `pnpm check:verifiers` must pass against both. The image checks the same hashes at build time ([DOCKER.md](./DOCKER.md#checking-a-digest)).

A depositor exits with `settlement_js/settlement.wasm` and `settlement.zkey` alone, without the server. Publish both next to the deployment, for example as a mirror of the release, with their sha256 from `artifacts.json`, so that a user can exit from any mirror or a local copy and check what they load. There is no standalone withdrawal page yet ([#157](https://github.com/w3hc/longjing/issues/157)): until there is, the exit is `pnpm prove withdrawal`, from a checkout of this repository ([API_REFERENCE.md](./API_REFERENCE.md#3-withdraw-without-the-server)).

### 2. Pin the image

Tag `vX.Y.Z`. CI builds the image reproducibly and publishes its digest in the release notes. Check the digest, then pin it in `docker-compose.yml` in a follow-up commit: the compose file at a release tag still pins the previous release ([DOCKER.md](./DOCKER.md#releases)).

The digest fixes the compose hash, which the `DstackApp` must allow before the enclave can derive its keys. On a first deployment, the current app owner adds it. Once the timelock owns the app, every release waits 7 days ([GOVERNANCE.md](./GOVERNANCE.md#releases)).

### 3. Pick the contract address

`LongjingCredits` is deployed by one `CREATE` from the deployer account, so its address follows from that account's next nonce:

```bash
cast nonce <deployer> --rpc-url $RPC_URL
cast compute-address <deployer> --nonce <n>
```

Set `ZK_CONTRACT_ADDRESS` to that address in `.env.prod`, and send no other transaction from the deployer until step 6.

### 4. Boot the enclave

Deploy the compose file and `.env.prod` on Phala Cloud ([PHALA_CONFIG.md](./PHALA_CONFIG.md#deploying)). Every key is derived inside the enclave: production refuses to start with key material in env ([KEY_DERIVATION.md](./KEY_DERIVATION.md#production-policy)).

With no contract at `ZK_CONTRACT_ADDRESS` yet, the enclave still boots: it serves `/attestation` and `/attestation/manifest`, answers 503 to every `/longjing` request and to `GET /health/ready`, and retries the contract every 30 s.

### 5. Read the manifest

Verify the attestation first, so you know the keys come from the enclave:

```bash
pnpm verify:attestation https://<gateway>/attestation
curl https://<gateway>/attestation/manifest
```

Take `refundSigner.x`, `refundSigner.y` and `txSignerAddress` from the manifest ([KEY_DERIVATION.md](./KEY_DERIVATION.md#key-manifest)).

### 6. Deploy LongjingCredits

From the deployer of step 3, as its next transaction:

```bash
cd contracts
NODE_ENV=production PRIVATE_KEY=<deployer key> \
SERVER_ADDRESS=<txSignerAddress> SERVER_PUBKEY_X=<refundSigner.x> SERVER_PUBKEY_Y=<refundSigner.y> \
forge script script/DeployLongjingCredits.s.sol:DeployLongjingCredits \
  --rpc-url $RPC_URL --broadcast --verify
```

Check that it landed at `ZK_CONTRACT_ADDRESS` ([contracts/README.md](../contracts/README.md#testnet-and-mainnet)). `C_MAX` and `SLASH_BOUNTY` are constants of the script and immutable in the contract.

Within 30 s, the enclave connects and checks that `serverPublicKey` is the key its refund signer signs with. If it isn't, it logs an error and stays at 503, since every request proof would fail against that key: redeploy with the manifest's values. A `serverAddress` other than `txSignerAddress` is only logged as a warning.

### 7. Fund the transaction signer

Send ETH for gas to `txSignerAddress`. It signs every contract transaction of the enclave, slashing included, and is the contract's `serverAddress`. The identity address only signs the manifest and needs no funds.

### 8. Hand over to the timelock

Do it before taking deposits, and only once steps 6 and 7 are right: from then on, a `LongjingCredits` change waits 14 days and a new release 7.

1. Deploy the timelock and `LongjingAppOwner` for the `DstackApp`, on Base.
2. Tighten the app: `setRequireTcbUpToDate(true)`, and remove every compose hash but the running one.
3. Transfer the `DstackApp` to `LongjingAppOwner`.
4. Hand `LongjingCredits` over to a timelock behind the same Safe, on Ethereum.

Commands and details are in [GOVERNANCE.md](./GOVERNANCE.md#setup).

### 9. Check the deployment

```bash
pnpm verify:attestation https://<gateway>/attestation \
  --app <DstackApp> --from-block <app creation block> --credits <LongjingCredits>
cast call <LongjingCredits> "serverPublicKey()(bytes32,bytes32)" --rpc-url $RPC_URL
cast call <LongjingCredits> "serverAddress()(address)" --rpc-url $RPC_URL
curl https://<gateway>/health/ready
```

- `verify:attestation` passes, including both ownership checks ([GOVERNANCE.md](./GOVERNANCE.md#verifying)).
- `serverPublicKey` is `(refundSigner.x, refundSigner.y)` and `serverAddress` is `txSignerAddress`.
- `GET /health/ready` answers 200.

`pnpm demo` against the deployment exercises a deposit, requests, a slash and an exit from a funded wallet ([TESTING_GUIDE.md](./TESTING_GUIDE.md#against-a-deployment)). It spends real ETH and real provider calls.

### 10. Publish

Publish what a user needs to check the deployment and to exit without it:

- the gateway URL, the `DstackApp` and `LongjingCredits` addresses, and the app's creation block
- the release, its image digest and the compose hash
- the mirrors of `settlement_js/settlement.wasm` and `settlement.zkey`, with their sha256
- the trusted setup transcript, so anyone can check the keys came from it

### Known gap

`docker-compose.yml` doesn't pass `ANTHROPIC_API_KEY`, so a production enclave answers with mock responses. Adding it changes the compose hash, so it ships as a release.
