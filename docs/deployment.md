# Architecture, deployment and publication

This guide covers contract wiring, reproducible builds, separate Sepolia and Ethereum mainnet deployment workflows, upgrades, public packaging and routing work. Publishing source does not establish mainnet readiness, explorer verification or routing approval.

## Contract architecture

The supported deployment workflow uses the community fundraising policy and LP-enabled services. The following modules form the default suite.

| Module | Responsibility |
| --- | --- |
| CommunityV4ProjectFactory | Project creation, creation deposits, project registration, and platform migration-fee custody |
| ProjectEscrow | Subscription accounting, immediate locked-token delivery, deadlines, refunds, migration, and creator reserve claims |
| ProjectToken | Fixed supply, transfer restrictions, snapshots, eligible voting power, and holding-age reward checkpoints |
| CommunityV4MigrationCoordinator | Atomic service deployment, pool initialization, allocation checks, and bounded migration reimbursement policy |
| PermanentLiquidityLocker | Permanent official LP custody, fee collection, and opening-tax liquidity additions |
| V4FeeHookLP | Swap fees, opening sell-tax accounting, and per-project allocation |
| ProjectSwapRouter | Exact-input and exact-output swaps, settlement, and bounded fee-distribution attempts |
| UpgradeableCommunityGovernance | Signed ballot results, treasury releases, termination, project topics, and creator handover |
| ProjectVault / ProjectSettlement | Isolated treasury custody and direct settlement claims |
| UpgradeableProjectRewards | Holder-fee reward rounds and independent user claims |
| OperatingRewardsLP | Creator-funded operating distributions with separate holder and LP accounting |
| LPRewardDistributor | LP income through the PoolManager fee-growth ledger |
| AllocationVerifier | Configured validator quorum for signed results |
| SwapFeePolicyLP | Upgradeable ordinary fee allocation within Hook enforcement limits |
| ProjectProxyDeployer / OriginProxy | Per-project service proxies and atomic initialization |
| OriginTimelock | Delayed configuration and UUPS upgrade authority |

Shared base contracts, interfaces, and policy identifiers are retained because the suite inherits them and they define storage, signatures, and compatibility checks. They are not deployment history. Local quoting and standalone modules are covered by regression tests; they do not change the default suite's service wiring.

## State and authority

The escrow, token, coordinator, Hook, and permanent locker have fixed code. Governance, holder rewards, operating rewards, and ordinary fee-allocation implementations support UUPS upgrades through a Timelock of at least 48 hours. Implementation-family checks and storage-layout review are required before an upgrade. Fixed-code limits require a new suite deployment to change.

Community ballots use EIP-712 signatures. Onchain finalization authenticates the result uploader and configured validator quorum and applies the snapshot denominator and deadlines. Validator signatures attest a tally; they are not an onchain recount of every ballot.

Official liquidity has fixed ownership, ticks and salt, with no principal-withdrawal or arbitrary-call entry point. Normal earnings and opening-tax principal use separate ledgers. Protocol rules are documented in [fundraising](fundraising.md), [trading](trading.md), [governance](governance.md) and [rewards](rewards.md).

## Build artifacts

Run `npm ci --ignore-scripts` and `npm run compile`. Preserve the generated Standard JSON input, compiler version, settings, ABIs, storage layouts, bytecode, and source hashes for each deployment. Before explorer submission, recompile the preserved input with its exact imports, dependency contents, and settings and compare the resulting bytecode with the deployment artifact. A generated source export alone does not establish that match. Explorer verification must use the exact deployed build and constructor arguments, not a later edited source tree.

The project compiler resolves imports in an ABI-only pass using its dependency whitelist. It then compiles the complete canonical Standard JSON input without an import callback and writes that same input verbatim to `artifacts/standard-input.json`. The build manifest includes `standardInputSHA256` and hashes of the emitted artifact files. These hashes bind the deployment baseline to its actual compiler input and bytecode, even when Solidity source contents have not changed. The separate pinned upstream PoolManager compilation retains its own compiler and import resolution.

## Sepolia deployment

Copy `deployments/sepolia.example.json` to a private configuration file. Fill in the RPC URL, platform treasury, upgrade proposer, validator addresses, validator threshold, confirmation count, and a Timelock delay of at least 172800 seconds. Keep configurations and credentials outside a public release.

```sh
npm run compile
npm run deploy:testnet -- deployments/sepolia.json
```

