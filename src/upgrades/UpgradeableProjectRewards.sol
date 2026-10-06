// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectFeeRewards, IWeightedToken, IFeeRewardGovernance} from "../ProjectFeeRewards.sol";
import {UpgradeControl} from "./UpgradeControl.sol";
import {OriginProxy} from "./OriginProxy.sol";
interface IRecoverableToken { function rewardRecovery() external view returns (bool); }

contract UpgradeableProjectRewards is ProjectFeeRewards, UpgradeControl {
    constructor() ProjectFeeRewards(IWeightedToken(address(0)), IFeeRewardGovernance(address(0)), address(0)) {
        _disableInitializers();
    }
    function initialize(IWeightedToken token_, IFeeRewardGovernance governance_, address source, address authority)
        external initializer {
        _initializeUpgrade(authority);
        _initializeRewards(token_, governance_, source);
    }
    function upgradeFamily() public pure override returns (bytes32) { return keccak256("origin.project.rewards.v1"); }
    event RoundAbortedForRecovery(uint256 roundId, uint256 carriedForward);
    /// @notice Only delayed recovery may abandon uncredited allocations. Existing
    /// claimable ETH remains owed; remaining funds are queued for a fresh snapshot.
    function abortRoundForRecovery() external {
        if (msg.sender != upgradeAuthority() || !IRecoverableToken(address(token)).rewardRecovery()) revert UnauthorizedUpgrade();
        if (currentRound.phase != Phase.Idle) {
            uint256 remaining = currentRound.amount - currentRound.credited;
            queuedFunds += remaining;
            currentRound.phase = Phase.Idle;
            emit RoundAbortedForRecovery(roundCount, remaining);
        }
    }
    function _authorizeUpgrade(address candidate) internal override {
        super._authorizeUpgrade(candidate);
        // Finish both scans before changing payout maths. Earned claimable
        // balances remain liabilities; queued funds use the next round's rules.
        if (currentRound.phase != Phase.Idle && !IRecoverableToken(address(token)).rewardRecovery()) revert InvalidUpgrade();
    }
}

contract ProxyRewardsDeployer {
    address public immutable implementation;
    address public immutable authority;
    constructor(address implementation_, address authority_) {
        require(implementation_.code.length != 0 && authority_.code.length != 0);
        require(UpgradeableProjectRewards(payable(implementation_)).upgradeFamily() == keccak256("origin.project.rewards.v1"));
        implementation = implementation_; authority = authority_;
    }
    function deploy(IWeightedToken token, IFeeRewardGovernance governance, address source) external returns (ProjectFeeRewards) {
        return ProjectFeeRewards(payable(new OriginProxy(implementation,
            abi.encodeCall(UpgradeableProjectRewards.initialize, (token, governance, source, authority)))));
    }
}
