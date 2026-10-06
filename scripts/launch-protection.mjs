import {Contract} from 'ethers';
import {artifact} from './local-chain.mjs';

// Explicit keeper operation. No credentials are loaded and no scheduler is started.
// Swaps already attempt one batch automatically; this handles queued larger
// amounts or deferred work. Each transaction remains subject to onchain limits.
export async function settleLaunchProtection(project, {maxBatches = 10, minimumSqrtPrice = 0n, deadlineSeconds = 300} = {}) {
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 20 ||
      !Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 3600)
    throw Error('Use 1..20 batches and a 1..3600 second deadline');
  const runner = project.runner, provider = runner?.provider;
  if (!provider || !runner.sendTransaction) throw Error('A connected signing wallet is required');
  const coordinator = new Contract(await project.coordinator(), artifact('V4MigrationCoordinator').abi, runner);
  const hook = new Contract(await coordinator.hook(), artifact('V4FeeHookLP').abi, runner);
  const locker = new Contract(await project.liquidityLocker(), artifact('PermanentLiquidityLocker').abi, runner);
  const poolId = await project.poolId(), receipts = [];
  if (await hook.protectionAccrued(poolId) > 0n) {
    const gas = await hook.forwardProtection.estimateGas(poolId);
    receipts.push(await (await hook.forwardProtection(poolId, {gasLimit: gas + gas / 5n + 10000n})).wait());
  }
  for (let batch = 0; batch < maxBatches && await locker.queuedProtectionETH() >= 10000n; batch++) {
    const block = await provider.getBlock('latest');
    const deadline = block.timestamp + deadlineSeconds;
    const gas = await locker.compoundProtection.estimateGas(minimumSqrtPrice, deadline);
    receipts.push(await (await locker.compoundProtection(minimumSqrtPrice, deadline,
      {gasLimit: gas + gas / 5n + 10000n})).wait());
  }
  return {receipts, queuedETH: await locker.queuedProtectionETH(), queuedTokens: await locker.queuedProtectionTokens(),
    addedLiquidity: await locker.totalProtectionLiquidity()};
}