The default command is preflight only. It checks the chain ID, official PoolManager address and code, validators, delay, and build. To deploy, supply `DEPLOYER_PRIVATE_KEY` in the process environment and explicitly pass `--broadcast`.

```sh
npm run deploy:testnet -- deployments/sepolia.json --broadcast
npm run verify:testnet -- deployments/sepolia.json
```

This deployment tool supports Ethereum Sepolia only. Use the independent mainnet workflow below for chain ID 1. Do not bypass the testnet chain checks to use this tool on another chain.

The deployment journal records each submitted transaction before awaiting confirmation. An interrupted workflow can inspect and resume the recorded transaction. A failed or unconfirmed transaction stops the workflow; it does not start an automatic retry loop. Deployment artifacts and receipts remain private runtime records.

## Ethereum mainnet deployment

Copy `deployments/mainnet.example.json` to a separate operation configuration. Set `network` to `ethereum-mainnet`, retain chain ID 1 and the official PoolManager, and supply `expectedDeployer`, platform treasury, upgrade proposer, validators, quorum, confirmations, and Timelock delay. Do not reuse Sepolia deployment records or change the testnet entry point.

```sh
npm run deploy:mainnet -- deployments/mainnet.json
```

This command performs read-only preflight. The mainnet entry does not read a key, write a deployment journal, or submit a transaction until `--broadcast` is supplied. Broadcast also checks that the process signing key derives `expectedDeployer`.

Choose `feeMode: "live"` to read current RPC max-fee and priority-fee recommendations before every transaction. Set `maximumDeploymentFeeEther` to the available balance allocated to this operation; fixed fee-cap fields are not required in live mode. Choose `feeMode: "fixed"` to use explicit decimal-string `maxFeePerGasGwei` and `maxPriorityFeePerGasGwei` together with the same total budget field. Omitted `feeMode` retains fixed behavior.

Actual cost is the receipt's gas used multiplied by its effective gas price. The script reserves gas limit multiplied by max fee before submission, checks both remaining operation budget and wallet balance, and records each transaction's chosen fee limits. It includes a bounded gas cushion and stops before a transaction that would exceed the available budget.

```sh
npm run deploy:mainnet -- deployments/mainnet.json --broadcast
npm run verify:mainnet -- deployments/mainnet.json
```

The mainnet workflow archives the exact build before its first transaction. It writes and flushes the transaction hash, nonce, and fee reservation before broadcasting, disables HTTP submission retries, and checks nonce continuity before later transactions. Resumption confirms the same recorded hashes; it does not automatically replace or resend an unknown, failed, or unconfirmed transaction. The configuration, build, deployer, fee mode, and operation budget must match the original journal; the RPC endpoint may change. See [mainnet operations](../scripts/MAINNET-DEPLOYMENT.md) for fee fallbacks, locks, and filesystem recovery boundaries.

## Configuration boundaries

