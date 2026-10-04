pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/**
 * Simplified ZK Circuit for API Credit Proof
 * This is a basic implementation for testing - production would use full EdDSA verification
 */

template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component selectors[levels];
    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i-1].out;
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];
    }

    root === hashers[levels - 1].out;
}

template ApiCreditProofSimple(levels) {
    // Private inputs
    signal input secretKey;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input ticketIndex;

    // Public inputs
    signal input merkleRoot;
    signal input maxCost;
    signal input initialDeposit;
    signal input signalX;

    // Public outputs
    signal output nullifier;
    signal output signalY;
    signal output idCommitment;

    // 1. Compute identity commitment
    component idHash = Poseidon(1);
    idHash.inputs[0] <== secretKey;
    idCommitment <== idHash.out;

    // 2. Verify Merkle proof
    component merkleProof = MerkleTreeChecker(levels);
    merkleProof.leaf <== idCommitment;
    merkleProof.root <== merkleRoot;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // 3. Simple solvency check: (ticketIndex + 1) * maxCost <= initialDeposit
    // Bound every operand so the arithmetic cannot wrap the field
    component ticketIndexBits = Num2Bits(32);
    ticketIndexBits.in <== ticketIndex;

    component maxCostBits = Num2Bits(128);
    maxCostBits.in <== maxCost;

    component initialDepositBits = Num2Bits(128);
    initialDepositBits.in <== initialDeposit;

    signal requiredBalance;
    requiredBalance <== (ticketIndex + 1) * maxCost;

    component solvencyCheck = LessEqThan(252);
    solvencyCheck.in[0] <== requiredBalance;
    solvencyCheck.in[1] <== initialDeposit;
    solvencyCheck.out === 1;

    // 4. RLN: Generate nullifier and signal
    component aHash = Poseidon(2);
    aHash.inputs[0] <== secretKey;
    aHash.inputs[1] <== ticketIndex;
    signal a;
    a <== aHash.out;

    component nullifierHash = Poseidon(1);
    nullifierHash.inputs[0] <== a;
    nullifier <== nullifierHash.out;

    signalY <== secretKey + a * signalX;
}

component main {public [merkleRoot, maxCost, initialDeposit, signalX]} = ApiCreditProofSimple(20);
