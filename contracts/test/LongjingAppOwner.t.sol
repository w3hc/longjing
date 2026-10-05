// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IDstackApp} from "../src/IDstackApp.sol";
import {LongjingAppOwner} from "../src/LongjingAppOwner.sol";

/// @dev The DstackApp functions Longjing's governance calls, with the same access control.
contract MockDstackApp is Ownable2Step {
    mapping(bytes32 => bool) public allowedComposeHashes;
    bool public requireTcbUpToDate;

    event ComposeHashAdded(bytes32 composeHash);
    event ComposeHashRemoved(bytes32 composeHash);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function addComposeHash(bytes32 composeHash) external onlyOwner {
        require(composeHash != bytes32(0), "invalid compose hash");
        allowedComposeHashes[composeHash] = true;
        emit ComposeHashAdded(composeHash);
    }

    function removeComposeHash(bytes32 composeHash) external onlyOwner {
        allowedComposeHashes[composeHash] = false;
        emit ComposeHashRemoved(composeHash);
    }

    function setRequireTcbUpToDate(bool requireUpToDate) external onlyOwner {
        requireTcbUpToDate = requireUpToDate;
    }
}

contract LongjingAppOwnerTest is Test {
    uint256 constant DELAY = 7 days;
    bytes32 constant V1 = keccak256("v1");
    bytes32 constant V2 = keccak256("v2");

    address deployer = makeAddr("deployer");
    address safe = makeAddr("safe");
    address stranger = makeAddr("stranger");

    MockDstackApp app;
    TimelockController timelock;
    LongjingAppOwner appOwner;

    function setUp() public {
        app = new MockDstackApp(deployer);
        vm.startPrank(deployer);
        app.addComposeHash(V1);
        app.setRequireTcbUpToDate(true);
        vm.stopPrank();

        address[] memory safeOnly = new address[](1);
        safeOnly[0] = safe;
        timelock = new TimelockController(DELAY, safeOnly, safeOnly, address(0));
        appOwner = new LongjingAppOwner(IDstackApp(address(app)), address(timelock), safe);

        vm.prank(deployer);
        app.transferOwnership(address(appOwner));
        appOwner.acceptOwnership();
    }

    function _batch(bytes[] memory calls)
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](calls.length);
        values = new uint256[](calls.length);
        payloads = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            targets[i] = address(appOwner);
            payloads[i] = abi.encodeCall(LongjingAppOwner.execute, (calls[i]));
        }
    }

    function _release() internal pure returns (bytes[] memory calls) {
        calls = new bytes[](2);
        calls[0] = abi.encodeCall(IDstackApp.addComposeHash, (V2));
        calls[1] = abi.encodeCall(IDstackApp.removeComposeHash, (V1));
    }

    function test_takesOwnership() public view {
        assertEq(app.owner(), address(appOwner));
        assertEq(app.pendingOwner(), address(0));
    }

    function test_releaseGoesThroughTheTimelock() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch(_release());

        vm.prank(safe);
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), DELAY);

        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(safe);
        vm.expectRevert();
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + 1);
        vm.prank(safe);
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));

        assertTrue(app.allowedComposeHashes(V2));
        assertFalse(app.allowedComposeHashes(V1));
    }

    function test_cannotScheduleUnderTheDelay() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch(_release());
        vm.prank(safe);
        vm.expectRevert();
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), DELAY - 1);
    }

    function test_onlyTheTimelockExecutes() public {
        bytes memory add = abi.encodeCall(IDstackApp.addComposeHash, (V2));
        vm.prank(safe);
        vm.expectRevert(LongjingAppOwner.NotTimelock.selector);
        appOwner.execute(add);
    }

    function test_executeBubblesRevertReasons() public {
        bytes memory add = abi.encodeCall(IDstackApp.addComposeHash, (bytes32(0)));
        vm.prank(address(timelock));
        vm.expectRevert("invalid compose hash");
        appOwner.execute(add);
    }

    function test_guardianRemovesWithoutDelay() public {
        vm.prank(safe);
        appOwner.removeComposeHash(V1);
        assertFalse(app.allowedComposeHashes(V1));
    }

    function test_onlyTheGuardianRemoves() public {
        vm.prank(stranger);
        vm.expectRevert(LongjingAppOwner.NotGuardian.selector);
        appOwner.removeComposeHash(V1);
    }

    function test_guardianCannotAdd() public {
        vm.prank(safe);
        vm.expectRevert(LongjingAppOwner.NotTimelock.selector);
        appOwner.execute(abi.encodeCall(IDstackApp.addComposeHash, (V2)));

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        app.addComposeHash(V2);
    }

    function test_onlyTheTimelockSetsTheGuardian() public {
        vm.prank(safe);
        vm.expectRevert(LongjingAppOwner.NotTimelock.selector);
        appOwner.setGuardian(stranger);

        vm.prank(address(timelock));
        appOwner.setGuardian(address(0));
        assertEq(appOwner.guardian(), address(0));

        vm.prank(safe);
        vm.expectRevert(LongjingAppOwner.NotGuardian.selector);
        appOwner.removeComposeHash(V1);
    }

    function test_timelockHandsTheAppOver() public {
        address next = makeAddr("next");
        vm.prank(address(timelock));
        appOwner.execute(abi.encodeCall(IDstackApp.transferOwnership, (next)));
        vm.prank(next);
        app.acceptOwnership();
        assertEq(app.owner(), next);
    }

    function test_rejectsZeroAddresses() public {
        vm.expectRevert(LongjingAppOwner.ZeroAddress.selector);
        new LongjingAppOwner(IDstackApp(address(0)), address(timelock), safe);
        vm.expectRevert(LongjingAppOwner.ZeroAddress.selector);
        new LongjingAppOwner(IDstackApp(address(app)), address(0), safe);
    }
}
