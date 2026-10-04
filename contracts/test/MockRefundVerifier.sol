// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

/**
 * @title MockRefundVerifier
 * @notice Mock verifier for testing refund proof verification
 * @dev Returns true for valid mock proofs, false for invalid ones
 */
contract MockRefundVerifier {
    /**
     * @notice Verify a refund redemption proof
     * @param proof The Groth16 proof components [pA, pB, pC]
     * @return bool True if the proof is valid (non-zero first element)
     */
    function verifyRefundProof(
        uint256[8] calldata proof,
        uint256[8] calldata /* publicSignals */
    )
        external
        pure
        returns (bool)
    {
        // Simple mock: valid if first proof element is non-zero
        return proof[0] != 0;
    }
}
