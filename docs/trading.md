# Trading and permanent liquidity

Successful [fundraising and migration](fundraising.md) initialize the official pool and open trading.

The LP-enabled suite implements the opening-tax mechanism below. Its ordinary Hook fee stays at 100 BPS. An additional sell-only ETH tax starts at 2,500 BPS and decreases to zero over 600 seconds from the successful migration block. The Hook records this start during registration in the same atomic migration transaction. The timestamp is stored in the fixed Hook, rather than an upgradeable governance getter, and cannot be reset. Fee policy upgrades only affect ordinary revenue allocation.

## Rates and swap settlement

For elapsed time t in seconds, the extra rate is floor(2,500 × (600 − t) / 600) when t < 600, and zero otherwise. It changes in basis-point steps; there is no sudden 25% removal at ten minutes. All projects have independent windows. Buys pay no extra tax, including internal replenishment buys. The pool's separate 3,000 pips LP fee remains unchanged.

| Time since launch | Extra sell tax | Combined sell Hook deduction |
| --- | --- | --- |
| Launch | 25% | 26% |
| 2 minutes | 20% | 21% |
| 5 minutes | 12.5% | 13.5% |
| 8 minutes | 5% | 6% |
| 10 minutes and later | 0% | 1% |

The table excludes the separate 0.3% LP swap fee and network gas. Buys pay the ordinary 1% Hook fee throughout the window.

The base Hook implements virtual extra-rate and accrual methods. The base V4FeeHook returns a zero extra rate; V4FeeHookLP enables the window. All four swap modes are supported:

| Specified currency and direction | Settlement |
| --- | --- |
| Buy with exact ETH input | Existing 1% deduction from specified ETH input |
| Buy with exact token output | Existing 1% ETH gross-up from actual pool input |
| Sell with exact token input | Base floor(gross ETH / 100) plus floor(gross ETH × extra BPS / 10,000) |
| Sell for exact net ETH output | Gross up by combined base and extra rate; allocate base floor(gross ETH / 100), with rounding remainder assigned to extra tax |

When ETH is the specified currency, partial fills still revert atomically. Token-specified partial fills pay fees only on the actual ETH delta. User router maximum input, minimum net output and deadline still apply. No address is exempt from the official-pool tax. Other pools and wallet transfers remain outside the Hook's scope.

## Separate custody

Normal FeesAccrued events and policy allocation refer only to the base fee. Extra tax is recorded in protectionAccrued and totalProtectionAccrued with LaunchProtectionTaxAccrued events, as backed ETH ERC6909 claims in PoolManager. Neither founder nor platform can claim it. Distribution redeems it separately and funds only that pool's fixed PermanentLiquidityLocker. Normal LP revenue continues through LPRewardDistributor and is not relabeled as principal replenishment.

In the locker, queuedProtectionETH, queuedProtectionTokens and cumulative funded, spent, acquired-token and added-liquidity counters account for the replenishment flow. Funding is accepted only from the pool's fixed Hook. Forced ETH cannot increase the protection budget. Queued assets have no sweep or principal-withdrawal entry point and cannot be paid to the keeper.

## Add real liquidity

Each replenishment batch uses at most 2% of the official full-range position's current virtual ETH reserve, calculated as liquidity × 2^96 / sqrtPrice. Half of that ETH batch is used for an exact-input token buy, so swap input is at most approximately 1% of that reserve. The buy pays the ordinary 1% Hook fee and existing pool fee. Partial ETH execution is rejected.

The buy's minimum sqrtPrice is no lower than 98% of the pre-batch sqrtPrice, also bounded by the official lower tick. This is a sqrt-price limit, corresponding to at most approximately 4.12% upward ETH-per-token movement; the swap-size bound is normally tighter. A caller can supply a stricter minimum and an expiry timestamp. These bounds limit batch execution impact; they are not an external oracle or a guarantee against all MEV.

After the buy, the locker computes the full-range liquidity affordable with the remaining batch ETH and its queued tokens at the new price. It adds strictly positive liquidity to the official owner's existing ticks and salt. It never removes liquidity or mints new tokens. Unpaired ETH or tokens, including rounding leftovers, remain queued for later batches; queued assets remain permanently restricted even after the tax window ends. Initial migration quote fields remain a historical record of the initial allocation; positionLiquidity and totalProtectionLiquidity expose the increased locked position.

Adding to the position also realizes any ordinary LP fees it has earned. Those fees are accounted separately from replenishment principal: ETH follows the existing developer-vault or termination-settlement route, and token fees are burned. The locker does not treat those fees as newly funded opening tax. Queued tax principal is conserved as totalProtectionFunded = totalProtectionETHUsed + queuedProtectionETH.

## Automatic processing and retries

ProjectSwapRouter attempts distribution after the swap and outside its PoolManager unlock. The Hook forwards all redeemed extra tax to the locker, then attempts one batch with bounded gas while reserving enough gas to complete distribution. Large amounts may remain queued. Failed or skipped compounding emits ProtectionLiquidityDeferred and preserves the queued assets. Failed fee collection retains the backed Hook accrual and emits the router's FeeCollectionDeferred event.

Anyone can call Hook.distribute(poolId) to distribute all accrued fees, Hook.forwardProtection(poolId) to forward only opening taxes independently of ordinary reward processing, or locker.compoundProtection(minimumSqrtPrice, deadline) to process queued assets. No caller receives principal. Keepers pay their own replenishment transaction gas; migration gas reimbursement applies only to migration, not later replenishment. scripts/launch-protection.mjs exports settleLaunchProtection for explicit, bounded retries using an already-connected wallet. It loads no credentials and starts no background scheduler.

At less than 10,000 wei of queued ETH, processing waits for more funding. Near a range boundary, a tight caller limit, inadequate gas or a failed optional service can defer processing without confiscating funds or preventing a user's completed trade. A production application should surface queued work and run its keeper if automatic batches do not drain it.

## Revenue and principal

The ordinary Hook fee follows [the reward allocation](rewards.md#ordinary-fee-allocation). The extra opening tax follows the dedicated ledger and liquidity-addition path above. Creator treasury releases and termination follow [governance and custody](governance.md). This mechanism reduces the incentive to sell immediately and recycles taxes into pool depth; it does not promise a minimum price or eliminate price impact.
