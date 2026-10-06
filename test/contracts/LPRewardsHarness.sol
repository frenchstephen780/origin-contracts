// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {OperatingRewardsLP} from "../../src/upgrades/OperatingRewardsLP.sol";
import {ProjectGovernance} from "../../src/ProjectGovernance.sol";
import {SwapFeePolicyLP} from "../../src/upgrades/SwapFeePolicyLP.sol";

contract NestedOperatingDeposit {
    IPoolManager public immutable manager;
    OperatingRewardsLP private reward;
    uint256 private pending;
    constructor(IPoolManager m) { manager = m; }
    function accept(ProjectGovernance governance) external { governance.acceptDeveloperTransfer(); }
    function depositNested(OperatingRewardsLP rewards) external payable {
        require(pending == 0 && msg.value != 0);
        reward = rewards; pending = msg.value;
        manager.unlock("");
    }
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(manager) && pending != 0);
        uint256 amount = pending; pending = 0;
        reward.deposit{value:amount}();
        return "";
    }
}
contract InvalidLPFeePolicy is SwapFeePolicyLP {
    function splitWithLP(uint256 amount, bool) external pure override returns (uint256, uint256, uint256) {
        return (0, amount, amount);
    }
}
