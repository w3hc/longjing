#!/bin/bash
# Add wrapper functions to Groth16 verifiers for easier contract integration

set -e

echo "Adding wrapper functions to verifiers..."

# Function to add wrapper and rename contract
add_wrapper() {
    local file=$1
    local contract_name=$2
    local function_name=$3
    local num_signals=$4

    echo "Processing $file..."

    # Rename contract from Groth16Verifier to specific name
    sed -i '' "s/contract Groth16Verifier {/contract $contract_name {/" "$file"

    # Remove closing brace
    sed -i '' '$ d' "$file"

    # Add wrapper function
    cat >> "$file" << EOF

    /// @notice Verify proof with simplified interface
    /// @param _proof Flat proof array [pA.x, pA.y, pB.x[0], pB.x[1], pB.y[0], pB.y[1], pC.x, pC.y]
    /// @param _publicSignals Public signals array ($num_signals elements)
    /// @return True if the proof is valid
    function $function_name(
        uint256[8] memory _proof,
        uint256[$num_signals] memory _publicSignals
    ) public view returns (bool) {
        uint[2] memory pA = [_proof[0], _proof[1]];
        uint[2][2] memory pB = [[_proof[2], _proof[3]], [_proof[4], _proof[5]]];
        uint[2] memory pC = [_proof[6], _proof[7]];

        return verifyProof(pA, pB, pC, _publicSignals);
    }
}
EOF

    echo "✓ $contract_name wrapper added"
}

# Add wrappers to each verifier
add_wrapper "contracts/src/WithdrawalVerifier.sol" "WithdrawalVerifier" "verifyWithdrawalProof" "6"
add_wrapper "contracts/src/RefundRedemptionVerifier.sol" "RefundRedemptionVerifier" "verifyRefundProof" "5"
add_wrapper "contracts/src/DoubleSpendSlashingVerifier.sol" "DoubleSpendSlashingVerifier" "verifySlashingProof" "4"

echo ""
echo "✅ All verifier wrappers added successfully!"
