// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectFactory} from "./ProjectFactory.sol";
import {IMigrationCoordinator} from "./interfaces/IMigrationCoordinator.sol";
import {MigrationMath} from "./libraries/MigrationMath.sol";

/// @notice V4-connected factory. The base ProjectFactory remains a refund-only
/// stage-one fixture for regression tests, never a migration-capable deployment.
contract V4ProjectFactory is ProjectFactory {
    IMigrationCoordinator public immutable coordinator;
    constructor(address platform, IMigrationCoordinator coordinator_) ProjectFactory(platform) {
        if (address(coordinator_).code.length == 0) revert InvalidTreasury();
        coordinator = coordinator_;
    }
    function _coordinator() internal view override returns (IMigrationCoordinator) { return coordinator; }
    function _validateMigrationTarget(uint256 target) internal pure override { MigrationMath.quote(target); }
}
