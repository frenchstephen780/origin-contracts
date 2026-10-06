// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {UpgradeControl} from "./UpgradeControl.sol";

/// @notice Upgradeable split calculator, with no custody or transfer permission.
/// The immutable hook still charges exactly 1% native ETH plus separate LP fees.
contract SwapFeePolicy is UpgradeControl {
    constructor() { _disableInitializers(); }
    function initialize(address authority) external initializer { _initializeUpgrade(authority); }
    function upgradeFamily() public pure virtual override returns (bytes32) { return keccak256("origin.swap.fee.policy.v1"); }
    function split(uint256 amount, bool ended) external pure virtual returns (uint256 founder, uint256 rewards) {
        if (ended) return (0, Math.mulDiv(amount, 70, 100));
        return (Math.mulDiv(amount, 40, 100), Math.mulDiv(amount, 30, 100));
    }
}
