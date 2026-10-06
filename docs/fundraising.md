# Fundraising and migration

This page documents the approved fundraising policy, from the creator's refundable deposit to subscriptions, migration and refunds. Funds are held and released by the protocol's contracts under the same rules for every project. Each project's subscription principal and treasury are isolated; the platform and creator do not receive discretionary access to those balances.

**Pricing and address-limit policy:** the approved terms are P / 1.15P / 1.3P subscriptions, an independent 1.45P opening price, and a cumulative 5% target limit per address per project. The community factory, its coordinator and immutable project escrows enforce these rules. Each project follows the policy and fixed code selected at its creation.

## Create a fundraising project

The creator submits the project information, token name and symbol, ETH target and fundraising duration, and pays exactly **0.02 ETH as a refundable creation deposit**. The deposit is held in the factory's separate deposit ledger. It is not project fundraising principal, a platform charge or migration gas funding.

The minimum target is **1 ETH**. The supported maximum is 1,000,000 ETH, and the target must be an even number of wei so the eventual half split is exact. The funding duration is one to fifteen days; the default is three days. Contract time determines the deadline.

The project snapshots the current platform migration fee when it is created. The initial deployment default is **1%**. A later change to the protocol default does not change the fee or subscription allocation of a project already fundraising.

The total initial token supply is 100,000,000 tokens. The creator reserve is fixed at 5,000,000 tokens, or 5% of initial supply. The protocol calculates the subscription allocation and pre-gas liquidity allocation together at an independently specified opening pool price of 1.45P. The reserve is separate from tokens sold to participants.

## Subscribe at three price tiers

Participants send ETH to the project's escrow and receive their purchased tokens in the same transaction. They can inspect their accepted ETH, allocation and actual wallet balance onchain. Transfers, transferFrom, sales and voluntary burns stay locked until successful migration. No separate subscription-token claim is required. The lock preserves the complete purchased balance in the original contributor wallet so a failed-funding or migration-timeout refund can burn the tokens and return ETH atomically, without recovering tokens from subsequent recipients.

The tiers are based on the percentage of the **ETH target already raised**, not a percentage of tokens sold or participant count:

| Part of the ETH target | Subscription price | Reference gap to the 1.45P opening price |
| --- | --- | --- |
| First 50% | P | +45% |
| Next 25% | 1.15P | +26.09% |
| Final 25% | 1.3P | +11.54% |

The reference gap is `(1.45P / subscription price - 1) * 100%`. It is not a guaranteed selling profit. After opening, market transactions determine price; sell taxes, swap fees, price impact and network gas affect actual proceeds.

P is the project's first-tier price, determined from the target and solved token allocation. A subscription crossing a boundary is divided between the applicable tiers. The contract computes cumulative allocations so splitting one purchase into several transactions cannot create additional tokens. A participant can specify a minimum token allocation to protect their purchase against another subscription moving it into a later tier.

**Per-address cap:** cumulative accepted subscriptions from one address in one project must not exceed **5% of that project's total ETH target**. Multiple transactions count together; changing price tiers does not reset the cap. A 1 ETH target permits at most 0.05 ETH per address. This contribution cap is independent of the founder's 5% token reserve and is an address limit, not an identity limit.

The escrow accepts the smaller of the remaining project target and the address’s remaining cumulative allowance (floor(target / 20) wei). Any ETH offered above that amount is returned in the same transaction. At a filled address cap, no additional allocation is possible. Rounding can require an additional contributor when the target is not divisible by 20 wei. A failed excess refund reverts the subscription rather than leaving a partial payment.

## Complete fundraising and migrate to external trading

When accepted subscriptions reach 100% of the target, fundraising closes and the project enters the waiting-for-migration state. The final participant's subscription does not execute the costly migration.

The migration requires a willing wallet to send a **separate permissionless migration transaction**. Contracts cannot originate a transaction by themselves. The application provides a manual migration action and the contract suite provides an RPC preparation helper. No automatic broadcast, replacement, or retry scheduler is enabled. A participant can trigger migration directly.

