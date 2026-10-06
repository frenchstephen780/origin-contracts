// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SwapFeePolicy} from "./SwapFeePolicy.sol";

/// @notice Active 20/40/10/30; terminated 0/60/10/30. LP has no age multiplier.
contract SwapFeePolicyLP is SwapFeePolicy {
    function upgradeFamily() public pure override returns (bytes32) { return keccak256("origin.swap.fee.policy.lp.v1"); }
    function split(uint256 amount, bool ended) external pure override returns (uint256 founder, uint256 rewards) {
        return (ended ? 0 : Math.mulDiv(amount, 20, 100), Math.mulDiv(amount, ended ? 60 : 40, 100));
    }
    function splitWithLP(uint256 amount, bool ended) external pure virtual
        returns (uint256 founder, uint256 rewards, uint256 lp) {
        return (ended ? 0 : Math.mulDiv(amount, 20, 100),
            Math.mulDiv(amount, ended ? 60 : 40, 100), Math.mulDiv(amount, 10, 100));
    }
}
