pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/comparators.circom";
include "templates/accumulator.circom";
include "templates/rln.circom";

/**
 * Settlement (withdrawal) circuit from docs/SETTLEMENT.md
 *
 * For a note with commitment c and deposit D, both read from the contract,
 * and a claimed count of used indices n, proves:
 * 1. Poseidon(k) = c
 * 2. the accumulator A is genesis, or signed by the server
 * 3. A opens to (R, m, c, s) and n ≥ m
 * 4. the payout P = D + R − n · C_MAX and P ≥ 0
 * 5. the RLN signal at index n, with x bound to the recipient by the contract
 *
 * No Merkle path: the contract already knows the note by c.
 */
template Settlement() {
    // ========== Private Inputs ==========
    signal input secretKey;                       // k
    signal input isGenesis;
    signal input refunds;                         // R
    signal input index;                           // m, the accumulator's next index
    signal input blinding;                        // s
    signal input signatureR8x;
    signal input signatureR8y;
    signal input signatureS;
    signal input claimedIndex;                    // n, the indices the note used

    // ========== Public Inputs ==========
    signal input commitment;                      // c
    signal input deposit;                         // D, notes[c].amount
    signal input maxCost;                         // C_MAX
    signal input serverPublicKeyX;
    signal input serverPublicKeyY;
    signal input recipient;
    signal input signalX;                         // Poseidon(recipient, chainId, contract)

    // ========== Public Outputs ==========
    signal output nullifier;
    signal output signalY;
    signal output payout;                         // P

    // ========== 1. Key ownership ==========
    component ownership = Poseidon(1);
    ownership.inputs[0] <== secretKey;
    ownership.out === commitment;

    // ========== 2-3. Accumulator opening ==========
    // Bounds R below 2^128 and m below 2^32
    component accumulator = SignedAccumulator();
    accumulator.isGenesis <== isGenesis;
    accumulator.refunds <== refunds;
    accumulator.index <== index;
    accumulator.commitment <== commitment;
    accumulator.blinding <== blinding;
    accumulator.signatureR8x <== signatureR8x;
    accumulator.signatureR8y <== signatureR8y;
    accumulator.signatureS <== signatureS;
    accumulator.serverPublicKeyX <== serverPublicKeyX;
    accumulator.serverPublicKeyY <== serverPublicKeyY;

    component claimedIndexBits = Num2Bits(32);
    claimedIndexBits.in <== claimedIndex;

    component claimCoversUsage = LessEqThan(32);
    claimCoversUsage.in[0] <== index;
    claimCoversUsage.in[1] <== claimedIndex;
    claimCoversUsage.out === 1;

    // ========== 4. Payout: P = D + R − n · C_MAX ≥ 0 ==========
    // D + R < 2^129, so P fits in 129 bits exactly when it doesn't wrap
    component depositBits = Num2Bits(128);
    depositBits.in <== deposit;

    component maxCostBits = Num2Bits(128);
    maxCostBits.in <== maxCost;

    signal spent;
    spent <== claimedIndex * maxCost;
    payout <== deposit + refunds - spent;

    component payoutBits = Num2Bits(129);
    payoutBits.in <== payout;

    // ========== 5. RLN signal at index n ==========
    component rln = RlnSignal();
    rln.secretKey <== secretKey;
    rln.index <== claimedIndex;
    rln.signalX <== signalX;
    nullifier <== rln.nullifier;
    signalY <== rln.signalY;

    // Bind recipient with an explicit constraint rather than relying on the
    // setup giving every public input an IC point
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

component main {public [commitment, deposit, maxCost, serverPublicKeyX, serverPublicKeyY, recipient, signalX]} = Settlement();
