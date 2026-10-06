// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {V4FeeHook} from "./V4FeeHook.sol";
import {LPRewardDistributor} from "./LPRewardDistributor.sol";
import {PermanentLiquidityLocker} from "./PermanentLiquidityLocker.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ProjectGovernance} from "./ProjectGovernance.sol";

interface ISwapFeePolicyLP {
    function splitWithLP(uint256 amount, bool ended) external view returns (uint256 founder, uint256 rewards, uint256 lp);
}
contract V4FeeHookLP is V4FeeHook {
    using PoolIdLibrary for PoolKey;
    LPRewardDistributor public immutable lpDistributor;
    mapping(bytes32 => uint256) public lpAccrued;
    mapping(bytes32 => uint256) public protectionAccrued;
    mapping(bytes32 => uint256) public totalProtectionAccrued;
    mapping(bytes32 => uint256) public protectionStartedAt;
    uint256 public constant MAX_EXTRA_SELL_TAX_BPS = 2500;
    uint256 public constant LAUNCH_PROTECTION_DURATION = 10 minutes;
    event LPFeesAccrued(bytes32 indexed poolId, uint256 amount);
    event LPDonationDeferred(bytes32 indexed poolId);
    event LaunchProtectionTaxAccrued(bytes32 indexed poolId, uint256 ethAmount, uint256 rateBps);
    event ProtectionLiquidityDeferred(bytes32 indexed poolId);
    event ProtectionTaxForwarded(bytes32 indexed poolId, uint256 ethAmount);
    constructor(IPoolManager manager, address coordinator_, address platform_, LPRewardDistributor distributor)
        V4FeeHook(manager, coordinator_, platform_) {
        if (address(distributor).code.length == 0 || distributor.coordinator() != coordinator_ ||
            address(distributor.poolManager()) != address(manager)) revert InvalidConfiguration();
        lpDistributor = distributor;
    }
    /// @notice Start is the migration block, which also opens trading atomically.
    /// No administrator can change the rate or restart the countdown.
    function register(PoolKey calldata key, address locker, ProjectGovernance governance, uint160 price) public override {
        super.register(key, locker, governance, price);
        protectionStartedAt[PoolId.unwrap(key.toId())] = block.timestamp;
    }
    function extraSellTaxBps(bytes32 poolId_) public view override returns (uint256) {
        Project storage p = projects[poolId_];
        if (p.locker == address(0)) revert InvalidPool();
        uint256 start = protectionStartedAt[poolId_];
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= LAUNCH_PROTECTION_DURATION) return 0;
        return MAX_EXTRA_SELL_TAX_BPS * (LAUNCH_PROTECTION_DURATION - elapsed) / LAUNCH_PROTECTION_DURATION;
    }
    function _accrueSwap(bytes32 poolId_, uint256 baseFee, uint256 extraFee) internal override {
        _accrue(poolId_, baseFee);
        if (extraFee == 0) return;
        poolManager.mint(address(this), 0, extraFee);
        protectionAccrued[poolId_] += extraFee;
        totalProtectionAccrued[poolId_] += extraFee;
        emit LaunchProtectionTaxAccrued(poolId_, extraFee, extraSellTaxBps(poolId_));
    }
    /// @notice Forward only opening taxes, independently of ordinary reward
    /// processing. Permissionless, with a fixed pool-specific destination.
    function forwardProtection(bytes32 poolId_) external nonReentrant {
        Project storage p = projects[poolId_];
        if (p.locker == address(0)) revert InvalidPool();
        uint256 amount = protectionAccrued[poolId_];
        if (amount == 0) revert NothingToClaim();
        protectionAccrued[poolId_] = 0;
        _redeem(amount);
        PermanentLiquidityLocker(payable(p.locker)).fundProtection{value: amount}();
        emit ProtectionTaxForwarded(poolId_, amount);
    }
    function _accrue(bytes32 poolId_, uint256 amount) internal override {
        if (amount == 0) return;
        Project storage p = projects[poolId_];
        bool ended = p.governance.terminated();
        uint256 devPart; uint256 rewardsPart; uint256 lpPart;
        if (address(feePolicy) != address(0)) {
            (bool ok, bytes memory raw) = address(feePolicy).staticcall{gas:50_000}(
                abi.encodeCall(ISwapFeePolicyLP.splitWithLP,(amount,ended)));
            if (ok && raw.length == 96) (devPart,rewardsPart,lpPart)=abi.decode(raw,(uint256,uint256,uint256));
            if (!ok || raw.length != 96 || devPart > amount || rewardsPart > amount-devPart ||
                lpPart > amount-devPart-rewardsPart || (ended && devPart != 0)) {
                devPart=ended?0:amount*20/100; rewardsPart=amount*(ended?60:40)/100; lpPart=amount*10/100;
                emit FeePolicyFallback(poolId_,address(feePolicy));
            }
        } else {
            devPart = ended ? 0 : amount * 20 / 100;
            rewardsPart = amount * (ended ? 60 : 40) / 100;
            lpPart = amount * 10 / 100;
        }
        if (devPart > amount || rewardsPart > amount - devPart ||
            lpPart > amount - devPart - rewardsPart || (ended && devPart != 0)) revert InvalidConfiguration();
        poolManager.mint(address(this), 0, amount);
        p.devAccrued += devPart; p.rewardsAccrued += rewardsPart; lpAccrued[poolId_] += lpPart;
        uint256 platformPart = amount - devPart - rewardsPart - lpPart;
        platformAccrued += platformPart;
        emit FeesAccrued(poolId_, amount, devPart, rewardsPart, platformPart);
        emit LPFeesAccrued(poolId_, lpPart);
    }
    function _distribute(bytes32 poolId_) internal override {
        Project storage p = projects[poolId_];
        if (p.locker == address(0)) revert InvalidPool();
        uint256 devPart = p.devAccrued; uint256 rewardsPart = p.rewardsAccrued;
        uint256 lpPart = lpAccrued[poolId_];
        uint256 protection = protectionAccrued[poolId_];
        uint256 amount = devPart + rewardsPart + lpPart + protection;
        if (amount == 0) revert NothingToClaim();
        p.devAccrued = 0; p.rewardsAccrued = 0; lpAccrued[poolId_] = 0;
        protectionAccrued[poolId_] = 0;
        _redeem(amount);
        bool ended = p.governance.terminated();
        if (devPart != 0) {
            if (ended) { p.governance.settlement().deposit{value:devPart}(); emit SettlementFeesForwarded(poolId_, devPart); }
            else p.governance.devVault().deposit{value:devPart}();
        }
        if (rewardsPart != 0) p.rewards.depositFees{value:rewardsPart}();
        if (lpPart != 0) {
            address token = address(p.rewards.token());
            lpDistributor.fund{value:lpPart}(token);
            try lpDistributor.process{gas:200_000}(token) {} catch { emit LPDonationDeferred(poolId_); }
        }
        if (protection != 0) {
            PermanentLiquidityLocker locker = PermanentLiquidityLocker(payable(p.locker));
            locker.fundProtection{value: protection}();
            emit ProtectionTaxForwarded(poolId_, protection);
            // Preserve enough gas to finish distribution even if compounding
            // consumes its whole allowance or token reward callbacks are busy.
            uint256 remaining = gasleft();
            if (remaining > 380_000) {
                uint256 budget = remaining - 80_000;
                if (budget > 700_000) budget = 700_000;
                try locker.compoundProtection{gas: budget}(0, block.timestamp) {}
                catch { emit ProtectionLiquidityDeferred(poolId_); }
            } else emit ProtectionLiquidityDeferred(poolId_);
        }
        emit FeesDistributed(poolId_, devPart, rewardsPart, ended);
    }
}
