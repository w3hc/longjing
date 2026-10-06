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

## For This Project

### Current Implementation Status: single-party setup

The artifacts of the [`circuits-v1.2` release](https://github.com/w3hc/longjing/releases/tag/circuits-v1.2) were produced as follows:

- `api_request`, `api_request_local`, `withdrawal` and `refund_redemption`: phase 1 is the public [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) file `ppot_0080_17.ptau` (sha256 `f807e065fde53f72f4bf4d57140fab85b26daa6cc95bdfec7cce93622b3a367c`). Phase 2 is one contribution by the maintainer, with `openssl rand` entropy, checked with `snarkjs zkey verify`.
- `double_spend_slashing` and `api_credit_proof_test`: unchanged from `circuits-v1`, which was produced by [run-trusted-setup.sh](../scripts/setup/run-trusted-setup.sh) on the maintainer's machine. That script generates its own powers of tau (2^15, two contributions with `openssl rand` entropy) and then makes one phase 2 contribution per circuit, so both phases ran on a single machine, with no public transcript. The slashing key is consistent with this: `snarkjs zkey verify` against `ppot_0080_17.ptau` rejects it (`Invalid alpha1`), so its phase 1 is not the public one.

The sha256 pins in [artifacts.json](../circuits/artifacts.json) guarantee that everyone fetches the same files. They say nothing about whether the setup secrets were destroyed.

**Current Status:**
- ⚠️ **NOT secure for production**: one phase 2 participant, who could forge proofs if the entropy was kept
- ⚠️ `double_spend_slashing` also has a single-party phase 1, so its setup is entirely in one party's hands
- ⚠️ Automated entropy (not airgapped)
- A public multi-party phase 2 ceremony is tracked in [#135](https://github.com/w3hc/longjing/issues/135)

### Production Deployment Roadmap

When implementing the trusted setup ceremony for production:

1. **Development** (Current):
   - ✅ Single-party phase 2 on the Perpetual Powers of Tau
   - ✅ `api_request_local` for fast local proving
   - ✅ Production refuses to start without the `api_request` verification key

2. **Testnet** (Next):
   - Small ceremony (3-5 participants) to validate process
   - Use test circuit or simplified production circuit
   - Practice ceremony coordination and verification
   - Document ceremony process

3. **Mainnet** (Production):
   - Organize public ceremony with 50+ participants for maximum security
   - Use production circuits:
     - [api_request.circom](../circuits/api_request.circom) - Request membership, solvency and refund signatures
     - [withdrawal.circom](../circuits/withdrawal.circom) - Merkle tree membership proof
     - [refund_redemption.circom](../circuits/refund_redemption.circom) - EdDSA signature verification
     - [double_spend_slashing.circom](../circuits/double_spend_slashing.circom) - RLN secret key extraction
     - [policy_violation.circom](../circuits/policy_violation.circom) - Policy violation evidence binding
   - Generate larger Powers of Tau (2^16 or higher)
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

### Request Circuit Setup

The server verifies requests with [api_request.circom](../circuits/api_request.circom) (~110K constraints), or [api_request_local.circom](../circuits/api_request_local.circom) (~32K) with `PROFILE=local`. Its committed keys use the public [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) for phase 1 and a single local contribution for phase 2, so they are **NOT secure for mainnet** until a multi-party phase 2 ceremony replaces them.

To regenerate them after changing the circuit:

```bash
cd circuits
circom api_request.circom --r1cs --wasm --sym -o build/
curl -O https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_17.ptau
npx snarkjs groth16 setup build/api_request.r1cs ppot_0080_17.ptau build/api_request_0000.zkey
npx snarkjs zkey contribute build/api_request_0000.zkey build/api_request.zkey --name="Contribution" -e="$(openssl rand -hex 32)"
npx snarkjs zkey export verificationkey build/api_request.zkey build/api_request_verification_key.json
```

Repeat for `api_request_local`, `withdrawal` and `refund_redemption`, then follow [ZK.md](./ZK.md#circuit-artifacts) to export the Solidity verifiers and publish a new release.
