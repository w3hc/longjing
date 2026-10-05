# ZK Circuits for API Credits

This directory contains the Circom implementations of Zero-Knowledge circuits for privacy-preserving API access using Rate-Limit Nullifiers (RLN).

## Production Circuits

The system uses four specialized circuits for different operations:

### 1. **API Request Circuit** ([api_request.circom](api_request.circom))

Proves the right to make one API request. The server verifies every request with it in production.

**Proves**:
- Identity commitment exists in Merkle tree (membership proof)
- Every refund ticket carries a valid EdDSA signature from the server
- Solvency: `(ticketIndex + 1) · maxCost ≤ initialDeposit + refunds`
- RLN signal is correctly computed for double-spend prevention

**Parameters**:
- Merkle tree depth: 20, max refund tickets: 10
- Constraints: ~112K
- Public inputs: `merkleRootExpected`, `maxCost`, `signalX`, `serverPublicKeyX`, `serverPublicKeyY` (the verifier fills the key in itself)
- Outputs: `nullifier`, `signalY`, `idCommitment`, `merkleRoot`
- Artifacts: `build/api_request_js/api_request.wasm`, `build/api_request.zkey`, `build/api_request_verification_key.json` (fetch with `pnpm circuits:fetch`, see [docs/ZK.md](../docs/ZK.md#circuit-artifacts) to regenerate)

### 2. **Withdrawal Circuit** ([withdrawal.circom](withdrawal.circom))

Proves the right to withdraw funds without revealing the secret key.

**Proves**:
- Identity commitment exists in Merkle tree (membership proof)
- Secret key generates the claimed identity commitment
- RLN signal is correctly computed for double-spend prevention

**Parameters**:
- Merkle tree depth: 20 (supports ~1M users)
- Constraints: ~5,596
- Public inputs: `signalX`, `merkleRootExpected`, `recipient` (front-running protection)
- Outputs: `nullifier`, `signalY`, `idCommitment`, `merkleRoot`

### 3. **Refund Redemption Circuit** ([refund_redemption.circom](refund_redemption.circom))

Proves the validity of server-signed refund tickets without revealing ticket details.

**Proves**:
- User knows the secret key for identity commitment
- Refund ticket has valid EdDSA signature from server
- Refund nullifier is correctly computed
- Refund value matches claimed amount

**Parameters**:
- Constraints: ~8,355
- Public inputs: `signalX`, `refundValueClaimed`, `serverPublicKeyX`, `serverPublicKeyY`, `recipient` (front-running protection)
- Outputs: `nullifier`, `signalY`, `idCommitment`

### 4. **Double-Spend Slashing Circuit** ([double_spend_slashing.circom](double_spend_slashing.circom))

Proves that a user double-spent a ticket, allowing anyone to extract and verify the secret key for slashing.

**Proves**:
- Two RLN signals exist with same nullifier but different x values
- Secret key was correctly extracted from these signals
- Extracted secret key matches the claimed identity commitment

**Parameters**:
- Constraints: 1,357
- Public inputs: `secretKeyClaimed`, `nullifierExpected`
- Outputs: `idCommitment`, `nullifier`

### Test Circuit (`api_credit_proof_test`)

Simplified test circuit used during development. The server refuses to start with it in production.

## Compilation

### Quick Start

To compile all production circuits and generate Solidity verifiers:

```bash
# From project root
bash scripts/compile-production-circuits.sh
```

This script:
1. Compiles each circuit to R1CS and WASM
2. Generates proving keys using Powers of Tau 15
3. Exports Solidity verifier contracts to `contracts/src/`

### Generated Artifacts

`build/` is not tracked in Git. `pnpm circuits:fetch` downloads the witness generators and keys pinned in [artifacts.json](artifacts.json); compiling produces the full set below.

After compilation, you'll find:

**Withdrawal Circuit**:
- `build/withdrawal.r1cs` - Constraint system (1.5MB)
- `build/withdrawal_js/withdrawal.wasm` - Witness generator
- `build/withdrawal.zkey` - Proving key (5.1MB)
- `../contracts/src/WithdrawalVerifier.sol` - Solidity verifier

**Refund Redemption Circuit**:
- `build/refund_redemption.r1cs` - Constraint system (2.0MB)
- `build/refund_redemption_js/refund_redemption.wasm` - Witness generator
- `build/refund_redemption.zkey` - Proving key (5.6MB)
- `../contracts/src/RefundRedemptionVerifier.sol` - Solidity verifier

**Double-Spend Slashing Circuit**:
- `build/double_spend_slashing.r1cs` - Constraint system (172KB)
- `build/double_spend_slashing_js/double_spend_slashing.wasm` - Witness generator
- `build/double_spend_slashing.zkey` - Proving key (613KB)
- `../contracts/src/DoubleSpendSlashingVerifier.sol` - Solidity verifier

### Manual Compilation

If you need to compile a single circuit:

```bash
# Compile circuit
circom withdrawal.circom --r1cs --wasm --sym -o build/

# Generate proving key
npx snarkjs groth16 setup build/withdrawal.r1cs build/powersOfTau28_hez_final_15.ptau build/withdrawal_0000.zkey

# Export Solidity verifier
npx snarkjs zkey export solidityverifier build/withdrawal.zkey ../contracts/src/WithdrawalVerifier.sol
```

## Input Format

```json
{
  "secretKey": "0x1234...",
  "pathElements": ["0x...", "0x...", ...],
  "pathIndices": [0, 1, 0, ...],
  "refundValues": [1000, 2000, ...],
  "refundSignaturesR8x": ["0x...", "0x...", ...],
  "refundSignaturesR8y": ["0x...", "0x...", ...],
  "refundSignaturesS": ["0x...", "0x...", ...],
  "ticketIndex": 5,
  "numRefunds": 2,
  "merkleRoot": "0x...",
  "maxCost": 10000,
  "initialDeposit": 100000,
  "signalX": "0x...",
  "serverPubKeyX": "0x...",
  "serverPubKeyY": "0x..."
}
```

`numRefunds` must be at most `MAX_REFUNDS`, and every slot from `numRefunds` up must have a `refundValues` entry of `0`, or witness generation fails.

`ticketIndex` must fit in 32 bits, and `maxCost`, `initialDeposit` and every `refundValues` entry must fit in 128 bits, or witness generation fails. These bounds keep both sides of the solvency check below 2^252, so `(ticketIndex + 1) * maxCost` cannot wrap around the field.

## Output Format

```json
{
  "nullifier": "0x...",
  "signalY": "0x...",
  "idCommitment": "0x..."
}
```

## Testing

```bash
# Create test input
echo '{
  "secretKey": "123456",
  "pathElements": [...],
  "pathIndices": [...],
  ...
}' > input.json

# Generate witness
node api_credit_proof_js/generate_witness.js api_credit_proof_js/api_credit_proof.wasm input.json witness.wtns

# Generate proof
snarkjs groth16 prove api_credit_proof_final.zkey witness.wtns proof.json public.json

# Verify proof
snarkjs groth16 verify verification_key.json public.json proof.json
```

## Security Considerations

1. **Trusted Setup**: The Powers of Tau ceremony must be done securely
2. **Circuit Auditing**: The circuit should be audited before mainnet deployment
3. **Nullifier Uniqueness**: Each ticket index must generate a unique nullifier
4. **Signal Extraction**: Double-spending reveals the secret key through RLN math

## Integration

The generated verifier contract (`LongjingVerifier.sol`) should be deployed onchain and called by the `LongjingCredits` contract to verify proofs.

## References

- [Circom Documentation](https://docs.circom.io/)
- [snarkjs Documentation](https://github.com/iden3/snarkjs)
- [Rate-Limit Nullifiers](https://rate-limiting-nullifier.github.io/rln-docs/)
- [ZK API Credits Proposal](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104)
