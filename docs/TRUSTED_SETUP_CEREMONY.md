# Trusted Setup Ceremony

## Overview

A trusted setup ceremony is a critical cryptographic process required for certain zero-knowledge proof systems, particularly those using zk-SNARKs with pairing-based cryptography. This ceremony generates public parameters (Common Reference String or CRS) that are used for proof generation and verification.

## Purpose

The trusted setup ceremony produces:
- **Proving Key**: Used by provers to generate zero-knowledge proofs
- **Verification Key**: Used by verifiers to validate proofs

These keys are derived from secret random values (toxic waste) that must be destroyed after the ceremony to ensure system security.

## Security Requirements

### Toxic Waste
The ceremony involves generating random values (τ, α, β, γ, δ) that must be:
- Generated with high entropy
- Used only once during parameter generation
- Permanently destroyed after use
- Never reconstructed or recovered

### Multi-Party Computation (MPC)
To enhance security, ceremonies typically use MPC where:
- Multiple participants contribute randomness
- Only one honest participant is needed for security
- Each participant adds their contribution sequentially
- Previous contributions are combined with new randomness

## Ceremony Types

### Powers of Tau
A universal ceremony that can be reused across multiple circuits:
- Generates parameters for a maximum circuit size
- Independent of specific circuit logic
- Can be performed once and shared
- More efficient for multiple applications

### Circuit-Specific Setup
Parameters generated for a specific circuit:
- Tied to the exact circuit implementation
- Must be regenerated if circuit changes
- Smaller parameter size
- Required for final deployment

## Process Workflow

### 1. Initialization
```
- Define circuit constraints
- Determine parameter size requirements
- Select ceremony coordinator
- Recruit participants
```

### 2. Contribution Phase
```
For each participant:
  1. Download previous parameters
  2. Generate random entropy
  3. Compute new parameters
  4. Upload contribution
  5. Destroy random values
  6. Provide attestation
```

### 3. Verification Phase
```
- Verify each contribution is valid
- Check cryptographic relationships
- Confirm randomness was added
- Validate participant attestations
```

### 4. Finalization
```
- Generate final proving/verification keys
- Publish parameters publicly
- Create ceremony transcript
- Archive attestations
```

## Implementation Considerations

### For Circuit Developers
- Use established ceremony tools (snarkjs, phase2-bn254)
- Consider using existing universal ceremonies
- Plan for ceremony before mainnet deployment
- Budget sufficient time (weeks to months)

### Security Best Practices
- Use hardware security modules (HSMs) when possible
- Perform ceremony on air-gapped machines
- Use multiple sources of entropy
- Document all steps and participants
- Enable community verification

### Transparency
- Make ceremony transcripts public
- Allow independent verification of contributions
- Document participant identities and attestations
- Enable anyone to verify the final parameters

## Tools and Libraries

### snarkjs
```bash
# Phase 1: Powers of Tau
snarkjs powersoftau new bn128 12 pot12_0000.ptau
snarkjs powersoftau contribute pot12_0000.ptau pot12_0001.ptau

# Phase 2: Circuit-specific
snarkjs powersoftau prepare phase2 pot12_final.ptau pot12_final.ptau
snarkjs groth16 setup circuit.r1cs pot12_final.ptau circuit_0000.zkey
snarkjs zkey contribute circuit_0000.zkey circuit_0001.zkey
snarkjs zkey export verificationkey circuit_final.zkey verification_key.json
```

### Circom Ecosystem
- **circom**: Circuit compiler
- **snarkjs**: Ceremony execution and proof generation
- **phase2-bn254**: Distributed ceremony coordination

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Single compromised participant | None (if others honest) | Use many participants |
| Parameter tampering | Invalid proofs | Cryptographic verification |
| Toxic waste retention | System compromise | Secure destruction process |
| Circuit changes | Parameters invalid | Version control and regeneration |

## Attestation Example

Participants typically provide signed attestations:

```
I, [Name], participated in the trusted setup ceremony on [Date].

Contribution hash: 0x[hash]
Random beacon: [beacon_value]

I certify that:
- I generated random entropy using [method]
- I destroyed all random values after computation
- I performed the ceremony on [environment]
- I did not retain any toxic waste

Signature: [digital_signature]
```

