// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoseidonHasher} from "./PoseidonHasher.sol";
import {BabyJubJub} from "./BabyJubJub.sol";
import {WithdrawalVerifier} from "./WithdrawalVerifier.sol";
import {RefundRedemptionVerifier} from "./RefundRedemptionVerifier.sol";
import {DoubleSpendSlashingVerifier} from "./DoubleSpendSlashingVerifier.sol";

/**
 * @title LongjingCredits
 * @notice Privacy-preserving API credits system using Zero-Knowledge proofs and Rate-Limit Nullifiers
 * @dev Based on the Ethresear.ch proposal by Davide Crapis and Vitalik Buterin
 * https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104
 *
 * IMPORTANT: Hash Function Compatibility
 * This contract uses Poseidon hash functions to maintain compatibility with the ZK circuit.
 * The circuits (api_request.circom and friends) use Poseidon hashing throughout:
 * - Identity commitments: Poseidon(secretKey)
 * - Merkle tree: Poseidon(left, right)
 * - Nullifiers: Poseidon(Poseidon(secretKey, ticketIndex))
 * - Refund verification: Poseidon(refundValue)
 *
 * All onchain hashing MUST use Poseidon to match the circuit's constraints.
 * Using Keccak256 would make proof verification impossible.
 */
contract LongjingCredits is ReentrancyGuard, Pausable, Ownable {
    // ============ Structs ============

    struct Deposit {
        bytes32 idCommitment; // Hash(secretKey) - user's anonymous identity
        uint256 rlnStake; // D - Claimable by anyone proving double-spend
        uint256 policyStake; // S - Burned (not claimed) for ToS violations
        uint256 timestamp; // When the deposit was made
        bool active; // Whether this deposit is still active
    }

    // ============ State Variables ============

    /// @notice Mapping from identity commitment to deposit details
    mapping(bytes32 => Deposit) public deposits;

    /// @notice Merkle root of all identity commitments (anonymity set)
    bytes32 public merkleRoot;

    /// @notice Set of all identity commitments (for Merkle tree construction)
    bytes32[] public identityCommitments;

    /// @notice 20-level Merkle tree depth (supports ~1M depositors)
    uint256 public constant TREE_DEPTH = 20;

    /// @notice Zero values for Merkle tree (Poseidon(0))
    bytes32[20] public zeros;

    /// @notice Filled subtrees at each level for incremental Merkle tree
    bytes32[20] public filledSubtrees;

    /// @notice Storage for all tree nodes: level => index => hash
    /// @dev Required for proper Merkle proof generation
    mapping(uint256 => mapping(uint256 => bytes32)) private treeNodes;

    /// @notice Mapping of slashed nullifiers (prevents re-use after slashing)
    mapping(bytes32 => bool) public slashedNullifiers;

    /// @notice Mapping of revealed secret keys (from double-spend detection)
    mapping(bytes32 => bool) public revealedSecretKeys;

    /// @notice Mapping of redeemed refund nullifiers (prevents double redemption)
    mapping(bytes32 => bool) public redeemedRefunds;

    /// @notice Server's public key for verifying refund signatures
    address public serverAddress;

    /// @notice Server's EdDSA public key (for signature verification)
    /// @dev In production, this would be a proper EdDSA public key point
    struct EdDSAPublicKey {
        bytes32 x;
        bytes32 y;
    }
    EdDSAPublicKey public serverPublicKey;

    /// @notice Minimum stake requirements
    uint256 public minRlnStake;
    uint256 public minPolicyStake;

    /// @notice ZK Proof Verifiers
    WithdrawalVerifier public withdrawalVerifier;
    RefundRedemptionVerifier public refundVerifier;
    DoubleSpendSlashingVerifier public slashingVerifier;

    /// @notice Delay before a proposed verifier or server address change can be executed
    /// @dev Gives users time to exit before a change they disagree with takes effect
    uint256 public constant ADMIN_DELAY = 7 days;

    /// @notice Settings that can only be changed through the timelock
    enum Target {
        WithdrawalVerifier,
        RefundVerifier,
        SlashingVerifier,
        ServerAddress
    }

    struct PendingChange {
        address value;
        uint256 eta; // 0 when nothing is pending
    }

    /// @notice Queued changes, executable once block.timestamp >= eta
    mapping(Target => PendingChange) public pendingChanges;

    /// @notice Time after which the operator can claim what is left on a note
    /// @dev Counted from the deposit, excluding any time the contract spent paused
    uint256 public constant NOTE_TTL = 365 days;

    /// @notice Total time spent paused, excluding the current pause
    uint256 public totalPausedTime;

    /// @notice When the current pause started (0 when not paused)
    uint256 public pausedAt;

    /// @notice Paused time already elapsed when each note was deposited
    mapping(bytes32 => uint256) public pausedTimeAtDeposit;

    // ============ Events ============

    event DepositMade(bytes32 indexed idCommitment, uint256 rlnStake, uint256 policyStake, uint256 timestamp);

    event WithdrawalMade(bytes32 indexed idCommitment, uint256 amount, address indexed recipient);

    event DoubleSpendSlashed(
        bytes32 indexed secretKey, bytes32 indexed nullifier, address indexed slasher, uint256 reward
    );

    event PolicyStakeSlashed(bytes32 indexed nullifier, bytes32 indexed idCommitment, uint256 amountBurned);

    event MerkleRootUpdated(bytes32 indexed newRoot, uint256 leafCount);

    event ServerAddressUpdated(address indexed oldAddress, address indexed newAddress);

    event ChangeProposed(Target indexed target, address value, uint256 eta);

    event ChangeExecuted(Target indexed target, address value);

    event ChangeCancelled(Target indexed target, address value);

    event NoteExpiredClaimed(bytes32 indexed idCommitment, uint256 amount, address indexed operator);

    event RefundRedeemed(
        bytes32 indexed idCommitment, bytes32 indexed nullifier, uint256 amount, address indexed recipient
    );

    // ============ Errors ============

    error InsufficientDeposit();
    error DepositAlreadyExists();
    error DepositNotFound();
    error AlreadySlashed();
    error InvalidProof();
    error InvalidSecretKey();
    error Unauthorized();
    error InvalidSignature();
    error RefundAlreadyRedeemed();
    error ZeroAddress();
    error NoPendingChange();
    error TimelockNotExpired();
    error NoteNotExpired();

    // ============ Constructor ============

    constructor(
        address _serverAddress,
        uint256 _minRlnStake,
        uint256 _minPolicyStake,
        bytes32 _serverPubKeyX,
        bytes32 _serverPubKeyY
    ) Ownable(msg.sender) {
        serverAddress = _serverAddress;
        minRlnStake = _minRlnStake;
        minPolicyStake = _minPolicyStake;
        serverPublicKey = EdDSAPublicKey({x: _serverPubKeyX, y: _serverPubKeyY});

        // Deploy ZK proof verifiers
        withdrawalVerifier = new WithdrawalVerifier();
        refundVerifier = new RefundRedemptionVerifier();
        slashingVerifier = new DoubleSpendSlashingVerifier();

        // Initialize 20-level Merkle tree with zero values
        // zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
        // This matches the circuit's expectation for empty tree nodes
        bytes32 currentZero = bytes32(0);
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            if (i < TREE_DEPTH - 1) {
                currentZero = bytes32(PoseidonHasher.hash(uint256(currentZero), uint256(currentZero)));
            }
        }

        // Initial Merkle root is the hash at the top level
        merkleRoot = bytes32(PoseidonHasher.hash(uint256(currentZero), uint256(currentZero)));
    }

    // ============ Core Functions ============

    /**
     * @notice Deposit ETH to participate in the Longjing system
     * @param _idCommitment Hash of the user's secret key (anonymous identity)
     * @dev msg.value should be at least minRlnStake + minPolicyStake
     * @dev 50% goes to RLN stake (D), 50% to policy stake (S)
     */
    function deposit(bytes32 _idCommitment) external payable nonReentrant whenNotPaused {
        if (msg.value < minRlnStake + minPolicyStake) {
            revert InsufficientDeposit();
        }
        if (deposits[_idCommitment].active) revert DepositAlreadyExists();

        // Split deposit 50/50 between RLN stake and policy stake
        uint256 half = msg.value / 2;

        deposits[_idCommitment] = Deposit({
            idCommitment: _idCommitment,
            rlnStake: half,
            policyStake: msg.value - half, // Handles odd amounts
            timestamp: block.timestamp,
            active: true
        });
        pausedTimeAtDeposit[_idCommitment] = _pausedTime();

        // Add to Merkle tree
        identityCommitments.push(_idCommitment);
        _updateMerkleRoot();

        emit DepositMade(_idCommitment, half, msg.value - half, block.timestamp);
    }

    /**
     * @notice Withdraw remaining funds using ZK proof (secret key never revealed!)
     * @param _idCommitment The user's identity commitment
     * @param _recipient Address to receive the withdrawn funds
     * @param _proof ZK proof components [pA, pB, pC] in Groth16 format
     * @param _publicSignals Public signals in snarkjs order [nullifier, signalY, idCommitment, merkleRoot, signalX, merkleRootExpected, recipient]
     * @dev Verifies a ZK proof that the caller knows the secret key without revealing it
     * @dev The recipient is bound into the proof to prevent front-running attacks ()
     */
    function withdraw(
        bytes32 _idCommitment,
        address payable _recipient,
        uint256[8] calldata _proof,
        uint256[7] calldata _publicSignals
    ) external nonReentrant {
        Deposit storage userDeposit = deposits[_idCommitment];
        if (!userDeposit.active) revert DepositNotFound();

        // Verify ZK proof of ownership
        // Public signals, outputs first as snarkjs emits them: [nullifier, signalY, idCommitment, merkleRoot, signalX, merkleRootExpected, recipient]
        // The proof verifies that:
        // 1. Prover knows secretKey such that Poseidon(secretKey) = idCommitment
        // 2. idCommitment is in the Merkle tree with root = merkleRoot
        // 3. Valid RLN signal generation (signalX, signalY) for the withdrawal
        // 4. Withdrawal is bound to the specified recipient (prevents front-running - )
        if (!withdrawalVerifier.verifyWithdrawalProof(_proof, _publicSignals)) {
            revert InvalidProof();
        }

        // Verify public signals match expected values
        // _publicSignals[6] is the recipient input - CRITICAL: prevents front-running
        require(_publicSignals[6] == uint256(uint160(address(_recipient))), "recipient mismatch");
        // _publicSignals[2] is the idCommitment output
        require(_publicSignals[2] == uint256(_idCommitment), "idCommitment mismatch");
        // _publicSignals[3] is the merkleRoot output
        require(_publicSignals[3] == uint256(merkleRoot), "merkleRoot mismatch");

        uint256 totalAmount = userDeposit.rlnStake + userDeposit.policyStake;

        // Mark as inactive
        userDeposit.active = false;
        userDeposit.rlnStake = 0;
        userDeposit.policyStake = 0;

        // Transfer funds
        (bool success,) = _recipient.call{value: totalAmount}("");
        require(success, "Transfer failed");

        emit WithdrawalMade(_idCommitment, totalAmount, _recipient);
    }

    /**
     * @notice Slash user for double-spending using ZK proof (RLN math verified in circuit!)
     * @param _secretKey The revealed secret key (extracted from two RLN signals)
     * @param _nullifier The nullifier from the double-spend
     * @param _idCommitment The user's identity commitment
     * @param _proof ZK proof components [pA, pB, pC] in Groth16 format
     * @param _publicSignals Public signals in snarkjs order [idCommitment, nullifier, secretKeyClaimed, nullifierExpected]
     * @dev Verifies a ZK proof that validates the secret key extraction from two RLN signals
     * @dev The circuit proves:
     *      1. Two RLN signals with the same nullifier but different x values exist
     *      2. Secret key was correctly extracted: k = (y1*x2 - y2*x1) / (x2 - x1)
     *      3. Poseidon(secretKey) = idCommitment
     *      4. All RLN mathematics are correct
     * @dev Reward goes to the slasher who provided the proof: the RLN stake and
     *      the policy stake, which would otherwise be locked in an inactive deposit
     */
    function slashDoubleSpend(
        bytes32 _secretKey,
        bytes32 _nullifier,
        bytes32 _idCommitment,
        uint256[8] calldata _proof,
        uint256[4] calldata _publicSignals
    ) external nonReentrant {
        Deposit storage userDeposit = deposits[_idCommitment];

        if (revealedSecretKeys[_secretKey]) revert AlreadySlashed();
        if (!userDeposit.active) revert DepositNotFound();

        // Verify ZK proof of double-spend slashing
        // Public signals, outputs first as snarkjs emits them: [idCommitment, nullifier, secretKeyClaimed, nullifierExpected]
        // The proof verifies:
        // 1. Two RLN signals exist with the same nullifier but different x values
        // 2. Secret key was correctly extracted using RLN math: k = (y1*x2 - y2*x1) / (x2 - x1)
        // 3. Poseidon(secretKey) = idCommitment (proves ownership)
        // 4. All RLN signal equations are valid: y = k + a*x
        if (!slashingVerifier.verifySlashingProof(_proof, _publicSignals)) {
            revert InvalidProof();
        }

        // Verify public signals match expected values
        require(_publicSignals[0] == uint256(_idCommitment), "idCommitment mismatch");
        require(_publicSignals[1] == uint256(_nullifier), "nullifier (output) mismatch");
        require(_publicSignals[2] == uint256(_secretKey), "secretKey mismatch");
        require(_publicSignals[3] == uint256(_nullifier), "nullifier (expected) mismatch");

        // Verify the secret key matches the idCommitment
        bytes32 computedCommitment = bytes32(PoseidonHasher.hash(uint256(_secretKey)));
        require(computedCommitment == _idCommitment, "Secret key does not match idCommitment");

        // Mark as slashed
        revealedSecretKeys[_secretKey] = true;
        slashedNullifiers[_nullifier] = true;
        userDeposit.active = false;

        uint256 reward = userDeposit.rlnStake + userDeposit.policyStake;
        userDeposit.rlnStake = 0;
        userDeposit.policyStake = 0;

        // Transfer reward to slasher
        (bool success,) = msg.sender.call{value: reward}("");
        require(success, "Transfer failed");

        emit DoubleSpendSlashed(_secretKey, _nullifier, msg.sender, reward);
    }

    /**
     * @notice Burn a user's policy stake for a ToS violation
     * @param _nullifier The nullifier from the violating request
     * @param _idCommitment The user's identity commitment
     * @dev Trusted-operator action: no proof backs the accusation, so the server address
     *      can burn any active deposit's policy stake. Its only guard is the ADMIN_DELAY
     *      timelock on changing that address. The stake is burned, not paid to the server,
     *      so the operator gains nothing from a false accusation.
     */
    function slashPolicyStake(bytes32 _nullifier, bytes32 _idCommitment) external nonReentrant {
        if (msg.sender != serverAddress) revert Unauthorized();

        Deposit storage userDeposit = deposits[_idCommitment];
        if (!userDeposit.active) revert DepositNotFound();
        if (slashedNullifiers[_nullifier]) revert AlreadySlashed();

        slashedNullifiers[_nullifier] = true;
        uint256 amountToBurn = userDeposit.policyStake;
        userDeposit.policyStake = 0;

        (bool success,) = address(0).call{value: amountToBurn}("");
        require(success, "Burn failed");

        emit PolicyStakeSlashed(_nullifier, _idCommitment, amountToBurn);
    }

    /**
     * @notice Redeem refund tickets using ZK proof (signatures verified in circuit!)
     * @param _idCommitment User's identity commitment
     * @param _nullifier Nullifier from the original API request
     * @param _refundValue Total refund amount in wei
     * @param _recipient Address to receive the refund
     * @param _proof ZK proof components [pA, pB, pC] in Groth16 format
     * @param _publicSignals Public signals in snarkjs order [nullifier, signalY, idCommitment, signalX, refundValueClaimed, serverPublicKeyX, serverPublicKeyY, recipient]
     * @dev Verifies a ZK proof that validates EdDSA signatures on refund tickets
     * @dev The circuit proves:
     *      1. User has valid refund tickets signed by the server
     *      2. Signatures are valid (EdDSA verification in circuit)
     *      3. Total refund amount matches the claimed value
     *      4. Refund is bound to the specified recipient (prevents front-running - )
     */
    function redeemRefund(
        bytes32 _idCommitment,
        bytes32 _nullifier,
        uint256 _refundValue,
        address payable _recipient,
        uint256[8] calldata _proof,
        uint256[8] calldata _publicSignals
    ) external nonReentrant {
        Deposit storage userDeposit = deposits[_idCommitment];
        if (!userDeposit.active) revert DepositNotFound();

        // Check if refund already redeemed
        if (redeemedRefunds[_nullifier]) revert RefundAlreadyRedeemed();

        // Check if nullifier was slashed
        if (slashedNullifiers[_nullifier]) revert AlreadySlashed();

        // Verify ZK proof of valid refund redemption
        // Public signals, outputs first as snarkjs emits them: [nullifier, signalY, idCommitment, signalX, refundValueClaimed, serverPublicKeyX, serverPublicKeyY, recipient]
        // The proof verifies:
        // 1. User has valid refund ticket with EdDSA signature from server
        // 2. Signature is cryptographically valid (verified in circuit)
        // 3. Refund value matches _refundValue
        // 4. Nullifier is correctly computed from secretKey and ticketIndex
        // 5. Server public key matches the on-chain stored value (CRITICAL for security - )
        // 6. Refund is bound to the specified recipient (CRITICAL for security - )
        if (!refundVerifier.verifyRefundProof(_proof, _publicSignals)) {
            revert InvalidProof();
        }

        // Verify public signals match expected values
        // _publicSignals[4] is the refundValueClaimed input
        require(_publicSignals[4] == _refundValue, "refundValue mismatch");
        // _publicSignals[5] is the serverPublicKeyX input - CRITICAL: prevents forged refunds ()
        require(_publicSignals[5] == uint256(serverPublicKey.x), "serverPublicKeyX mismatch");
        // _publicSignals[6] is the serverPublicKeyY input - CRITICAL: prevents forged refunds ()
        require(_publicSignals[6] == uint256(serverPublicKey.y), "serverPublicKeyY mismatch");
        // _publicSignals[7] is the recipient input - CRITICAL: prevents front-running
        require(_publicSignals[7] == uint256(uint160(address(_recipient))), "recipient mismatch");
        // _publicSignals[0] is the nullifier output
        require(_publicSignals[0] == uint256(_nullifier), "nullifier mismatch");
        // _publicSignals[2] is the idCommitment output
        require(_publicSignals[2] == uint256(_idCommitment), "idCommitment mismatch");

        // Mark refund as redeemed
        redeemedRefunds[_nullifier] = true;

        // Transfer refund to recipient
        (bool success,) = _recipient.call{value: _refundValue}("");
        require(success, "Refund transfer failed");

        emit RefundRedeemed(_idCommitment, _nullifier, _refundValue, _recipient);
    }

    /**
     * @notice Claim what is left on a note once its TTL has passed
     * @param _idCommitment The note's identity commitment
     * @dev Only the operator can claim, and not while paused. The user can still
     *      withdraw an expired note until the operator claims it.
     */
    function claimExpired(bytes32 _idCommitment) external nonReentrant whenNotPaused {
        if (msg.sender != serverAddress) revert Unauthorized();

        Deposit storage userDeposit = deposits[_idCommitment];
        if (!userDeposit.active) revert DepositNotFound();
        if (block.timestamp < noteExpiry(_idCommitment)) revert NoteNotExpired();

        uint256 amount = userDeposit.rlnStake + userDeposit.policyStake;

        userDeposit.active = false;
        userDeposit.rlnStake = 0;
        userDeposit.policyStake = 0;

        (bool success,) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit NoteExpiredClaimed(_idCommitment, amount, msg.sender);
    }

    // ============ View Functions ============

    /**
     * @notice When a note expires, pushed back by every second spent paused since its deposit
     * @dev Pausing can therefore never bring a note's expiry closer
     */
    function noteExpiry(bytes32 _idCommitment) public view returns (uint256) {
        Deposit storage userDeposit = deposits[_idCommitment];
        if (!userDeposit.active) revert DepositNotFound();
        return userDeposit.timestamp + NOTE_TTL + _pausedTime() - pausedTimeAtDeposit[_idCommitment];
    }

    /**
     * @notice Get deposit details for an identity commitment
     */
    function getDeposit(bytes32 _idCommitment) external view returns (Deposit memory) {
        return deposits[_idCommitment];
    }

    /**
     * @notice Get all identity commitments (for Merkle tree construction)
     */
    function getAllIdentityCommitments() external view returns (bytes32[] memory) {
        return identityCommitments;
    }

    /**
     * @notice Get the current size of the anonymity set
     */
    function getAnonymitySetSize() external view returns (uint256) {
        return identityCommitments.length;
    }

    /**
     * @notice Check if a nullifier has been used (either slashed or redeemed)
     * @param _nullifier The nullifier to check
     * @return bool True if the nullifier has been used/slashed/redeemed
     * @dev Used for double-spend prevention and refund redemption checks
     */
    function isNullifierUsed(bytes32 _nullifier) external view returns (bool) {
        return slashedNullifiers[_nullifier] || redeemedRefunds[_nullifier];
    }

    // ============ Admin Functions ============

    /**
     * @notice Update minimum stake requirements
     */
    function setMinStakes(uint256 _minRlnStake, uint256 _minPolicyStake) external onlyOwner {
        minRlnStake = _minRlnStake;
        minPolicyStake = _minPolicyStake;
    }

    /**
     * @notice Queue a verifier or server address change, executable after ADMIN_DELAY
     * @dev Overwrites any change already pending for the same target and restarts the delay
     */
    function proposeChange(Target _target, address _value) external onlyOwner {
        if (_value == address(0)) revert ZeroAddress();
        uint256 eta = block.timestamp + ADMIN_DELAY;
        pendingChanges[_target] = PendingChange({value: _value, eta: eta});
        emit ChangeProposed(_target, _value, eta);
    }

    /**
     * @notice Apply a queued change once its delay has elapsed
     */
    function executeChange(Target _target) external onlyOwner {
        PendingChange memory change = pendingChanges[_target];
        if (change.eta == 0) revert NoPendingChange();
        if (block.timestamp < change.eta) revert TimelockNotExpired();
        delete pendingChanges[_target];

        if (_target == Target.WithdrawalVerifier) {
            withdrawalVerifier = WithdrawalVerifier(change.value);
        } else if (_target == Target.RefundVerifier) {
            refundVerifier = RefundRedemptionVerifier(change.value);
        } else if (_target == Target.SlashingVerifier) {
            slashingVerifier = DoubleSpendSlashingVerifier(change.value);
        } else {
            emit ServerAddressUpdated(serverAddress, change.value);
            serverAddress = change.value;
        }

        emit ChangeExecuted(_target, change.value);
    }

    /**
     * @notice Drop a queued change
     */
    function cancelChange(Target _target) external onlyOwner {
        PendingChange memory change = pendingChanges[_target];
        if (change.eta == 0) revert NoPendingChange();
        delete pendingChanges[_target];
        emit ChangeCancelled(_target, change.value);
    }

    /**
     * @notice Pause the contract (emergency)
     */
    function pause() external onlyOwner {
        _pause();
        pausedAt = block.timestamp;
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
        totalPausedTime += block.timestamp - pausedAt;
        pausedAt = 0;
    }

    // ============ Internal Functions ============

    /**
     * @notice Total time spent paused, including the current pause
     */
    function _pausedTime() internal view returns (uint256) {
        return paused() ? totalPausedTime + block.timestamp - pausedAt : totalPausedTime;
    }

    /**
     * @notice Update the Merkle root after adding new identity commitment
     * @dev Implements proper 20-level incremental Merkle tree using Poseidon hash
     * @dev This matches the circuit's MerkleTreeChecker structure exactly
     *
     * Algorithm:
     * 1. Start with the new leaf at level 0
     * 2. For each level, hash current node with its sibling
     * 3. If index bit is 0, node is left child: hash(node, filledSubtree)
     * 4. If index bit is 1, node is right child: hash(filledSubtree, node)
     * 5. Update filledSubtrees when a level is complete
     * 6. Final hash at level 20 is the new Merkle root
     */
    function _updateMerkleRoot() internal {
        uint256 leafIndex = identityCommitments.length - 1;
        bytes32 currentHash = identityCommitments[leafIndex];

        // Store the leaf node at level 0
        treeNodes[0][leafIndex] = currentHash;

        // Incrementally update the Merkle tree
        // For each level, hash with the appropriate sibling
        uint256 currentIndex = leafIndex;
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            bool isLeft = currentIndex % 2 == 0;
            uint256 siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

            bytes32 left;
            bytes32 right;

            if (isLeft) {
                left = currentHash;
                // For right sibling, check if it exists in treeNodes, otherwise use zero
                right = treeNodes[i][siblingIndex] != bytes32(0) ? treeNodes[i][siblingIndex] : zeros[i];
                // Store current in filledSubtrees for compatibility
                filledSubtrees[i] = currentHash;
            } else {
                // For left sibling, it must exist (we always fill left to right)
                left = treeNodes[i][siblingIndex] != bytes32(0) ? treeNodes[i][siblingIndex] : filledSubtrees[i];
                right = currentHash;
            }

            // Compute parent hash
            currentHash = bytes32(PoseidonHasher.hash(uint256(left), uint256(right)));

            // Store parent node
            uint256 parentIndex = currentIndex / 2;
            treeNodes[i + 1][parentIndex] = currentHash;

            // Move to parent level
            currentIndex = parentIndex;
        }

        merkleRoot = currentHash;
        emit MerkleRootUpdated(merkleRoot, identityCommitments.length);
    }

    /**
     * @notice Get Merkle proof for a given leaf index
     * @dev Returns path elements and path indices needed for ZK proof
     * @param _leafIndex Index of the leaf in the tree
     * @return pathElements Array of sibling hashes at each level
     * @return pathIndices Array of position bits (0=left, 1=right)
     */
    function getMerkleProof(uint256 _leafIndex)
        external
        view
        returns (bytes32[20] memory pathElements, uint8[20] memory pathIndices)
    {
        require(_leafIndex < identityCommitments.length, "Leaf index out of bounds");

        uint256 currentIndex = _leafIndex;

        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            bool isLeft = currentIndex % 2 == 0;
            pathIndices[i] = isLeft ? 0 : 1;

            // Calculate sibling index at current level
            uint256 siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

            // Get sibling hash from stored nodes
            pathElements[i] = _getNodeHash(siblingIndex, i);

            // Move to parent level
            currentIndex = currentIndex / 2;
        }

        return (pathElements, pathIndices);
    }

    /**
     * @notice Internal helper to retrieve hash of a node at given level and index
     * @dev Returns stored node hash or zero hash if node doesn't exist
     * @param _index Node index at the given level (not leaf index)
     * @param _level Tree level (0 = leaves, TREE_DEPTH = root)
     */
    function _getNodeHash(uint256 _index, uint256 _level) internal view returns (bytes32) {
        // Check if node exists in storage
        bytes32 node = treeNodes[_level][_index];

        // If node exists, return it; otherwise return zero hash for that level
        return node != bytes32(0) ? node : zeros[_level];
    }

    /**
     * @notice Hash refund data for signature verification
     * @dev CANONICAL MESSAGE FORMAT: EdDSA_sign(Poseidon(idCommitment, nullifier, value, timestamp))
     *
     * This MUST match:
     * - refund-signer.service.ts hashRefundData()
     * - refund_redemption.circom signature verification (lines 64-73)
     * - api_request_proof.circom refund verification
     *
     * Security Note:
     * - The signature covers idCommitment, nullifier, value, and timestamp for complete integrity
     * - idCommitment binds the refund to a specific user identity
     * - nullifier binds the refund to a specific API request
     * - Replay protection comes from the nullifier being marked as redeemed
     * - Timestamp prevents signature reuse across different redemption attempts
     *
     * Note: This function is currently unused (signature verification happens in the ZK circuit).
     * It is kept for reference and potential future on-chain verification optimizations.
     */
    function _hashRefundData(bytes32 _idCommitment, bytes32 _nullifier, uint256 _value, uint256 _timestamp)
        internal
        pure
        returns (bytes32)
    {
        // Hash all four values using Poseidon to match server and circuit implementations
        // Poseidon(idCommitment, nullifier, value, timestamp)
        return bytes32(PoseidonHasher.hash4(uint256(_idCommitment), uint256(_nullifier), _value, _timestamp));
    }

    /**
     * @notice DEAD CODE - This function is no longer used
     * @dev The system now uses ZK proofs (refund_redemption.circom) which verify EdDSA
     *      signatures inside the circuit, solving the gas cost problem.
     *
     * @dev HISTORICAL CONTEXT: This was a temporary stub that returned `true` after basic
     *      validation because full EdDSA verification requires >30M gas (2 scalar muls on
     *      Baby Jubjub), exceeding block gas limits.
     *
     * @dev The current redeemRefund() function uses proof-based verification where the
     *      EdDSA signature check happens in the circuit, not on-chain. This function is
     *      kept for reference only and should be removed in a future cleanup.
     *
     * @param _message Message hash (Poseidon hash of refund data)
     * @param _signature EdDSA signature (R8x, R8y, S)
     * @return True if signature passes basic validation (stub always returns true)
     */
    function _verifyEdDSASignature(bytes32 _message, EdDSASignature calldata _signature) internal view returns (bool) {
        // Convert bytes32 to uint256
        uint256 R8x = uint256(_signature.R8x);
        uint256 R8y = uint256(_signature.R8y);
        uint256 S = uint256(_signature.S);
        uint256 Ax = uint256(serverPublicKey.x);
        uint256 Ay = uint256(serverPublicKey.y);

        // Basic validation checks (low gas cost)

        // 1. Message must be non-zero
        if (_message == bytes32(0)) return false;

        // 2. Verify signature components are in valid range
        if (S >= BabyJubJub.SUBORDER) return false;
        if (R8x >= BabyJubJub.PRIME_Q) return false;
        if (R8y >= BabyJubJub.PRIME_Q) return false;

        // 3. Verify R is on the curve
        if (!BabyJubJub.isOnCurve(R8x, R8y)) return false;

        // 4. Verify public key is on the curve (cached check, should always pass)
        if (!BabyJubJub.isOnCurve(Ax, Ay)) return false;

        // TEMPORARY: Skip expensive elliptic curve operations (>30M gas)
        // Full verification would require:
        // - Computing H = Poseidon(R8x, R8y, Ax, Ay, M)
        // - Computing S*B (scalar mul ~200 iterations)
        // - Computing (H*8)*A (scalar mul ~200 iterations)
        // - Verifying S*B = R + (H*8)*A
        //
        // This is implemented in BabyJubJub.sol and works correctly,
        // but exceeds block gas limit.
        //
        // Security relies on:
        // - Only trusted server can create signatures
        // - Nullifier prevents double-spending
        // - Users can challenge invalid signatures and slash server
        // - Economic incentive: Server loses stake if it signs invalid refunds

        return true;
    }

    // ============ Helper Structs ============

    struct Signal {
        uint256 x;
        uint256 y;
    }

    struct EdDSASignature {
        bytes32 R8x;
        bytes32 R8y;
        bytes32 S;
    }
}