The fixed coordinator identifies the authorized backend wallet through `migrationExecutor()` and exposes Timelock-controlled setters for the [migration fee](fundraising.md#migration-fee-configuration), shared `migrationReimbursementGasUnits()` allowance, and [reimbursement budget](fundraising.md#migration-gas-reimbursement). Each project snapshots its fee at creation; compensation uses the effective allowance and ETH limit at execution. Deployment verification must confirm the executor, allowance, authority and ceilings. These setters do not replace fixed code or update old projects retroactively.

The executor address is fixed in coordinator code; allowance and budget setters do not rotate it. The backend must use that address's signing key and hold enough network ETH to front migration fees. Releasing another suite does not change the executor or custody of projects already created under an older factory.

## Prepare an upgrade

`upgrade:prepare` is read-only. It requires an explicit RPC, proxy, Timelock, old artifact, new artifact, candidate implementation, unique salt, and output filename. It checks runtime artifacts, the implementation family, UUPS UUID, authority, storage layout, and minimum delay and prepares schedule/execute calldata without broadcasting.

Review implementation behavior and the ERC-7201 upgrade-control namespace in addition to the linear storage layout. Storage compatibility does not establish semantic safety. Active proposal and reward-round guards must be respected before execution. Upgrading one policy cannot replace fixed Hook or escrow code.

## Verification scopes

`verify:testnet` checks bytecode, recorded receipts, Timelock roles, service wiring, fee splits, migration quotes, fee ceilings, and reimbursement limits against the archived build. `verify:mainnet` also checks creation calldata hashes, nonce-derived addresses, confirmation counts, the exact fee limits recorded for each transaction, and actual total deployment fees. These are onchain configuration checks; they do not submit explorer source-verification requests.

`package:source` exports the current Solidity sources and resolved dependencies for review. Its manifest includes compiler settings and source hashes. Open-source publication, explorer verification, and any third-party router approval are separate operations. This repository includes no prior approval claims or account-specific application materials.

Explorer verification must inventory every newly created address, including constructor-created deployment services and factory-created project instances. A deployment receipt list alone misses internal CREATE children. Use the exact archived Standard JSON input and compiler settings, reproduce creation/runtime bytecode, reconstruct constructor arguments, submit them through Etherscan V2 for the target chain, and confirm that source is actually published. A submission GUID is not a successful verification. After creating and migrating a project, repeat the inventory for its escrow, token, governance/reward proxies, custody vaults, settlement and permanent liquidity locker. Reused implementations retain their original addresses and verification evidence; they are not newly deployed contracts.

## Public package

```sh
npm run public:check
npm run package:open-source
npm run package:source
```

The repository package is written to `artifacts/open-source/`; the Solidity source bundle is written to `artifacts/routing-source/`. Both include source hashes. Unit tests use the pinned real Uniswap v4 PoolManager on isolated networks. Contract code has not undergone an independent external audit; local tests establish only the behavior they exercise.

### Test organization

Run `npm test` to compile contracts and execute all nine test entry points serially. Named suites isolate each fixture's state and hooks; base contracts, community policy and proxy wiring retain distinct coverage.

| Test entry | Coverage |
| --- | --- |
| `fundraising.test.mjs` | Subscription curves, address caps, refunds, deposits and locked token delivery |
| `migration.test.mjs` | Pool initialization, atomic allocation and project fee snapshots |
| `migration-gas.test.mjs` | Executor authorization, shared compensation allowance, Timelock budget and hard ceiling |
| `governance.test.mjs` | Base voting, signed ballots, cooldowns, termination thresholds and topics |
| `custody.test.mjs` | Reserve vesting, first withdrawal, handover, recovery and settlement |
| `rewards.test.mjs` | Holding age, independent scans, LP income and standalone Merkle distributions |
| `trading.test.mjs` | Opening protection, liquidity additions, router limits and secondary pools |
| `security.test.mjs` | Attack reproductions, lifecycle outcomes and production ABI authority |
| `upgrades.test.mjs` | UUPS, storage compatibility, Timelock and maintenance integration |

`test/helpers.mjs` shares transaction receipt handling and local-chain fixture cleanup. Test-only Solidity harnesses stay in `test/contracts/`; the build emits their artifacts for local tests and production deployment tools select the production contracts.

## Public and private files

The public repository includes project Solidity sources, interfaces, libraries, pinned package manifests, the MIT license for project-owned code, reproducible local tests, generic deployment tools, documentation, CI configuration, and empty deployment configuration examples. Dependency sources retain their own license identifiers.

Local tests and test-only Solidity helpers are retained for reproducibility. They are not part of the production deployment workflow. Installing dependencies and running a compiler generates ignored directories; these do not need to be uploaded to GitHub.

Keep private keys, seed phrases, credential-bearing RPC URLs, API tokens, account-specific application details, actual deployment configurations, wallet inventories, funded-wallet journals, local runtime reports, historic deployment archives, and superseded release packages outside a public publication. The package command uses an explicit public-file list and excludes runtime files and installed dependencies.

The exact compiler input and build archives must be preserved locally for each deployment. They are verification evidence, not substitutes for explorer verification. A public package must be generated from the final source tree; later edits cannot verify an earlier deployment.

## Technical work required before mainnet execution

For an existing platform, `deploy:migration-update` replaces only the migration-bound services. Copy `deployments/migration-update.example.json` to a private configuration, point `reuseDeployment` at the previous complete deployment and its archived artifacts, and preserve its treasury, Timelock and validator settings. The workflow requires identical bytecode and constructor arguments for all ten reused components. It creates a Coordinator, Factory, LP distributor, Hook and Router, plus the Coordinator's internal liquidity deployer. Existing escrows stay bound to their original contracts.

Run `npm run deploy:migration-update -- PRIVATE_CONFIG.json` for a read-only preflight, then add `--broadcast` to execute the authorized deployment. Fees come from the live RPC recommendation and an explicit total ETH budget bounds the journaled operation. An unknown transaction result must be inspected before resuming; the workflow never automatically resends a recorded transaction. `npm run verify:migration-update -- PRIVATE_CONFIG.json` checks the receipts, exact archived bytecode, bindings, authorities and migration policy. Explorer source verification is a separate step. Configure reimbursement units for the destination network using measured migration receipts, rather than the transaction's execution margin.

1. Review the dedicated `deploy:mainnet` workflow and operation configuration. `deploy:testnet` accepts chain ID 11155111 only; do not bypass its checks. Recheck chain ID 1, official Uniswap addresses and code, `expectedDeployer`, transaction journaling, fee mode, and the available deployment budget.
2. Run the final build, contract size checks, regression tests, and deployment simulation. Reproduce the archived compiler input's bytecode before relying on it for public source verification. Separately verify the official Universal Router path before claiming that compatibility, including buy and sell directions, supported exact-input and exact-output modes, launch protection, and empty Hook data. Existing project-router and isolated PoolManager tests do not establish official Universal Router compatibility.
3. Submit explorer source verification using the exact deployed compiler input, compiler version, constructor arguments, dependency licenses, and deployed addresses. Verify implementations and proxy contracts and associate proxies with their implementations. `verify:testnet` and `verify:mainnet` check bytecode and configuration onchain; neither submits Etherscan source verification.
4. Replace the application-specific historic Sepolia material with the final mainnet Hook address, verified-source links, real pool ID, current fee behavior, actual administrative controls, and final public repository URL.

Before mainnet execution, recheck the official deployment feed and onchain PoolManager code for the intended network. Do not infer addresses from another network.

## Information and access required

- A mainnet RPC endpoint and a privately configured signing method for the reviewed deployment account. An account balance alone does not provide signing access.
- The platform treasury, upgrade proposer, validator addresses and quorum, Timelock delay, confirmation policy, and maximum approved transaction-fee budget.
- A public GitHub repository URL. Publishing through Git also requires repository write access; supplying a URL does not grant it. Uploading the prepared public package manually is an alternative.
- An Etherscan API key for automated verification, or access to the explorer's manual verification workflow. Store API credentials in private configuration.
- The applicant's name, contact email, Telegram handle, final Hook description, public website, and any audit link that actually exists. Application contact details must not be copied into the public repository.
- A real example pool and its liquidity. Treat this funding as a separate requirement from contract deployment gas.

## Example pool requirement

The official routing application requires a pool using the submitted Hook with some minimal liquidity; test tokens are allowed. The current Hook only registers pools through the project migration coordinator and rejects unregistered pools. Deploying the platform alone does not create a qualifying project pool.

Under the current contract rules, a project target is at least 1 ETH, the separate refundable creation deposit is 0.02 ETH, and each address may contribute at most 5% of the target. Completing a minimum-target project therefore needs at least 20 contributing addresses and a successful migration. A privately controlled demonstration must be explicitly funded and authorized as such; it must not be presented as independent community participation. A local or fork simulation can test this lifecycle without spending mainnet funds, but it does not create a public mainnet example pool.

If a different demonstration-pool procedure is proposed, first verify that it works with the existing immutable Hook and coordinator authorization. Do not assume an arbitrary standalone pool can be substituted.

## Routing approval boundaries

The Hook uses swap delta-return flags, so manual routing allowlisting is required under the published Uniswap Labs criteria. GitHub publication does not replace matching explorer verification. The official application rejects unverified Hook submissions.

The application must disclose the 1% ordinary Hook fee, the sell-only launch tax that starts at 25% and decays to zero over ten minutes, its liquidity destination, supported partial-fill behavior, pool registration restrictions, the fixed Hook implementation, and the upgradeable external allocation policies. Source availability does not establish that these behaviors will be accepted.

Submitting a Hook to the public Hooklist registry does not itself grant routing allowlisting. Uniswap Labs decides whether to approve a routing application and may later change that decision. Approval only makes a pool eligible for consideration; it does not guarantee a chosen route or a third-party wallet integration.

The application form includes acceptance of terms and a privacy policy. Confirm those terms at submission time. Account authentication, any CAPTCHA, or applicant verification may require the account owner's participation.

## Official references

- [Uniswap v4 deployment addresses](https://developers.uniswap.org/docs/protocols/v4/deployments)
- [Hook routing application](https://developers.uniswap.org/hook-allowlist)
- [Routing allowlisting criteria](https://support.uniswap.org/hc/en-us/articles/48291859140621-Routing-for-hooked-pools)
- [Etherscan Solidity verification API](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode)
