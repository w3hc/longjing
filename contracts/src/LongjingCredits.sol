// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoseidonHasher} from "./PoseidonHasher.sol";
import {SettlementVerifier} from "./SettlementVerifier.sol";

/**
 * @title LongjingCredits
 * @notice Prepaid, unlinkable API credits: one deposit per note, settled net of
 *         spending, as specified in docs/SETTLEMENT.md
 * @dev Based on ZK API Usage Credits: LLMs and Beyond (Crapis and Buterin)
 *      https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104
 *
 * A note is keyed by its commitment c = Poseidon(k). The contract computes its
 * leaf Poseidon(c, D) from msg.value, so a request proof can only use the
 * amount that was paid. Requests never touch the contract: the server checks
 * their proofs against a recent root.
 */
contract LongjingCredits is ReentrancyGuard, Pausable, Ownable {
    // ============ Types ============

    enum Status {
        None,
        Active,
        Exiting,
        Closed,
        Slashed,
        Expired
    }

    struct Note {
        uint256 amount; // D, the whole deposit
        uint256 depositedAt;
        uint256 leafIndex;
        Status status;
    }

    /// @notice Settings that can only be changed through the timelock
    enum Target {
        SettlementVerifier,
        ServerAddress
    }

    struct PendingChange {
        address value;
        uint256 eta; // 0 when nothing is pending
    }

    struct EdDSAPublicKey {
        bytes32 x;
        bytes32 y;
    }

    /// @notice A pending exit, challengeable until exitAt
    struct Exit {
        uint256 nullifier; // N, the RLN nullifier at the claimed index n
        uint256 signalX; // x = Poseidon(Poseidon(recipient, chainId), contract)
        uint256 signalY; // y = k + a · x
        uint256 payout; // P = D + R − n · C_MAX
        address recipient;
        uint256 exitAt;
    }

    // ============ Constants ============

    /// @notice 20-level Merkle tree depth (supports ~1M notes)
    uint256 public constant TREE_DEPTH = 20;

    /// @notice How many recent roots a request proof may use
    /// @dev Much shorter than the challenge window, so no accepted root still
    ///      contains a note whose exit is final
    uint256 public constant ROOT_HISTORY_SIZE = 30;

    /// @notice Delay before a proposed change can be executed
    /// @dev Longer than an exit takes, so users can leave before a change they disagree with
    uint256 public constant ADMIN_DELAY = 7 days;

    /// @notice Time after which the operator can claim an untouched note
    /// @dev Counted from the deposit, excluding any time the contract spent paused
    uint256 public constant NOTE_TTL = 365 days;

    /// @notice W: how long an exit can be challenged before it pays out
    /// @dev Shorter than ADMIN_DELAY, so no admin change can land during an exit started before it
    uint256 public constant CHALLENGE_WINDOW = 3 days;

    uint256 internal constant FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ============ Immutables ============

    /// @notice C_max, the most a single request can cost, in wei
    uint256 public immutable C_MAX;

    /// @notice What whoever slashes a note gets, at most D. The rest goes to the operator,
    ///         so an owner who slashes their own note recovers no spending.
    uint256 public immutable SLASH_BOUNTY;

    // ============ State ============

    mapping(bytes32 => Note) public notes;

    mapping(bytes32 => Exit) public exits;

    /// @notice Refund signer keys a withdrawal may present, keyed by keccak256(x, y)
    mapping(bytes32 => bool) public acceptedRefundKeys;

    /// @notice Leaves in insertion order; a closed note's leaf is the empty value 0
    bytes32[] public leaves;

    bytes32[TREE_DEPTH] public zeros;

    /// @dev level => index => hash, so any leaf can be rewritten
    mapping(uint256 => mapping(uint256 => bytes32)) private treeNodes;

    bytes32 public merkleRoot;
    bytes32[ROOT_HISTORY_SIZE] public roots;
    uint256 public currentRootIndex;

    /// @notice Operator's address, which claims expired notes and operator revenue
    address public serverAddress;

    /// @notice Refund signer key the server signs accumulators with
    EdDSAPublicKey public serverPublicKey;

    /// @notice What the notes owe the operator: spending, slash remainders, expired notes
    uint256 public operatorBalance;

    SettlementVerifier public settlementVerifier;

    mapping(Target => PendingChange) public pendingChanges;

    /// @notice Total time spent paused, excluding the current pause
    uint256 public totalPausedTime;

    /// @notice When the current pause started (0 when not paused)
    uint256 public pausedAt;

    /// @notice Paused time already elapsed when each note was deposited
    mapping(bytes32 => uint256) public pausedTimeAtDeposit;

    // ============ Events ============

    event Deposited(bytes32 indexed commitment, uint256 amount, uint256 leafIndex);
    event WithdrawalInitiated(
        bytes32 indexed commitment,
        uint256 nullifier,
        uint256 signalX,
        uint256 signalY,
        uint256 payout,
        address indexed recipient,
        uint256 exitAt
    );
    event WithdrawalFinalized(bytes32 indexed commitment, address indexed recipient, uint256 payout);
    event Slashed(bytes32 indexed commitment, address indexed slasher, uint256 bounty);
    event MerkleRootUpdated(bytes32 indexed newRoot, uint256 leafCount);
    event NoteExpiredClaimed(bytes32 indexed commitment, uint256 amount);
    event OperatorBalanceWithdrawn(address indexed to, uint256 amount);
    event ServerAddressUpdated(address indexed oldAddress, address indexed newAddress);
    event ChangeProposed(Target indexed target, address value, uint256 eta);
    event ChangeExecuted(Target indexed target, address value);
    event ChangeCancelled(Target indexed target, address value);

    // ============ Errors ============

    error InvalidDepositAmount();
    error InvalidCommitment();
    error InvalidSecretKey();
    error NoteAlreadyExists();
    error NoteNotActive();
    error NoteNotExiting();
    error ChallengeWindowOpen();
    error UnknownRefundKey();
    error PayoutExceedsDeposit();
    error InvalidProof();
    error Unauthorized();
    error ZeroAddress();
    error NoPendingChange();
    error TimelockNotExpired();
    error NoteNotExpired();
    error TreeFull();
    error TransferFailed();

    // ============ Constructor ============

    constructor(
        address _serverAddress,
        bytes32 _serverPubKeyX,
        bytes32 _serverPubKeyY,
        uint256 _cMax,
        uint256 _slashBounty
    ) Ownable(msg.sender) {
        if (_serverAddress == address(0)) revert ZeroAddress();
        serverAddress = _serverAddress;
        serverPublicKey = EdDSAPublicKey({x: _serverPubKeyX, y: _serverPubKeyY});
        acceptedRefundKeys[_refundKeyId(_serverPubKeyX, _serverPubKeyY)] = true;
        C_MAX = _cMax;
        SLASH_BOUNTY = _slashBounty;
        settlementVerifier = new SettlementVerifier();

        // zeros[i] is the root of an empty subtree of height i, matching the circuit
        bytes32 currentZero = bytes32(0);
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            zeros[i] = currentZero;
            currentZero = bytes32(PoseidonHasher.hash(uint256(currentZero), uint256(currentZero)));
        }
        _pushRoot(currentZero);
    }

    // ============ Notes ============

    /**
     * @notice Open a note worth msg.value
     * @param _commitment c = Poseidon(k), where k is the note's secret key
     * @dev The note must cover at least one request, and D stays below 2^128
     *      as the circuits require
     */
    function deposit(bytes32 _commitment) external payable nonReentrant whenNotPaused {
        if (msg.value < C_MAX || msg.value >= 2 ** 128) revert InvalidDepositAmount();
        if (uint256(_commitment) >= FIELD_MODULUS) revert InvalidCommitment();
        if (notes[_commitment].status != Status.None) revert NoteAlreadyExists();
        if (leaves.length == 2 ** TREE_DEPTH) revert TreeFull();

        uint256 leafIndex = leaves.length;
        notes[_commitment] =
            Note({amount: msg.value, depositedAt: block.timestamp, leafIndex: leafIndex, status: Status.Active});
        pausedTimeAtDeposit[_commitment] = _pausedTime();

        leaves.push(bytes32(PoseidonHasher.hash(uint256(_commitment), msg.value)));
        _updateLeaf(leafIndex);

        emit Deposited(_commitment, msg.value, leafIndex);
    }

    /**
     * @notice Start an exit: pay out D + R − n · C_MAX after the challenge window
     * @param _commitment The note's commitment c
     * @param _recipient Who gets the payout, bound into the proof through x
     * @param _refundKey The key that signed the accumulator, any key ever accepted
     * @param _proof Groth16 proof [pA, pB, pC] from settlement.circom
     * @param _nullifier N, the RLN nullifier at the claimed index n
     * @param _signalY y, the RLN signal at n
     * @param _payout P
     * @dev Open while paused. The leaf goes now, so no new request proof can use
     *      the note. The contract can't see n, so the server has the window to
     *      show that index n was already used, which reveals k (see slash).
     */
    function initiateWithdrawal(
        bytes32 _commitment,
        address _recipient,
        EdDSAPublicKey calldata _refundKey,
        uint256[8] calldata _proof,
        uint256 _nullifier,
        uint256 _signalY,
        uint256 _payout
    ) external nonReentrant {
        if (_recipient == address(0)) revert ZeroAddress();
        Note storage note = notes[_commitment];
        if (note.status != Status.Active) revert NoteNotActive();
        if (!acceptedRefundKeys[_refundKeyId(_refundKey.x, _refundKey.y)]) revert UnknownRefundKey();
        if (_payout > note.amount) revert PayoutExceedsDeposit();

        uint256 signalX = withdrawalSignalX(_recipient);
        // [nullifier, signalY, payout, commitment, deposit, maxCost, serverPublicKeyX, serverPublicKeyY, recipient, signalX]
        uint256[10] memory publicSignals = [
            _nullifier,
            _signalY,
            _payout,
            uint256(_commitment),
            note.amount,
            C_MAX,
            uint256(_refundKey.x),
            uint256(_refundKey.y),
            uint256(uint160(_recipient)),
            signalX
        ];
        if (!settlementVerifier.verifySettlementProof(_proof, publicSignals)) revert InvalidProof();

        uint256 exitAt = block.timestamp + CHALLENGE_WINDOW;
        note.status = Status.Exiting;
        exits[_commitment] = Exit({
            nullifier: _nullifier,
            signalX: signalX,
            signalY: _signalY,
            payout: _payout,
            recipient: _recipient,
            exitAt: exitAt
        });
        _removeLeaf(note.leafIndex);

        emit WithdrawalInitiated(_commitment, _nullifier, signalX, _signalY, _payout, _recipient, exitAt);
    }

    /**
     * @notice Pay an exit once its window has passed unchallenged
     * @dev Anyone can call it, also while paused
     */
    function finalizeWithdrawal(bytes32 _commitment) external nonReentrant {
        Note storage note = notes[_commitment];
        if (note.status != Status.Exiting) revert NoteNotExiting();
        Exit memory exit = exits[_commitment];
        if (block.timestamp < exit.exitAt) revert ChallengeWindowOpen();

        note.status = Status.Closed;
        operatorBalance += note.amount - exit.payout;
        _pay(exit.recipient, exit.payout);

        emit WithdrawalFinalized(_commitment, exit.recipient, exit.payout);
    }

    /**
     * @notice Slash a note whose secret key is known
     * @param _secretKey k, which leaks only when two RLN signals share a nullifier:
     *        k = (y1 · x2 − y2 · x1) / (x2 − x1)
     * @dev Knowing k is the proof, so anyone can call it, also while paused and
     *      during an exit's challenge window. The caller gets the bounty and the
     *      operator the rest of D.
     */
    function slash(uint256 _secretKey) external nonReentrant {
        if (_secretKey >= FIELD_MODULUS) revert InvalidSecretKey();
        bytes32 commitment = bytes32(PoseidonHasher.hash(_secretKey));
        Note storage note = notes[commitment];
        if (note.status == Status.Active) {
            _removeLeaf(note.leafIndex);
        } else if (note.status != Status.Exiting) {
            revert NoteNotActive();
        }

        uint256 bounty = note.amount < SLASH_BOUNTY ? note.amount : SLASH_BOUNTY;
        note.status = Status.Slashed;
        operatorBalance += note.amount - bounty;
        _pay(msg.sender, bounty);

        emit Slashed(commitment, msg.sender, bounty);
    }

    /**
     * @notice Claim a note nobody touched for NOTE_TTL
     * @dev Only the operator, never while paused, and never on a note that is
     *      exiting, so an exit started before expiry always completes
     */
    function claimExpired(bytes32 _commitment) external nonReentrant whenNotPaused {
        if (msg.sender != serverAddress) revert Unauthorized();
        Note storage note = notes[_commitment];
        if (note.status != Status.Active) revert NoteNotActive();
        if (block.timestamp < noteExpiry(_commitment)) revert NoteNotExpired();

        note.status = Status.Expired;
        _removeLeaf(note.leafIndex);
        operatorBalance += note.amount;

        emit NoteExpiredClaimed(_commitment, note.amount);
    }

    /**
     * @notice Pay the operator what closed notes owe it
     */
    function withdrawOperatorBalance() external nonReentrant {
        if (msg.sender != serverAddress) revert Unauthorized();
        uint256 amount = operatorBalance;
        operatorBalance = 0;
        _pay(serverAddress, amount);
        emit OperatorBalanceWithdrawn(serverAddress, amount);
    }

    // ============ Views ============

    /**
     * @notice When a note expires, pushed back by every second spent paused since its deposit
     * @dev Pausing can therefore never bring a note's expiry closer
     */
    function noteExpiry(bytes32 _commitment) public view returns (uint256) {
        Note storage note = notes[_commitment];
        if (note.status == Status.None) revert NoteNotActive();
        return note.depositedAt + NOTE_TTL + _pausedTime() - pausedTimeAtDeposit[_commitment];
    }

    /**
     * @notice The RLN signal x a withdrawal to this recipient must use
     * @dev Poseidon(Poseidon(recipient, chainId), contract): the proof is bound
     *      to the recipient, the chain and this deployment
     */
    function withdrawalSignalX(address _recipient) public view returns (uint256) {
        return PoseidonHasher.hash3(uint256(uint160(_recipient)), block.chainid, uint256(uint160(address(this))));
    }

    function getNote(bytes32 _commitment) external view returns (Note memory) {
        return notes[_commitment];
    }

    function getLeaves() external view returns (bytes32[] memory) {
        return leaves;
    }

    function getLeafCount() external view returns (uint256) {
        return leaves.length;
    }

    /**
     * @notice Whether a request proof may use this root
     */
    function isKnownRoot(bytes32 _root) public view returns (bool) {
        if (_root == bytes32(0)) return false;
        for (uint256 i = 0; i < ROOT_HISTORY_SIZE; i++) {
            if (roots[i] == _root) return true;
        }
        return false;
    }

    /**
     * @notice Merkle path of a leaf, for request proofs
     * @return pathElements Sibling hashes from the leaf up
     * @return pathIndices 0 when the node is a left child, 1 when right
     */
    function getMerkleProof(uint256 _leafIndex)
        external
        view
        returns (bytes32[TREE_DEPTH] memory pathElements, uint8[TREE_DEPTH] memory pathIndices)
    {
        require(_leafIndex < leaves.length, "Leaf index out of bounds");
        uint256 index = _leafIndex;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            pathIndices[level] = uint8(index % 2);
            pathElements[level] = _node(level, index ^ 1);
            index /= 2;
        }
    }

    // ============ Admin ============

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

    function executeChange(Target _target) external onlyOwner {
        PendingChange memory change = pendingChanges[_target];
        if (change.eta == 0) revert NoPendingChange();
        if (block.timestamp < change.eta) revert TimelockNotExpired();
        delete pendingChanges[_target];

        if (_target == Target.SettlementVerifier) {
            settlementVerifier = SettlementVerifier(change.value);
        } else {
            emit ServerAddressUpdated(serverAddress, change.value);
            serverAddress = change.value;
        }

        emit ChangeExecuted(_target, change.value);
    }

    function cancelChange(Target _target) external onlyOwner {
        PendingChange memory change = pendingChanges[_target];
        if (change.eta == 0) revert NoPendingChange();
        delete pendingChanges[_target];
        emit ChangeCancelled(_target, change.value);
    }

    /**
     * @notice Pause deposits and expiry claims (emergency). Exits stay open.
     */
    function pause() external onlyOwner {
        _pause();
        pausedAt = block.timestamp;
    }

    function unpause() external onlyOwner {
        _unpause();
        totalPausedTime += block.timestamp - pausedAt;
        pausedAt = 0;
    }

    // ============ Internal ============

    /// @notice Total time spent paused, including the current pause
    function _pausedTime() internal view returns (uint256) {
        return paused() ? totalPausedTime + block.timestamp - pausedAt : totalPausedTime;
    }

    function _refundKeyId(bytes32 _x, bytes32 _y) internal pure returns (bytes32) {
        return keccak256(abi.encode(_x, _y));
    }

    function _pay(address _to, uint256 _amount) internal {
        (bool success,) = _to.call{value: _amount}("");
        if (!success) revert TransferFailed();
    }

    /// @dev Replaces a closed note's leaf with the empty value, so new proofs can't use it
    function _removeLeaf(uint256 _leafIndex) internal {
        leaves[_leafIndex] = bytes32(0);
        _updateLeaf(_leafIndex);
    }

    function _node(uint256 _level, uint256 _index) internal view returns (bytes32) {
        bytes32 node = treeNodes[_level][_index];
        return node != bytes32(0) ? node : zeros[_level];
    }

    /// @dev Recomputes the path from a leaf to the root, which becomes the newest known root
    function _updateLeaf(uint256 _leafIndex) internal {
        bytes32 current = leaves[_leafIndex];
        uint256 index = _leafIndex;
        treeNodes[0][index] = current;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            bytes32 sibling = _node(level, index ^ 1);
            current = index % 2 == 0
                ? bytes32(PoseidonHasher.hash(uint256(current), uint256(sibling)))
                : bytes32(PoseidonHasher.hash(uint256(sibling), uint256(current)));
            index /= 2;
            treeNodes[level + 1][index] = current;
        }
        _pushRoot(current);
    }

    function _pushRoot(bytes32 _root) internal {
        currentRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        roots[currentRootIndex] = _root;
        merkleRoot = _root;
        emit MerkleRootUpdated(_root, leaves.length);
    }
}
