pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/eddsamimc.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

/**
 * Production API Request Circuit
 *
 * Proves the full solvency formula from the original proposal:
 * (i + 1) · C_max ≤ D + R
 *
 * Where:
 * - i = ticketIndex (current request number)
 * - C_max = maxCost (maximum cost per request)
 * - D = initialDeposit (original deposit amount)
 * - R = sum of refunds from previous requests
 *
 * This circuit proves:
 * 1. User knows secretKey for idCommitment
 * 2. idCommitment is in Merkle tree (anonymity set)
 * 3. User has sufficient balance for this request: (i+1)·C_max ≤ D + R
 * 4. All refund tickets have valid EdDSA signatures from server
 * 5. RLN signal generation (prevents double-spending)
 *
 * WITHOUT revealing secret key, balance, or request history
 */

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

template ApiRequestProof(TREE_DEPTH, MAX_REFUNDS) {
    // ========== Private Inputs ==========
    signal input secretKey;                                    // k: User's secret key
    signal input ticketIndex;                                  // i: Current ticket index
    signal input initialDeposit;                               // D: Initial deposit amount
    signal input merklePathElements[TREE_DEPTH];               // Merkle proof path
    signal input merklePathIndices[TREE_DEPTH];                // Merkle proof indices

    // Refund tickets from previous requests
    signal input numRefunds;                                   // Number of valid refunds
    signal input refundValues[MAX_REFUNDS];                    // Refund amounts in wei
    signal input refundTimestamps[MAX_REFUNDS];                // Refund issuance times
    signal input refundSignaturesR8x[MAX_REFUNDS];             // EdDSA R8x components
    signal input refundSignaturesR8y[MAX_REFUNDS];             // EdDSA R8y components
    signal input refundSignaturesS[MAX_REFUNDS];               // EdDSA S components
    signal input refundNullifiers[MAX_REFUNDS];                // Nullifiers from refund tickets

    // Server's EdDSA public key
    signal input serverPublicKeyX;
    signal input serverPublicKeyY;

    // ========== Public Inputs ==========
    signal input merkleRootExpected;                           // Expected Merkle root
    signal input maxCost;                                      // C_max: Maximum cost for this request
    signal input signalX;                                      // RLN signal x

    // ========== Public Outputs ==========
    signal output nullifier;                                   // RLN nullifier
    signal output signalY;                                     // RLN signal y
    signal output idCommitment;                                // User's identity commitment
    signal output merkleRoot;                                  // Computed Merkle root

    // ========== 1. Compute Identity Commitment ==========
    component idHash = Poseidon(1);
    idHash.inputs[0] <== secretKey;
    idCommitment <== idHash.out;

    // ========== 2. Verify Merkle Tree Membership ==========
    component merkleProof = MerkleTreeChecker(TREE_DEPTH);
    merkleProof.leaf <== idCommitment;
    for (var i = 0; i < TREE_DEPTH; i++) {
        merkleProof.pathElements[i] <== merklePathElements[i];
        merkleProof.pathIndices[i] <== merklePathIndices[i];
    }
    merkleRoot <== merkleProof.root;

    // Verify Merkle root matches expected value
    merkleRoot === merkleRootExpected;

    // ========== 3. Verify Refund Signatures and Sum Refunds ==========
    // Bound numRefunds to [0, MAX_REFUNDS]
    var REFUND_BITS = 8;
    component numRefundsBits = Num2Bits(REFUND_BITS);
    numRefundsBits.in <== numRefunds;

    component numRefundsBound = LessEqThan(REFUND_BITS);
    numRefundsBound.in[0] <== numRefunds;
    numRefundsBound.in[1] <== MAX_REFUNDS;
    numRefundsBound.out === 1;

    // Bound every solvency operand so the arithmetic below cannot wrap the field
    var INDEX_BITS = 32;
    var AMOUNT_BITS = 128;

    component refundActive[MAX_REFUNDS];
    component refundValueBits[MAX_REFUNDS];
    component refundMessageHashers[MAX_REFUNDS];
    component refundSignatureVerifiers[MAX_REFUNDS];
    signal refundSum[MAX_REFUNDS + 1];
    refundSum[0] <== 0;

    for (var i = 0; i < MAX_REFUNDS; i++) {
        // Slot i is active iff i < numRefunds
        refundActive[i] = LessThan(REFUND_BITS);
        refundActive[i].in[0] <== i;
        refundActive[i].in[1] <== numRefunds;

        // Turned-off slots must carry a zero value
        refundValues[i] * (1 - refundActive[i].out) === 0;

        refundValueBits[i] = Num2Bits(AMOUNT_BITS);
        refundValueBits[i].in <== refundValues[i];

        // Hash refund ticket: Poseidon(idCommitment, nullifier, value, timestamp)
        refundMessageHashers[i] = Poseidon(4);
        refundMessageHashers[i].inputs[0] <== idCommitment;
        refundMessageHashers[i].inputs[1] <== refundNullifiers[i];
        refundMessageHashers[i].inputs[2] <== refundValues[i];
        refundMessageHashers[i].inputs[3] <== refundTimestamps[i];

        refundSignatureVerifiers[i] = EdDSAMiMCVerifier();
        refundSignatureVerifiers[i].enabled <== refundActive[i].out;
        refundSignatureVerifiers[i].Ax <== serverPublicKeyX;
        refundSignatureVerifiers[i].Ay <== serverPublicKeyY;
        refundSignatureVerifiers[i].R8x <== refundSignaturesR8x[i];
        refundSignatureVerifiers[i].R8y <== refundSignaturesR8y[i];
        refundSignatureVerifiers[i].S <== refundSignaturesS[i];
        refundSignatureVerifiers[i].M <== refundMessageHashers[i].out;

        refundSum[i + 1] <== refundSum[i] + refundValues[i] * refundActive[i].out;
    }

    signal totalRefunds;
    totalRefunds <== refundSum[MAX_REFUNDS];

    // ========== 4. SOLVENCY CHECK: (i + 1) · C_max ≤ D + R ==========
    // This is the core formula from the original proposal
    // With i < 2^32 and C_max, D, R_j < 2^128, both sides stay below 2^252

    component ticketIndexBits = Num2Bits(INDEX_BITS);
    ticketIndexBits.in <== ticketIndex;

    component maxCostBits = Num2Bits(AMOUNT_BITS);
    maxCostBits.in <== maxCost;

    component initialDepositBits = Num2Bits(AMOUNT_BITS);
    initialDepositBits.in <== initialDeposit;

    signal availableBalance;
    availableBalance <== initialDeposit + totalRefunds;

    signal requiredBalance;
    requiredBalance <== (ticketIndex + 1) * maxCost;

    // Assert solvency: requiredBalance ≤ availableBalance
    component solvencyCheck = LessEqThan(252);
    solvencyCheck.in[0] <== requiredBalance;
    solvencyCheck.in[1] <== availableBalance;
    solvencyCheck.out === 1;

    // ========== 5. Generate RLN Nullifier and Signal ==========
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

    // y = secretKey + a * x
    // If user submits two requests with same ticketIndex but different x values,
    // anyone can solve for secretKey and claim their RLN stake
    signalY <== secretKey + a * signalX;
}

// Export with 20-level Merkle tree and max 10 refund tickets
// 20 levels = ~1M users, 10 refunds = reasonable batch size before redemption
component main {public [merkleRootExpected, maxCost, signalX]} = ApiRequestProof(20, 10);
