// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ProjectGovernance} from "./ProjectGovernance.sol";
import {PermanentLiquidityLocker} from "./PermanentLiquidityLocker.sol";

/// @notice Stateless deployment keeps locker bytecode outside coordinator runtime.
contract PermanentLiquidityDeployer {
    function deploy(IPoolManager manager, IERC20 token, IHooks hook, ProjectGovernance governance,
        uint256 target, uint256 feeBps) external returns (PermanentLiquidityLocker) {
        return new PermanentLiquidityLocker(manager, token, hook, governance, target, feeBps, msg.sender);
    }
}
