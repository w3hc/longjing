// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Script, console} from "forge-std/Script.sol";
import {LongjingCredits} from "../src/LongjingCredits.sol";

/// @notice Deploys LongjingCredits for a NODE_ENV, like the server.
/// @dev NODE_ENV=development or test: Anvil only (chain 31337), with Anvil
///      account #0 and the dev refund-signer key
///      (sha256('longjing-refund-signer-dev-key')).
///      NODE_ENV=production: never chain 31337, and PRIVATE_KEY,
///      SERVER_ADDRESS, SERVER_PUBKEY_X and SERVER_PUBKEY_Y are required.
///      Placeholders are refused: the dev refund-signer key would let anyone
///      sign refunds.
contract DeployLongjingCredits is Script {
    struct Config {
        uint256 deployerPrivateKey;
        address serverAddress;
        bytes32 serverPubKeyX;
        bytes32 serverPubKeyY;
    }

    uint256 constant ANVIL_CHAIN_ID = 31337;
    uint256 constant ANVIL_PRIVATE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant ANVIL_ADDRESS = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    bytes32 constant DEV_PUBKEY_X = 0x2de05716d2326de41468ba1ee14d34a5c74c348b112c1743798dd68ce7715115;
    bytes32 constant DEV_PUBKEY_Y = 0x1150d8e55cc05caef9ddb06b484ad5f7fea37e315dc3d27b727f681982cccce1;

    // C_max: the most one request may cost, and the smallest deposit
    uint256 constant C_MAX = 0.001 ether;

    function run() external {
        Config memory c = config();

        vm.startBroadcast(c.deployerPrivateKey);
        LongjingCredits longjing = new LongjingCredits(c.serverAddress, c.serverPubKeyX, c.serverPubKeyY, C_MAX);
        vm.stopBroadcast();

        console.log("LongjingCredits deployed at:", address(longjing));
        console.log("Server address:", c.serverAddress);
        console.log("C_MAX:", C_MAX);
        console.log("Settlement verifier:", address(longjing.settlementVerifier()));
    }

    function config() public view returns (Config memory) {
        string memory nodeEnv = vm.envOr("NODE_ENV", string(""));
        Config memory fromEnv;
        if (keccak256(bytes(nodeEnv)) == keccak256("production")) {
            fromEnv = Config(
                vm.envUint("PRIVATE_KEY"),
                vm.envAddress("SERVER_ADDRESS"),
                vm.envBytes32("SERVER_PUBKEY_X"),
                vm.envBytes32("SERVER_PUBKEY_Y")
            );
        }
        return resolve(nodeEnv, block.chainid, fromEnv);
    }

    function resolve(string memory nodeEnv, uint256 chainId, Config memory fromEnv)
        public
        pure
        returns (Config memory)
    {
        bytes32 e = keccak256(bytes(nodeEnv));

        if (e == keccak256("development") || e == keccak256("test")) {
            require(chainId == ANVIL_CHAIN_ID, "NODE_ENV=development or test deploys to Anvil only (chain 31337)");
            return Config(ANVIL_PRIVATE_KEY, ANVIL_ADDRESS, DEV_PUBKEY_X, DEV_PUBKEY_Y);
        }

        require(e == keccak256("production"), "NODE_ENV must be development, test or production");
        require(chainId != ANVIL_CHAIN_ID, "NODE_ENV=production refuses chain 31337");
        require(fromEnv.deployerPrivateKey != ANVIL_PRIVATE_KEY, "NODE_ENV=production refuses the Anvil PRIVATE_KEY");
        require(fromEnv.serverAddress != ANVIL_ADDRESS, "NODE_ENV=production refuses the Anvil SERVER_ADDRESS");
        require(
            fromEnv.serverPubKeyX != DEV_PUBKEY_X || fromEnv.serverPubKeyY != DEV_PUBKEY_Y,
            "NODE_ENV=production refuses the dev refund-signer key"
        );
        return fromEnv;
    }
}
