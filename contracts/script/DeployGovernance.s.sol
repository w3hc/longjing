// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Script, console} from "forge-std/Script.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IDstackApp} from "../src/IDstackApp.sol";
import {LongjingAppOwner} from "../src/LongjingAppOwner.sol";

/// @notice Deploys a timelock, and puts Longjing's DstackApp, its
/// LongjingCredits, or both behind it.
/// @dev SAFE=0x... [DSTACK_APP=0x...] [LONGJING_CREDITS=0x...] [GUARDIAN=0x...]
///      [TIMELOCK_DELAY=604800]
///      forge script script/DeployGovernance.s.sol --rpc-url <chain> --broadcast
///      DSTACK_APP lives on Base and LongjingCredits on Ethereum, so run it once
///      per chain. With LONGJING_CREDITS, the broadcaster must own the contract.
///      Then hand the app over: see docs/GOVERNANCE.md#setup.
contract DeployGovernance is Script {
    uint256 constant DEFAULT_DELAY = 7 days;

    function run() external returns (TimelockController timelock, LongjingAppOwner appOwner) {
        address app = vm.envOr("DSTACK_APP", address(0));
        address credits = vm.envOr("LONGJING_CREDITS", address(0));
        require(app != address(0) || credits != address(0), "set DSTACK_APP, LONGJING_CREDITS or both");
        address safe = vm.envAddress("SAFE");
        address guardian = vm.envOr("GUARDIAN", safe);
        uint256 delay = vm.envOr("TIMELOCK_DELAY", DEFAULT_DELAY);

        vm.startBroadcast();
        timelock = deployTimelock(safe, delay);
        if (app != address(0)) {
            appOwner = new LongjingAppOwner(IDstackApp(app), address(timelock), guardian);
        }
        if (credits != address(0)) {
            handOverCredits(Ownable(credits), timelock);
        }
        vm.stopBroadcast();

        console.log("TimelockController:", address(timelock));
        if (app != address(0)) console.log("LongjingAppOwner:  ", address(appOwner));
        if (credits != address(0)) console.log("LongjingCredits owner:", Ownable(credits).owner());
    }

    function deploy(IDstackApp app, address safe, address guardian, uint256 delay)
        public
        returns (TimelockController timelock, LongjingAppOwner appOwner)
    {
        timelock = deployTimelock(safe, delay);
        appOwner = new LongjingAppOwner(app, address(timelock), guardian);
    }

    /// @notice The Safe proposes, executes and cancels. Nobody administers the
    /// timelock but itself, so changing its roles or delay is itself delayed.
    function deployTimelock(address safe, uint256 delay) public returns (TimelockController) {
        address[] memory safeOnly = new address[](1);
        safeOnly[0] = safe;
        return new TimelockController(delay, safeOnly, safeOnly, address(0));
    }

    /// @notice From here, every LongjingCredits admin call waits for the
    /// timelock delay, on top of the contract's own ADMIN_DELAY.
    /// @dev Ownable is one step: the transfer lands at once, so check the address.
    function handOverCredits(Ownable credits, TimelockController timelock) public {
        credits.transferOwnership(address(timelock));
        require(credits.owner() == address(timelock), "handover failed");
    }
}
