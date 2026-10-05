// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {DeployLongjingCredits} from "../script/DeployLongjingCredits.s.sol";

contract DeployLongjingCreditsTest is Test {
    DeployLongjingCredits script = new DeployLongjingCredits();

    uint256 constant ANVIL_PRIVATE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant ANVIL_ADDRESS = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    bytes32 constant DEV_PUBKEY_X = 0x2de05716d2326de41468ba1ee14d34a5c74c348b112c1743798dd68ce7715115;
    bytes32 constant DEV_PUBKEY_Y = 0x1150d8e55cc05caef9ddb06b484ad5f7fea37e315dc3d27b727f681982cccce1;

    function prodEnv() internal returns (DeployLongjingCredits.Config memory) {
        return DeployLongjingCredits.Config(0x2a, makeAddr("server"), bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_localUsesAnvilDefaults() public {
        DeployLongjingCredits.Config memory c = script.resolve("local", 31337, prodEnv());

        assertEq(c.deployerPrivateKey, ANVIL_PRIVATE_KEY);
        assertEq(c.serverAddress, ANVIL_ADDRESS);
        assertEq(c.serverPubKeyX, DEV_PUBKEY_X);
        assertEq(c.serverPubKeyY, DEV_PUBKEY_Y);
    }

    function test_localRefusesOtherChains() public {
        DeployLongjingCredits.Config memory env = prodEnv();
        vm.expectRevert("PROFILE=local deploys to Anvil only (chain 31337)");
        script.resolve("local", 1, env);
    }

    function test_refusesMissingProfile() public {
        DeployLongjingCredits.Config memory env = prodEnv();
        vm.expectRevert("PROFILE must be local or prod");
        script.resolve("", 1, env);
    }

    function test_prodUsesEnv() public {
        DeployLongjingCredits.Config memory env = prodEnv();

        DeployLongjingCredits.Config memory c = script.resolve("prod", 1, env);

        assertEq(c.deployerPrivateKey, env.deployerPrivateKey);
        assertEq(c.serverAddress, env.serverAddress);
        assertEq(c.serverPubKeyX, env.serverPubKeyX);
        assertEq(c.serverPubKeyY, env.serverPubKeyY);
    }

    function test_prodRefusesAnvil() public {
        DeployLongjingCredits.Config memory env = prodEnv();
        vm.expectRevert("PROFILE=prod refuses chain 31337");
        script.resolve("prod", 31337, env);
    }

    function test_prodRefusesAnvilPrivateKey() public {
        DeployLongjingCredits.Config memory env = prodEnv();
        env.deployerPrivateKey = ANVIL_PRIVATE_KEY;
        vm.expectRevert("PROFILE=prod refuses the Anvil PRIVATE_KEY");
        script.resolve("prod", 1, env);
    }

    function test_prodRefusesAnvilServerAddress() public {
        DeployLongjingCredits.Config memory env = prodEnv();
        env.serverAddress = ANVIL_ADDRESS;
        vm.expectRevert("PROFILE=prod refuses the Anvil SERVER_ADDRESS");
        script.resolve("prod", 1, env);
    }

    function test_prodRefusesDevRefundSignerKey() public {
        DeployLongjingCredits.Config memory env = prodEnv();
        env.serverPubKeyX = DEV_PUBKEY_X;
        env.serverPubKeyY = DEV_PUBKEY_Y;
        vm.expectRevert("PROFILE=prod refuses the dev refund-signer key");
        script.resolve("prod", 1, env);
    }
}
