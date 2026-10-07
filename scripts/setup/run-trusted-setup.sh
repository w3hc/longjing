#!/bin/bash
set -e

echo "🔐 Starting Trusted Setup Ceremony for Production Circuits"
echo ""

# Create build directory if it doesn't exist
mkdir -p circuits/build

# Circuit constraints:
# - Request: ~37K constraints (needs 2^16 = 65,536)
# - Settlement: ~22K constraints (needs 2^15 = 32,768)

# We'll use 2^16 to handle the largest circuit
POWER=16
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

setup_circuit() {
    local name=$1
    echo ""
    echo "  ${name}"
    if [ -f "circuits/build/${name}.zkey" ]; then
        echo "✓ ${name} already set up"
        return
    fi
    npx snarkjs groth16 setup \
        circuits/build/${name}.r1cs \
        ${PTAU_FILE} \
        circuits/build/${name}_0000.zkey \
        > /dev/null
    npx snarkjs zkey contribute \
        circuits/build/${name}_0000.zkey \
        circuits/build/${name}.zkey \
        --name="Production contribution" \
        -e="$(openssl rand -base64 64)" \
        > /dev/null
    npx snarkjs zkey export verificationkey \
        circuits/build/${name}.zkey \
        circuits/build/${name}_verification_key.json
    rm -f circuits/build/${name}_0000.zkey
    echo "✓ ${name} set up"
}

setup_circuit request
setup_circuit settlement

echo ""
echo "🎉 Trusted Setup Ceremony Complete!"
echo ""
echo "Generated files:"
echo "  - circuits/build/pot${POWER}_final.ptau (Powers of Tau)"
echo "  - circuits/build/request.zkey"
echo "  - circuits/build/request_verification_key.json"
echo "  - circuits/build/settlement.zkey"
echo "  - circuits/build/settlement_verification_key.json"
echo ""
echo "⚠️  SECURITY NOTE:"
echo "This is a development ceremony with 2 contributions."
echo "For production deployment, run a multi-party ceremony with 50+ participants."
echo ""
