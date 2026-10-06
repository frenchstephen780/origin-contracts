// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {UpgradeableCommunityGovernance} from "../../src/upgrades/UpgradeableCommunityGovernance.sol";
import {UpgradeableProjectRewards} from "../../src/upgrades/UpgradeableProjectRewards.sol";
import {SwapFeePolicy} from "../../src/upgrades/SwapFeePolicy.sol";
import {HoldingWeight} from "../../src/libraries/HoldingWeight.sol";

contract GovernanceV2Test is UpgradeableCommunityGovernance {
    function version() external pure returns (uint256) { return 2; }
    // Demonstrates an actual upgraded withdrawal constraint, not just a getter.
    function _withdrawalAmount(uint256 available, bool initial) internal pure override returns (uint256) {
        return available / (initial ? 4 : 5);
    }
}
contract GovernanceMinimumTest is UpgradeableCommunityGovernance {
    function setOldMinimum(uint256 value) external { minimumPower = value; }
}
contract BrokenRewardsTest is UpgradeableProjectRewards {
    function capture(address) external pure override { revert("broken capture"); }
}
interface IRawWeightState {
    function recentWeightState(address account, uint256 blockNumber, uint256 time)
        external view returns (uint256 balance, uint256 decayBalance, uint256 elapsed);
}
contract RewardsV2Test is UpgradeableProjectRewards {
    function version() external pure returns (uint256) { return 2; }
    // Compatible revaluation of the existing aggregate decay state. This sample
    // reduces the new payout multiplier to 1..4; production V1 retains 1..7.
    function _snapshotShares(address account, uint256 snapshotBlock, uint256 weightTime)
        internal view override returns (uint256 balance, uint256 shares) {
        uint256 decay; uint256 elapsed;
        (balance, decay, elapsed) = IRawWeightState(address(token)).recentWeightState(account, snapshotBlock, weightTime);
        shares = balance <= 1 ether ? 0 : (balance + HoldingWeight.shares(balance, decay, elapsed)) / 2;
    }
}
contract FeePolicyV2Test is SwapFeePolicy {
    function split(uint256 amount, bool ended) external pure override returns (uint256, uint256) {
        return ended ? (uint256(0), amount * 70 / 100) : (amount * 50 / 100, amount * 20 / 100);
    }
}
contract InvalidFeePolicyTest is SwapFeePolicy {
    function split(uint256 amount, bool) external pure override returns (uint256, uint256) { return (amount + 1, 0); }
}
