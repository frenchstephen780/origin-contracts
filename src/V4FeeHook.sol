// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ProjectGovernance} from "./ProjectGovernance.sol";
import {ProjectToken} from "./ProjectToken.sol";
import {ProjectFeeRewards} from "./ProjectFeeRewards.sol";

interface ISwapFeePolicy { function split(uint256 amount, bool ended) external view returns (uint256 founder, uint256 rewards); }

/// @notice Native-ETH hook fee; charges the official pool, not unrelated pools.
/// Fees accrue as ETH ERC6909 claims, so a refusing beneficiary cannot block swaps.
/// @dev V1 rejects partial fills where ETH is the specified currency. In the
    /// other two swap modes fees use the actual ETH delta. Base fee is immutable.
contract V4FeeHook is ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    uint160 public constant REQUIRED_FLAGS = 0x20cc;
    uint256 public constant FEE_BPS = 100;
    IPoolManager public immutable poolManager;
    address public immutable coordinator;
    address public immutable platform;
    address public immutable deployedBy;
    struct Project {
        address locker;
        ProjectGovernance governance;
        uint160 initialPrice;
        uint256 devAccrued;
        uint256 rewardsAccrued;
        // Retained for the existing tuple layout. Pre-termination dev fees
        // collected after termination go directly to settlement.
        uint256 settlementReserve;
        ProjectFeeRewards rewards;
    }
    mapping(bytes32 => Project) public projects;
    mapping(address => bytes32) public tokenPoolIds;
    uint256 public platformAccrued;
    bool private redeeming;
    uint256 private redemptionAmount;
    ISwapFeePolicy public feePolicy;
    uint256 public registeredPools;
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidPool();
    error TradingNotOpen();
    error PartialEthFillUnsupported();
    error InvalidSwapAmount();
    error NothingToClaim();
    error TransferFailed();
    event FeesAccrued(bytes32 indexed poolId, uint256 ethFee, uint256 devPart, uint256 rewardsPart, uint256 platformPart);
    event FeesDistributed(bytes32 indexed poolId, uint256 devPart, uint256 rewardsPart, bool devReservedForSettlement);
    event SettlementFeesForwarded(bytes32 indexed poolId, uint256 amount);
    event FeePolicyConfigured(address policy);
    event FeePolicyFallback(bytes32 indexed poolId, address policy);

    constructor(IPoolManager manager_, address coordinator_, address platform_) {
        if (address(manager_).code.length == 0 || coordinator_.code.length == 0 || platform_ == address(0) ||
            uint160(address(this)) & 0x3fff != REQUIRED_FLAGS) revert InvalidConfiguration();
        poolManager = manager_;
        coordinator = coordinator_;
        platform = platform_;
        deployedBy = msg.sender;
    }

    modifier onlyManager() {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        _;
    }

    function configureFeePolicy(address policy) external {
        if (msg.sender != coordinator || address(feePolicy) != address(0) || registeredPools != 0) revert Unauthorized();
        if (policy.code.length == 0) revert InvalidConfiguration();
        feePolicy = ISwapFeePolicy(policy);
        emit FeePolicyConfigured(policy);
    }

    function register(PoolKey calldata key, address locker, ProjectGovernance governance, uint160 price) public virtual {
        if (msg.sender != coordinator) revert Unauthorized();
        if (Currency.unwrap(key.currency0) != address(0) || key.fee != 3000 || key.tickSpacing != 60 ||
            address(key.hooks) != address(this) || locker == address(0)) revert InvalidPool();
        Project storage p = projects[PoolId.unwrap(key.toId())];
        if (p.locker != address(0)) revert InvalidPool();
        p.locker = locker;
        p.governance = governance;
        p.initialPrice = price;
        address token = Currency.unwrap(key.currency1);
        ProjectFeeRewards rewards = ProjectFeeRewards(payable(address(ProjectToken(token).feeRewards())));
        if (address(rewards).code.length == 0 || address(rewards.token()) != token ||
            address(rewards.governance()) != address(governance) || rewards.feeSource() != address(this)) revert InvalidPool();
        p.rewards = rewards;
        tokenPoolIds[token] = PoolId.unwrap(key.toId());
        ++registeredPools;
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160 price) external view onlyManager returns (bytes4) {
        Project storage p = projects[PoolId.unwrap(key.toId())];
        if (p.locker == address(0) || sender != p.locker || price != p.initialPrice) revert InvalidPool();
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external onlyManager returns (bytes4, BeforeSwapDelta, uint24)
    {
        bytes32 poolId = PoolId.unwrap(key.toId());
        if (projects[poolId].locker == address(0)) revert InvalidPool();
        if (!ProjectToken(Currency.unwrap(key.currency1)).launched()) revert TradingNotOpen();
        if (params.amountSpecified == 0 || params.amountSpecified <= -int256(type(int128).max) ||
            params.amountSpecified > int256(type(int128).max)) revert InvalidSwapAmount();
        if (_ethSpecified(params)) {
            (uint256 baseFee, uint256 extraFee) = _specifiedFees(poolId, params);
            uint256 fee = baseFee + extraFee;
            if (fee > uint256(uint128(type(int128).max))) revert InvalidSwapAmount();
            _accrueSwap(poolId, baseFee, extraFee);
            return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external onlyManager returns (bytes4, int128)
    {
        if (_ethSpecified(params)) {
            (uint256 baseFee, uint256 extraFee) = _specifiedFees(PoolId.unwrap(key.toId()), params);
            int256 expected = params.amountSpecified + int256(baseFee + extraFee);
            if (int256(delta.amount0()) != expected) revert PartialEthFillUnsupported();
            return (IHooks.afterSwap.selector, 0);
        }
        int256 ethDelta = delta.amount0();
        uint256 amount = uint256(ethDelta < 0 ? -ethDelta : ethDelta);
        // Token-specified buy: ETH delta is the pool payment excluding our fee.
        // Gross it up so the surcharge is 1% of total ETH spent, not 1% on top.
        // Token-specified sell: ETH delta is gross proceeds before our fee.
        uint256 baseFee = params.zeroForOne
            ? Math.mulDiv(amount, FEE_BPS, 10_000 - FEE_BPS, Math.Rounding.Ceil)
            : amount * FEE_BPS / 10_000;
        bytes32 poolId = PoolId.unwrap(key.toId());
        uint256 extraFee = params.zeroForOne ? 0 : Math.mulDiv(amount, extraSellTaxBps(poolId), 10_000);
        uint256 fee = baseFee + extraFee;
        if (fee > uint256(uint128(type(int128).max))) revert InvalidSwapAmount();
        _accrueSwap(poolId, baseFee, extraFee);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function distribute(bytes32 poolId) external nonReentrant {
        _distribute(poolId);
    }

    /// @notice Official router collects after PoolManager.unlock has completed.
    /// Other routers/keepers can invoke this or distribute without authority.
    function distributeForToken(address token) external nonReentrant {
        _distribute(tokenPoolIds[token]);
    }

    function _distribute(bytes32 poolId) internal virtual {
        Project storage p = projects[poolId];
        if (p.locker == address(0)) revert InvalidPool();
        uint256 devPart = p.devAccrued;
        uint256 rewardsPart = p.rewardsAccrued;
        uint256 amount = devPart + rewardsPart;
        if (amount == 0) revert NothingToClaim();
        p.devAccrued = 0;
        p.rewardsAccrued = 0;
        _redeem(amount);
        bool ended = p.governance.terminated();
        if (ended && devPart != 0) {
            p.governance.settlement().deposit{value: devPart}();
            emit SettlementFeesForwarded(poolId, devPart);
        }
        else if (!ended) {
            if (devPart != 0) p.governance.devVault().deposit{value: devPart}();
        }
        if (rewardsPart != 0) p.rewards.depositFees{value: rewardsPart}();
        emit FeesDistributed(poolId, devPart, rewardsPart, ended);
    }

    function claimPlatform(address payable recipient) external nonReentrant {
        if (msg.sender != platform || recipient == address(0) || recipient == address(this)) revert Unauthorized();
        _claimPlatform(recipient);
    }
    /// @notice Permissionless forwarding to the fixed platform address.
    function collectPlatformFees() external nonReentrant { _claimPlatform(payable(platform)); }
    function _claimPlatform(address payable recipient) private {
        uint256 amount = platformAccrued;
        if (amount == 0) revert NothingToClaim();
        platformAccrued = 0;
        _redeem(amount);
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function unlockCallback(bytes calldata) external onlyManager returns (bytes memory) {
        if (!redeeming) revert Unauthorized();
        redeeming = false;
        uint256 amount = redemptionAmount;
        poolManager.burn(address(this), 0, amount);
        poolManager.take(Currency.wrap(address(0)), address(this), amount);
        return "";
    }

    function _redeem(uint256 amount) internal {
        redeeming = true;
        redemptionAmount = amount;
        poolManager.unlock("");
    }

    function _accrue(bytes32 poolId, uint256 amount) internal virtual {
        if (amount == 0) return;
        // Native ETH currency id is zero. No upfront transfer from PoolManager
        // is needed; swap settlement backs these claims in the same transaction.
        poolManager.mint(address(this), 0, amount);
        Project storage p = projects[poolId];
        uint256 devPart;
        uint256 rewardsPart;
        bool ended = p.governance.terminated();
        if (address(feePolicy) != address(0)) {
            (bool ok, bytes memory raw) = address(feePolicy).staticcall{gas:50_000}(
                abi.encodeCall(ISwapFeePolicy.split,(amount,ended)));
            if (ok && raw.length == 64) (devPart,rewardsPart) = abi.decode(raw,(uint256,uint256));
            if (!ok || raw.length != 64 || devPart > amount || rewardsPart > amount-devPart || (ended && devPart != 0)) {
                devPart = ended ? 0 : amount*40/100; rewardsPart=amount*(ended?70:30)/100;
                emit FeePolicyFallback(poolId,address(feePolicy));
            }
        } else { devPart=ended?0:amount*40/100; rewardsPart=amount*(ended?70:30)/100; }
        p.devAccrued += devPart;
        p.rewardsAccrued += rewardsPart;
        uint256 platformPart = amount - devPart - rewardsPart;
        platformAccrued += platformPart;
        emit FeesAccrued(poolId, amount, devPart, rewardsPart, platformPart);
    }

    function _ethSpecified(SwapParams calldata params) private pure returns (bool) {
        return (params.amountSpecified < 0) == params.zeroForOne;
    }

    function extraSellTaxBps(bytes32) public view virtual returns (uint256) { return 0; }

    function _accrueSwap(bytes32 poolId, uint256 baseFee, uint256 extraFee) internal virtual {
        if (extraFee != 0) revert InvalidConfiguration();
        _accrue(poolId, baseFee);
    }

    function _specifiedFees(bytes32 poolId, SwapParams calldata params) private view returns (uint256 baseFee, uint256 extraFee) {
        // Buy exact ETH input: 1% of total input, 99% goes to the pool.
        // Sell exact ETH output: gross up requested net proceeds for 1% deduction.
        if (params.amountSpecified < 0) return (uint256(-params.amountSpecified) * FEE_BPS / 10_000, 0);
        uint256 extraRate = extraSellTaxBps(poolId);
        uint256 rate = FEE_BPS + extraRate;
        uint256 totalFee = Math.mulDiv(uint256(params.amountSpecified), rate, 10_000 - rate, Math.Rounding.Ceil);
        if (extraRate == 0) return (totalFee, 0);
        baseFee = Math.mulDiv(uint256(params.amountSpecified) + totalFee, FEE_BPS, 10_000);
        extraFee = totalFee - baseFee;
    }

    receive() external payable {
        if (msg.sender != address(poolManager)) revert Unauthorized();
    }
}
