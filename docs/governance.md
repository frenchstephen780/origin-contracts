# Governance and custody

Community proposals use a token snapshot from the preceding block, signed ballots, a public result archive, and an onchain finalization transaction. Token-defined eligibility and the snapshot denominator are shared by the voting and result-validation paths. Vote weight is token balance in base units; interfaces can display whole votes rounded down without changing the contract's base-unit accounting.

## Project funding unlock schedule

The creator does not receive the development half at launch. It remains in a project vault controlled by governance. Under the default implementation:

| Claim | Earliest time | Maximum default release |
| --- | --- | --- |
| First claim | 24 hours after successful launch | 25% of the development vault's then-available funds |
| Subsequent claims | Weekly cycles, at least 7 days after the previous successful claim | 25% of the then-remaining available funds |

The first claim is vote-free. Later claims follow [withdrawal proposals](#withdrawal-proposals); a qualifying Against tally blocks that cycle. Pending termination freezes claims. Skipping a claim does not permit catch-up payments, and percentages apply to remaining available funds. See [termination proposals](#termination-proposals) for settlement and the validator trust boundary.

With no new deposits or governance blocks, the first three claims release 25%, 18.75% and 14.0625% of the original development balance, respectively. Fees subsequently deposited into that vault are subject to the same available-balance calculation.

## Creator token reserve schedule

The 5% reserve is held in the escrow and unlocks separately from development ETH. Percentages below are cumulative percentages of the original 100,000,000-token supply:

| Time after successful launch | Cumulative reserve unlocked |
| --- | --- |
| Before day 15 | 0 tokens |
| Day 15 | 500,000 tokens, or 0.5% |
| Day 30 | 1,000,000 tokens, or 1% |
| Day 60 | 2,500,000 tokens, or 2.5% |
| Day 180 | 5,000,000 tokens, or 5% |

Already claimed tokens are subtracted from each entitlement. Project termination stops future vesting at the termination time. A management handover carries the unclaimed reserve without resetting its schedule. Unclaimed reserve has no holder voting power or reward age.

## Custody and permissions

The protocol uses a unified set of contracts and rules, with isolated custody for each project:

| Contract | What it controls | Who can move funds |
| --- | --- | --- |
| Factory | Creator deposits and earned platform migration fees in separate ledgers | Eligible manager claims their deposit; platform claims only earned fees |
| Project escrow | Accepted subscriptions, delivered-token accounting and creator reserve | Contributors claim eligible refunds; creator claims vested reserve |
| Development vault and governance | Development half and subsequent development revenues | Governance authorizes scheduled payments and settlement |
| Permanent liquidity locker | Official pool principal and queued protection taxes | Only positive replenishment and fee collection; no principal withdrawal |
| Hook and reward services | Separately accounted ordinary fees, opening taxes and holder rewards | Fixed distribution routes and eligible claims |

Users authorize their own wallet transactions. The backend does not hold a key that can arbitrarily withdraw subscription principal or permanent liquidity. Shared PoolManager custody is accounted by each pool and position; it is not an unrestricted common project balance. Forced ETH is excluded from accounted principal, refundable deposits and the protection budget.

Some governance, rewards and ordinary fee-allocation modules support upgrades through the protocol Timelock with at least 48 hours of notice and module compatibility checks. Consequently, the weekly release schedule above is the current default implementation, not a claim that governance logic can never change. The escrow, token and permanent locker use fixed code. The Hook fixes the opening tax rate and duration without an administrator setter. Creating a new suite does not change the balances or rules of old deployed projects.

## Withdrawal proposals

The first proposal may be opened 24 hours after launch. Withdrawal proposals have a seven-day initiation cooldown and can target only the upcoming weekly cycle. Voting lasts 24 hours. Result upload is allowed after voting ends and before the earlier of 24 further hours or the target cycle's opening; proposals too late to leave a voting period are rejected.

For means support for withdrawal. Against means opposition to withdrawal. An attested Against tally of at least half the eligible snapshot denominator blocks that cycle. A defeated, expired, or missing blocking result permits the normal weekly withdrawal rules to apply. The first treasury claim is vote-free and remains separate from weekly cycles. A pending termination proposal freezes treasury withdrawals.

## Termination proposals

Termination proposals first become available 24 hours after launch and have their own seven-day initiation cooldown. Voting lasts three days, followed by a 24-hour result-upload period. For means support for termination. At least two thirds of all eligible snapshot voting power is required, including equality; the denominator is not only votes cast.

A proposal may finalize before voting ends when the attested For tally already reaches the two-thirds threshold. Finalization still requires a valid eligible uploader ballot and validator quorum. Intermediate offchain totals alone cannot terminate a project.

Termination seals the creator treasury, stops future creator reserve releases, transfers the remaining creator treasury to the holder-fee reward vault, and sends any insurance-vault balance to settlement. Existing claims remain independently accounted. Swaps remain available after termination; official LP principal remains locked. Previously withdrawn funds are not recovered by termination.

## Project topics

The current creator may propose project topics after the first 24 hours. A topic vote lasts three days with a 24-hour result-upload period and passes at half the eligible snapshot denominator. One unresolved topic proposal may exist at a time. Topic results record community direction and cannot execute arbitrary calls or automatically release funds.

## Creator handover

Handover uses a proposed recipient, the contract's two-day delay, and recipient acceptance. After acceptance, treasury withdrawal authority, creator reserve claims, unclaimed creation deposits, and creator-only proposal rights follow the new address. Creator-only project updates and operating deposits also follow the successor. The schedules and previous claim records do not reset. Already received tokens and funds remain with the former creator, who retains ordinary holder rights for tokens they hold.

## Result validation and trust

EIP-712 domains bind signatures to the chain and governance address. Results bind the proposal, snapshot, totals, archive hash, CID, uploader, and deadline. Onchain validation rejects excessive totals, invalid signatures, duplicate finalization, and submissions outside the permitted window. The configured validator quorum is a trust dependency for tally correctness and archive completeness.

For separate reward ledgers and post-termination fee allocation, see [rewards and distributions](rewards.md). Module wiring and upgrade procedures are described in [architecture and deployment](deployment.md).
