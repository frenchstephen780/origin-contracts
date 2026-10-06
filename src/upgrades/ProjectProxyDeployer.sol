// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {OriginProxy} from "./OriginProxy.sol";
import {UpgradeableCommunityGovernance} from "./UpgradeableCommunityGovernance.sol";
import {UpgradeableProjectRewards} from "./UpgradeableProjectRewards.sol";
import {ProjectGovernance} from "../ProjectGovernance.sol";
import {ProjectFeeRewards, IWeightedToken, IFeeRewardGovernance} from "../ProjectFeeRewards.sol";
import {IProjectVotingPower} from "../interfaces/IProjectVotingPower.sol";
import {AllocationVerifier} from "../AllocationVerifier.sol";

/// @notice Stateless factory for all three project proxies; no custody or admin calls.
contract ProjectProxyDeployer {
    address public immutable implementation;
    address public immutable rewardsImplementation;
    address public immutable operatingImplementation;
    address public immutable authority;
    constructor(address governanceImpl,address feeImpl,address operatingImpl,address authority_) {
        require(governanceImpl.code.length != 0 && feeImpl.code.length != 0 &&
            operatingImpl.code.length != 0 && authority_.code.length != 0);
        require(UpgradeableCommunityGovernance(governanceImpl).upgradeFamily() == keccak256("origin.community.governance.v1"));
        require(UpgradeableProjectRewards(payable(feeImpl)).upgradeFamily() == keccak256("origin.project.rewards.v1"));
        require(UpgradeableProjectRewards(payable(operatingImpl)).upgradeFamily() == keccak256("origin.project.rewards.v1"));
        implementation=governanceImpl; rewardsImplementation=feeImpl; operatingImplementation=operatingImpl; authority=authority_;
    }
    function deployCommunity(address founder,IProjectVotingPower token,AllocationVerifier verifier) external returns(ProjectGovernance) {
        return ProjectGovernance(address(new OriginProxy(implementation,
            abi.encodeCall(UpgradeableCommunityGovernance.initialize,(founder,token,verifier,authority)))));
    }
    function deploy(address,IProjectVotingPower) external pure returns(ProjectGovernance) { revert("community verifier required"); }
    function deploy(IWeightedToken token,IFeeRewardGovernance governance,address source) external returns(ProjectFeeRewards) {
        return _rewards(rewardsImplementation,token,governance,source);
    }
    function deployOperating(IWeightedToken token,IFeeRewardGovernance governance,address source) external returns(ProjectFeeRewards) {
        return _rewards(operatingImplementation,token,governance,source);
    }
    function _rewards(address impl,IWeightedToken token,IFeeRewardGovernance governance,address source) private returns(ProjectFeeRewards) {
        return ProjectFeeRewards(payable(new OriginProxy(impl,
            abi.encodeCall(UpgradeableProjectRewards.initialize,(token,governance,source,authority)))));
    }
}
