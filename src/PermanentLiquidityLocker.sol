// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ProjectGovernance} from "./ProjectGovernance.sol";
import {ProjectToken} from "./ProjectToken.sol";
import {IFundraisingPolicy} from "./interfaces/IFundraisingPolicy.sol";
import {MigrationMath} from "./libraries/MigrationMath.sol";

/// @notice Owns a native V4 core position directly, without a transferable NFT.
/// Gas is deducted before the initial positive liquidity deposit. After
/// finalization only fee collection and positive protection-funded additions
/// are possible; there is no principal removal.
contract PermanentLiquidityLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    IPoolManager public immutable poolManager;
    address public immutable coordinator;
    uint256 public immutable migrationFeeBps;
    uint256 public immutable fundraisingTarget;
    bool public immutable communityFundraising;
    uint256 public immutable initialEthBudget;
    IERC20 public immutable token;
    ProjectGovernance public immutable governance;
    PoolKey public poolKey;
    MigrationMath.Quote public initialQuote;
    bool public initialized;
    bool public migrationFinalized;
    uint256 public migrationGasRefund;
    uint256 public migrationTokensBurned;
    uint256 public totalTokenFeesBurned;
    uint256 public settlementEthFees;
    uint256 public queuedProtectionETH;
    uint256 public queuedProtectionTokens;
    uint256 public totalProtectionFunded;
    uint256 public totalProtectionETHUsed;
    uint256 public totalProtectionTokensBought;
    uint256 public totalProtectionLiquidity;
    uint160 private protectionPriceLimit;
    uint256 private protectionBudget;
    uint8 private operation;
    error Unauthorized();
    error InvalidMigration();
    error InsufficientLiquidityBudget(uint256 available, uint256 gasUnits, uint256 gasPrice);
    event LiquidityLocked(bytes32 indexed poolId, uint128 liquidity, uint256 ethAmount, uint256 tokenAmount, uint256 lockedRemainder);
    event LpFeesCollected(uint256 ethAmount, uint256 tokenAmount, bool projectTerminated);
    event MigrationFinalized(uint256 gasRefund, uint256 tokensBurned, uint128 liquidity);
    event ProtectionFunded(uint256 amount);
    event ProtectionLiquidityAdded(uint256 ethUsed, uint256 tokensBought, uint128 liquidityAdded);

    constructor(IPoolManager manager, IERC20 token_, IHooks hook, ProjectGovernance governance_, uint256 target, uint256 feeBps, address coordinator_) {
        coordinator = coordinator_;
        poolManager = manager;
        token = token_;
        governance = governance_;
        poolKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token_)), 3000, 60, hook);
        migrationFeeBps = feeBps;
        fundraisingTarget = target;
        bool community;
        try IFundraisingPolicy(coordinator_).fundraisingPolicyVersion() returns (uint256 version) { community = version == 2; } catch {}
        communityFundraising = community;
        initialQuote = MigrationMath.quote(target, feeBps, community);
        initialEthBudget = initialQuote.ethAmount;
    }

    /// @notice Only the bound escrow can adjust migration cost before trading opens.
    /// Deduct gas first, calculate the final token amount, then add positive LP.
    /// Unused tokens are burned and ETH goes only to the escrow for reimbursement.
    function finalizeMigration(uint256 requestedRefund) external nonReentrant returns (uint256 refund) {
        ProjectToken projectToken = ProjectToken(address(token));
        if (msg.sender != projectToken.escrow() || !initialized || migrationFinalized || projectToken.launched()) revert Unauthorized();
        MigrationMath.Quote memory beforeGas = initialQuote;
        if (requestedRefund >= beforeGas.ethAmount) revert InsufficientLiquidityBudget(beforeGas.ethAmount, requestedRefund, 1);
        MigrationMath.Quote memory q = MigrationMath.quoteForLiquidity(
            fundraisingTarget, beforeGas.saleSupply, beforeGas.ethAmount - requestedRefund, communityFundraising
        );
        if (q.sqrtPriceX96 != beforeGas.sqrtPriceX96 || q.tokenAmount > beforeGas.tokenAmount) revert InvalidMigration();
        migrationFinalized = true;
        initialQuote = q;
        operation = 1;
        poolManager.unlock("");
        (uint160 price,,,) = poolManager.getSlot0(poolKey.toId());
        if (price != q.sqrtPriceX96) revert InvalidMigration();
        (uint128 liquidity,,) = poolManager.getPositionInfo(
            poolKey.toId(), address(this), MigrationMath.TICK_LOWER, MigrationMath.TICK_UPPER, bytes32(0)
        );
        if (liquidity != q.liquidity) revert InvalidMigration();
        uint256 burned = beforeGas.tokenAmount - q.tokenAmount;
        refund = requestedRefund;
        migrationGasRefund = refund;
        migrationTokensBurned = burned;
        if (burned != 0) projectToken.burn(burned);
        if (token.balanceOf(address(this)) != 0) revert InvalidMigration();
        emit MigrationFinalized(refund, burned, q.liquidity);
        emit LiquidityLocked(PoolId.unwrap(poolKey.toId()), q.liquidity, q.ethAmount, q.tokenAmount, 0);
        if (refund != 0) {
            (bool sent,) = payable(msg.sender).call{value: refund}("");
            if (!sent) revert InvalidMigration();
        }
    }

    function initialize() external payable nonReentrant {
        if (msg.sender != coordinator || initialized) revert Unauthorized();
        MigrationMath.Quote memory q = initialQuote;
        if (msg.value != q.ethAmount || token.balanceOf(address(this)) != q.tokenAmount) {
            revert InvalidMigration();
        }
        initialized = true;
        poolManager.initialize(poolKey, q.sqrtPriceX96);
        (uint160 actualPrice,,,) = poolManager.getSlot0(poolKey.toId());
        if (actualPrice != q.sqrtPriceX96) revert InvalidMigration();
    }

    function collectFees() external nonReentrant {
        if (!migrationFinalized) revert InvalidMigration();
        operation = 2;
        (uint256 ethFees, uint256 tokenFees) = abi.decode(poolManager.unlock(""), (uint256, uint256));
        _forwardFees(ethFees, tokenFees);
    }

    /// @notice Only launch sell taxes from this pool's fixed hook may fund this ledger.
    function fundProtection() external payable {
        if (msg.sender != address(poolKey.hooks) || !migrationFinalized || msg.value == 0) revert Unauthorized();
        queuedProtectionETH += msg.value;
        totalProtectionFunded += msg.value;
        emit ProtectionFunded(msg.value);
    }

    /// @notice Buy tokens, then add a positive full-range position to the same
    /// permanently locked owner/salt. No keeper receives ETH, tokens or LP.
    /// A zero limit uses a bounded current-price limit; callers may tighten it.
    function compoundProtection(uint160 minimumSqrtPrice, uint256 deadline) external nonReentrant {
        if (!migrationFinalized || block.timestamp > deadline || queuedProtectionETH < 10_000) revert InvalidMigration();
        (uint160 price,,,) = poolManager.getSlot0(poolKey.toId());
        uint160 a = TickMath.getSqrtPriceAtTick(MigrationMath.TICK_LOWER);
        uint160 b = TickMath.getSqrtPriceAtTick(MigrationMath.TICK_UPPER);
        if (price <= a || price >= b) revert InvalidMigration();
        (uint128 liquidity,,) = poolManager.getPositionInfo(
            poolKey.toId(), address(this), MigrationMath.TICK_LOWER, MigrationMath.TICK_UPPER, bytes32(0)
        );
        // Budget is at most 2% of the official position's virtual ETH reserve.
        // Half is bought, limiting a batch's swap input to approximately 1%.
        protectionBudget = Math.min(queuedProtectionETH, Math.mulDiv(liquidity, 1 << 96, price) / 50);
        if (protectionBudget < 10_000) revert InvalidMigration();
        uint160 floorPrice = uint160(Math.max(uint256(price) * 9800 / 10_000, uint256(a) + 1));
        protectionPriceLimit = minimumSqrtPrice == 0 ? floorPrice : minimumSqrtPrice;
        if (protectionPriceLimit < floorPrice || protectionPriceLimit >= price) revert InvalidMigration();
        operation = 3;
        (uint256 ethFees, uint256 tokenFees, uint256 spent, uint256 bought, uint128 added) =
            abi.decode(poolManager.unlock(""), (uint256, uint256, uint256, uint256, uint128));
        totalProtectionETHUsed += spent;
        totalProtectionTokensBought += bought;
        totalProtectionLiquidity += added;
        _forwardFees(ethFees, tokenFees);
        emit ProtectionLiquidityAdded(spent, bought, added);
    }

    function _forwardFees(uint256 ethFees, uint256 tokenFees) private {
        if (tokenFees != 0) {
            totalTokenFeesBurned += tokenFees;
            ProjectToken(address(token)).burn(tokenFees);
        }
        bool ended = governance.terminated();
        if (ended && ethFees != 0) {
            settlementEthFees += ethFees;
            governance.settlement().deposit{value: ethFees}();
        }
        else if (ethFees != 0) governance.devVault().deposit{value: ethFees}();
        emit LpFeesCollected(ethFees, tokenFees, ended);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || operation == 0) revert Unauthorized();
        uint8 action = operation;
        operation = 0;
        if (action == 3) return _compoundProtection();
        MigrationMath.Quote memory q = initialQuote;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(poolKey, ModifyLiquidityParams({
            tickLower: MigrationMath.TICK_LOWER, tickUpper: MigrationMath.TICK_UPPER,
            liquidityDelta: action == 1 ? int256(uint256(q.liquidity)) : int256(0), salt: bytes32(0)
        }), "");
        if (action == 1) {
            if (int256(delta.amount0()) != -int256(q.ethAmount) || int256(delta.amount1()) != -int256(q.tokenAmount)) {
                revert InvalidMigration();
            }
            poolManager.settle{value: q.ethAmount}();
            poolManager.sync(poolKey.currency1);
            token.safeTransfer(address(poolManager), q.tokenAmount);
            poolManager.settle();
            return "";
        }
        if (delta.amount0() < 0 || delta.amount1() < 0) revert InvalidMigration();
        uint256 ethFees = uint256(uint128(delta.amount0()));
        uint256 tokenFees = uint256(uint128(delta.amount1()));
        if (ethFees != 0) poolManager.take(poolKey.currency0, address(this), ethFees);
        if (tokenFees != 0) poolManager.take(poolKey.currency1, address(this), tokenFees);
        return abi.encode(ethFees, tokenFees);
    }

    function _compoundProtection() private returns (bytes memory) {
        uint256 input = protectionBudget / 2;
        BalanceDelta swapDelta = poolManager.swap(poolKey, SwapParams({
            zeroForOne: true, amountSpecified: -int256(input), sqrtPriceLimitX96: protectionPriceLimit
        }), "");
        if (int256(swapDelta.amount0()) != -int256(input) || swapDelta.amount1() <= 0) revert InvalidMigration();
        uint256 bought = uint256(uint128(swapDelta.amount1()));
        poolManager.settle{value: input}();
        poolManager.take(poolKey.currency1, address(this), bought);
        queuedProtectionETH -= input;
        queuedProtectionTokens += bought;
        (uint160 price,,,) = poolManager.getSlot0(poolKey.toId());
        uint160 a = TickMath.getSqrtPriceAtTick(MigrationMath.TICK_LOWER);
        uint160 b = TickMath.getSqrtPriceAtTick(MigrationMath.TICK_UPPER);
        uint256 ethBudget = protectionBudget - input;
        uint256 ethLiquidity = Math.mulDiv(ethBudget, Math.mulDiv(price, b, 1 << 96), uint256(b) - price);
        uint256 tokenLiquidity = Math.mulDiv(queuedProtectionTokens, 1 << 96, uint256(price) - a);
        (uint128 currentLiquidity,,) = poolManager.getPositionInfo(
            poolKey.toId(), address(this), MigrationMath.TICK_LOWER, MigrationMath.TICK_UPPER, bytes32(0)
        );
        uint256 added = Math.min(Math.min(ethLiquidity, tokenLiquidity), uint256(uint128(type(int128).max)) - currentLiquidity);
        if (added == 0) revert InvalidMigration();
        (BalanceDelta delta, BalanceDelta fees) = poolManager.modifyLiquidity(poolKey, ModifyLiquidityParams({
            tickLower: MigrationMath.TICK_LOWER, tickUpper: MigrationMath.TICK_UPPER,
            liquidityDelta: int256(added), salt: bytes32(0)
        }), "");
        int256 principalETH = int256(delta.amount0()) - int256(fees.amount0());
        int256 principalTokens = int256(delta.amount1()) - int256(fees.amount1());
        if (principalETH >= 0 || principalTokens >= 0 || fees.amount0() < 0 || fees.amount1() < 0) revert InvalidMigration();
        uint256 ethAdded = uint256(-principalETH);
        uint256 tokensAdded = uint256(-principalTokens);
        if (ethAdded > ethBudget || tokensAdded > queuedProtectionTokens) revert InvalidMigration();
        queuedProtectionETH -= ethAdded;
        queuedProtectionTokens -= tokensAdded;
        _settleProtectionDelta(delta);
        return abi.encode(uint256(uint128(fees.amount0())), uint256(uint128(fees.amount1())), input + ethAdded, bought, uint128(added));
    }

    function _settleProtectionDelta(BalanceDelta delta) private {
        if (delta.amount0() < 0) poolManager.settle{value: uint256(-int256(delta.amount0()))}();
        else if (delta.amount0() > 0) poolManager.take(poolKey.currency0, address(this), uint256(uint128(delta.amount0())));
        if (delta.amount1() < 0) {
            poolManager.sync(poolKey.currency1);
            token.safeTransfer(address(poolManager), uint256(-int256(delta.amount1())));
            poolManager.settle();
        } else if (delta.amount1() > 0) poolManager.take(poolKey.currency1, address(this), uint256(uint128(delta.amount1())));
    }

    function positionLiquidity() external view returns (uint128 liquidity) {
        (liquidity,,) = poolManager.getPositionInfo(
            poolKey.toId(), address(this), MigrationMath.TICK_LOWER, MigrationMath.TICK_UPPER, bytes32(0)
        );
    }

    receive() external payable {
        if (msg.sender != address(poolManager)) revert Unauthorized();
    }
}
