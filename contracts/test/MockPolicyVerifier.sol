// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

/**
 * Mock PolicyViolationVerifier for testing
 * Accepts any non-zero proof to allow testing without real ZK proofs
 */
contract MockPolicyVerifier {
    /**
     * Mock verify function - accepts any non-zero proof
     * @param proof The ZK proof (8 elements)
     * @param publicSignals Public signals [nullifierExpected (input), idCommitmentExpected (input), evidenceHash (output), nullifier (output), idCommitment (output)]
     * @return bool True if the proof is valid (non-zero first element)
     */
    function verifyPolicyProof(uint256[8] calldata proof, uint256[5] calldata publicSignals)
        public
        pure
        returns (bool)
    {
        // Accept any non-zero proof for testing
        return proof[0] != 0 && publicSignals.length == 5;
    }
}
