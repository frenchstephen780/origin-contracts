// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectFeeRewards, IWeightedToken, IFeeRewardGovernance} from "./ProjectFeeRewards.sol";

contract FeeRewardsDeployer {
    function deploy(IWeightedToken token, IFeeRewardGovernance governance, address feeSource) external returns (ProjectFeeRewards) {
        return new ProjectFeeRewards(token, governance, feeSource);
    }
}
