// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Script, console} from 'forge-std/Script.sol';
import {LongjingCredits} from '../src/LongjingCredits.sol';

contract DeployLongjingCredits is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr(
            'PRIVATE_KEY',
            uint256(
                0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
            )
        );
        address serverAddress = vm.envOr(
            'SERVER_ADDRESS',
            address(0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
        );

        // Min stakes: 0.1 ETH for RLN, 0.1 ETH for policy (0.2 ETH total minimum deposit)
        uint256 minRlnStake = 0.1 ether;
        uint256 minPolicyStake = 0.1 ether;

        // Server EdDSA public key (derived from dev private key in refund-signer.service.ts)
        // Private key: sha256('longjing-refund-signer-dev-key')
        // Public key derived using circomlib EdDSA
        bytes32 serverPubKeyX = bytes32(
            0x2de05716d2326de41468ba1ee14d34a5c74c348b112c1743798dd68ce7715115
        );
        bytes32 serverPubKeyY = bytes32(
            0x1150d8e55cc05caef9ddb06b484ad5f7fea37e315dc3d27b727f681982cccce1
        );

        vm.startBroadcast(deployerPrivateKey);

        LongjingCredits longjing = new LongjingCredits(
            serverAddress,
            minRlnStake,
            minPolicyStake,
            serverPubKeyX,
            serverPubKeyY
        );

        console.log('LongjingCredits deployed at:', address(longjing));
        console.log('Server address:', serverAddress);
        console.log('Min RLN stake:', minRlnStake);
        console.log('Min Policy stake:', minPolicyStake);

        // Real Groth16 verifiers are deployed automatically in the constructor
        console.log('\nVerifiers deployed:');
        console.log('Withdrawal verifier:', address(longjing.withdrawalVerifier()));
        console.log('Refund verifier:', address(longjing.refundVerifier()));
        console.log('Slashing verifier:', address(longjing.slashingVerifier()));

        console.log('\nUsing real Groth16 verifiers from api_credit_proof_test circuit');
        console.log('Circuit: circuits/api_credit_proof_test.circom');
        console.log('Constraints: 1,349');

        vm.stopBroadcast();
    }
}