## Alternatives

### Transparent SNARKs (No Trusted Setup)
- **STARKs**: Uses hash functions, no setup needed
- **Bulletproofs**: No setup, but larger proofs
- **PLONK with Universal Setup**: Single ceremony for all circuits

### Trade-offs
- Trusted setup systems often have smaller proofs
- Setup-free systems may have higher verification costs
- Universal setups reduce ceremony burden

## References

- [Zcash Powers of Tau](https://zfnd.org/conclusion-of-the-powers-of-tau-ceremony/)
- [snarkjs Documentation](https://github.com/iden3/snarkjs)
- [Vitalik's Introduction to zk-SNARKs](https://vitalik.ca/general/2021/01/26/snarks.html)
- [Phase 2 Ceremony Guide](https://github.com/kobigurk/phase2-bn254)
- [Privacy Pools on L2BEAT's ZK catalog](https://l2beat.com/zk-catalog/privacy-pools)
- [p0tion](https://github.com/privacy-ethereum/p0tion) and its [retrospective](https://pse.dev/blog/retrospective-trusted-setups-and-p0tion-project)

## For This Project

### Current Implementation Status: single-party setup

The `request` and `settlement` artifacts of the [`circuits-v2` release](https://github.com/w3hc/longjing/releases/tag/circuits-v2) use the public [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) file `ppot_0080_17.ptau` (sha256 `f807e065fde53f72f4bf4d57140fab85b26daa6cc95bdfec7cce93622b3a367c`) for phase 1. Phase 2 is one contribution by the maintainer, with `openssl rand` entropy.

The sha256 pins in [artifacts.json](../circuits/artifacts.json) guarantee that everyone fetches the same files. They say nothing about whether the setup secrets were destroyed.

A zkey with no phase 2 contribution keeps δ = γ, and then anyone can forge proofs from the verification key alone. Two `circuits-v1` zkeys had this flaw. `pnpm check:verifiers` fails on any pinned key where `vk_delta_2` equals `vk_gamma_2`.

**Current Status:**
- ⚠️ **NOT secure for production**: one phase 2 participant, who could forge request proofs and withdrawals the contract pays out on, if the entropy was kept
- ⚠️ Automated entropy (not airgapped)
- A public multi-party phase 2 ceremony is tracked in [#135](https://github.com/w3hc/longjing/issues/135)

### Ceremony Options

Phase 1 is settled: `ppot_0080_17.ptau` already carries 80 public contributions. What remains is phase 2 for `request` and `settlement`. Their zkeys are about 20 MB and 12 MB, small enough for a contribution to run in a browser in seconds.

1. **Pull-request ceremony.** Each contributor downloads the latest zkey, runs `snarkjs zkey contribute` and opens a pull request with the new zkey and its contribution hash. CI runs `snarkjs zkey verify` against the r1cs and the ptau before the next contribution is accepted. The git history is the transcript. It costs nothing and needs no server, but few people will take part.
2. **Browser ceremony page.** A static page runs snarkjs in the browser, with a small queue so one contributor works on the latest zkey at a time, and storage for the zkeys. Contributors sign in, wait their turn and add entropy. It is the only option that reaches hundreds of contributors.
3. **[p0tion](https://github.com/privacy-ethereum/p0tion) / DefinitelySetup.** PSE's toolkit for phase 2 ceremonies: a web app and a CLI, GitHub sign-in against sybils, and contributions verified on the coordinator's side. It is sunset and in long-term support only, and it needs AWS and Firebase infrastructure, which is a lot for two small circuits.
4. **No phase 2.** PLONK or fflonk on the same ppot file needs only phase 1. This is a redesign rather than a ceremony: client proving, which runs on every API request, gets several times slower, onchain verification costs more gas, and the verifiers and the [fidelity note](./notes/fidelity-zk-api-credits-proposal.md) change.

#### Example: Privacy Pools

[Privacy Pools](https://l2beat.com/zk-catalog/privacy-pools) by 0xbow is a Groth16 (snarkjs) protocol that ran option 2. Phase 1 is the 80th contribution to the Perpetual Powers of Tau, the same file Longjing uses. For phase 2, anyone could open the ceremony page, sign in with GitHub, press "Begin Contribution" and move the mouse to add entropy. Anonymous and identified participants were both welcome. It closed in March 2025 with 514 contributions to the Withdraw circuit and 513 to the Ragequit circuit.

[L2BEAT](https://l2beat.com/zk-catalog/privacy-pools) checked it independently: compile the circuits, download the phase 1 file, check the final zkeys against the compiled circuits, and compare the verification keys exported from them with the ones in the contracts. It rates the setup medium risk, because its green rating needs at least 150 contributions per circuit.

#### Best Practices

- **Freeze the circuits first.** Any change to a circuit discards its phase 2. Run the ceremony only once the circuits are reviewed and final.
- **Make the starting zkey reproducible.** Pin the circom version and the commit, and publish the r1cs hash, so anyone derives the same `_0000.zkey` from the r1cs and the ptau.
- **Verify every contribution** with `snarkjs zkey verify` before accepting the next, and publish each contribution hash, ideally with every intermediate zkey. Ask contributors to post their hash somewhere the coordinator does not control.
- **Let anyone contribute.** One honest contributor is enough, so anonymous contributions are fine. Sign-in only protects the queue. Invite a few known people to contribute from airgapped or unusual setups.
- **Finish with a random beacon.** Apply `snarkjs zkey beacon` with a value nobody can know in advance, such as the hash of an Ethereum block at a height announced beforehand.
- **Publish a verification recipe**: compile at the pinned commit, check the r1cs hash, run `zkey verify` against the ptau, export the verification key and compare it with the deployed verifier. `pnpm check:verifiers` already covers part of it.
- **Keep the transcript independent of any server.** Publish the final zkeys, their hashes and the transcript as a `circuits-v3` release that anyone can mirror. The ceremony page must not be needed afterwards.
- **Plan the rollout around the timelock.** New verifiers reach `LongjingCredits` through the 7-day `ADMIN_DELAY`.

#### Recommendation

Start with the pull-request ceremony: it meets [#135](https://github.com/w3hc/longjing/issues/135)'s criterion of at least 3 independent contributors and leaves a complete public transcript. Before any deployment holding real value, add a browser ceremony page on top of the same transcript to reach the scale of Privacy Pools.

### Production Deployment Roadmap

When implementing the trusted setup ceremony for production:

1. **Development** (Current):
   - ✅ Single-party phase 2 on the Perpetual Powers of Tau
   - ✅ Production refuses to start without the `request` verification key

2. **Testnet** (Next):
   - Pull-request ceremony with at least 3 independent contributors
   - Practice ceremony coordination and verification
   - Publish the transcript as `circuits-v3`

3. **Mainnet** (Production):
   - Browser ceremony page open to anyone, aiming for 150+ contributions per circuit
   - Use production circuits:
     - [request.circom](../circuits/request.circom) - Membership, the signed accumulator, solvency and the RLN signal
     - [settlement.circom](../circuits/settlement.circom) - The withdrawal payout `D + R − n · C_max`, bound to its recipient
   - Multiple rounds of contributions
   - At least 1 airgapped contributor
   - Publish ceremony transcript and final parameter hashes

4. **Maintenance**:
   - Plan for re-ceremonies if circuits are upgraded
   - Version control for all ceremony artifacts
   - Keep historical verification keys for old proofs

### Quick Start (Development)

```bash
# Download the pinned artifacts and check them
pnpm circuits:fetch
pnpm check:verifiers

# Build and run server
pnpm build
pnpm start
```

### Regenerating the Keys

[ZK.md](./ZK.md#circuit-artifacts) gives the commands for `request` and `settlement` on `ppot_0080_17.ptau`, and how to export `SettlementVerifier.sol` and publish a new release. [run-trusted-setup.sh](../scripts/setup/run-trusted-setup.sh) runs both phases on one machine instead, for local experiments only.
