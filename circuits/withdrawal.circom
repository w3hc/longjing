pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

/**
 * Merkle Tree Membership Proof
 * Proves that a leaf exists in a Merkle tree with given root
 */
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    signal output root;

    component hashers[levels];
    component mux[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Selector: if pathIndices[i] == 0, hash(current, sibling)
        //           if pathIndices[i] == 1, hash(sibling, current)
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== levelHashes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== levelHashes[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[levels];
}

/**
 * Production Withdrawal Circuit
 *
 * Proves:
 * 1. User knows secretKey such that Poseidon(secretKey) = idCommitment
 * 2. idCommitment is in Merkle tree with given root
 * 3. Valid RLN signal generation (prevents double-spending)
 * 4. Withdrawal is bound to a specific recipient address (prevents front-running)
 *
 * WITHOUT revealing the secretKey
 */
template WithdrawalProof(TREE_DEPTH) {
    // Private inputs (never revealed onchain)
    signal input secretKey;
    signal input ticketIndex;
    signal input merklePathElements[TREE_DEPTH];
    signal input merklePathIndices[TREE_DEPTH];

    // Public inputs (visible onchain)
    signal input signalX;
    signal input merkleRootExpected;
    signal input recipient;  // Ethereum address as uint160 - prevents front-running

    // Public outputs
    signal output nullifier;
    signal output signalY;
    signal output idCommitment;
    signal output merkleRoot;

    // 1. Compute identity commitment from secret key
    component idHash = Poseidon(1);
    idHash.inputs[0] <== secretKey;
    idCommitment <== idHash.out;

    // 2. Prove idCommitment is in Merkle tree
    component merkleProof = MerkleTreeChecker(TREE_DEPTH);
    merkleProof.leaf <== idCommitment;
    for (var i = 0; i < TREE_DEPTH; i++) {
        merkleProof.pathElements[i] <== merklePathElements[i];
        merkleProof.pathIndices[i] <== merklePathIndices[i];
    }
    merkleRoot <== merkleProof.root;

    // 3. Verify Merkle root matches expected value
    merkleRoot === merkleRootExpected;

    // 4. Generate RLN nullifier
    // a = Poseidon(secretKey, ticketIndex)
    component aHash = Poseidon(2);
    aHash.inputs[0] <== secretKey;
    aHash.inputs[1] <== ticketIndex;
    signal a;
    a <== aHash.out;

    // nullifier = Poseidon(a)
    component nullifierHash = Poseidon(1);
    nullifierHash.inputs[0] <== a;
    nullifier <== nullifierHash.out;

    // 5. Generate RLN signal
    // y = secretKey + a * x
    signalY <== secretKey + a * signalX;

    // Bind recipient with an explicit constraint rather than relying on the
    // setup giving every public input an IC point
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

// Export with 20-level Merkle tree (supports ~1 million users)
component main {public [signalX, merkleRootExpected, recipient]} = WithdrawalProof(20);
