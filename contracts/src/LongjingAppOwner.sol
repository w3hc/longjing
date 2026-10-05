// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.35;

import {IDstackApp} from "./IDstackApp.sol";

/// @title LongjingAppOwner
/// @notice Owns Longjing's DstackApp. The timelock can make any call to the app,
/// so adding a compose hash is always delayed. The guardian can only remove
/// compose hashes, without delay: removal only ever shrinks the set of builds
/// that can derive Longjing's keys.
contract LongjingAppOwner {
    IDstackApp public immutable app;
    address public immutable timelock;
    address public guardian;

    event GuardianSet(address indexed guardian);

    error NotTimelock();
    error NotGuardian();
    error ZeroAddress();

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock();
        _;
    }

    constructor(IDstackApp app_, address timelock_, address guardian_) {
        if (address(app_) == address(0) || timelock_ == address(0)) revert ZeroAddress();
        app = app_;
        timelock = timelock_;
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Forwards any call to the app: add or remove a compose hash,
    /// upgrade, change a setting, or hand the app to another owner.
    function execute(bytes calldata data) external onlyTimelock returns (bytes memory) {
        (bool ok, bytes memory result) = address(app).call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }

    /// @notice The emergency path: stops a build from booting, and from
    /// deriving the keys, right away.
    function removeComposeHash(bytes32 composeHash) external {
        if (msg.sender != guardian) revert NotGuardian();
        app.removeComposeHash(composeHash);
    }

    /// @notice Zero disables the emergency path.
    function setGuardian(address guardian_) external onlyTimelock {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Completes the app's two-step ownership transfer to this contract.
    function acceptOwnership() external {
        app.acceptOwnership();
    }
}
