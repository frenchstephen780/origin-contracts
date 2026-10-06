// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {RefundableV4ProjectFactory} from "./RefundableV4ProjectFactory.sol";
import {IMigrationCoordinator} from "./interfaces/IMigrationCoordinator.sol";
contract LPV4ProjectFactory is RefundableV4ProjectFactory {
    constructor(address platform, IMigrationCoordinator coordinator_) RefundableV4ProjectFactory(platform, coordinator_) {}
    function CONTRACT_VERSION() external pure virtual override returns (uint256) { return 13; }
}
