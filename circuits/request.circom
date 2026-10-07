pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/comparators.circom";
include "templates/accumulator.circom";
include "templates/merkle_tree.circom";
include "templates/rln.circom";

/**
 * Request circuit from docs/SETTLEMENT.md
 *
 * For request i of a note with secret key k and deposit D, proves:
 * 1. leaf = Poseidon(Poseidon(k), D) is in the tree under the public root
 * 2. the accumulator A is genesis (with i = 0), or signed by the server
 * 3. A opens to (R, i, Poseidon(k), s)
 * 4. A_pub = A + s'·H
 * 5. solvency: (i + 1) · C_MAX ≤ D + R
 * 6. the RLN signal at index i
 *
 * Public: the root, C_MAX, x, the server key, A_pub, the nullifier and y.
 * The commitment, leaf, D, i and R stay private.
 */
template Request(TREE_DEPTH) {
    // ========== Private Inputs ==========
    signal input secretKey;                       // k
    signal input deposit;                         // D, bound through the leaf
    signal input merklePathElements[TREE_DEPTH];
    signal input merklePathIndices[TREE_DEPTH];
    signal input isGenesis;                       // 1 for the first request
    signal input refunds;                         // R
    signal input index;                           // i, the next ticket index
    signal input blinding;                        // s
    signal input signatureR8x;                    // server signature on A
    signal input signatureR8y;
    signal input signatureS;
    signal input rerandomizer;                    // s'

    // ========== Public Inputs ==========
    signal input merkleRoot;
    signal input maxCost;                         // C_MAX, a constant of the deployment
    signal input signalX;                         // x = Poseidon(H(M), ρ)
    signal input serverPublicKeyX;
    signal input serverPublicKeyY;

    // ========== Public Outputs ==========
    signal output nullifier;
    signal output signalY;
    signal output accumulatorX;                   // A_pub
    signal output accumulatorY;

    // ========== 1. Note membership ==========
    component commitment = Poseidon(1);
    commitment.inputs[0] <== secretKey;

    component leaf = Poseidon(2);
    leaf.inputs[0] <== commitment.out;
    leaf.inputs[1] <== deposit;

    component tree = MerkleTreeChecker(TREE_DEPTH);
    tree.leaf <== leaf.out;
    for (var i = 0; i < TREE_DEPTH; i++) {
        tree.pathElements[i] <== merklePathElements[i];
        tree.pathIndices[i] <== merklePathIndices[i];
    }
    tree.root === merkleRoot;

    // ========== 2-3. Accumulator opening ==========
    // Bounds R below 2^128 and i below 2^32
    component accumulator = SignedAccumulator();
    accumulator.isGenesis <== isGenesis;
    accumulator.refunds <== refunds;
    accumulator.index <== index;
    accumulator.commitment <== commitment.out;
    accumulator.blinding <== blinding;
    accumulator.signatureR8x <== signatureR8x;
    accumulator.signatureR8y <== signatureR8y;
    accumulator.signatureS <== signatureS;
    accumulator.serverPublicKeyX <== serverPublicKeyX;
    accumulator.serverPublicKeyY <== serverPublicKeyY;

    // ========== 4. Re-randomization ==========
    component published = Rerandomize();
    published.in[0] <== accumulator.out[0];
    published.in[1] <== accumulator.out[1];
    published.blinding <== rerandomizer;
    accumulatorX <== published.out[0];
    accumulatorY <== published.out[1];

    // ========== 5. Solvency: (i + 1) · C_MAX ≤ D + R ==========
    // With i < 2^32 and C_MAX, D, R < 2^128, both sides stay below 2^161
    component depositBits = Num2Bits(128);
    depositBits.in <== deposit;

    component maxCostBits = Num2Bits(128);
    maxCostBits.in <== maxCost;

    signal required;
    required <== (index + 1) * maxCost;

    component solvency = LessEqThan(161);
    solvency.in[0] <== required;
    solvency.in[1] <== deposit + refunds;
    solvency.out === 1;

    // ========== 6. RLN signal at index i ==========
    component rln = RlnSignal();
    rln.secretKey <== secretKey;
    rln.index <== index;
    rln.signalX <== signalX;
    nullifier <== rln.nullifier;
    signalY <== rln.signalY;
}

component main {public [merkleRoot, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]} = Request(20);
