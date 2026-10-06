// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Fixed supply and cumulative allocation for the P / 1.25P / 1.5P sale.
library FundraisingCurve {
    uint256 internal constant TOTAL_SUPPLY = 100_000_000 ether;
    uint256 internal constant CREATOR_SUPPLY = TOTAL_SUPPLY / 20;
    uint256 internal constant PUBLIC_SUPPLY = TOTAL_SUPPLY - CREATOR_SUPPLY;
    // ETH budgets: R/2, R/4, R/4 at P, 5P/4, 3P/2.
    // Q = 13R/(15P); LP tokens = 5Q/13; ideal Q = 13(0.95T)/18.
    // Round to 26 base units so tranche quantities 15Q/26, 6Q/26,
    // 5Q/26 are integral. The V4 coordinator solves actual finite-range Q.
    uint256 internal constant SALE_SUPPLY = (PUBLIC_SUPPLY / 36) * 26;
    uint256 internal constant LIQUIDITY_SUPPLY = PUBLIC_SUPPLY - SALE_SUPPLY;
    uint256 internal constant MAX_TARGET = type(uint128).max;

    error InvalidTarget();
    error AmountExceedsTarget();

    function validateTarget(uint256 target) internal pure {
        // Even wei permits the eventual exact 50/50 split. The cap also makes
        // the rational boundary products below safe without truncation.
        if (target < 2 || target > MAX_TARGET || target % 2 != 0) revert InvalidTarget();
    }

    /// @dev The tranche ETH boundaries are exactly 50% and 75% of target.
    /// Allocate floor(F(newRaised)) - floor(F(oldRaised)), rather than rounding
    /// each payment independently. Splitting a purchase cannot create tokens.
    function tokensAt(uint256 raised, uint256 target) internal pure returns (uint256) {
        return tokensAt(raised, target, SALE_SUPPLY);
    }

    /// @notice 50%/25%/25% ETH at P, 23P/20 and 13P/10. Q = 272R/(299P).
    function communityTokensAt(uint256 raised, uint256 target, uint256 saleSupply) internal pure returns (uint256) {
        validateTarget(target);
        if (raised > target) revert AmountExceedsTarget();
        if (raised * 4 <= target * 2) return Math.mulDiv(raised * 299, saleSupply, target * 272);
        if (raised * 4 <= target * 3) return Math.mulDiv(raised * 520 + target * 39, saleSupply, target * 544);
        return Math.mulDiv(raised * 460 + target * 84, saleSupply, target * 544);
    }

    function tokensAt(uint256 raised, uint256 target, uint256 saleSupply) internal pure returns (uint256) {
        validateTarget(target);
        if (raised > target) revert AmountExceedsTarget();
        uint256 scaledRaised = raised * 4;
        if (scaledRaised <= target * 2) {
            return Math.mulDiv(raised * 15, saleSupply, target * 13);
        }
        if (scaledRaised <= target * 3) {
            return Math.mulDiv(raised * 24 + target * 3, saleSupply, target * 26);
        }
        return Math.mulDiv(raised * 10 + target * 3, saleSupply, target * 13);
    }
}
