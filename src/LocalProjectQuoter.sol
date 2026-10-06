// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @notice Local preview quote helper. The simulated swap always reverts inside
/// PoolManager.unlock, rolling back all pool balances and Hook fee accrual.
/// Public networks continue to use their pinned official Quoter addresses.
contract LocalProjectQuoter {
    using BalanceDeltaLibrary for BalanceDelta;
    IPoolManager public immutable poolManager;

    struct QuoteExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    error InvalidQuote();
    error Unauthorized();
    error QuoteResult(uint256 amountOut);

    constructor(IPoolManager manager) {
        if (address(manager).code.length == 0) revert InvalidQuote();
        poolManager = manager;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external returns (uint256 amountOut, uint256 gasEstimate)
    {
        if (params.exactAmount == 0 || params.exactAmount > uint128(type(int128).max)) revert InvalidQuote();
        uint256 beforeGas = gasleft();
        try poolManager.unlock(abi.encode(params)) returns (bytes memory) {
            revert InvalidQuote();
        } catch (bytes memory reason) {
            bytes4 selector;
            if (reason.length == 36) {
                assembly ("memory-safe") {
                    selector := mload(add(reason, 32))
                    amountOut := mload(add(reason, 36))
                }
            }
            if (reason.length != 36 || selector != QuoteResult.selector) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
            if (amountOut == 0) revert InvalidQuote();
            gasEstimate = beforeGas - gasleft();
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        QuoteExactInputSingleParams memory params = abi.decode(data, (QuoteExactInputSingleParams));
        BalanceDelta delta = poolManager.swap(params.poolKey, SwapParams({
            zeroForOne: params.zeroForOne,
            amountSpecified: -int256(uint256(params.exactAmount)),
            sqrtPriceLimitX96: params.zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341
        }), params.hookData);
        int128 output = params.zeroForOne ? delta.amount1() : delta.amount0();
        if (output <= 0) revert InvalidQuote();
        revert QuoteResult(uint256(uint128(output)));
    }
}
