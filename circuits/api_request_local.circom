pragma circom 2.0.0;

include "templates/api_request_proof.circom";

// Local profile entry point: same statement as api_request with 2 refund slots
// instead of 10, which keeps proving and the trusted setup fast on a laptop
component main {public [merkleRootExpected, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]} = ApiRequestProof(20, 2);
