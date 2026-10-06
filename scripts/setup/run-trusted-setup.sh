#!/bin/bash
set -e

echo "🔐 Starting Trusted Setup Ceremony for Production Circuits"
echo ""

# Create build directory if it doesn't exist
mkdir -p circuits/build

# Circuit constraints:
# - Withdrawal: 11,749 constraints (needs 2^15 = 32,768)
# - Refund Redemption: 11,156 constraints (needs 2^15 = 32,768)
# - Double-Spend Slashing: 1,357 constraints (needs 2^12 = 4,096)

# We'll use 2^15 to handle the largest circuits
POWER=15
PTAU_FILE="circuits/build/pot${POWER}_final.ptau"

# Check if Powers of Tau already exists
if [ -f "$PTAU_FILE" ]; then
    echo "✓ Powers of Tau (2^${POWER}) already exists"
else
    echo "📊 Phase 1: Powers of Tau Ceremony (2^${POWER} constraints)"
    echo "  This may take several minutes..."

    # Initialize Powers of Tau
    echo "  - Initializing..."
    npx snarkjs powersoftau new bn128 ${POWER} circuits/build/pot${POWER}_0000.ptau > /dev/null

    # First contribution
    echo "  - Making first contribution..."
    npx snarkjs powersoftau contribute \
        circuits/build/pot${POWER}_0000.ptau \
        circuits/build/pot${POWER}_0001.ptau \
        --name="First contribution" \
        -e="$(openssl rand -base64 64)" \
        > /dev/null

    # Second contribution (for better security)
    echo "  - Making second contribution..."
    npx snarkjs powersoftau contribute \
        circuits/build/pot${POWER}_0001.ptau \
        circuits/build/pot${POWER}_0002.ptau \
        --name="Second contribution" \
        -e="$(openssl rand -base64 64)" \
        > /dev/null

    # Prepare for phase 2
    echo "  - Preparing for Phase 2..."
    npx snarkjs powersoftau prepare phase2 \
        circuits/build/pot${POWER}_0002.ptau \
        ${PTAU_FILE} \
        > /dev/null

    # Cleanup intermediate files
    rm -f circuits/build/pot${POWER}_0000.ptau circuits/build/pot${POWER}_0001.ptau circuits/build/pot${POWER}_0002.ptau

    echo "✓ Phase 1 complete"
fi

echo ""
echo "🔧 Phase 2: Circuit-Specific Setup"

# Withdrawal Circuit
echo ""
echo "1️⃣  Withdrawal Circuit (11,749 constraints)"
if [ ! -f "circuits/build/withdrawal_final.zkey" ]; then
    echo "  - Initial setup..."
    npx snarkjs groth16 setup \
        circuits/build/withdrawal.r1cs \
        ${PTAU_FILE} \
        circuits/build/withdrawal_0000.zkey \
        > /dev/null

    echo "  - Contributing randomness..."
    npx snarkjs zkey contribute \
        circuits/build/withdrawal_0000.zkey \
        circuits/build/withdrawal_final.zkey \
        --name="Production contribution" \
        -e="$(openssl rand -base64 64)" \
        > /dev/null

    echo "  - Exporting verification key..."
    npx snarkjs zkey export verificationkey \
        circuits/build/withdrawal_final.zkey \
        circuits/build/withdrawal_verification_key.json

    # Cleanup
    rm -f circuits/build/withdrawal_0000.zkey

    echo "✓ Withdrawal circuit setup complete"
else
    echo "✓ Withdrawal circuit already set up"
fi

# Refund Redemption Circuit
echo ""
echo "2️⃣  Refund Redemption Circuit (11,156 constraints)"
if [ ! -f "circuits/build/refund_redemption_final.zkey" ]; then
    echo "  - Initial setup..."
    npx snarkjs groth16 setup \
        circuits/build/refund_redemption.r1cs \
        ${PTAU_FILE} \
        circuits/build/refund_redemption_0000.zkey \
        > /dev/null

    echo "  - Contributing randomness..."
    npx snarkjs zkey contribute \
        circuits/build/refund_redemption_0000.zkey \
        circuits/build/refund_redemption_final.zkey \
        --name="Production contribution" \
        -e="$(openssl rand -base64 64)" \
        > /dev/null

    echo "  - Exporting verification key..."
    npx snarkjs zkey export verificationkey \
        circuits/build/refund_redemption_final.zkey \
        circuits/build/refund_redemption_verification_key.json

    # Cleanup
    rm -f circuits/build/refund_redemption_0000.zkey

    echo "✓ Refund redemption circuit setup complete"
else
    echo "✓ Refund redemption circuit already set up"
fi

# Double-Spend Slashing Circuit
echo ""
echo "3️⃣  Double-Spend Slashing Circuit (1,357 constraints)"
if [ ! -f "circuits/build/double_spend_slashing_final.zkey" ]; then
    echo "  - Initial setup..."
    npx snarkjs groth16 setup \
        circuits/build/double_spend_slashing.r1cs \
        ${PTAU_FILE} \
        circuits/build/double_spend_slashing_0000.zkey \
        > /dev/null

    echo "  - Contributing randomness..."
    npx snarkjs zkey contribute \
        circuits/build/double_spend_slashing_0000.zkey \
        circuits/build/double_spend_slashing_final.zkey \
        --name="Production contribution" \
        -e="$(openssl rand -base64 64)" \
        > /dev/null

    echo "  - Exporting verification key..."
    npx snarkjs zkey export verificationkey \
        circuits/build/double_spend_slashing_final.zkey \
        circuits/build/double_spend_slashing_verification_key.json

    # Cleanup
    rm -f circuits/build/double_spend_slashing_0000.zkey

    echo "✓ Double-spend slashing circuit setup complete"
else
    echo "✓ Double-spend slashing circuit already set up"
fi

echo ""
echo "🎉 Trusted Setup Ceremony Complete!"
echo ""
echo "Generated files:"
echo "  - circuits/build/pot${POWER}_final.ptau (Powers of Tau)"
echo "  - circuits/build/withdrawal_final.zkey"
echo "  - circuits/build/withdrawal_verification_key.json"
echo "  - circuits/build/refund_redemption_final.zkey"
echo "  - circuits/build/refund_redemption_verification_key.json"
echo "  - circuits/build/double_spend_slashing_final.zkey"
echo "  - circuits/build/double_spend_slashing_verification_key.json"
echo ""
echo "⚠️  SECURITY NOTE:"
echo "This is a development ceremony with 2 contributions."
echo "For production deployment, run a multi-party ceremony with 50+ participants."
echo ""
