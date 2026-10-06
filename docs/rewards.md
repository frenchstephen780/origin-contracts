# Rewards and distributions

Ordinary Hook fees can fund the creator treasury, holder rewards, personal LP income, and platform fees. Creator-funded operating distributions use a separate reward vault. These categories have separate accounting; claiming one does not consume another.

## Holding-age shares

The token maintains aggregate balance and age-decay checkpoints rather than iterating over individual purchase lots. With age t measured in days, the weight function is:

```text
w(t) = 7 - 6 * 20^(-t / 23)
```

The multiplier starts at one, reaches 6.7 at 23 days, and approaches seven from below. An outgoing transfer proportionally reduces the sender's aggregate age state. Incoming tokens start with fresh age at the recipient; any previously held recipient balance keeps its accumulated age. Holder balances of one token or less do not receive holding-age shares. Protocol-owned balances are excluded through the token's fixed ledger rules.

`HoldingWeight` stores decay in token base units times 1e18, rounds residual decay up, and rounds credited shares conservatively down. The exponential computation has a bounded loop independent of holder count. Voting power uses token snapshots and is separate from these age-weighted reward shares.

## Batched rounds

Each reward vault independently queues incoming ETH. Processing fixes a snapshot and uses bounded scans to determine total shares and credit per-holder claim balances. The holder registry and checkpoints cannot be mutated in ways that invalidate an active scan. Credited amounts remain liabilities of that vault; unallocated amounts and integer rounding follow its queue accounting.

Automatic processing during token transfers or swaps is bounded by the existing 350,000-gas allowance per vault callback, without a fixed registry-entry count limit. The internal processing budget is the forwarded allowance minus 20,000 gas, and each loop iteration retains a 110,000-gas safety reserve. The number of entries processed depends on the phase, eligibility, and storage access costs. Multiple token transfers in the same transaction may invoke multiple bounded callbacks. Explicit processing remains bounded by its requested gas budget, capped at 2,000,000 gas, so quiet markets can finish rounds without requiring trades.

The allowance is a ceiling, not a fixed charge. Once both passes finish, later callbacks return without scanning until a new funded round is due. They still incur a small call and state-check cost, and ordinary transfer accounting remains necessary.

Each address's shares are frozen only once per vault and round. Later balance changes reuse that frozen state. The summing and crediting cursors advance monotonically within their respective passes; each address is credited only once. The crediting pass uses the frozen shares rather than recalculating holding age. Mandatory capture of the current transfer's sender and recipient still occurs before their balances change and is separate from optional registry scanning. The two vaults maintain independent rounds and liabilities.

Anyone can advance the permitted processing functions. A round does not automatically send ETH to every holder. Each holder calls the corresponding claim function for their credited balance, reducing exposure to rejecting recipients and unbounded payout loops.

## LP income

Personal LP income uses the real Uniswap v4 PoolManager fee-growth ledger. LPRewardDistributor funds the pool channel and processes backed ETH into LP income. Active LP participation follows the native position ledger without a holder-age waiting period. Official locked LP fee collection remains separate from personal positions and permanent principal.

Opening sell taxes fund permanent liquidity additions through a dedicated Hook/locker ledger. They are not holder rewards or personal LP principal withdrawals. See [opening tax and liquidity](trading.md).

## Permission and recovery controls

Reward initialization is atomic and bound to its deploying service. Implementations and fee policy use the disclosed Timelock upgrade authority. Mandatory capture, compatible token binding, idle-round upgrade guards, and recovery controls protect accounting continuity.

The Timelock can enable token recovery after the required notice if a reward implementation blocks capture. Recovery pauses reward processing and permits controlled token transfer continuity. An aborted round returns uncredited round funds to the queue without cancelling confirmed claim balances. Both reward vaults must be idle before normal processing resumes.

The holder registry supports bounded pruning of addresses whose balances are at most one token and whose state was updated in an earlier block, while both reward vaults are idle. Receiving tokens again registers the address again. Registry indices do not move during an active scan.

## Ordinary fee allocation

The ordinary 1% Hook fee is allocated as follows under the current fee policy:

| Destination | Active project | Terminated project |
| --- | ---: | ---: |
| Creator treasury | 20% | 0% |
| Holder-fee reward vault | 40% | 60% |
| LP income | 10% | 10% |
| Platform | 30% | 30% |

The router attempts optional distribution after PoolManager settlement with bounded gas. Failure preserves backed accrual and emits a deferral event; explicit distribution can process it later. A fee policy does not grant arbitrary access to principal. [Termination](governance.md#termination-proposals) also redirects remaining creator treasury funds to the holder-fee reward vault.

## Operating distributions

The current creator can fund the independent operating-reward contract through `OperatingRewardsLP.deposit()`. Only that creator may deposit; zero-value deposits and deposits after termination are rejected. The contract separates holder funding from the LP portion, queues holder rewards and sends the LP portion through the configured distributor. A failed optional LP processing attempt leaves the funded amount available for subsequent processing.

Holder rounds use the holding-age algorithm and bounded processing described above, with independent queues, snapshots and claim balances. Each holder claims their own credited ETH; claiming ordinary fee rewards does not consume operating rewards. LP income follows the PoolManager fee-growth ledger without holder-age weighting. Creator reserve and treasury claims follow [governance and custody](governance.md).

See [architecture and deployment](deployment.md) for upgrade authority and storage review.
