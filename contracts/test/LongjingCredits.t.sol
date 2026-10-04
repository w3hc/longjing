// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {Test} from 'forge-std/Test.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {LongjingCredits} from '../src/LongjingCredits.sol';
import {PoseidonHasher} from '../src/PoseidonHasher.sol';
import {MockWithdrawalVerifier} from './MockWithdrawalVerifier.sol';
import {MockSlashingVerifier} from './MockSlashingVerifier.sol';
import {MockRefundVerifier} from './MockRefundVerifier.sol';
import {MockPolicyVerifier} from './MockPolicyVerifier.sol';

contract LongjingCreditsTest is Test {
    LongjingCredits public longjing;
    MockWithdrawalVerifier public mockWithdrawalVerifier;
    MockRefundVerifier public mockRefundVerifier;
    MockSlashingVerifier public mockSlashingVerifier;
    MockPolicyVerifier public mockPolicyVerifier;

    address public owner;
    address public server;
    address public user1;
    address public user2;
    address public slasher;

    uint256 public constant MIN_RLN_STAKE = 0.005 ether;
    uint256 public constant MIN_POLICY_STAKE = 0.005 ether;
    uint256 public constant MIN_TOTAL_DEPOSIT =
        MIN_RLN_STAKE + MIN_POLICY_STAKE;

    // Test identity commitments (Hash of secret keys)
    bytes32 public idCommitment1;
    bytes32 public idCommitment2;
    bytes32 public secretKey1;
    bytes32 public secretKey2;

    event DepositMade(
        bytes32 indexed idCommitment,
        uint256 rlnStake,
        uint256 policyStake,
        uint256 timestamp
    );

    event WithdrawalMade(
        bytes32 indexed idCommitment,
        uint256 amount,
        address indexed recipient
    );

    event DoubleSpendSlashed(
        bytes32 indexed secretKey,
        bytes32 indexed nullifier,
        address indexed slasher,
        uint256 reward
    );

    event PolicyViolationSlashed(
        bytes32 indexed nullifier,
        bytes32 indexed idCommitment,
        uint256 amountBurned,
        bytes32 evidenceHash
    );

    function setUp() public {
        owner = address(this);
        server = makeAddr('server');
        user1 = makeAddr('user1');
        user2 = makeAddr('user2');
        slasher = makeAddr('slasher');

        // Deploy contract with dummy server public key
        bytes32 serverPubKeyX = bytes32(uint256(1));
        bytes32 serverPubKeyY = bytes32(uint256(2));
        longjing = new LongjingCredits(
            server,
            MIN_RLN_STAKE,
            MIN_POLICY_STAKE,
            serverPubKeyX,
            serverPubKeyY
        );

        // Deploy mock verifiers for testing (production verifiers reject mock proofs)
        mockWithdrawalVerifier = new MockWithdrawalVerifier();
        mockRefundVerifier = new MockRefundVerifier();
        mockSlashingVerifier = new MockSlashingVerifier();
        mockPolicyVerifier = new MockPolicyVerifier();

        // Replace production verifiers with mocks for testing
        longjing.proposeChange(LongjingCredits.Target.WithdrawalVerifier, address(mockWithdrawalVerifier));
        longjing.proposeChange(LongjingCredits.Target.RefundVerifier, address(mockRefundVerifier));
        longjing.proposeChange(LongjingCredits.Target.SlashingVerifier, address(mockSlashingVerifier));
        longjing.proposeChange(LongjingCredits.Target.PolicyVerifier, address(mockPolicyVerifier));
        vm.warp(block.timestamp + longjing.ADMIN_DELAY());
        longjing.executeChange(LongjingCredits.Target.WithdrawalVerifier);
        longjing.executeChange(LongjingCredits.Target.RefundVerifier);
        longjing.executeChange(LongjingCredits.Target.SlashingVerifier);
        longjing.executeChange(LongjingCredits.Target.PolicyVerifier);

        // Generate test identity commitments using Poseidon (matching circuit)
        secretKey1 = keccak256(abi.encodePacked('secret1'));
        secretKey2 = keccak256(abi.encodePacked('secret2'));
        // Use Poseidon hash: idCommitment = Poseidon(secretKey)
        idCommitment1 = bytes32(PoseidonHasher.hash(uint256(secretKey1)));
        idCommitment2 = bytes32(PoseidonHasher.hash(uint256(secretKey2)));

        // Fund test users
        vm.deal(user1, 10 ether);
        vm.deal(user2, 10 ether);
        vm.deal(slasher, 1 ether);
    }

    // ============ Deposit Tests ============

    function test_Deposit_Success() public {
        uint256 depositAmount = 0.01 ether;

        vm.startPrank(user1);

        vm.expectEmit(true, false, false, true);
        emit DepositMade(
            idCommitment1,
            depositAmount / 2,
            depositAmount / 2,
            block.timestamp
        );

        longjing.deposit{value: depositAmount}(idCommitment1);
        vm.stopPrank();

        // Verify deposit was recorded
        LongjingCredits.Deposit memory dep = longjing.getDeposit(idCommitment1);
        assertEq(dep.idCommitment, idCommitment1);
        assertEq(dep.rlnStake, depositAmount / 2);
        assertEq(dep.policyStake, depositAmount / 2);
        assertTrue(dep.active);
        assertEq(dep.timestamp, block.timestamp);

        // Verify anonymity set size increased
        assertEq(longjing.getAnonymitySetSize(), 1);
    }

    function test_Deposit_InsufficientAmount() public {
        vm.startPrank(user1);

        vm.expectRevert(LongjingCredits.InsufficientDeposit.selector);
        longjing.deposit{value: 0.001 ether}(idCommitment1);

        vm.stopPrank();
    }

    function test_Deposit_AlreadyExists() public {
        vm.startPrank(user1);

        // First deposit succeeds
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // Second deposit with same commitment fails
        vm.expectRevert(LongjingCredits.DepositAlreadyExists.selector);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        vm.stopPrank();
    }

    function test_Deposit_MultipleUsers() public {
        // User 1 deposits
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // User 2 deposits
        vm.prank(user2);
        longjing.deposit{value: 0.02 ether}(idCommitment2);

        // Verify both deposits
        assertEq(longjing.getAnonymitySetSize(), 2);
        assertTrue(longjing.getDeposit(idCommitment1).active);
        assertTrue(longjing.getDeposit(idCommitment2).active);
    }

    // ============ Withdrawal Tests ============

    function test_Withdraw_Success() public {
        uint256 depositAmount = 0.01 ether;

        // User deposits
        vm.prank(user1);
        longjing.deposit{value: depositAmount}(idCommitment1);

        // User withdraws
        address payable recipient = payable(makeAddr('recipient'));
        uint256 balanceBefore = recipient.balance;

        // Generate mock ZK proof (in production, this would be generated by the circuit)
        uint256[8] memory proof = _generateMockProof();
        // Public signals: [signalX (input), merkleRootExpected (input), nullifier (output), signalY (output), idCommitment (output), merkleRoot (output)]
        uint256[7] memory publicSignals = [
            0, // signalX (RLN signal x input)
            uint256(longjing.merkleRoot()), // merkleRootExpected input
            uint256(uint160(address(recipient))), // recipient input (front-running protection)
            0, // nullifier output
            0, // signalY output
            uint256(idCommitment1), // idCommitment output
            uint256(longjing.merkleRoot()) // merkleRoot output
        ];

        vm.prank(user1);
        vm.expectEmit(true, true, false, true);
        emit WithdrawalMade(idCommitment1, depositAmount, recipient);

        longjing.withdraw(idCommitment1, recipient, proof, publicSignals);

        // Verify withdrawal
        assertEq(recipient.balance, balanceBefore + depositAmount);

        LongjingCredits.Deposit memory dep = longjing.getDeposit(idCommitment1);
        assertFalse(dep.active);
        assertEq(dep.rlnStake, 0);
        assertEq(dep.policyStake, 0);
    }

    function test_Withdraw_InvalidProof() public {
        // User deposits
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // Try to withdraw with invalid proof
        address payable recipient = payable(makeAddr('recipient'));
        uint256[8] memory proof = _generateInvalidProof();
        uint256[7] memory publicSignals = [
            0, // signalX
            uint256(longjing.merkleRoot()), // merkleRootExpected
            uint256(uint160(address(recipient))), // recipient (front-running protection)
            0, 0, // nullifier, signalY
            uint256(idCommitment1), // idCommitment
            uint256(longjing.merkleRoot()) // merkleRoot
        ];

        vm.prank(user1);
        vm.expectRevert(LongjingCredits.InvalidProof.selector);
        longjing.withdraw(idCommitment1, recipient, proof, publicSignals);
    }

    function test_Withdraw_DepositNotFound() public {
        address payable recipient = payable(makeAddr('recipient'));
        uint256[8] memory proof = _generateMockProof();
        uint256[7] memory publicSignals = [
            0, // signalX
            uint256(longjing.merkleRoot()), // merkleRootExpected
            uint256(uint160(address(recipient))), // recipient (front-running protection)
            0, 0, // nullifier, signalY
            uint256(idCommitment1), // idCommitment
            uint256(longjing.merkleRoot()) // merkleRoot
        ];

        vm.expectRevert(LongjingCredits.DepositNotFound.selector);
        longjing.withdraw(idCommitment1, recipient, proof, publicSignals);
    }

    // Helper functions for mock proofs
    function _generateMockProof() internal pure returns (uint256[8] memory) {
        // Mock proof that will pass verification in the mock verifier
        // In production, this would be generated by snarkjs from the circuit
        return [uint256(1), 2, 3, 4, 5, 6, 7, 8];
    }

    function _generateInvalidProof() internal pure returns (uint256[8] memory) {
        // Mock invalid proof that will fail verification
        return [uint256(0), 0, 0, 0, 0, 0, 0, 0];
    }

    // ============ Double-Spend Slashing Tests ============

    function test_SlashDoubleSpend_Success() public {
        uint256 depositAmount = 0.01 ether;

        // User deposits
        vm.prank(user1);
        longjing.deposit{value: depositAmount}(idCommitment1);

        // Simulate double-spend detection with ZK proof
        bytes32 nullifier = keccak256(abi.encodePacked('nullifier1'));

        // Mock ZK proof (in production, this would be a real Groth16 proof)
        uint256[8] memory proof = [
            uint256(1),
            2,
            3,
            4,
            5,
            6,
            7,
            8
        ];

        // Public signals: [secretKeyClaimed (input), nullifierExpected (input), idCommitment (output), nullifier (output)]
        uint256[4] memory publicSignals = [
            uint256(secretKey1), // secretKeyClaimed input
            uint256(nullifier), // nullifierExpected input
            uint256(idCommitment1), // idCommitment output
            uint256(nullifier) // nullifier output
        ];

        uint256 slasherBalanceBefore = slasher.balance;

        // Slasher reports double-spend
        vm.prank(slasher);
        vm.expectEmit(true, true, true, true);
        emit DoubleSpendSlashed(
            secretKey1,
            nullifier,
            slasher,
            depositAmount / 2
        );

        longjing.slashDoubleSpend(
            secretKey1,
            nullifier,
            idCommitment1,
            proof,
            publicSignals
        );

        // Verify slashing
        assertTrue(longjing.revealedSecretKeys(secretKey1));
        assertTrue(longjing.slashedNullifiers(nullifier));
        assertEq(slasher.balance, slasherBalanceBefore + depositAmount / 2);

        LongjingCredits.Deposit memory dep = longjing.getDeposit(idCommitment1);
        assertFalse(dep.active);
        assertEq(dep.rlnStake, 0);
    }

    function test_SlashDoubleSpend_AlreadySlashed() public {
        // User deposits
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // First slash succeeds
        bytes32 nullifier = keccak256(abi.encodePacked('nullifier1'));

        // Mock ZK proof
        uint256[8] memory proof = [
            uint256(1),
            2,
            3,
            4,
            5,
            6,
            7,
            8
        ];

        // Public signals: [secretKeyClaimed (input), nullifierExpected (input), idCommitment (output), nullifier (output)]
        uint256[4] memory publicSignals = [
            uint256(secretKey1),
            uint256(nullifier),
            uint256(idCommitment1),
            uint256(nullifier)
        ];

        vm.prank(slasher);
        longjing.slashDoubleSpend(
            secretKey1,
            nullifier,
            idCommitment1,
            proof,
            publicSignals
        );

        // Second slash fails
        vm.prank(slasher);
        vm.expectRevert(LongjingCredits.AlreadySlashed.selector);
        longjing.slashDoubleSpend(
            secretKey1,
            nullifier,
            idCommitment1,
            proof,
            publicSignals
        );
    }

    // ============ Admin Tests ============

    function test_SetServerAddress() public {
        address newServer = makeAddr('newServer');

        longjing.proposeChange(LongjingCredits.Target.ServerAddress, newServer);
        vm.warp(block.timestamp + longjing.ADMIN_DELAY());
        longjing.executeChange(LongjingCredits.Target.ServerAddress);

        assertEq(longjing.serverAddress(), newServer);
    }

    function test_SetMinStakes() public {
        uint256 newRlnStake = 0.01 ether;
        uint256 newPolicyStake = 0.02 ether;

        longjing.setMinStakes(newRlnStake, newPolicyStake);

        assertEq(longjing.minRlnStake(), newRlnStake);
        assertEq(longjing.minPolicyStake(), newPolicyStake);
    }

    function test_PauseUnpause() public {
        // Pause
        longjing.pause();

        // Deposits should fail when paused
        vm.prank(user1);
        vm.expectRevert();
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // Unpause
        longjing.unpause();

        // Deposits should work again
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        assertTrue(longjing.getDeposit(idCommitment1).active);
    }

    // ============ View Function Tests ============

    function test_GetAllIdentityCommitments() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        vm.prank(user2);
        longjing.deposit{value: 0.01 ether}(idCommitment2);

        bytes32[] memory commitments = longjing.getAllIdentityCommitments();
        assertEq(commitments.length, 2);
        assertEq(commitments[0], idCommitment1);
        assertEq(commitments[1], idCommitment2);
    }

    function test_MerkleRootUpdates() public {
        bytes32 rootBefore = longjing.merkleRoot();

        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        bytes32 rootAfter = longjing.merkleRoot();
        assertTrue(rootBefore != rootAfter);
    }

    function test_MerkleProofGeneration_MultipleLeaves() public {
        // This test validates H-2 fix: Merkle proof generation must work for >2 leaves
        // Create 5 identity commitments
        bytes32 id1 = bytes32(PoseidonHasher.hash(uint256(keccak256('user1'))));
        bytes32 id2 = bytes32(PoseidonHasher.hash(uint256(keccak256('user2'))));
        bytes32 id3 = bytes32(PoseidonHasher.hash(uint256(keccak256('user3'))));
        bytes32 id4 = bytes32(PoseidonHasher.hash(uint256(keccak256('user4'))));
        bytes32 id5 = bytes32(PoseidonHasher.hash(uint256(keccak256('user5'))));

        // Create funded depositor addresses
        address depositor1 = makeAddr('depositor1');
        address depositor2 = makeAddr('depositor2');
        address depositor3 = makeAddr('depositor3');
        address depositor4 = makeAddr('depositor4');
        address depositor5 = makeAddr('depositor5');

        vm.deal(depositor1, 1 ether);
        vm.deal(depositor2, 1 ether);
        vm.deal(depositor3, 1 ether);
        vm.deal(depositor4, 1 ether);
        vm.deal(depositor5, 1 ether);

        // Deposit all 5
        vm.prank(depositor1);
        longjing.deposit{value: 0.01 ether}(id1);

        vm.prank(depositor2);
        longjing.deposit{value: 0.01 ether}(id2);

        vm.prank(depositor3);
        longjing.deposit{value: 0.01 ether}(id3);

        vm.prank(depositor4);
        longjing.deposit{value: 0.01 ether}(id4);

        vm.prank(depositor5);
        longjing.deposit{value: 0.01 ether}(id5);

        bytes32 storedRoot = longjing.merkleRoot();

        // Test proof generation and verification for each leaf
        for (uint256 i = 0; i < 5; i++) {
            (bytes32[20] memory pathElements, uint8[20] memory pathIndices) = longjing.getMerkleProof(i);

            // Get the leaf
            bytes32 leaf = longjing.identityCommitments(i);

            // Manually verify the proof reconstructs the root
            bytes32 computedHash = leaf;
            for (uint256 level = 0; level < 20; level++) {
                bytes32 sibling = pathElements[level];

                if (pathIndices[level] == 0) {
                    // Current node is left child
                    computedHash = bytes32(PoseidonHasher.hash(uint256(computedHash), uint256(sibling)));
                } else {
                    // Current node is right child
                    computedHash = bytes32(PoseidonHasher.hash(uint256(sibling), uint256(computedHash)));
                }
            }

            // The computed root must match the stored root
            assertEq(computedHash, storedRoot, "Merkle proof verification failed for leaf index");
        }
    }

    // ============ Policy Violation Slashing Tests ============

    function test_PolicyViolationSlashing_Success() public {
        // First, user makes a deposit
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // Verify initial policy stake
        LongjingCredits.Deposit memory depBefore = longjing.getDeposit(idCommitment1);
        assertEq(depBefore.policyStake, 0.005 ether);

        // Create mock proof and public signals
        uint256[8] memory proof;
        proof[0] = 1; // Non-zero to pass mock verifier

        bytes32 nullifier = keccak256('test_nullifier');
        bytes32 evidenceHash = keccak256('violation_evidence');

        // Public signals: [nullifierExpected (input), idCommitmentExpected (input), evidenceHash (output), nullifier (output), idCommitment (output)]
        uint256[5] memory publicSignals;
        publicSignals[0] = uint256(nullifier);
        publicSignals[1] = uint256(idCommitment1);
        publicSignals[2] = uint256(evidenceHash);
        publicSignals[3] = uint256(nullifier);
        publicSignals[4] = uint256(idCommitment1);

        // Server slashes for policy violation
        vm.startPrank(server);

        vm.expectEmit(true, true, false, true);
        emit PolicyViolationSlashed(nullifier, idCommitment1, 0.005 ether, evidenceHash);

        longjing.slashPolicyViolation(nullifier, idCommitment1, proof, publicSignals);
        vm.stopPrank();

        // Verify policy stake was burned
        LongjingCredits.Deposit memory depAfter = longjing.getDeposit(idCommitment1);
        assertEq(depAfter.policyStake, 0);

        // Verify nullifier is marked as slashed
        assertTrue(longjing.slashedNullifiers(nullifier));
    }

    function test_PolicyViolationSlashing_OnlyServer() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        uint256[8] memory proof;
        proof[0] = 1;

        bytes32 nullifier = keccak256('test_nullifier');

        uint256[5] memory publicSignals;
        publicSignals[0] = uint256(nullifier);
        publicSignals[1] = uint256(idCommitment1);
        publicSignals[2] = uint256(keccak256('evidence'));
        publicSignals[3] = uint256(nullifier);
        publicSignals[4] = uint256(idCommitment1);

        // Non-server cannot slash
        vm.startPrank(user2);
        vm.expectRevert(LongjingCredits.Unauthorized.selector);
        longjing.slashPolicyViolation(nullifier, idCommitment1, proof, publicSignals);
        vm.stopPrank();
    }

    function test_PolicyViolationSlashing_RequiresProof() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        uint256[8] memory proof; // All zeros - will fail mock verifier

        bytes32 nullifier = keccak256('test_nullifier');

        uint256[5] memory publicSignals;
        publicSignals[0] = uint256(nullifier);
        publicSignals[1] = uint256(idCommitment1);
        publicSignals[2] = uint256(keccak256('evidence'));
        publicSignals[3] = uint256(nullifier);
        publicSignals[4] = uint256(idCommitment1);

        // Should revert due to invalid proof
        vm.startPrank(server);
        vm.expectRevert(LongjingCredits.InvalidProof.selector);
        longjing.slashPolicyViolation(nullifier, idCommitment1, proof, publicSignals);
        vm.stopPrank();
    }

    // ============ Refund Redemption Tests ============

    function test_RedeemRefund_Success() public {
        uint256 depositAmount = 0.01 ether;

        // User deposits
        vm.prank(user1);
        longjing.deposit{value: depositAmount}(idCommitment1);

        // Give the longjing contract some eth to pay refunds
        vm.deal(address(longjing), 1 ether);

        // Create refund parameters
        bytes32 refundNullifier = keccak256('refund_nullifier');
        uint256 refundAmount = 0.002 ether;
        address payable recipient = payable(makeAddr('recipient'));

        // Mock ZK proof (non-zero to pass mock verifier)
        uint256[8] memory proof;
        proof[0] = 1;

        // Public signals: [signalX (input), refundValueClaimed (input), serverPublicKeyX (input), serverPublicKeyY (input), recipient (input), nullifier (output), signalY (output), idCommitment (output)]
        (bytes32 serverPubKeyX, bytes32 serverPubKeyY) = longjing.serverPublicKey();
        uint256[8] memory publicSignals;
        publicSignals[0] = 0; // signalX
        publicSignals[1] = refundAmount; // refundValueClaimed
        publicSignals[2] = uint256(serverPubKeyX); // serverPublicKeyX
        publicSignals[3] = uint256(serverPubKeyY); // serverPublicKeyY
        publicSignals[4] = uint256(uint160(address(recipient))); // recipient (front-running protection)
        publicSignals[5] = uint256(refundNullifier); // nullifier output
        publicSignals[6] = 0; // signalY output
        publicSignals[7] = uint256(idCommitment1); // idCommitment output

        uint256 balanceBefore = recipient.balance;

        // Redeem refund
        vm.prank(user1);
        longjing.redeemRefund(
            idCommitment1,
            refundNullifier,
            refundAmount,
            recipient,
            proof,
            publicSignals
        );

        // Verify refund was sent
        assertEq(recipient.balance, balanceBefore + refundAmount);
        assertTrue(longjing.redeemedRefunds(refundNullifier));

        // Verify deposit still active
        LongjingCredits.Deposit memory dep = longjing.getDeposit(idCommitment1);
        assertTrue(dep.active);
    }

    function test_RedeemRefund_AlreadyRedeemed() public {
        // User deposits
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // Give the longjing contract some eth
        vm.deal(address(longjing), 1 ether);

        // Create refund parameters
        bytes32 refundNullifier = keccak256('refund_nullifier');
        uint256 refundAmount = 0.002 ether;
        address payable recipient = payable(makeAddr('recipient'));

        // Mock ZK proof
        uint256[8] memory proof;
        proof[0] = 1;

        (bytes32 serverPubKeyX, bytes32 serverPubKeyY) = longjing.serverPublicKey();
        uint256[8] memory publicSignals;
        publicSignals[0] = 0; // signalX
        publicSignals[1] = refundAmount; // refundValueClaimed
        publicSignals[2] = uint256(serverPubKeyX); // serverPublicKeyX
        publicSignals[3] = uint256(serverPubKeyY); // serverPublicKeyY
        publicSignals[4] = uint256(uint160(address(recipient))); // recipient (front-running protection)
        publicSignals[5] = uint256(refundNullifier); // nullifier output
        publicSignals[6] = 0; // signalY output
        publicSignals[7] = uint256(idCommitment1); // idCommitment output

        // First redemption succeeds
        vm.prank(user1);
        longjing.redeemRefund(
            idCommitment1,
            refundNullifier,
            refundAmount,
            recipient,
            proof,
            publicSignals
        );

        // Second redemption with same nullifier fails
        vm.prank(user1);
        vm.expectRevert(LongjingCredits.RefundAlreadyRedeemed.selector);
        longjing.redeemRefund(
            idCommitment1,
            refundNullifier,
            refundAmount,
            recipient,
            proof,
            publicSignals
        );
    }

    function test_RedeemRefund_InvalidProof() public {
        // User deposits
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        bytes32 refundNullifier = keccak256('refund_nullifier');
        uint256 refundAmount = 0.002 ether;
        address payable recipient = payable(makeAddr('recipient'));

        // Invalid proof (all zeros)
        uint256[8] memory proof;

        (bytes32 serverPubKeyX, bytes32 serverPubKeyY) = longjing.serverPublicKey();
        uint256[8] memory publicSignals;
        publicSignals[0] = 0; // signalX
        publicSignals[1] = refundAmount; // refundValueClaimed
        publicSignals[2] = uint256(serverPubKeyX); // serverPublicKeyX
        publicSignals[3] = uint256(serverPubKeyY); // serverPublicKeyY
        publicSignals[4] = uint256(uint160(address(recipient))); // recipient (front-running protection)
        publicSignals[5] = uint256(refundNullifier); // nullifier output
        publicSignals[6] = 0; // signalY output
        publicSignals[7] = uint256(idCommitment1); // idCommitment output

        vm.prank(user1);
        vm.expectRevert(LongjingCredits.InvalidProof.selector);
        longjing.redeemRefund(
            idCommitment1,
            refundNullifier,
            refundAmount,
            recipient,
            proof,
            publicSignals
        );
    }

    function test_RedeemRefund_DepositNotFound() public {
        bytes32 refundNullifier = keccak256('refund_nullifier');
        uint256 refundAmount = 0.002 ether;
        address payable recipient = payable(makeAddr('recipient'));

        uint256[8] memory proof;
        proof[0] = 1;

        (bytes32 serverPubKeyX, bytes32 serverPubKeyY) = longjing.serverPublicKey();
        uint256[8] memory publicSignals;
        publicSignals[0] = 0; // signalX
        publicSignals[1] = refundAmount; // refundValueClaimed
        publicSignals[2] = uint256(serverPubKeyX); // serverPublicKeyX
        publicSignals[3] = uint256(serverPubKeyY); // serverPublicKeyY
        publicSignals[4] = uint256(uint160(address(recipient))); // recipient (front-running protection)
        publicSignals[5] = uint256(refundNullifier); // nullifier output
        publicSignals[6] = 0; // signalY output
        publicSignals[7] = uint256(idCommitment1); // idCommitment output

        vm.expectRevert(LongjingCredits.DepositNotFound.selector);
        longjing.redeemRefund(
            idCommitment1,
            refundNullifier,
            refundAmount,
            recipient,
            proof,
            publicSignals
        );
    }

    // ============ Additional Admin Tests ============

    // ============ Pause Edge Cases ============

    function test_Deposit_WhenPaused() public {
        longjing.pause();

        vm.prank(user1);
        vm.expectRevert();
        longjing.deposit{value: 0.01 ether}(idCommitment1);
    }

    function test_Withdraw_WhenNotPaused() public {
        // Deposit while not paused
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        // Note: withdraw doesn't have whenNotPaused modifier
        // so it should work even if contract is paused
        longjing.pause();

        address payable recipient = payable(makeAddr('recipient'));
        uint256[8] memory proof = _generateMockProof();
        uint256[7] memory publicSignals = [
            0,
            uint256(longjing.merkleRoot()),
            uint256(uint160(address(recipient))), // recipient (front-running protection)
            0,
            0,
            uint256(idCommitment1),
            uint256(longjing.merkleRoot())
        ];

        // This should succeed even when paused
        vm.prank(user1);
        longjing.withdraw(idCommitment1, recipient, proof, publicSignals);

        assertEq(recipient.balance, 0.01 ether);
    }

    // ============ Timelock Tests ============

    function test_ProposeChange_RevertsForNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, user1);
    }

    function test_ProposeChange_RevertsOnZeroAddress() public {
        vm.expectRevert(LongjingCredits.ZeroAddress.selector);
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, address(0));
    }

    function test_ProposeChange_StoresPendingChange() public {
        address newServer = makeAddr('newServer');
        uint256 eta = block.timestamp + longjing.ADMIN_DELAY();

        vm.expectEmit(true, false, false, true);
        emit LongjingCredits.ChangeProposed(LongjingCredits.Target.ServerAddress, newServer, eta);
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, newServer);

        (address value, uint256 pendingEta) = longjing.pendingChanges(LongjingCredits.Target.ServerAddress);
        assertEq(value, newServer);
        assertEq(pendingEta, eta);
        assertEq(longjing.serverAddress(), server);
    }

    function test_ExecuteChange_RevertsBeforeDelay() public {
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, makeAddr('newServer'));
        vm.warp(block.timestamp + longjing.ADMIN_DELAY() - 1);

        vm.expectRevert(LongjingCredits.TimelockNotExpired.selector);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
        assertEq(longjing.serverAddress(), server);
    }

    function test_ExecuteChange_RevertsWithoutProposal() public {
        vm.expectRevert(LongjingCredits.NoPendingChange.selector);
        longjing.executeChange(LongjingCredits.Target.WithdrawalVerifier);
    }

    function test_ExecuteChange_RevertsForNonOwner() public {
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, makeAddr('newServer'));
        vm.warp(block.timestamp + longjing.ADMIN_DELAY());

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
    }

    function test_ExecuteChange_ClearsPendingChange() public {
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, makeAddr('newServer'));
        vm.warp(block.timestamp + longjing.ADMIN_DELAY());
        longjing.executeChange(LongjingCredits.Target.ServerAddress);

        vm.expectRevert(LongjingCredits.NoPendingChange.selector);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
    }

    function test_ExecuteChange_SwapsVerifier() public {
        MockWithdrawalVerifier newVerifier = new MockWithdrawalVerifier();
        longjing.proposeChange(LongjingCredits.Target.WithdrawalVerifier, address(newVerifier));
        vm.warp(block.timestamp + longjing.ADMIN_DELAY());

        vm.expectEmit(true, false, false, true);
        emit LongjingCredits.ChangeExecuted(LongjingCredits.Target.WithdrawalVerifier, address(newVerifier));
        longjing.executeChange(LongjingCredits.Target.WithdrawalVerifier);

        assertEq(address(longjing.withdrawalVerifier()), address(newVerifier));
    }

    function test_ProposeChange_RestartsDelay() public {
        address newServer = makeAddr('newServer');
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, makeAddr('otherServer'));
        vm.warp(block.timestamp + longjing.ADMIN_DELAY() - 1);
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, newServer);
        vm.warp(block.timestamp + 1);

        vm.expectRevert(LongjingCredits.TimelockNotExpired.selector);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
    }

    function test_CancelChange() public {
        address newServer = makeAddr('newServer');
        longjing.proposeChange(LongjingCredits.Target.ServerAddress, newServer);

        vm.expectEmit(true, false, false, true);
        emit LongjingCredits.ChangeCancelled(LongjingCredits.Target.ServerAddress, newServer);
        longjing.cancelChange(LongjingCredits.Target.ServerAddress);

        vm.warp(block.timestamp + longjing.ADMIN_DELAY());
        vm.expectRevert(LongjingCredits.NoPendingChange.selector);
        longjing.executeChange(LongjingCredits.Target.ServerAddress);
        assertEq(longjing.serverAddress(), server);
    }

    function test_CancelChange_RevertsWithoutProposal() public {
        vm.expectRevert(LongjingCredits.NoPendingChange.selector);
        longjing.cancelChange(LongjingCredits.Target.ServerAddress);
    }

    function test_Withdraw_WhilePausedAndChangePending() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        longjing.proposeChange(LongjingCredits.Target.WithdrawalVerifier, makeAddr('permissiveVerifier'));
        longjing.pause();

        address payable recipient = payable(makeAddr('recipient'));
        uint256[7] memory publicSignals = [
            0,
            uint256(longjing.merkleRoot()),
            uint256(uint160(address(recipient))),
            0,
            0,
            uint256(idCommitment1),
            uint256(longjing.merkleRoot())
        ];

        vm.prank(user1);
        longjing.withdraw(idCommitment1, recipient, _generateMockProof(), publicSignals);

        assertEq(recipient.balance, 0.01 ether);
    }

    function test_RedeemRefund_WhenPaused() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        vm.deal(address(longjing), 1 ether);
        longjing.pause();

        bytes32 refundNullifier = keccak256('refund_nullifier');
        uint256 refundAmount = 0.002 ether;
        address payable recipient = payable(makeAddr('recipient'));
        (bytes32 serverPubKeyX, bytes32 serverPubKeyY) = longjing.serverPublicKey();
        uint256[8] memory publicSignals;
        publicSignals[1] = refundAmount;
        publicSignals[2] = uint256(serverPubKeyX);
        publicSignals[3] = uint256(serverPubKeyY);
        publicSignals[4] = uint256(uint160(address(recipient)));
        publicSignals[5] = uint256(refundNullifier);
        publicSignals[7] = uint256(idCommitment1);

        vm.prank(user1);
        longjing.redeemRefund(
            idCommitment1, refundNullifier, refundAmount, recipient, _generateMockProof(), publicSignals
        );

        assertEq(recipient.balance, refundAmount);
    }

    // ============ Note Expiry Tests ============

    function test_NoteExpiry_IsDepositPlusTtl() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        assertEq(longjing.noteExpiry(idCommitment1), block.timestamp + longjing.NOTE_TTL());
    }

    function test_ClaimExpired_Success() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        vm.warp(longjing.noteExpiry(idCommitment1));

        vm.expectEmit(true, true, false, true);
        emit LongjingCredits.NoteExpiredClaimed(idCommitment1, 0.01 ether, server);
        vm.prank(server);
        longjing.claimExpired(idCommitment1);

        assertEq(server.balance, 0.01 ether);
        LongjingCredits.Deposit memory dep = longjing.getDeposit(idCommitment1);
        assertFalse(dep.active);
        assertEq(dep.rlnStake, 0);
        assertEq(dep.policyStake, 0);
    }

    function test_ClaimExpired_RevertsBeforeTtl() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        vm.warp(longjing.noteExpiry(idCommitment1) - 1);

        vm.prank(server);
        vm.expectRevert(LongjingCredits.NoteNotExpired.selector);
        longjing.claimExpired(idCommitment1);
    }

    function test_ClaimExpired_OnlyOperator() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        vm.warp(longjing.noteExpiry(idCommitment1));

        vm.expectRevert(LongjingCredits.Unauthorized.selector);
        longjing.claimExpired(idCommitment1);
    }

    function test_ClaimExpired_RevertsAfterWithdrawal() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        vm.warp(longjing.noteExpiry(idCommitment1));

        address payable recipient = payable(makeAddr('recipient'));
        vm.prank(user1);
        longjing.withdraw(idCommitment1, recipient, _generateMockProof(), _withdrawalSignals(idCommitment1, recipient));
        assertEq(recipient.balance, 0.01 ether);

        vm.prank(server);
        vm.expectRevert(LongjingCredits.DepositNotFound.selector);
        longjing.claimExpired(idCommitment1);
    }

    function test_ClaimExpired_RevertsWhilePaused() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        vm.warp(longjing.noteExpiry(idCommitment1));
        longjing.pause();

        vm.prank(server);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        longjing.claimExpired(idCommitment1);
    }

    function test_NoteExpiry_PausedTimeBeforeDepositDoesNotCount() public {
        longjing.pause();
        vm.warp(block.timestamp + 100 days);
        longjing.unpause();

        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);

        assertEq(longjing.noteExpiry(idCommitment1), block.timestamp + longjing.NOTE_TTL());
    }

    /// The ethereum/zkapi flaw: the owner pauses to block exits, waits out the TTL, then sweeps the note.
    function test_PauseCannotBlockExitsThenTriggerExpiry() public {
        vm.prank(user1);
        longjing.deposit{value: 0.01 ether}(idCommitment1);
        uint256 expiry = longjing.noteExpiry(idCommitment1);
        uint256 ttl = longjing.NOTE_TTL();

        longjing.pause();
        vm.warp(expiry);

        // The clock stops while paused, so the note is still a full TTL away from expiring
        assertEq(longjing.noteExpiry(idCommitment1), expiry + ttl);
        vm.prank(server);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        longjing.claimExpired(idCommitment1);

        longjing.unpause();
        vm.prank(server);
        vm.expectRevert(LongjingCredits.NoteNotExpired.selector);
        longjing.claimExpired(idCommitment1);

        // Exits stayed open throughout
        longjing.pause();
        address payable recipient = payable(makeAddr('recipient'));
        vm.prank(user1);
        longjing.withdraw(idCommitment1, recipient, _generateMockProof(), _withdrawalSignals(idCommitment1, recipient));
        assertEq(recipient.balance, 0.01 ether);
    }

    function _withdrawalSignals(
        bytes32 _idCommitment,
        address _recipient
    ) internal view returns (uint256[7] memory) {
        return [
            0,
            uint256(longjing.merkleRoot()),
            uint256(uint160(_recipient)),
            0,
            0,
            uint256(_idCommitment),
            uint256(longjing.merkleRoot())
        ];
    }
}
