// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

/**
 * @title BabyJubJub
 * @author Longjing Team
 * @notice Implements Baby Jubjub elliptic curve operations for EdDSA signature verification
 * @dev Based on ERC-2494 and iden3's circomlib implementation
 *
 * Baby Jubjub is a twisted Edwards curve defined over the scalar field of BN128:
 * ax^2 + y^2 = 1 + dx^2y^2
 *
 * Curve parameters:
 * - a = 168700
 * - d = 168696
 * - Prime field: p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 * - Subgroup order: 2736030358979909402780800718157159386076813972158567259200215660948447373041
 *
 * This library provides the cryptographic primitives needed for on-chain EdDSA signature
 * verification, ensuring compatibility with circomlib circuits used in zero-knowledge proofs.
 *
 * References:
 * - EIP-2494: https://eips.ethereum.org/EIPS/eip-2494
 * - circomlib: https://github.com/iden3/circomlib/blob/master/circuits/babyjub.circom
 */
library BabyJubJub {
    /// @notice Prime field size for Baby Jubjub (same as BN128 scalar field)
    uint256 constant PRIME_Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Subgroup order - the number of points in the prime-order subgroup
    uint256 constant SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041;

    /// @notice Generator point X coordinate - base point for scalar multiplication
    uint256 constant GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553;

    /// @notice Generator point Y coordinate - base point for scalar multiplication
    uint256 constant GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203;

    /// @notice Curve coefficient 'd' in twisted Edwards form: ax^2 + y^2 = 1 + dx^2y^2
    uint256 constant D = 168696;

    /// @notice Curve coefficient 'a' in twisted Edwards form: ax^2 + y^2 = 1 + dx^2y^2
    uint256 constant A = 168700;

    /**
     * @notice Add two points on the Baby Jubjub curve using the twisted Edwards addition law
     * @dev Implements the complete addition formula for twisted Edwards curves:
     *      x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)
     *      y3 = (y1*y2 - a*x1*x2) / (1 - d*x1*x2*y1*y2)
     *
     *      All operations are performed modulo PRIME_Q to ensure results stay in the field.
     *      This formula is complete (works for all points including the identity).
     *
     * @param x1 X coordinate of the first point
     * @param y1 Y coordinate of the first point
     * @param x2 X coordinate of the second point
     * @param y2 Y coordinate of the second point
     * @return x3 X coordinate of the resulting point
     * @return y3 Y coordinate of the resulting point
     */
    function pointAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal pure returns (uint256 x3, uint256 y3) {
        uint256 beta = mulmod(x1, y2, PRIME_Q);
        uint256 gamma = mulmod(y1, x2, PRIME_Q);

        // Compute (y1 - A*x1) mod PRIME_Q safely
        uint256 term1 = addmod(y1, PRIME_Q - mulmod(A, x1, PRIME_Q), PRIME_Q);
        // Compute (y2 + A*x2) mod PRIME_Q
        uint256 term2 = addmod(y2, mulmod(A, x2, PRIME_Q), PRIME_Q);
        uint256 delta = mulmod(term1, term2, PRIME_Q);

        uint256 tau = mulmod(beta, gamma, PRIME_Q);
        uint256 dtau = mulmod(D, tau, PRIME_Q);

        // x3 = (beta + gamma) / (1 + d*tau)
        x3 = mulmod(addmod(beta, gamma, PRIME_Q), invmod(addmod(1, dtau, PRIME_Q), PRIME_Q), PRIME_Q);

        // y3 = (delta + A*beta - A*gamma) / (1 - d*tau)
        // = (delta + A*(beta - gamma)) / (1 - d*tau)
        uint256 betaMinusGamma = addmod(beta, PRIME_Q - gamma, PRIME_Q);
        uint256 numerator = addmod(delta, mulmod(A, betaMinusGamma, PRIME_Q), PRIME_Q);
        uint256 denominator = addmod(1, PRIME_Q - dtau, PRIME_Q); // 1 - dtau

        y3 = mulmod(numerator, invmod(denominator, PRIME_Q), PRIME_Q);
    }

    /**
     * @notice Multiply a point on the Baby Jubjub curve by a scalar
     * @dev Implements the double-and-add algorithm with optimizations:
     *      - Skips leading zero bits to reduce iterations
     *      - Processes scalar from most significant to least significant bit
     *      - Returns point at infinity (0, 1) for scalar = 0
     *
     *      The algorithm works by:
     *      1. Finding the highest set bit in the scalar
     *      2. Iterating through each bit from high to low
     *      3. Doubling the accumulator for each bit
     *      4. Adding the base point when the bit is 1
     *
     *      This is the standard method for efficient scalar multiplication in ECC.
     *
     * @param x X coordinate of the base point to multiply
     * @param y Y coordinate of the base point to multiply
     * @param scalar The scalar value to multiply the point by
     * @return rx X coordinate of the resulting point (scalar * P)
     * @return ry Y coordinate of the resulting point (scalar * P)
     */
    function pointMul(uint256 x, uint256 y, uint256 scalar) internal pure returns (uint256 rx, uint256 ry) {
        // Return point at infinity for scalar = 0
        if (scalar == 0) {
            return (0, 1);
        }

        // Find the highest set bit to avoid unnecessary iterations
        uint256 px = x;
        uint256 py = y;

        // Initialize result with the base point (since we know scalar > 0)
        rx = 0;
        ry = 1;
        bool started = false;

        // Only iterate through significant bits (big-endian)
        for (uint256 i = 0; i < 256; i++) {
            if (!started) {
                // Skip leading zeros
                if ((scalar >> (255 - i)) & 1 == 1) {
                    started = true;
                    rx = px;
                    ry = py;
                }
                continue;
            }

            // Double the accumulator
            (rx, ry) = pointAdd(rx, ry, rx, ry);

            // Add base point if bit is set
            if ((scalar >> (255 - i)) & 1 == 1) {
                (rx, ry) = pointAdd(rx, ry, px, py);
            }
        }
    }

    /**
     * @notice Compute the modular multiplicative inverse of a number
     * @dev Uses Fermat's Little Theorem: for prime p and a ≠ 0 mod p,
     *      a^(p-1) ≡ 1 (mod p), therefore a^(-1) ≡ a^(p-2) (mod p)
     *
     *      This is more efficient than the extended Euclidean algorithm for prime moduli.
     *
     * @param a The number to find the inverse of (must be non-zero mod p)
     * @param p The prime modulus
     * @return result The modular inverse of a, such that (a * result) mod p = 1
     */
    function invmod(uint256 a, uint256 p) internal pure returns (uint256) {
        return expmod(a, p - 2, p);
    }

    /**
     * @notice Compute modular exponentiation: (base^exponent) mod modulus
     * @dev Implements the binary exponentiation algorithm (square-and-multiply):
     *      - Processes exponent bits from least significant to most significant
     *      - Squares the base for each bit position
     *      - Multiplies result by base when bit is 1
     *
     *      This algorithm has O(log n) complexity instead of O(n) for naive exponentiation.
     *
     * @param base The base value to exponentiate
     * @param exponent The exponent to raise the base to
     * @param modulus The modulus to reduce by after each operation
     * @return result The result of (base^exponent) mod modulus
     */
    function expmod(uint256 base, uint256 exponent, uint256 modulus) internal pure returns (uint256) {
        uint256 result = 1;
        base = base % modulus;
        while (exponent > 0) {
            if (exponent % 2 == 1) {
                result = mulmod(result, base, modulus);
            }
            exponent = exponent >> 1;
            base = mulmod(base, base, modulus);
        }
        return result;
    }

    /**
     * @notice Verify that a point lies on the Baby Jubjub curve
     * @dev Checks the twisted Edwards curve equation: ax^2 + y^2 = 1 + dx^2y^2
     *
     *      A point is valid if and only if its coordinates satisfy this equation.
     *      This check is essential for validating EdDSA public keys and preventing
     *      attacks using invalid curve points.
     *
     * @param x The X coordinate of the point to verify
     * @param y The Y coordinate of the point to verify
     * @return valid True if the point satisfies the curve equation, false otherwise
     */
    function isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        uint256 x2 = mulmod(x, x, PRIME_Q);
        uint256 y2 = mulmod(y, y, PRIME_Q);
        uint256 lhs = addmod(mulmod(A, x2, PRIME_Q), y2, PRIME_Q);
        uint256 rhs = addmod(1, mulmod(mulmod(D, x2, PRIME_Q), y2, PRIME_Q), PRIME_Q);
        return lhs == rhs;
    }
}
