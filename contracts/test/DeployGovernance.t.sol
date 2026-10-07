// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IDstackApp} from "../src/IDstackApp.sol";
import {LongjingAppOwner} from "../src/LongjingAppOwner.sol";
import {LongjingCredits} from "../src/LongjingCredits.sol";
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

    function test_handsTheCreditsOverToTheTimelock() public {
        DeployGovernance script = new DeployGovernance();
        LongjingCredits credits =
            new LongjingCredits(makeAddr("server"), bytes32(uint256(1)), bytes32(uint256(2)), 0.001 ether, 0);
        // The script broadcasts as the deployer, which it stands in for here
        credits.transferOwnership(address(script));

        TimelockController timelock = script.deployTimelock(safe, 7 days);
        script.handOverCredits(credits, timelock);
        assertEq(credits.owner(), address(timelock));

        vm.prank(address(script));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(script)));
        credits.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        credits.proposeChange(LongjingCredits.Target.ServerAddress, makeAddr("attacker"));

        bytes memory pause = abi.encodeCall(LongjingCredits.pause, ());
        vm.prank(safe);
        timelock.schedule(address(credits), 0, pause, bytes32(0), bytes32(0), 7 days);
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(credits), 0, pause, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + 1);
        vm.prank(safe);
        timelock.execute(address(credits), 0, pause, bytes32(0), bytes32(0));
        assertTrue(credits.paused());
    }

    function test_refusesAHandoverByAnotherAccount() public {
        DeployGovernance script = new DeployGovernance();
        LongjingCredits credits =
            new LongjingCredits(makeAddr("server"), bytes32(uint256(1)), bytes32(uint256(2)), 0.001 ether, 0);
        TimelockController timelock = script.deployTimelock(safe, 7 days);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(script)));
        script.handOverCredits(credits, timelock);
        assertEq(credits.owner(), address(this));
    }
}
