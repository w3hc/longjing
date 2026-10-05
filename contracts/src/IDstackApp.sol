// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

/// @notice The subset of dstack's DstackApp that Longjing's governance calls.
/// @dev https://github.com/Dstack-TEE/dstack/blob/master/dstack/kms/auth-eth/contracts/DstackApp.sol
interface IDstackApp {
    event ComposeHashAdded(bytes32 composeHash);
    event ComposeHashRemoved(bytes32 composeHash);

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;

    function allowedComposeHashes(bytes32 composeHash) external view returns (bool);
    function addComposeHash(bytes32 composeHash) external;
    function removeComposeHash(bytes32 composeHash) external;

    function requireTcbUpToDate() external view returns (bool);
    function setRequireTcbUpToDate(bool requireUpToDate) external;
}
