# Origin Contracts

Solidity contracts for project fundraising, refundable subscriptions, Uniswap v4 migration, permanent liquidity custody, swaps, holder rewards, LP income, operating distributions, and community governance. This repository builds and tests independently of any application backend.

## Build and test

Requires Node.js 24 or newer and npm.

```sh
npm ci --ignore-scripts
npm run public:check
npm test
```

Tests run on isolated in-process Hardhat networks. The test suite does not use a public RPC, real wallet keys, or funded public-network accounts. Test helpers remain separate from production sources in `test/contracts/`.

Project contracts compile with Solidity 0.8.30. The pinned upstream Uniswap v4 PoolManager compiles with Solidity 0.8.26. Compiler settings use Cancun, viaIR, and 200 optimizer runs. Dependencies and compilers are pinned in `package-lock.json`. The project build first resolves dependencies without generating bytecode, then compiles one complete Standard JSON input without an import callback. It archives that exact input with the artifacts. Compilation checks runtime and initcode size limits and saves ABIs, storage layouts, source hashes, the input hash, and emitted artifact hashes in `artifacts/`.

## Repository layout

| Directory | Contents |
| --- | --- |
| `src/` | Contracts, interfaces, libraries, and upgrade modules |
| `test/` | Reproducible local regression and security tests |
| `scripts/` | Build, local simulation, deployment, verification, and packaging tools |
| `docs/` | Current protocol rules and deployment procedures |
| `deployments/` | Empty deployment configuration examples |

## Protocol overview

- Funding targets range from 1 to 1,000,000 ETH and must contain an even number of wei. Duration is 1-15 whole days; the default is 3 days. The creator pays a separate refundable 0.02 ETH creation deposit.
- Subscriptions use P, 1.15P, and 1.3P across the first 50%, next 25%, and final 25% of the target. Each address may subscribe up to 5% of the target cumulatively. Tokens are delivered during subscription and remain non-transferable until successful migration. Failed fundraising refunds the contributed ETH and burns the corresponding tokens.
- Reaching the target enables a separate parameter-free migration transaction. The opening pool ratio is 1.45P. The creator treasury receives half of the target. The liquidity half pays the snapshotted migration fee and contract-computed gas reimbursement before permanent liquidity is added. Unused tokens are burned; subscription balances and the fixed creator reserve do not change.
- The migration fee starts at 1% and can be adjusted within 0-1% through the Timelock. The gas reimbursement budget starts at 0.1 ETH and can be adjusted up to an absolute 0.3 ETH maximum. An over-budget migration reverts atomically.
- Swaps use a 1% ordinary Hook fee. The additional sell-only opening tax decays from 25% to zero over ten minutes and funds additions to permanent liquidity. Holder rewards, personal LP income, and creator-funded operating distributions have separate accounting and user-initiated claims.
- Withdrawal and termination proposals first become available 24 hours after launch. Each has its own seven-day initiation cooldown. Withdrawal voting lasts 24 hours; termination voting lasts three days and can finalize early at two thirds of eligible snapshot power. For supports withdrawal; Against opposes withdrawal. The current creator can also propose project topics.
- Termination stops creator treasury withdrawals and reserve vesting while swaps remain available. Remaining creator treasury funds enter holder rewards. Creator identity transfer follows the contract delay and acceptance procedure, transferring the associated privileges to the new address.

## Documentation

Read the protocol guides in lifecycle order, then use the deployment guide for implementation and operations. Each rule has one detailed home; related guides link to it.

| Guide | Contents |
| --- | --- |
| [Fundraising and migration](docs/fundraising.md) | Creation, subscriptions, refunds, migration allocation, fee snapshots and gas reimbursement |
| [Trading and permanent liquidity](docs/trading.md) | Opening sell tax, swap modes, separate tax custody and bounded liquidity replenishment |
| [Governance and custody](docs/governance.md) | Treasury and reserve schedules, voting, termination, handover and fund permissions |
| [Rewards and distributions](docs/rewards.md) | Ordinary fee allocation, holding-age rounds, holder claims, LP income and operating deposits |
| [Architecture, deployment and publication](docs/deployment.md) | Contract modules, upgrade boundaries, Sepolia and mainnet tools, verification, public packaging and routing prerequisites |

## Deployment tools

`deploy:testnet` supports Ethereum Sepolia. The separate `deploy:mainnet` entry supports Ethereum chain ID 1 and checks its official Uniswap PoolManager. Both default to read-only preflight and require an explicit configuration file; transactions require `--broadcast` and `DEPLOYER_PRIVATE_KEY` in the process environment. Mainnet also requires the signing address to match `expectedDeployer`. The repository contains no actual deployment configuration, wallet inventory, deployment receipts, or signing keys. See [deployment procedures](docs/deployment.md) and [mainnet operations](scripts/MAINNET-DEPLOYMENT.md).

Mainnet `feeMode: "live"` uses current RPC fee recommendations for each transaction and an operation budget based on the available wallet balance. `feeMode: "fixed"` uses explicit max-fee and priority-fee caps. Receipts determine actual charges from gas used and effective gas price; the gas-limit/max-fee product is only a balance reservation before submission. The mainnet journal records each transaction hash before submission and resumes by checking that hash, without automatic resubmission.

`verify:testnet` and `verify:mainnet` verify deployed bytecode, receipts, and configuration onchain; mainnet also verifies the recorded transaction fee limits and total budget. Explorer source verification is a separate operation using the exact archived compiler input and constructor arguments. First reproduce deployment bytecode from that input, then submit the matching source. Neither an onchain verification report nor a generated source bundle is an explorer verification or a routing approval.

## Public release

```sh
npm run public:check
npm run package:open-source
npm run package:source
```

The repository package is written to `artifacts/open-source/` using an explicit public-file list. The Solidity source bundle is written to `artifacts/routing-source/`, with dependency license identifiers preserved. Both outputs include source hashes. Runtime directories, environments, keys, wallet journals, actual deployments, generated caches, and dependencies are excluded from the repository package.

The public check rejects Chinese text, common credential literals, personal filesystem paths, populated RPC examples, and obsolete deployment references. Git ignore rules exclude local private files. All project-owned public text is English. Protocol compatibility identifiers and upstream protocol names are part of the contract interface and remain intact.

Contracts have not undergone an independent external audit. Local tests establish only the behaviors they exercise. Upgradeable governance, rewards, and fee allocation depend on the disclosed Timelock authority; ballot-result validation depends on the configured validator quorum.

Project code is licensed under [MIT](LICENSE). Dependency sources retain their original licenses. `private: true` prevents accidental npm publication and does not restrict publishing this repository.
