Copy `deployments/mainnet.example.json` to a separate operation directory and fill its public addresses and RPC. Do not place private keys in JSON or copy a Sepolia manifest. The official Ethereum chain 1 PoolManager is listed at https://developers.uniswap.org/docs/protocols/v4/deployments.

`expectedDeployer` must match the public address of the intended mainnet deployment wallet. `upgradeProposer`, `platformTreasury`, and `validators` are separate roles. Keep the platform address and wallet roles agreed for the operation. A successful Sepolia deployment and its verification are prerequisites for proceeding with this project's mainnet operation; these scripts do not establish that prerequisite themselves.

Read-only preflight (no key read, file writes, or transaction submission):

```powershell
node scripts/deploy-mainnet.mjs PATH_TO_CONFIG.json
```

Broadcast requires a matching `DEPLOYER_PRIVATE_KEY` supplied in the process environment and an explicit `--broadcast`. Every transaction is type 2 and transfers zero ETH value.

With `feeMode: "live"`, each transaction reads the current RPC fee recommendation and latest base fee. The recommended `maxFeePerGas` and priority fee are recorded separately for that transaction. If the recommendation has no positive priority fee, the script uses a positive `gasPrice - baseFee` difference or, when that difference is unavailable, a minimum 0.01 gwei tip. An unavailable or insufficient max fee is set to twice the current base fee plus that tip. Live mode requires only the decimal-string `maximumDeploymentFeeEther`, set from the available balance for this operation; it ignores fixed max-fee and priority-fee fields. It imposes no default 0.025 ETH limit.

With `feeMode: "fixed"` (also the default when omitted), set three decimal-string fields: `maxFeePerGasGwei`, `maxPriorityFeePerGasGwei` (zero is permitted), and `maximumDeploymentFeeEther`. The example intentionally leaves them blank.

Actual charged transaction fees are `gasUsed * effectiveGasPrice` from receipts. `gasLimit * maxFeePerGas` is only the maximum balance reservation before sending, including a 20% gas cushion. The reservation plus fees already paid must stay within the available operation budget, and the wallet must cover the next reservation. Neither mode promises that the entire suite fits; insufficient balance or budget stops before the next transaction. The manifest records the exact limits for every transaction, and verification checks them against the actual chain transactions. Fixed mode additionally checks that those limits equal the configured caps.

```powershell
node scripts/deploy-mainnet.mjs PATH_TO_CONFIG.json --broadcast
node scripts/verify-mainnet.mjs PATH_TO_CONFIG.json
```

The deployed manifest and exact artifact archive are saved beside the configuration. Every signed transaction hash, nonce, gas limit, and maximum fee is journaled before submission. Journal writes flush the temporary file, rename it, and flush the final file. Windows does not expose a portable directory-metadata flush through this workflow, so OS failure, power loss, filesystem failure, and complete journal loss are outside a guaranteed recovery boundary. Preserve the journal/archive and inspect chain history after such a failure. Before any new transaction, the chain nonce must equal the recorded starting nonce plus the journaled transaction count; an unexpected nonce stops the run.

Resuming requires the same configuration (except RPC URL), build, deployer, fee mode, and operation budget. Fixed caps remain unchanged; live mode reads a fresh fee recommendation for each later transaction. It confirms the original transaction hashes and checks the recorded state before sending any later transaction. It never resends a prepared, failed, pending, dropped, replaced, or unknown transaction. If a hash never confirms, a submission fails, or an external wallet transaction interferes with the nonce, stop and inspect the journal and chain history. Do not delete or edit the journal to make an uncertain transaction eligible for retry.

The script archives artifacts before its first transaction and stops if the archive or journal differs on resume. An exclusive `.deployed.json.lock` prevents simultaneous runs using the same journal. A forcibly interrupted process can leave this lock behind; inspect the process and recorded transaction hashes before removing only that stale lock. Verification reads the archived build, receipts, permissions, runtime code, fee splits, and migration wiring; it never loads a private key or submits a transaction. It does not submit explorer source-verification requests. Preparation and static checks alone do not mean the mainnet suite is ready or deployed.
