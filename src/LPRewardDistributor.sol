// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ProjectToken} from "./ProjectToken.sol";
import {ITransferRewards as IOperatingRewards} from "./interfaces/ITransferRewards.sol";

/// @notice Extra native ETH revenue uses V4 fee growth, not token age weights.
/// All in-range positions, including the official locker, earn their share.
/// Each token's queued revenue is isolated; failed donations remain retryable.
contract LPRewardDistributor is ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    IPoolManager public immutable poolManager;
    address public immutable coordinator;
    address public hook;
    struct Pool { PoolKey key; address operatingRewards; bool registered; }
    mapping(address => Pool) private pools;
    mapping(address => uint256) public queuedETH;
    mapping(address => uint256) public totalDonatedETH;
    uint256 public totalQueuedETH;
    address private pendingToken;
    uint256 private pendingAmount;
    error Unauthorized(); error InvalidPool(); error InvalidAmount();
    event PoolRegistered(address indexed token, bytes32 indexed poolId, address operatingRewards);
    event Funded(address indexed token, address indexed source, uint256 amount);
    event Donated(address indexed token, bytes32 indexed poolId, uint256 amount);
    constructor(IPoolManager manager, address coordinator_) {
        if (address(manager).code.length == 0 || coordinator_.code.length == 0) revert InvalidPool();
        poolManager = manager; coordinator = coordinator_;
    }
    function configureHook(address hook_) external {
        if (msg.sender != coordinator || hook != address(0) || hook_.code.length == 0) revert Unauthorized();
        hook = hook_;
    }
    function register(PoolKey calldata key, address operating) external {
        if (msg.sender != coordinator || hook == address(0)) revert Unauthorized();
        address token = Currency.unwrap(key.currency1);
        if (Currency.unwrap(key.currency0) != address(0) || address(key.hooks) != hook || key.fee != 3000 ||
            key.tickSpacing != 60 || pools[token].registered || operating.code.length == 0 ||
            ProjectToken(token).operatingRewards() != IOperatingRewards(operating)) revert InvalidPool();
        pools[token] = Pool(key, operating, true);
        emit PoolRegistered(token, PoolId.unwrap(key.toId()), operating);
    }
    function poolId(address token) external view returns (bytes32) {
        if (!pools[token].registered) revert InvalidPool();
        return PoolId.unwrap(pools[token].key.toId());
    }
    function fund(address token) external payable {
        Pool storage p = pools[token];
        if (!p.registered) revert InvalidPool();
        if (msg.sender != hook && msg.sender != p.operatingRewards) revert Unauthorized();
        if (msg.value == 0) revert InvalidAmount();
        queuedETH[token] += msg.value; totalQueuedETH += msg.value;
        emit Funded(token, msg.sender, msg.value);
    }
    /// @notice No nested unlock. Call only after swap/fee redemption completes.
    /// A zero-liquidity or failed donation reverts and preserves all liabilities.
    function process(address token) external nonReentrant {
        Pool storage p = pools[token];
        uint256 amount = queuedETH[token];
        if (!p.registered) revert InvalidPool();
        if (amount == 0) revert InvalidAmount();
        queuedETH[token] = 0; totalQueuedETH -= amount;
        pendingToken = token; pendingAmount = amount;
        poolManager.unlock("");
        if (pendingToken != address(0)) revert Unauthorized();
        totalDonatedETH[token] += amount;
        emit Donated(token, PoolId.unwrap(p.key.toId()), amount);
    }
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        address token = pendingToken;
        if (msg.sender != address(poolManager) || token == address(0)) revert Unauthorized();
        uint256 amount = pendingAmount;
        pendingToken = address(0); pendingAmount = 0;
        poolManager.donate(pools[token].key, amount, 0, "");
        poolManager.settle{value: amount}();
        return "";
    }
}
