// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FundraisingCurve} from "./FundraisingCurve.sol";

library MigrationMath {
    int24 internal constant TICK_LOWER = -887220;
    int24 internal constant TICK_UPPER = 887220;
    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant LP_FEE = 3000;
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant Q192 = 1 << 192;
    // Explicit target range keeps amounts, price and liquidity representable.
    uint256 internal constant MIN_TARGET = 1 ether;
    uint256 internal constant MAX_TARGET = 1_000_000 ether;
    uint256 internal constant DEFAULT_MIGRATION_FEE_BPS = 100;
    uint256 internal constant MAX_MIGRATION_FEE_BPS = 100;
    struct Quote {
        uint256 saleSupply;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        uint256 ethAmount;
        uint256 tokenAmount;
        uint256 lockedTokenRemainder;
    }
    error UnsupportedTarget();
    error InvalidAllocation();
    error InvalidMigrationFee();

    function quote(uint256 target) internal pure returns (Quote memory q) {
        return quote(target, DEFAULT_MIGRATION_FEE_BPS);
    }

    function quote(uint256 target, uint256 feeBps) internal pure returns (Quote memory q) {
        return quote(target, feeBps, false);
    }

    function quote(uint256 target, uint256 feeBps, bool community) internal pure returns (Quote memory q) {
        FundraisingCurve.validateTarget(target);
        if (target < MIN_TARGET || target > MAX_TARGET) revert UnsupportedTarget();
        if (feeBps > MAX_MIGRATION_FEE_BPS) revert InvalidMigrationFee();
        uint160 a = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 b = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint256 lpEth = target / 2 - Math.mulDiv(target, feeBps, 10_000);
        // Full-range is finite. Solve Q + actual V4 token requirement(Q) <= 95% of T,
        // with Q divisible by 26 so 15:6:5 tranche token budgets are integral.
        // Fees come from R/2. Using the actual rounded ETH budget, ideal
        // Q = 13RA / (13R + 10*lpEth), where A = 95% of initial supply.
        uint256 step = community ? 544 : 26;
        uint256 priceNumerator = community ? 1972 : 13;
        uint256 priceDenominator = community ? 1495 : 10;
        uint256 high = Math.mulDiv(FundraisingCurve.PUBLIC_SUPPLY, target * priceNumerator, target * priceNumerator + lpEth * priceDenominator) / step;
        q = _forSale(target, high * step, lpEth, a, b, community);
        uint256 used = q.saleSupply + q.tokenAmount;
        uint256 excess = used > FundraisingCurve.PUBLIC_SUPPLY ? used - FundraisingCurve.PUBLIC_SUPPLY : 0;
        uint256 low = (q.saleSupply - excess - step) / step;
        if (_forSale(target, low * step, lpEth, a, b, community).tokenAmount + low * step > FundraisingCurve.PUBLIC_SUPPLY) {
            revert InvalidAllocation();
        }
        while (low < high) {
            uint256 mid = low + (high - low + 1) / 2;
            Quote memory candidate = _forSale(target, mid * step, lpEth, a, b, community);
            if (candidate.saleSupply + candidate.tokenAmount <= FundraisingCurve.PUBLIC_SUPPLY) low = mid;
            else high = mid - 1;
        }
        q = _forSale(target, low * step, lpEth, a, b, community);
        q.lockedTokenRemainder = FundraisingCurve.PUBLIC_SUPPLY - q.saleSupply - q.tokenAmount;
        // One liquidity unit can require ceil(sqrtPrice/Q96) token base units;
        // The 26-unit sale step consumes < 36 total units at the ideal ratio;
        // allow 52 units including finite-range and integer quantization.
        if (q.lockedTokenRemainder > Math.ceilDiv(q.sqrtPriceX96, Q96) + step * 2) revert InvalidAllocation();
    }

    /// @notice Uses the snapshotted sale/price and the final ETH budget after gas.
    function quoteForLiquidity(uint256 target, uint256 sale, uint256 lpEth) internal pure returns (Quote memory q) {
        return quoteForLiquidity(target, sale, lpEth, false);
    }

    function quoteForLiquidity(uint256 target, uint256 sale, uint256 lpEth, bool community) internal pure returns (Quote memory q) {
        if (lpEth == 0) revert InvalidAllocation();
        q = _forSale(target, sale, lpEth, TickMath.getSqrtPriceAtTick(TICK_LOWER), TickMath.getSqrtPriceAtTick(TICK_UPPER), community);
        if (sale + q.tokenAmount > FundraisingCurve.PUBLIC_SUPPLY) revert InvalidAllocation();
        q.lockedTokenRemainder = FundraisingCurve.PUBLIC_SUPPLY - sale - q.tokenAmount;
    }

    function _forSale(uint256 target, uint256 sale, uint256 lpEth, uint160 a, uint160 b, bool community) private pure returns (Quote memory q) {
        q.saleSupply = sale;
        // currency0 = ETH, currency1 = token. Last-tier price = 13R/(10Q).
        q.sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(sale * (community ? 1495 : 10), Q192, target * (community ? 1972 : 13))));
        q.ethAmount = lpEth;
        uint256 liquidity = Math.mulDiv(
            q.ethAmount * uint256(q.sqrtPriceX96), b,
            (uint256(b) - q.sqrtPriceX96) * Q96
        );
        if (liquidity == 0 || liquidity > uint256(uint128(type(int128).max))) revert InvalidAllocation();
        q.liquidity = uint128(liquidity);
        // Require exactly the post-fee LP ETH budget, not just a max budget.
        if (SqrtPriceMath.getAmount0Delta(q.sqrtPriceX96, b, q.liquidity, true) != q.ethAmount) {
            revert InvalidAllocation();
        }
        q.tokenAmount = SqrtPriceMath.getAmount1Delta(a, q.sqrtPriceX96, q.liquidity, true);
        if (q.tokenAmount == 0) revert InvalidAllocation();
    }
}
