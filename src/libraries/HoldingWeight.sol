// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Proportional-age accounting for w(t) = 7 - 6 * 20^(-t/23 days).
/// Decay is stored in token base units times 1e18. Round up the remaining
/// decay, conservatively rounding shares down; never round a multiplier to 7.
library HoldingWeight {
    uint256 internal constant SCALE = 1e18;
    uint256 private constant PRECISION = 1e27;
    uint256 private constant LN20 = 2995732273553990993435223576;
    uint256 private constant PERIOD = 23 days;

    function decay(uint256 value, uint256 elapsed) internal pure returns (uint256) {
        if (value == 0 || elapsed == 0) return value;
        uint256 periods = elapsed / PERIOD;
        // Supply is at most 100m * 1e18 and decay at most supply * 1e18.
        // After 40 periods even the largest possible value is below one unit.
        if (periods >= 40) return 1;
        uint256 x = LN20 * (elapsed % PERIOD) / PERIOD;
        uint256 term = PRECISION;
        uint256 exponential = term;
        // Bounded Taylor expansion, x < ln(20). Never loops over holders/lots.
        for (uint256 n = 1; n <= 40; ++n) {
            term = Math.mulDiv(term, x, PRECISION * n);
            exponential += term;
            if (term == 0) break;
        }
        uint256 result = Math.mulDiv(value, PRECISION, exponential, Math.Rounding.Ceil);
        return Math.ceilDiv(result, 20 ** periods);
    }

    function shares(uint256 balance, uint256 decayValue, uint256 elapsed) internal pure returns (uint256) {
        if (balance <= 1 ether) return 0;
        uint256 remaining = decay(decayValue, elapsed);
        return 7 * balance - Math.ceilDiv(6 * remaining, SCALE);
    }
}
