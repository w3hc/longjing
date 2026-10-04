pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/eddsaposeidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

/**
 * ZK Circuit for API Credit Proof
 * Implements Rate-Limit Nullifiers (RLN) for privacy-preserving API access
 *
 * This circuit proves:
 * 1. Membership: User's identity is in the Merkle tree
 * 2. Refund Summation: All refund tickets are validly signed
 * 3. Solvency: User has sufficient balance
 * 4. RLN: Generates nullifier and signal for double-spend detection
 */

// Helper templates defined first
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

template Mux1() {
    signal input c[2];
    signal input s;
    signal output out;

    s * (1 - s) === 0;
    out <== c[0] + s * (c[1] - c[0]);
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

template ApiCreditProof(levels, maxRefunds) {
    // Private inputs
    signal input secretKey;                          // k: User's secret key
    signal input pathElements[levels];               // Merkle proof path
    signal input pathIndices[levels];                // Merkle proof indices
    signal input refundValues[maxRefunds];           // Refund ticket values
    signal input refundNullifiers[maxRefunds];       // Refund nullifiers (for signature binding)
    signal input refundTimestamps[maxRefunds];       // Refund timestamps (for signature binding)
    signal input refundSignaturesR8x[maxRefunds];    // EdDSA signature R8x
    signal input refundSignaturesR8y[maxRefunds];    // EdDSA signature R8y
    signal input refundSignaturesS[maxRefunds];      // EdDSA signature S
    signal input ticketIndex;                        // i: Current ticket index
    signal input numRefunds;                         // Number of valid refunds

    // Public inputs
    signal input merkleRoot;                         // Merkle tree root
    signal input maxCost;                            // C_max: Maximum cost per request
    signal input initialDeposit;                     // D: Initial deposit
    signal input signalX;                            // x: RLN signal x
    signal input serverPubKeyX;                      // Server's public key for signature verification
    signal input serverPubKeyY;                      // Server's public key for signature verification

    // Public outputs
    signal output nullifier;                         // RLN nullifier
    signal output signalY;                           // y: RLN signal y
    signal output idCommitment;                      // ID = Hash(k)

    // 1. Compute identity commitment: ID = Hash(secretKey)
    component idHash = Poseidon(1);
    idHash.inputs[0] <== secretKey;
    idCommitment <== idHash.out;

    // 2. Verify Merkle proof: Prove ID is in the tree
    component merkleProof = MerkleTreeChecker(levels);
    merkleProof.leaf <== idCommitment;
    merkleProof.root <== merkleRoot;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // 3. Verify refund signatures and sum refunds
    // Canonical message format: Poseidon(idCommitment, nullifier, value, timestamp)
    // This MUST match:
    // - refund-signer.service.ts hashRefundData()
    // - refund_redemption.circom signature verification
    // - LongjingCredits.sol _hashRefundData()
    component refundVerifiers[maxRefunds];
    component refundHashers[maxRefunds];
    component enabledChecks[maxRefunds];
    component valueMux[maxRefunds];
    signal isEnabled[maxRefunds];
    signal totalRefunds;
    signal refundSum[maxRefunds + 1];
    refundSum[0] <== 0;

    for (var i = 0; i < maxRefunds; i++) {
        // Compute if this refund slot is enabled: i < numRefunds
        enabledChecks[i] = LessThan(8);  // 8 bits sufficient for reasonable maxRefunds
        enabledChecks[i].in[0] <== i;
        enabledChecks[i].in[1] <== numRefunds;
        isEnabled[i] <== enabledChecks[i].out;

        // Hash the complete refund data: Poseidon(idCommitment, nullifier, value, timestamp)
        refundHashers[i] = Poseidon(4);
        refundHashers[i].inputs[0] <== idCommitment;
        refundHashers[i].inputs[1] <== refundNullifiers[i];
        refundHashers[i].inputs[2] <== refundValues[i];
        refundHashers[i].inputs[3] <== refundTimestamps[i];

        // Verify EdDSA signature using Poseidon-EdDSA
        refundVerifiers[i] = EdDSAPoseidonVerifier();
        refundVerifiers[i].enabled <== isEnabled[i];
        refundVerifiers[i].Ax <== serverPubKeyX;
        refundVerifiers[i].Ay <== serverPubKeyY;
        refundVerifiers[i].R8x <== refundSignaturesR8x[i];
        refundVerifiers[i].R8y <== refundSignaturesR8y[i];
        refundVerifiers[i].S <== refundSignaturesS[i];
        refundVerifiers[i].M <== refundHashers[i].out;

        // Accumulate refunds (only count if enabled)
        // Use Mux to select: enabled ? refundValues[i] : 0
        valueMux[i] = Mux1();
        valueMux[i].c[0] <== 0;
        valueMux[i].c[1] <== refundValues[i];
        valueMux[i].s <== isEnabled[i];

        refundSum[i + 1] <== refundSum[i] + valueMux[i].out;
    }

    totalRefunds <== refundSum[maxRefunds];

    // 4. Solvency check: (ticketIndex + 1) * maxCost <= initialDeposit + totalRefunds
    signal availableBalance;
    availableBalance <== initialDeposit + totalRefunds;

    signal requiredBalance;
    requiredBalance <== (ticketIndex + 1) * maxCost;

    // Assert solvency
    component solvencyCheck = LessEqThan(252);
    solvencyCheck.in[0] <== requiredBalance;
    solvencyCheck.in[1] <== availableBalance;
    solvencyCheck.out === 1;

    // 5. RLN: Generate nullifier and signal
    // a = Hash(secretKey, ticketIndex)
    component aHash = Poseidon(2);
    aHash.inputs[0] <== secretKey;
    aHash.inputs[1] <== ticketIndex;
    signal a;
    a <== aHash.out;

    // nullifier = Hash(a)
    component nullifierHash = Poseidon(1);
    nullifierHash.inputs[0] <== a;
    nullifier <== nullifierHash.out;

    // y = secretKey + a * signalX
    signalY <== secretKey + a * signalX;
}

// Main component instantiation
component main {public [merkleRoot, maxCost, initialDeposit, signalX, serverPubKeyX, serverPubKeyY]} = ApiCreditProof(20, 100);
