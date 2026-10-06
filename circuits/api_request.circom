pragma circom 2.0.0;

include "templates/api_request_proof.circom";

// Export with 20-level Merkle tree and max 10 refund tickets
// 20 levels = ~1M users, 10 refunds = reasonable batch size before redemption
component main {public [merkleRootExpected, maxCost, signalX, serverPublicKeyX, serverPublicKeyY]} = ApiRequestProof(20, 10);