Before sending, the migration wallet estimates the transaction gas limit and simulates parameter-free `migrate()`. It fronts the network fee and receives the contract-computed reimbursement from the liquidity half. See [gas reimbursement](#migration-gas-reimbursement) for metering, budget checks, preparation and deferred payments.

For target R, project-snapshotted migration fee f and gas reimbursement G, successful migration allocates ETH as follows:

| Destination | Amount |
| --- | --- |
| Project development vault | R / 2 |
| Platform migration fee | floor(R × f / 10,000), with f in basis points |
| Migration wallet reimbursement | G |
| Permanent official liquidity | R / 2 − platform migration fee − G |

The 0.02 ETH creation deposit remains separate. Migration creates the official native ETH/token Uniswap v4 pool and project governance and reward services. The pool opens at the independently specified **1.45P**, above the final subscription tier of **1.3P**. This sets the initial pool ratio; subsequent trades determine the market price. After deducting gas, the contract calculates the token amount required by the actual ETH liquidity budget at that fixed price. Purchased entitlements and the creator's fixed reserve remain unchanged. All unused tokens outside those allocations and the initial pool deposit are burned.

Initialization, funding, burns and launch succeed atomically. If migration fails, those changes revert together and subscription principal remains in escrow. A rejecting reimbursement recipient does not block a successful launch: the wallet can claim its recorded credit to another recipient later.

After launch, subscription tokens already held in participant wallets become transferable. Holder reward age starts at successful migration, not at the subscription timestamp. Holder rewards and operating distributions use independent [reward accounting and claims](rewards.md). The creator's 0.02 ETH deposit becomes fully claimable from the factory. This is an onchain claim, not an automatic unsolicited transfer. After a valid management handover, the current project manager owns any still-unclaimed deposit.

## Failed fundraising and refunds

If the deadline arrives before the target is reached, the escrow enters the refund state. If the target is reached but migration has not succeeded within **72 hours of full funding**, it also enters the refund state. Once refunds become available, migration is no longer allowed.

Each original contributor can claim **100% of their accepted subscription ETH** to a recipient they choose. The same refund transaction burns all purchased tokens from the original contributor wallet before paying ETH; no allowance is required. Only escrow can perform this pre-launch burn. If ETH payment fails, the burn and refund ledger revert together. Refunds cannot be claimed twice. The platform and creator cannot withdraw that principal. No platform migration fee is collected when migration does not succeed.

The creator can also claim the full **0.02 ETH creation deposit**, whether the failure is an unmet target or the migration timeout. Refund and claim transactions still have ordinary network gas costs; previously paid network gas is not refunded.

## Migration fee configuration

The initial default and hard maximum are 100 basis points (1%). The fee applies to the entire target and is deducted from the liquidity half. The creator treasury still receives exactly half.

| Project fee | LP share before gas and integer rounding | Platform migration share |
| --- | ---: | ---: |
| 100 BPS (default) | 49% | 1% |
| 50 BPS | 49.5% | 0.5% |
| 0 BPS | 50% | 0% |

### Configuration and authority

Read `coordinator.migrationFeeBps()` for the default used by future project creations. Set it with `coordinator.setMigrationFeeBps(newBps)` through the suite's existing Timelock, using its normal schedule and execute operations and minimum 48-hour delay. The deployment workflow verifies `migrationFeeAuthority() == timelock`. Neither the deployer, a project creator, nor a validator can change the fee directly after this binding.

Rates must be integer basis points between 0 and 100 inclusive. The library and coordinator both enforce the absolute ceiling in contract code. For example, 100 -> 50 -> 100 and 0 -> 1 are allowed, but 101 BPS is rejected. The Timelock cannot bypass the ceiling. These restrictions also apply during bootstrap. A zero-fee launch still records a zero-valued MigrationFeeRecorded event, without transferring any migration revenue.

Before configuring upgrade services, the bootstrap deployer controls the initial configuration. In standalone deployments without proxy services, activation assigns this authority to the fixed platform treasury. Production deployments use the Timelock-bound suite.

### Project snapshots

The ProjectEscrow constructor reads the coordinator default once and stores immutable `migrationFeeBps`. It calculates immutable `SALE_SUPPLY` using `saleSupplyForFee(target, snapshotBps)`. Contributions continue to use that fixed sale supply.

When a fully funded project migrates, the coordinator reads the project's snapshot and recalculates the quote for that rate. It checks that the quote sale supply equals the escrow's immutable sale supply. The permanent locker receives the same rate and records it as an immutable value. The ETH/token requirements, initialization price and burn remainder therefore use the original project terms even after the default changes.

`coordinator.quote(target)` previews a newly created project at the current default. To inspect an existing project, use `coordinator.quoteForFee(project.target(), project.migrationFeeBps())`. Using the current default quote for an older project's terms would be incorrect.

The sale-supply solver uses the actual rounded LP ETH budget before gas settlement rather than a fixed percentage. It maximizes the combined sale and pre-gas LP token allocation within 95% of initial supply under the subscription curve and opening price described above. Gas settlement reduces final LP tokens and burns unused tokens at that unchanged price.

## Migration gas reimbursement

### Contract-computed reimbursement

The only migration entry is parameter-free `migrate()`. The escrow measures `gasleft()` across preparation, deployment, service registration, price initialization, vault funding and escrow bookkeeping. A fixed 500,000-unit allowance covers remaining initial liquidity settlement, burns, launch, payment and transaction entry. The reimbursement is this internally computed quantity multiplied by the mined transaction's effective `tx.gasprice`.

RPC estimates and the transaction gas limit cannot set the reimbursed quantity. `migrationGasUnits` and `migrationGasMeteredUnits` both record the contract-computed quantity. The beneficiary, effective gas price and reimbursement remain recorded on the project. The configured total ETH limit defaults to 0.1 ETH. The coordinator's `setMigrationGasRefundLimit(limit)` can raise or lower it through the existing Timelock, with at least 48 hours of scheduling delay; its hard maximum `MAX_MIGRATION_GAS_REFUND` is 0.3 ETH. The escrow independently enforces the same absolute ceiling. `project.migrationGasRefundLimit()` returns the effective current limit, read at migration time rather than snapshotted at creation.

`migrate()` returns its internally computed quantity. An `eth_call` simulation can therefore preview the reimbursement without persisting migration, initializing a real pool, or moving funds. The actual transaction computes the quantity again from its own execution; the caller never submits the simulated result as an argument.

This is an estimate of normal direct migration costs, not exact receipt-based billing. Transaction entry, remaining operations and protocol gas refunds can cause a small difference from final receipt `gasUsed`. Arbitrary outer contract work is not in the metered scope. This implementation targets Ethereum L1; L2 data fees are not reconstructed.

### Prepare before sending

Use `scripts/migration-gas.mjs` `prepareMigration(project, feeOptions)` with a signer-connected project. It only reads and simulates; it never broadcasts or loads credentials. RPC `eth_estimateGas` sizes the transaction gas limit. A separate `eth_call` executes parameter-free `migrate()` and reads the returned onchain quantity. The prepared transaction contains only the migration selector, without a gas-estimate argument.

The result separates `estimatedGasUnits` (RPC transaction estimate) from `onchainGasUnits` and `estimatedReimbursementUnits` (contract reimbursement estimate). `estimatedTransactionCost` is an RPC estimate of the network fee; `estimatedGasCost` previews the reimbursement. It also contains the wallet's maximum estimated reimbursement, pre-gas allocation, estimated final ETH/token allocation, and prepared transaction. `estimateAndMigrate` is the explicit sending helper.

Older fixed escrows return no simulation data. The helper still uses their parameter-free `migrate()` entry and marks `onchainGasUnits` as null; their RPC-based display is approximate. Changing helper code cannot change their fixed onchain reimbursement rules.

The prepared transaction includes a small gas-limit margin. Unused gas is not treated as consumption and does not enlarge reimbursement. The helper checks the reimbursement estimate multiplied by the wallet's maximum fee against both the effective current reimbursement limit (when the escrow exposes it) and the LP ETH budget. RPC failures propagate rather than disabling that check. Changes in gas price, configured budget or chain state before mining can change the final reimbursement and liquidity, so the prepared allocation is a simulation rather than a guaranteed quote.

### Deduct ETH, then compute token quantity

The ETH allocation is defined in [the migration split](#complete-fundraising-and-migrate-to-external-trading). The creation deposit and forced ETH remain outside that allocation. Reimbursement must not exceed the effective `migrationGasRefundLimit()` and must leave positive LP ETH. An over-budget migration reverts in full; an accepted migration reimburses the complete computed amount. A zero limit permits only zero-cost reimbursement. Purchased allocations and the fixed creator reserve remain unchanged.

The coordinator prepares the locker, pool price and other services without depositing liquidity. Once the contract-computed charge is known, `finalizeMigration` subtracts G, calculates the exact V4 token requirement for the remaining ETH, and adds positive liquidity once. Unused LP tokens and initial allocation dust are burned. The opening price and delivered subscription balances do not change.

The locker's `initialQuote` records actual locked ETH, token amount, liquidity and total initial burn. Coordinator `quote` and `quoteForFee` show pre-gas allocation; `quoteAfterGas(target, projectFeeBps, gasRefund)` previews allocation for a particular charge. Use the project's immutable fee snapshot rather than the coordinator's current default.

### Reimbursement and permanent locking

Reimbursement belongs to `msg.sender`, including a contract wallet; `tx.origin` is not used. An outer sponsor and a contract wallet arrange their own fee sharing. An EOA normally receives payment during migration. The payout callback gets at most 30,000 gas; refusal leaves a credit in escrow without reverting launch. Only the beneficiary can claim that credit to another recipient, once. Pending reimbursement is excluded from `unaccountedSurplus`.

`finalizeMigration` is escrow-only, once-only, and requires trading to remain closed. After finalization, collecting fees uses zero liquidity delta. Separately accounted opening taxes can fund bounded positive additions to permanent liquidity; removal remains unavailable. See [Launch protection](trading.md). Existing fixed escrows cannot adopt this change through a governance upgrade; new deployments use the new entry and internally metered calculation.

### Gas-price boundary

The contract still uses the actual effective `tx.gasprice`, including the sender's chosen priority fee. The configured total ETH limit constrains the product of gas units and that effective price; ordinary callers cannot enlarge it by increasing their tip, outer transaction gas limit, project target, or forced ETH balance. Division checks the limit before multiplication so extreme prices cannot overflow the charge calculation. There is no separate fixed-Gwei tip ceiling. At the minimum 1 ETH target, the default 1% platform fee and default 0.1 ETH reimbursement limit, 0.49 ETH is reserved before gas and at least 0.39 ETH remains in initial LP. Raising the reimbursement limit can reduce this remaining LP amount; a 0.3 ETH configuration is still subject to the independent requirement that reimbursement remain strictly below the project's available LP budget. The platform fee is independently capped at 1%. Existing deployments retain their old limits.

At the minimum 1 ETH target, raising the limit to the absolute 0.3 ETH maximum still leaves at least 0.19 ETH in initial LP after the maximum 1% platform fee. The positive-LP check is not a separately configured reserve percentage; this minimum follows from the 1 ETH funding floor and the fee and reimbursement ceilings. A high effective transaction price can still consume a substantial part of the liquidity allocation within the authorized budget. The default budget remains 0.1 ETH.

Network prices continue to vary. If the permitted budget cannot cover a migration, it must wait for an affordable price, a Timelock-authorized limit change, or remain unlaunched until the existing 72-hour refund timeout. Failed transaction fees are not reimbursed. No automatic rebroadcast, replacement, or retry scheduler is added. Existing immutable escrows and coordinators retain their deployed minimum target and reimbursement rules; applying these limits onchain requires a new deployment. The configurable budget is an administrative entry on the new fixed coordinator, not a replacement of deployed escrow code through a UUPS upgrade.

## After launch

- [Trading and permanent liquidity](trading.md): opening taxes, swap settlement and replenishment.
- [Governance and custody](governance.md): treasury releases, creator reserve vesting, proposals and handover.
- [Rewards and distributions](rewards.md): holder claims, LP income and operating deposits.
- [Architecture and deployment](deployment.md): module wiring, upgrade authority and release procedures.
