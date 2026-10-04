// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {PoseidonT2} from 'poseidon-solidity/PoseidonT2.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

/**
 * @title PoseidonHasher
 * @author Longjing Team
 * @notice Wrapper library for Poseidon hash functions, ensuring ZK circuit compatibility
 * @dev Uses the poseidon-solidity library which provides optimized Poseidon implementations
 *      that exactly match circomlib's Poseidon circuits.
 *
 * Poseidon is a ZK-friendly hash function designed for efficient computation in arithmetic circuits.
 * It uses algebraic operations over finite fields, making it much more efficient than traditional
 * hash functions like SHA-256 or Keccak when used in zero-knowledge proofs.
 *
 * This library ensures complete compatibility across:
 * - Circuit constraints (circomlib Poseidon in Circom)
 * - On-chain verification (poseidon-solidity in Solidity)
 * - Off-chain computations (circomlibjs in JavaScript/TypeScript)
 *
 * All hash functions operate over the BN128 scalar field (same as Baby Jubjub curve).
 *
 * @custom:security These functions must match the circuit implementations exactly.
 *                   Any deviation will cause proof verification to fail.
 */
library PoseidonHasher {
    /**
     * @notice Hash a single field element using Poseidon
     * @dev Uses PoseidonT2 (t=2, meaning 1 input + 1 capacity element).
     *      The capacity element is fixed, allowing the function to hash a single input.
     *
     * @param input A single uint256 value in the BN128 scalar field to hash
     * @return hash The Poseidon hash output as a uint256 field element
     */
    function hash(uint256 input) internal pure returns (uint256) {
        uint256[1] memory arr = [input];
        return PoseidonT2.hash(arr);
    }

    /**
     * @notice Hash two field elements using Poseidon
     * @dev Uses PoseidonT3 (t=3, meaning 2 inputs + 1 capacity element).
     *      This is the most commonly used Poseidon variant for building Merkle trees
     *      and other cryptographic structures.
     *
     * @param left The first uint256 value in the BN128 scalar field
     * @param right The second uint256 value in the BN128 scalar field
     * @return hash The Poseidon hash output as a uint256 field element
     */
    function hash(uint256 left, uint256 right) internal pure returns (uint256) {
        uint256[2] memory arr = [left, right];
        return PoseidonT3.hash(arr);
    }

    /**
     * @notice Hash a single bytes32 value using Poseidon
     * @dev Convenience function that converts bytes32 to uint256, hashes it with Poseidon,
     *      then converts the result back to bytes32. Useful for maintaining bytes32 types
     *      while using ZK-friendly Poseidon hashing internally.
     *
     * @param input A bytes32 value to hash
     * @return hash The Poseidon hash output as bytes32
     */
    function hashBytes32(bytes32 input) internal pure returns (bytes32) {
        return bytes32(hash(uint256(input)));
    }

    /**
     * @notice Hash two bytes32 values using Poseidon
     * @dev Convenience function that converts both bytes32 inputs to uint256, hashes them
     *      with PoseidonT3, then converts the result back to bytes32. Useful for Merkle tree
     *      implementations using bytes32 node types.
     *
     * @param left The first bytes32 value to hash
     * @param right The second bytes32 value to hash
     * @return hash The Poseidon hash output as bytes32
     */
    function hashBytes32(
        bytes32 left,
        bytes32 right
    ) internal pure returns (bytes32) {
        return bytes32(hash(uint256(left), uint256(right)));
    }

    /**
     * @notice Hash three field elements using Poseidon
     * @dev Uses iterative application of PoseidonT3: Poseidon(Poseidon(a, b), c)
     *      This approach is more efficient than using PoseidonT4 directly, as it reuses
     *      the smaller PoseidonT3 contract, reducing overall bytecode size.
     *
     * @param a The first uint256 value in the BN128 scalar field
     * @param b The second uint256 value in the BN128 scalar field
     * @param c The third uint256 value in the BN128 scalar field
     * @return hash The Poseidon hash output as a uint256 field element
     */
    function hash3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 h = hash(a, b);
        return hash(h, c);
    }

    /**
     * @notice Hash four field elements using Poseidon
     * @dev Uses iterative application of PoseidonT3 to avoid deploying the large PoseidonT5 contract.
     *      Computation chain: Poseidon(Poseidon(Poseidon(a, b), c), d)
     *
     *      This trades slightly higher gas cost for much smaller bytecode size, which is often
     *      preferable for contract deployment.
     *
     * @param a The first uint256 value in the BN128 scalar field
     * @param b The second uint256 value in the BN128 scalar field
     * @param c The third uint256 value in the BN128 scalar field
     * @param d The fourth uint256 value in the BN128 scalar field
     * @return hash The Poseidon hash output as a uint256 field element
     */
    function hash4(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256) {
        uint256 h = hash(a, b);
        h = hash(h, c);
        return hash(h, d);
    }

    /**
     * @notice Hash five field elements using Poseidon
     * @dev Uses iterative application of PoseidonT3 to avoid deploying the large PoseidonT6 contract.
     *      Computation chain: Poseidon(Poseidon(Poseidon(Poseidon(inputs[0], inputs[1]), inputs[2]), inputs[3]), inputs[4])
     *
     *      Takes an array input for convenience when working with multiple values.
     *      This trades slightly higher gas cost for much smaller bytecode size.
     *
     * @param inputs A fixed-size array of 5 uint256 values in the BN128 scalar field
     * @return hash The Poseidon hash output as a uint256 field element
     */
    function hash5(uint256[5] memory inputs) internal pure returns (uint256) {
        // Iteratively hash pairs to avoid large Poseidon contracts
        uint256 h = hash(inputs[0], inputs[1]);
        h = hash(h, inputs[2]);
        h = hash(h, inputs[3]);
        h = hash(h, inputs[4]);
        return h;
    }
}
