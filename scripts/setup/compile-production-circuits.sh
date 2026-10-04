#!/bin/bash

# Compile production ZK circuits and generate Solidity verifiers
# This script compiles: withdrawal, refund_redemption, and double_spend_slashing circuits

set -e

echo "=== Compiling Production ZK Circuits ==="
echo ""

# Change to project root
cd "$(dirname "$0")/.."

# Configuration
CIRCUITS_DIR="circuits"
BUILD_DIR="$CIRCUITS_DIR/build"
CONTRACTS_DIR="contracts/src"
PTAU_FILE="$BUILD_DIR/powersOfTau28_hez_final_15.ptau"

# Check if ptau file exists
if [ ! -f "$PTAU_FILE" ]; then
  echo "❌ Powers of Tau file not found: $PTAU_FILE"
  echo "   Please run the trusted setup ceremony first"
  exit 1
fi

# Function to compile a circuit
compile_circuit() {
  local CIRCUIT_NAME=$1
  local CIRCUIT_FILE="$CIRCUITS_DIR/${CIRCUIT_NAME}.circom"
  local VERIFIER_NAME="${2:-$(echo $CIRCUIT_NAME | sed 's/_\([a-z]\)/\U\1/g;s/^./\U&/')Verifier}"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📦 Compiling: $CIRCUIT_NAME"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Step 1: Compile to R1CS and WASM
  echo "Step 1/4: Compiling circuit to R1CS and WASM..."
  circom "$CIRCUIT_FILE" --r1cs --wasm --sym -o "$BUILD_DIR/"

  if [ $? -eq 0 ]; then
    echo "✅ Compilation successful"
  else
    echo "❌ Compilation failed"
    return 1
  fi
  echo ""

  # Get circuit info
  echo "Step 2/4: Analyzing circuit..."
  npx snarkjs r1cs info "$BUILD_DIR/${CIRCUIT_NAME}.r1cs"
  echo ""

  # Step 3: Generate proving key (Groth16 setup)
  echo "Step 3/4: Generating proving key (this may take several minutes)..."
  echo "   Using Powers of Tau: $PTAU_FILE"

  if npx snarkjs groth16 setup \
    "$BUILD_DIR/${CIRCUIT_NAME}.r1cs" \
    "$PTAU_FILE" \
    "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey"; then
    echo "✅ Proving key generated successfully"
  else
    echo "❌ Failed to generate proving key"
    return 1
  fi
  echo ""

  # Optional: Contribute to phase 2 ceremony (for production use)
  # For now, we'll use the _0000.zkey directly as the final key
  echo "⚠️  Note: Using _0000.zkey as final key (for development)"
  echo "   In production, run a Phase 2 trusted setup ceremony"
  cp "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey" "$BUILD_DIR/${CIRCUIT_NAME}.zkey"
  echo ""

  # Step 4: Export Solidity verifier
  echo "Step 4/4: Exporting Solidity verifier contract..."
  npx snarkjs zkey export solidityverifier \
    "$BUILD_DIR/${CIRCUIT_NAME}.zkey" \
    "$CONTRACTS_DIR/${VERIFIER_NAME}.sol"

  if [ $? -eq 0 ]; then
    echo "✅ Solidity verifier exported: $CONTRACTS_DIR/${VERIFIER_NAME}.sol"
  else
    echo "❌ Failed to export Solidity verifier"
    return 1
  fi
  echo ""

  # Generate verification key for reference
  npx snarkjs zkey export verificationkey \
    "$BUILD_DIR/${CIRCUIT_NAME}.zkey" \
    "$BUILD_DIR/${CIRCUIT_NAME}_verification_key.json" > /dev/null 2>&1

  echo "✅ Circuit compilation complete!"
  echo "   • R1CS: $BUILD_DIR/${CIRCUIT_NAME}.r1cs"
  echo "   • WASM: $BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
  echo "   • Proving Key: $BUILD_DIR/${CIRCUIT_NAME}.zkey"
  echo "   • Verifier Contract: $CONTRACTS_DIR/${VERIFIER_NAME}.sol"
  echo ""
}

# Compile all production circuits
echo "Starting compilation of 4 production circuits..."
echo ""

# 1. Withdrawal circuit
compile_circuit "withdrawal" "WithdrawalVerifier"

# 2. Refund redemption circuit
compile_circuit "refund_redemption" "RefundRedemptionVerifier"

# 3. Double-spend slashing circuit
compile_circuit "double_spend_slashing" "DoubleSpendSlashingVerifier"

# 4. Policy violation circuit
compile_circuit "policy_violation" "PolicyViolationVerifier"

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ ALL CIRCUITS COMPILED SUCCESSFULLY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Summary of generated files:"
echo ""
echo "Withdrawal Circuit:"
echo "  • circuits/build/withdrawal.r1cs"
echo "  • circuits/build/withdrawal_js/withdrawal.wasm"
echo "  • circuits/build/withdrawal.zkey"
echo "  • contracts/src/WithdrawalVerifier.sol"
echo ""
echo "Refund Redemption Circuit:"
echo "  • circuits/build/refund_redemption.r1cs"
echo "  • circuits/build/refund_redemption_js/refund_redemption.wasm"
echo "  • circuits/build/refund_redemption.zkey"
echo "  • contracts/src/RefundRedemptionVerifier.sol"
echo ""
echo "Double-Spend Slashing Circuit:"
echo "  • circuits/build/double_spend_slashing.r1cs"
echo "  • circuits/build/double_spend_slashing_js/double_spend_slashing.wasm"
echo "  • circuits/build/double_spend_slashing.zkey"
echo "  • contracts/src/DoubleSpendSlashingVerifier.sol"
echo ""
echo "Policy Violation Circuit:"
echo "  • circuits/build/policy_violation.r1cs"
echo "  • circuits/build/policy_violation_js/policy_violation.wasm"
echo "  • circuits/build/policy_violation.zkey"
echo "  • contracts/src/PolicyViolationVerifier.sol"
echo ""
echo "Next steps:"
echo "  1. Review the generated Solidity verifier contracts"
echo "  2. Update LongjingCredits.sol to use production verifiers"
echo "  3. Run contract tests to verify integration"
echo "  4. Consider running a Phase 2 trusted setup ceremony for production"
echo ""
