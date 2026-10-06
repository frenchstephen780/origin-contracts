// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {LPV4ProjectFactory} from "./LPV4ProjectFactory.sol";
import {IMigrationCoordinator} from "./interfaces/IMigrationCoordinator.sol";
import {IFundraisingPolicy} from "./interfaces/IFundraisingPolicy.sol";

/// @notice New projects use 1P/1.15P/1.3P, open at 1.45P and cap each address at 5%.
contract CommunityV4ProjectFactory is LPV4ProjectFactory {
    constructor(address platform, IMigrationCoordinator coordinator_) LPV4ProjectFactory(platform, coordinator_) {
        require(IFundraisingPolicy(address(coordinator_)).fundraisingPolicyVersion() == 2, "Incorrect fundraising policy");
    }
    function CONTRACT_VERSION() external pure override returns (uint256) { return 15; }
}
