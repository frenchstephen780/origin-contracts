// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @dev Test driver only, not a production router: intentionally no user slippage
/// or deadline API. Calls the actual PoolManager; never simulates swap results.
contract V4TestRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    IPoolManager public immutable manager;
    bool private pending;
    event Delta(int128 ethDelta, int128 tokenDelta);
    constructor(IPoolManager manager_) { manager = manager_; }

    function swap(PoolKey calldata key, SwapParams calldata params) external payable nonReentrant returns (BalanceDelta delta) {
        pending = true;
        delta = abi.decode(manager.unlock(abi.encode(uint8(1), msg.sender, key, abi.encode(params))), (BalanceDelta));
        _refund(delta);
    }

    function modify(PoolKey calldata key, ModifyLiquidityParams calldata params)
        external payable nonReentrant returns (BalanceDelta delta)
    {
        pending = true;
        delta = abi.decode(manager.unlock(abi.encode(uint8(2), msg.sender, key, abi.encode(params))), (BalanceDelta));
        _refund(delta);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager) && pending);
        pending = false;
        (uint8 action, address payer, PoolKey memory key, bytes memory params) = abi.decode(data, (uint8, address, PoolKey, bytes));
        BalanceDelta delta;
        if (action == 1) delta = manager.swap(key, abi.decode(params, (SwapParams)), "");
        else (delta,) = manager.modifyLiquidity(key, abi.decode(params, (ModifyLiquidityParams)), "");
        if (delta.amount0() < 0) manager.settle{value: uint256(-int256(delta.amount0()))}();
        if (delta.amount1() < 0) {
            manager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).safeTransferFrom(payer, address(manager), uint256(-int256(delta.amount1())));
            manager.settle();
        }
        if (delta.amount0() > 0) manager.take(key.currency0, payer, uint256(uint128(delta.amount0())));
        if (delta.amount1() > 0) manager.take(key.currency1, payer, uint256(uint128(delta.amount1())));
        return abi.encode(delta);
    }

    function _refund(BalanceDelta delta) private {
        uint256 used = delta.amount0() < 0 ? uint256(-int256(delta.amount0())) : 0;
        require(msg.value >= used);
        if (msg.value > used) {
            (bool ok,) = msg.sender.call{value: msg.value - used}("");
            require(ok);
        }
        emit Delta(delta.amount0(), delta.amount1());
    }

    function poolState(PoolKey calldata key) external view returns (uint160, int24, uint24, uint24) {
        return manager.getSlot0(key.toId());
    }
}
