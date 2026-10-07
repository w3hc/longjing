pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/babyjub.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/circomlib/circuits/eddsaposeidon.circom";
include "../../node_modules/circomlib/circuits/escalarmulfix.circom";
include "../../node_modules/circomlib/circuits/poseidon.circom";

/**
 * Refund accumulator from docs/SETTLEMENT.md, a Pedersen commitment on
 * Baby Jubjub:
 *
 *   A = R·G + m·J + c·K + s·H
 *
 * R is the sum of refunds, m the next ticket index, c the note's commitment
 * and s a blinding factor. The generators are hashed to the curve from the
 * seeds longjing/accumulator/{G,J,K,H} (src/longjing/accumulator.ts), so
 * nobody knows a discrete log between them.
 */

function GENERATOR_G() {
    return [
        18891097169288653087893319358176119911434283417707569988321287040614592813441,
        7860657952746490641010431794884102523135412871148967527117598022318856757355
    ];
}

function GENERATOR_J() {
    return [
        9355242946826564246596339623000927660947180691373501561174839848920096889098,
        5781297037533749164671578987434977586939883164721324158318402311010617548447
    ];
}

function GENERATOR_K() {
    return [
        10091301215100818316994948506512801193726841756990533464310239660356987896404,
        18942670726857660232249921857623130179002007525955879997549966126382094771891
    ];
}

function GENERATOR_H() {
    return [
        13556252777791168262952330903992668184110251936673810894841963303519998714808,
        6394268297776531876912426155015605865041308032211543906119719637484169236582
    ];
}

/**
 * out = scalar · BASE, with scalar < 2^BITS
 */
template FixedBaseMul(BITS, BASE) {
    signal input scalar;
    signal output out[2];

    component bits = Num2Bits(BITS);
    bits.in <== scalar;

    component mul = EscalarMulFix(BITS, BASE);
    for (var i = 0; i < BITS; i++) {
        mul.e[i] <== bits.out[i];
    }
    out[0] <== mul.out[0];
    out[1] <== mul.out[1];
}

/**
 * out = scalar · BASE for any field element, decomposed canonically
 */
template FieldBaseMul(BASE) {
    signal input scalar;
    signal output out[2];

    component bits = Num2Bits_strict();
    bits.in <== scalar;

    component mul = EscalarMulFix(254, BASE);
    for (var i = 0; i < 254; i++) {
        mul.e[i] <== bits.out[i];
    }
    out[0] <== mul.out[0];
    out[1] <== mul.out[1];
}

/**
 * out = refunds·G + index·J + commitment·K + blinding·H, with refunds below
 * 2^128 and index below 2^32
 */
template AccumulatorCommitment() {
    signal input refunds;
    signal input index;
    signal input commitment;
    signal input blinding;
    signal output out[2];

    component refundsTerm = FixedBaseMul(128, GENERATOR_G());
    refundsTerm.scalar <== refunds;
    component indexTerm = FixedBaseMul(32, GENERATOR_J());
    indexTerm.scalar <== index;
    component commitmentTerm = FieldBaseMul(GENERATOR_K());
    commitmentTerm.scalar <== commitment;
    component blindingTerm = FieldBaseMul(GENERATOR_H());
    blindingTerm.scalar <== blinding;

    component sum1 = BabyAdd();
    sum1.x1 <== refundsTerm.out[0];
    sum1.y1 <== refundsTerm.out[1];
    sum1.x2 <== indexTerm.out[0];
    sum1.y2 <== indexTerm.out[1];

    component sum2 = BabyAdd();
    sum2.x1 <== sum1.xout;
    sum2.y1 <== sum1.yout;
    sum2.x2 <== commitmentTerm.out[0];
    sum2.y2 <== commitmentTerm.out[1];

    component sum3 = BabyAdd();
    sum3.x1 <== sum2.xout;
    sum3.y1 <== sum2.yout;
    sum3.x2 <== blindingTerm.out[0];
    sum3.y2 <== blindingTerm.out[1];

    out[0] <== sum3.xout;
    out[1] <== sum3.yout;
}

/**
 * Opens a note's accumulator and checks it is either the genesis
 * accumulator c·K or signed by the server, with EdDSA-Poseidon over
 * Poseidon(A.x, A.y). Genesis needs no signature, so it forces R, m and s
 * to zero.
 */
template SignedAccumulator() {
    signal input isGenesis;
    signal input refunds;
    signal input index;
    signal input commitment;
    signal input blinding;
    signal input signatureR8x;
    signal input signatureR8y;
    signal input signatureS;
    signal input serverPublicKeyX;
    signal input serverPublicKeyY;
    signal output out[2];

    isGenesis * (1 - isGenesis) === 0;
    isGenesis * refunds === 0;
    isGenesis * index === 0;
    isGenesis * blinding === 0;

    component accumulator = AccumulatorCommitment();
    accumulator.refunds <== refunds;
    accumulator.index <== index;
    accumulator.commitment <== commitment;
    accumulator.blinding <== blinding;

    component message = Poseidon(2);
    message.inputs[0] <== accumulator.out[0];
    message.inputs[1] <== accumulator.out[1];

    component signature = EdDSAPoseidonVerifier();
    signature.enabled <== 1 - isGenesis;
    signature.Ax <== serverPublicKeyX;
    signature.Ay <== serverPublicKeyY;
    signature.R8x <== signatureR8x;
    signature.R8y <== signatureR8y;
    signature.S <== signatureS;
    signature.M <== message.out;

    out[0] <== accumulator.out[0];
    out[1] <== accumulator.out[1];
}

/**
 * out = in + blinding·H, the fresh point a request reveals in place of the
 * accumulator the server signed
 */
template Rerandomize() {
    signal input in[2];
    signal input blinding;
    signal output out[2];

    component blindingTerm = FieldBaseMul(GENERATOR_H());
    blindingTerm.scalar <== blinding;

    component sum = BabyAdd();
    sum.x1 <== in[0];
    sum.y1 <== in[1];
    sum.x2 <== blindingTerm.out[0];
    sum.y2 <== blindingTerm.out[1];

    out[0] <== sum.xout;
    out[1] <== sum.yout;
}
