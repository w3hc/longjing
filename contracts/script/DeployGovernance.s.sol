// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IDstackApp} from "../src/IDstackApp.sol";
import {LongjingAppOwner} from "../src/LongjingAppOwner.sol";

/// @notice Deploys the timelock and the LongjingAppOwner that will own
/// Longjing's DstackApp.
/// @dev DSTACK_APP=0x... SAFE=0x... [GUARDIAN=0x...] [TIMELOCK_DELAY=604800]
///      forge script script/DeployGovernance.s.sol --rpc-url base --broadcast
///      Then hand the app over: see docs/GOVERNANCE.md#setup.
contract DeployGovernance is Script {
    uint256 constant DEFAULT_DELAY = 7 days;

    function run() external returns (TimelockController timelock, LongjingAppOwner appOwner) {
        IDstackApp app = IDstackApp(vm.envAddress("DSTACK_APP"));
        address safe = vm.envAddress("SAFE");
        address guardian = vm.envOr("GUARDIAN", safe);
        uint256 delay = vm.envOr("TIMELOCK_DELAY", DEFAULT_DELAY);

        vm.startBroadcast();
        (timelock, appOwner) = deploy(app, safe, guardian, delay);
        vm.stopBroadcast();

        console.log("TimelockController:", address(timelock));
        console.log("LongjingAppOwner:  ", address(appOwner));
    }

    /// @notice The Safe proposes, executes and cancels. Nobody administers the
    /// timelock but itself, so changing its roles or delay is itself delayed.
    function deploy(IDstackApp app, address safe, address guardian, uint256 delay)
        public
        returns (TimelockController timelock, LongjingAppOwner appOwner)
    {
        address[] memory safeOnly = new address[](1);
        safeOnly[0] = safe;
        timelock = new TimelockController(delay, safeOnly, safeOnly, address(0));
        appOwner = new LongjingAppOwner(app, address(timelock), guardian);
    }
}
