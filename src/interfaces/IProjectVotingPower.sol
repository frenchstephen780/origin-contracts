// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Immutable on-chain policy boundary; never backed by backend-supplied
/// tallies. A production implementation is pending the circulation decision.
/// @dev Both methods MUST use the same historical population, include no
/// duplicated economic claims, and remain immutable for a past block. Direct
/// balance power is intended; delegating votes must not duplicate that power.
/// Future factories must pin an audited implementation; accepting arbitrary
/// dev-selected policies would let the dev fabricate all voting power.
interface IProjectVotingPower {
    function initialSupply() external view returns (uint256);
    function getPastPower(address account, uint256 blockNumber) external view returns (uint256);
    function getPastTotalPower(uint256 blockNumber) external view returns (uint256);
}
