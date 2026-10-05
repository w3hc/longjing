// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IDstackApp} from "../src/IDstackApp.sol";
import {LongjingAppOwner} from "../src/LongjingAppOwner.sol";
import {DeployGovernance} from "../script/DeployGovernance.s.sol";

contract DeployGovernanceTest is Test {
    address app = makeAddr("app");
    address safe = makeAddr("safe");
    address guardian = makeAddr("guardian");

    function test_wiresTheTimelock() public {
        DeployGovernance script = new DeployGovernance();
        (TimelockController timelock, LongjingAppOwner appOwner) =
            script.deploy(IDstackApp(app), safe, guardian, 7 days);

        assertEq(timelock.getMinDelay(), 7 days);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), safe));
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(script)));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)));

        assertEq(address(appOwner.app()), app);
        assertEq(appOwner.timelock(), address(timelock));
        assertEq(appOwner.guardian(), guardian);
    }
}
