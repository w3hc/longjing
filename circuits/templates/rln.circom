pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

/**
 * RLN signal at one ticket index, as in the paper:
 * a = Poseidon(k, i), N = Poseidon(a), y = k + a · x.
 * Two signals at the same index with different x reveal k.
 */
template RlnSignal() {
    signal input secretKey;
    signal input index;
    signal input signalX;
    signal output nullifier;
    signal output signalY;

    component aHash = Poseidon(2);
    aHash.inputs[0] <== secretKey;
    aHash.inputs[1] <== index;

    component nullifierHash = Poseidon(1);
    nullifierHash.inputs[0] <== aHash.out;
    nullifier <== nullifierHash.out;

    signalY <== secretKey + aHash.out * signalX;
}
