// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

interface IFeeCollectionHook { function distributeForToken(address token) external; }

/// @notice Single official-pool swap with net-output/input bounds, deadline and refund.
/// No arbitrary calls, liquidity removal, persistent custody or admin sweep.
contract ProjectSwapRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IPoolManager public immutable manager;
    address public immutable hook;
    bytes32 private pending;
    struct Order {
        address payer;
        address recipient;
        PoolKey key;
        SwapParams params;
        uint256 maxInput;
        uint256 minOutput;
    }
    error InvalidOrder();
    error SlippageExceeded();
    error Unauthorized();
    error TransferFailed();
    event Swapped(address indexed payer, address indexed recipient, address indexed token,
        bool buy, uint256 input, uint256 output);
    event FeeCollectionDeferred(address indexed token);

    constructor(IPoolManager manager_, address hook_) {
        if (address(manager_).code.length == 0 || hook_.code.length == 0) revert InvalidOrder();
        manager = manager_;
        hook = hook_;
    }

    function swap(PoolKey calldata key, SwapParams calldata params, uint256 maxInput,
        uint256 minOutput, address recipient, uint256 deadline)
        external payable nonReentrant returns (uint256 input, uint256 output)
    {
        if (block.timestamp > deadline || recipient == address(0) || recipient == address(this) ||
            recipient == address(manager) || maxInput == 0 || minOutput == 0 || params.amountSpecified == 0 ||
            Currency.unwrap(key.currency0) != address(0) || Currency.unwrap(key.currency1).code.length == 0 ||
            address(key.hooks) != hook || key.fee != 3000 || key.tickSpacing != 60) revert InvalidOrder();
        if (params.zeroForOne ? msg.value != maxInput : msg.value != 0) revert InvalidOrder();
        bytes memory data = abi.encode(Order(msg.sender, recipient, key, params, maxInput, minOutput));
        pending = keccak256(data);
        (input, output) = abi.decode(manager.unlock(data), (uint256, uint256));
        // Never nest PoolManager.unlock during token transfer/swap callbacks.
        // Accrual already succeeded atomically with the swap; failed collection
        // leaves claims backed by PoolManager for a permissionless retry.
        try IFeeCollectionHook(hook).distributeForToken{gas:1_200_000}(Currency.unwrap(key.currency1)) {}
        catch { emit FeeCollectionDeferred(Currency.unwrap(key.currency1)); }
        if (params.zeroForOne && msg.value > input) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - input}("");
            if (!ok) revert TransferFailed();
        }
        emit Swapped(msg.sender, recipient, Currency.unwrap(key.currency1), params.zeroForOne, input, output);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager) || pending == bytes32(0) || keccak256(data) != pending) revert Unauthorized();
        pending = bytes32(0);
        Order memory order = abi.decode(data, (Order));
        BalanceDelta delta = manager.swap(order.key, order.params, "");
        int256 inputDelta = order.params.zeroForOne ? int256(delta.amount0()) : int256(delta.amount1());
        int256 outputDelta = order.params.zeroForOne ? int256(delta.amount1()) : int256(delta.amount0());
        if (inputDelta >= 0 || outputDelta <= 0) revert InvalidOrder();
        uint256 input = uint256(-inputDelta);
        uint256 output = uint256(outputDelta);
        if (input > order.maxInput || output < order.minOutput) revert SlippageExceeded();
        if (order.params.zeroForOne) {
            manager.settle{value: input}();
            manager.take(order.key.currency1, order.recipient, output);
        } else {
            manager.sync(order.key.currency1);
            IERC20(Currency.unwrap(order.key.currency1)).safeTransferFrom(order.payer, address(manager), input);
            manager.settle();
            manager.take(order.key.currency0, order.recipient, output);
        }
        return abi.encode(input, output);
    }
}
