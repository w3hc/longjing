// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {LongjingCredits} from "../src/LongjingCredits.sol";
import {PoseidonHasher} from "../src/PoseidonHasher.sol";

/// Deploys at the fixtures' address with their server key, so the real
/// SettlementVerifier accepts the proofs in test/fixtures/settlement.json
/// (regenerate with scripts/testing/generate-settlement-fixtures.ts)
contract LongjingCreditsTest is Test {
    LongjingCredits public longjing;
    string internal fixtures;

    address public server;
    address public user1;
    address public user2;

    uint256 public constant C_MAX = 0.001 ether;
    uint256 public constant DEPOSIT = 0.01 ether;
    uint256 internal constant FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    bytes32 public commitment1;
    bytes32 public commitment2;

    function setUp() public {
        server = makeAddr("server");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        fixtures = vm.readFile("test/fixtures/settlement.json");
        assertEq(C_MAX, vm.parseJsonUint(fixtures, ".cMax"));
        assertEq(DEPOSIT, vm.parseJsonUint(fixtures, ".deposit"));
        address at = vm.parseJsonAddress(fixtures, ".contract");
        deployCodeTo(
            "LongjingCredits.sol:LongjingCredits", abi.encode(server, _refundKey().x, _refundKey().y, C_MAX), at
        );
        longjing = LongjingCredits(at);

        commitment1 = bytes32(PoseidonHasher.hash(uint256(keccak256("secret1")) % FIELD_MODULUS));
        commitment2 = bytes32(PoseidonHasher.hash(uint256(keccak256("secret2")) % FIELD_MODULUS));

        vm.deal(user1, 10 ether);
        vm.deal(user2, 10 ether);
    }

    // ============ Deposit ============

    function test_Deposit_RecordsNoteAndLeaf() public {
        vm.expectEmit(true, false, false, true);
        emit LongjingCredits.Deposited(commitment1, DEPOSIT, 0);
        vm.prank(user1);
        longjing.deposit{value: DEPOSIT}(commitment1);

        LongjingCredits.Note memory note = longjing.getNote(commitment1);
        assertEq(note.amount, DEPOSIT);
        assertEq(note.depositedAt, block.timestamp);
        assertEq(note.leafIndex, 0);
        assertEq(uint256(note.status), uint256(LongjingCredits.Status.Active));

        // The leaf binds D, so a proof can't claim another amount
        assertEq(longjing.leaves(0), bytes32(PoseidonHasher.hash(uint256(commitment1), DEPOSIT)));
        assertEq(longjing.getLeafCount(), 1);
    }

    function test_Deposit_RevertsBelowCMax() public {
        vm.prank(user1);
        vm.expectRevert(LongjingCredits.InvalidDepositAmount.selector);
        longjing.deposit{value: C_MAX - 1}(commitment1);
    }

    function test_Deposit_RevertsAt2To128() public {
        vm.deal(user1, 2 ** 128);
        vm.prank(user1);
        vm.expectRevert(LongjingCredits.InvalidDepositAmount.selector);
        longjing.deposit{value: 2 ** 128}(commitment1);
    }

    function test_Deposit_RevertsOnCommitmentOutsideTheField() public {
        vm.prank(user1);
        vm.expectRevert(LongjingCredits.InvalidCommitment.selector);
        longjing.deposit{value: DEPOSIT}(bytes32(FIELD_MODULUS));
    }

    function test_Deposit_RevertsOnExistingCommitment() public {
        vm.startPrank(user1);
        longjing.deposit{value: DEPOSIT}(commitment1);
        vm.expectRevert(LongjingCredits.NoteAlreadyExists.selector);
        longjing.deposit{value: DEPOSIT}(commitment1);
        vm.stopPrank();
    }

    function test_Deposit_RevertsWhenPaused() public {
        longjing.pause();
        vm.prank(user1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        longjing.deposit{value: DEPOSIT}(commitment1);
    }

    // ============ Merkle tree ============

    function test_MerkleProof_ReconstructsTheRootForEveryLeaf() public {
        for (uint256 i = 0; i < 5; i++) {
            _deposit(bytes32(PoseidonHasher.hash(i + 1)), DEPOSIT + i);
        }
        for (uint256 i = 0; i < 5; i++) {
            assertEq(_rootFrom(i, longjing.leaves(i)), longjing.merkleRoot());
        }
    }

    function test_RootHistory_KeepsRecentRoots() public {
        bytes32 empty = longjing.merkleRoot();
        assertTrue(longjing.isKnownRoot(empty));
        assertFalse(longjing.isKnownRoot(bytes32(0)));

        _deposit(commitment1, DEPOSIT);
        bytes32 first = longjing.merkleRoot();
        assertTrue(longjing.isKnownRoot(first));
        assertTrue(longjing.isKnownRoot(empty));

        // ROOT_HISTORY_SIZE later deposits push both out
        for (uint256 i = 0; i < longjing.ROOT_HISTORY_SIZE(); i++) {
            _deposit(bytes32(PoseidonHasher.hash(i + 100)), DEPOSIT);
        }
        assertFalse(longjing.isKnownRoot(empty));
        assertFalse(longjing.isKnownRoot(first));
        assertTrue(longjing.isKnownRoot(longjing.merkleRoot()));
    }

    // ============ Withdrawal ============

    function test_InitiateWithdrawal_StartsTheWindowAndRemovesTheLeaf() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        _deposit(commitment2, DEPOSIT);

        vm.expectEmit(true, true, false, true);
        emit LongjingCredits.WithdrawalInitiated(
            e.commitment, e.nullifier, e.signalX, e.signalY, e.payout, _recipient(), block.timestamp + 3 days
        );
        _initiate(e);

        assertEq(uint256(longjing.getNote(e.commitment).status), uint256(LongjingCredits.Status.Exiting));
        assertEq(longjing.leaves(0), bytes32(0));
        assertEq(_rootFrom(1, longjing.leaves(1)), longjing.merkleRoot());
        (uint256 nullifier,,, uint256 payout, address recipient, uint256 exitAt) = longjing.exits(e.commitment);
        assertEq(nullifier, e.nullifier);
        assertEq(payout, e.payout);
        assertEq(recipient, _recipient());
        assertEq(exitAt, block.timestamp + longjing.CHALLENGE_WINDOW());
    }

    function test_FinalizeWithdrawal_PaysDPlusRMinusSpendingAfterTheWindow() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        _initiate(e);

        vm.warp(block.timestamp + longjing.CHALLENGE_WINDOW() - 1);
        vm.expectRevert(LongjingCredits.ChallengeWindowOpen.selector);
        longjing.finalizeWithdrawal(e.commitment);

        vm.warp(block.timestamp + 1);
        vm.prank(user2);
        longjing.finalizeWithdrawal(e.commitment);

        // Two requests at C_MAX each, refunded 0.001 ether in total
        assertEq(e.payout, DEPOSIT + C_MAX - 2 * C_MAX);
        assertEq(_recipient().balance, e.payout);
        assertEq(longjing.operatorBalance(), DEPOSIT - e.payout);
        assertEq(address(longjing).balance, DEPOSIT - e.payout);
        assertEq(uint256(longjing.getNote(e.commitment).status), uint256(LongjingCredits.Status.Closed));

        vm.expectRevert(LongjingCredits.NoteNotExiting.selector);
        longjing.finalizeWithdrawal(e.commitment);
    }

    function test_Withdrawal_FromGenesisPaysTheWholeDeposit() public {
        Exit memory e = _exit(".genesis");
        _deposit(e.commitment, DEPOSIT);
        _initiate(e);
        vm.warp(block.timestamp + longjing.CHALLENGE_WINDOW());
        longjing.finalizeWithdrawal(e.commitment);
        assertEq(_recipient().balance, DEPOSIT);
        assertEq(longjing.operatorBalance(), 0);
    }

    function test_InitiateWithdrawal_RejectsAnotherRecipient() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        vm.expectRevert(LongjingCredits.InvalidProof.selector);
        longjing.initiateWithdrawal(e.commitment, user2, _refundKey(), e.proof, e.nullifier, e.signalY, e.payout);
    }

    function test_InitiateWithdrawal_RejectsAnInflatedPayout() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        vm.expectRevert(LongjingCredits.InvalidProof.selector);
        longjing.initiateWithdrawal(e.commitment, _recipient(), _refundKey(), e.proof, e.nullifier, e.signalY, DEPOSIT);
    }

    function test_InitiateWithdrawal_RejectsAPayoutAboveTheDeposit() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        vm.expectRevert(LongjingCredits.PayoutExceedsDeposit.selector);
        longjing.initiateWithdrawal(
            e.commitment, _recipient(), _refundKey(), e.proof, e.nullifier, e.signalY, DEPOSIT + 1
        );
    }

    function test_InitiateWithdrawal_RejectsAnotherDeposit() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT + 1);
        vm.expectRevert(LongjingCredits.InvalidProof.selector);
        _initiate(e);
    }

    function test_InitiateWithdrawal_RejectsAnUnknownRefundKey() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        vm.expectRevert(LongjingCredits.UnknownRefundKey.selector);
        longjing.initiateWithdrawal(
            e.commitment,
            _recipient(),
            LongjingCredits.EdDSAPublicKey(bytes32(uint256(1)), bytes32(uint256(2))),
            e.proof,
            e.nullifier,
            e.signalY,
            e.payout
        );
    }

    function test_InitiateWithdrawal_RevertsTwice() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        _initiate(e);
        vm.expectRevert(LongjingCredits.NoteNotActive.selector);
        _initiate(e);
    }

    function test_Withdrawal_StaysOpenWhilePaused() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        longjing.pause();
        _initiate(e);
        vm.warp(block.timestamp + longjing.CHALLENGE_WINDOW());
        longjing.finalizeWithdrawal(e.commitment);
        assertEq(_recipient().balance, e.payout);
    }

    function test_ClaimExpired_RevertsWhileExiting() public {
        Exit memory e = _exit(".honest");
        _deposit(e.commitment, DEPOSIT);
        vm.warp(longjing.noteExpiry(e.commitment) - 1);
        _initiate(e);
        vm.warp(block.timestamp + 1);
        vm.prank(server);
        vm.expectRevert(LongjingCredits.NoteNotActive.selector);
        longjing.claimExpired(e.commitment);
    }

    function test_WithdrawalSignalX_MatchesTheFixture() public view {
        assertEq(longjing.withdrawalSignalX(_recipient()), _exit(".honest").signalX);
    }

    // ============ Expiry ============

    function test_NoteExpiry_IsDepositPlusTtl() public {
        _deposit(commitment1, DEPOSIT);
        assertEq(longjing.noteExpiry(commitment1), block.timestamp + longjing.NOTE_TTL());
    }

    function test_ClaimExpired_CreditsOperatorAndRemovesLeaf() public {
        _deposit(commitment1, DEPOSIT);
        _deposit(commitment2, DEPOSIT);
        vm.warp(longjing.noteExpiry(commitment1));

        vm.expectEmit(true, false, false, true);
        emit LongjingCredits.NoteExpiredClaimed(commitment1, DEPOSIT);
        vm.prank(server);
        longjing.claimExpired(commitment1);

        assertEq(uint256(longjing.getNote(commitment1).status), uint256(LongjingCredits.Status.Expired));
        assertEq(longjing.operatorBalance(), DEPOSIT);
        assertEq(longjing.leaves(0), bytes32(0));
        // The other note's path still opens to the new root
        assertEq(_rootFrom(1, longjing.leaves(1)), longjing.merkleRoot());
    }

    function test_ClaimExpired_RevertsBeforeTtl() public {
        _deposit(commitment1, DEPOSIT);
        vm.warp(longjing.noteExpiry(commitment1) - 1);
        vm.prank(server);
        vm.expectRevert(LongjingCredits.NoteNotExpired.selector);
        longjing.claimExpired(commitment1);
    }

    function test_ClaimExpired_OnlyOperator() public {
        _deposit(commitment1, DEPOSIT);
        vm.warp(longjing.noteExpiry(commitment1));
        vm.expectRevert(LongjingCredits.Unauthorized.selector);
        longjing.claimExpired(commitment1);
    }

    function test_ClaimExpired_RevertsTwice() public {
        _deposit(commitment1, DEPOSIT);
        vm.warp(longjing.noteExpiry(commitment1));
        vm.startPrank(server);
        longjing.claimExpired(commitment1);
        vm.expectRevert(LongjingCredits.NoteNotActive.selector);
        longjing.claimExpired(commitment1);
        vm.stopPrank();
    }

    function test_ClaimExpired_RevertsWhilePaused() public {
        _deposit(commitment1, DEPOSIT);
        vm.warp(longjing.noteExpiry(commitment1));
        longjing.pause();
        vm.prank(server);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        longjing.claimExpired(commitment1);
    }

    function test_NoteExpiry_PausedTimeBeforeDepositDoesNotCount() public {
        longjing.pause();
        vm.warp(block.timestamp + 100 days);
        longjing.unpause();

        _deposit(commitment1, DEPOSIT);
        assertEq(longjing.noteExpiry(commitment1), block.timestamp + longjing.NOTE_TTL());
    }

    /// The ethereum/zkapi flaw: the owner pauses, waits out the TTL, then sweeps the note
    function test_PauseCannotTriggerExpiry() public {
        _deposit(commitment1, DEPOSIT);
        uint256 expiry = longjing.noteExpiry(commitment1);
        uint256 ttl = longjing.NOTE_TTL();

        longjing.pause();
        vm.warp(expiry);
        assertEq(longjing.noteExpiry(commitment1), expiry + ttl);

        longjing.unpause();
        vm.prank(server);
        vm.expectRevert(LongjingCredits.NoteNotExpired.selector);
        longjing.claimExpired(commitment1);
    }

    // ============ Operator balance ============

    function test_WithdrawOperatorBalance_PaysServer() public {
        _deposit(commitment1, DEPOSIT);
        vm.warp(longjing.noteExpiry(commitment1));
        vm.startPrank(server);
        longjing.claimExpired(commitment1);
        longjing.withdrawOperatorBalance();
        vm.stopPrank();

        assertEq(server.balance, DEPOSIT);
        assertEq(longjing.operatorBalance(), 0);
    }

    function test_WithdrawOperatorBalance_OnlyServer() public {
        vm.expectRevert(LongjingCredits.Unauthorized.selector);
        longjing.withdrawOperatorBalance();
    }

    // ============ Timelock ============

    function test_ProposeChange_RevertsForNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, user1);
    }

    function test_ProposeChange_RevertsOnZeroAddress() public {
        vm.expectRevert(LongjingCredits.ZeroAddress.selector);
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, address(0));
    }

    function test_ExecuteChange_WaitsForTheDelay() public {
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, user2);

        vm.warp(block.timestamp + longjing.ADMIN_DELAY() - 1);
        vm.expectRevert(LongjingCredits.TimelockNotExpired.selector);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);

        vm.warp(block.timestamp + 1);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
        assertEq(longjing.serverAddress(), user2);
        (, uint256 eta) = longjing.pendingChanges(LongjingCredits.Target.ServerAddress);
        assertEq(eta, 0);
    }

    function test_ExecuteChange_SwapsVerifier() public {
        address replacement = makeAddr("verifier");
        longjing.proposeChange(LongjingCredits.Target.SettlementVerifier, replacement);
        vm.warp(block.timestamp + longjing.ADMIN_DELAY());
        longjing.executeChange(LongjingCredits.Target.SettlementVerifier);
        assertEq(address(longjing.settlementVerifier()), replacement);
    }

    function test_ExecuteChange_RevertsWithoutProposal() public {
        vm.expectRevert(LongjingCredits.NoPendingChange.selector);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
    }

    function test_CancelChange() public {
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, user2);
        longjing.cancelChange(LongjingCredits.Target.ServerAddress);
        vm.warp(block.timestamp + longjing.ADMIN_DELAY());
        vm.expectRevert(LongjingCredits.NoPendingChange.selector);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
    }

    // ============ Helpers ============

    struct Exit {
        bytes32 commitment;
        uint256[8] proof;
        uint256 nullifier;
        uint256 signalX;
        uint256 signalY;
        uint256 payout;
    }

    function _exit(string memory _name) internal view returns (Exit memory e) {
        e.commitment = bytes32(vm.parseJsonUint(fixtures, string.concat(_name, ".commitment")));
        uint256[] memory proof = vm.parseJsonUintArray(fixtures, string.concat(_name, ".proof"));
        for (uint256 i = 0; i < 8; i++) {
            e.proof[i] = proof[i];
        }
        e.nullifier = vm.parseJsonUint(fixtures, string.concat(_name, ".nullifier"));
        e.signalX = vm.parseJsonUint(fixtures, string.concat(_name, ".signalX"));
        e.signalY = vm.parseJsonUint(fixtures, string.concat(_name, ".signalY"));
        e.payout = vm.parseJsonUint(fixtures, string.concat(_name, ".payout"));
    }

    function _initiate(Exit memory _e) internal {
        longjing.initiateWithdrawal(
            _e.commitment, _recipient(), _refundKey(), _e.proof, _e.nullifier, _e.signalY, _e.payout
        );
    }

    function _recipient() internal view returns (address) {
        return vm.parseJsonAddress(fixtures, ".recipient");
    }

    function _refundKey() internal view returns (LongjingCredits.EdDSAPublicKey memory) {
        return LongjingCredits.EdDSAPublicKey(
            bytes32(vm.parseJsonUint(fixtures, ".serverPublicKeyX")),
            bytes32(vm.parseJsonUint(fixtures, ".serverPublicKeyY"))
        );
    }

    function _deposit(bytes32 _commitment, uint256 _amount) internal {
        vm.prank(user1);
        longjing.deposit{value: _amount}(_commitment);
    }

    function _rootFrom(uint256 _leafIndex, bytes32 _leaf) internal view returns (bytes32 node) {
        (bytes32[20] memory pathElements, uint8[20] memory pathIndices) = longjing.getMerkleProof(_leafIndex);
        node = _leaf;
        for (uint256 level = 0; level < 20; level++) {
            node = pathIndices[level] == 0
                ? bytes32(PoseidonHasher.hash(uint256(node), uint256(pathElements[level])))
                : bytes32(PoseidonHasher.hash(uint256(pathElements[level]), uint256(node)));
        }
    }
}
