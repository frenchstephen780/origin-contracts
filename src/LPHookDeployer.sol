// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPRewardDistributor} from "./LPRewardDistributor.sol";
import {V4FeeHookLP} from "./V4FeeHookLP.sol";
contract LPHookDeployer {
    function deploy(bytes32 salt, IPoolManager manager, address coordinator, address platform, LPRewardDistributor distributor)
        external returns (V4FeeHookLP) { return new V4FeeHookLP{salt:salt}(manager, coordinator, platform, distributor); }
}
