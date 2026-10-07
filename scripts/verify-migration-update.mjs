import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JsonRpcProvider, Contract, ZeroAddress, ZeroHash, formatEther, keccak256, getCreateAddress} from 'ethers';
import {assertArtifactRuntime} from './storage-layout.mjs';

// Reads chain state and writes only its verification report. Never reads keys or sends transactions.
const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) throw Error('Usage: node scripts/verify-migration-update.mjs CONFIG.json');
const configPath = path.resolve(inputPath);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (![1, 11155111].includes(config.chainId) || config.contractVersion !== 16) throw Error('A v16 migration configuration is required');
const settings = {expectedDeployer: config.expectedDeployer, manager: config.poolManager, platform: config.platformTreasury, proposer: config.upgradeProposer, validators: config.validators, feeMode: 'live', fees: {totalBudget: BigInt(config.maximumDeploymentFeeWei)}};
const manifestPath = configPath.replace(/\.json$/i, '') + '.deployed.json';
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const digest = data => createHash('sha256').update(data).digest('hex');
const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
assert.equal(m.complete, true, 'Deployment is incomplete');
assert.equal(m.chainId, config.chainId);
assert.equal(m.contractVersion, config.contractVersion, 'Manifest version must match its exact archived build');
same(m.deployer, settings.expectedDeployer);
same(m.poolManager, settings.manager);
assert.equal(m.configHash, digest(JSON.stringify({...config, rpcUrl: ''})), 'Configuration changed');
assert.equal(m.maximumDeploymentFeeWei, String(settings.fees.totalBudget));
assert.equal(m.feeMode ?? 'live', settings.feeMode);
assert.ok(Number.isSafeInteger(m.startingNonce) && m.startingNonce >= 0, 'Recorded starting nonce');
assert.ok(m.artifactArchive && m.artifactHashes && Object.keys(m.artifactHashes).length, 'Exact artifact archive is required');
for (const [name, hash] of Object.entries(m.artifactHashes)) {
  assert.equal(digest(fs.readFileSync(path.join(m.artifactArchive, name))), hash, `Archived artifact ${name}`);
}
assert.equal(m.artifactHashes['build-manifest.json'], m.buildHash);
const savedArtifact = name => JSON.parse(fs.readFileSync(path.join(m.artifactArchive, name + '.json'), 'utf8'));
const p = new JsonRpcProvider(config.rpcUrl, undefined, {batchMaxCount: 1});
const bind = (name, address) => new Contract(address, savedArtifact(name).abi, p);
try {
  assert.equal((await p.getNetwork()).chainId, BigInt(config.chainId));
  assert.notEqual(await p.getCode(settings.manager), '0x', 'Official PoolManager code');
  assert.equal((await p.getBlock(m.deploymentBlock)).hash, m.deploymentBlockHash);
  for (const [label, r] of Object.entries(m.records)) {
    assertArtifactRuntime(savedArtifact(r.artifact), await p.getCode(r.address));
    if (!r.reused) assert.equal(m.transactions[label]?.status, 1, label);
    else { const previous = JSON.parse(fs.readFileSync(r.reusedFrom, 'utf8')); const old = previous.records[label]; same(r.address, old.address); assert.equal(r.initHash, old.initHash); assert.equal(r.runtimeHash, old.runtimeHash); }
  }
  let totalFee = 0n;
  let expectedNonce = m.startingNonce;
  for (const [label, t] of Object.entries(m.transactions)) {
    const [receipt, transaction] = await Promise.all([p.getTransactionReceipt(t.hash), p.getTransaction(t.hash)]);
    assert.ok(receipt && transaction, `Missing transaction ${label}`);
    assert.equal(receipt.status, 1, label);
    assert.equal(receipt.blockHash, t.blockHash, label);
    assert.ok(await receipt.confirmations() >= config.confirmations, label);
    assert.equal(transaction.chainId, BigInt(config.chainId), label);
    same(transaction.from, m.deployer);
    assert.equal(transaction.type, 2, label);
    assert.equal(transaction.value, 0n, label);
    assert.equal(transaction.nonce, t.nonce, label);
    assert.equal(transaction.nonce, expectedNonce++, `Non-contiguous deployment nonce: ${label}`);
    assert.equal(transaction.gasLimit, BigInt(t.gasLimit), label);
    const maxFeePerGas = BigInt(t.maxFeePerGasWei), priorityFeePerGas = BigInt(t.maxPriorityFeePerGasWei);
    assert.equal(transaction.maxFeePerGas, maxFeePerGas, label);
    assert.equal(transaction.maxPriorityFeePerGas, priorityFeePerGas, label);
    assert.equal(BigInt(t.feeBudgetWei), transaction.gasLimit * maxFeePerGas, label);
    if (settings.feeMode === 'fixed') {
      assert.equal(maxFeePerGas, settings.fees.maxFeePerGas, label);
      assert.equal(priorityFeePerGas, settings.fees.maxPriorityFeePerGas, label);
    } else {
      assert.ok(t.feeMode === undefined || t.feeMode === 'live', label);
      assert.ok(maxFeePerGas >= priorityFeePerGas && priorityFeePerGas >= 0n, label);
    }
    if (m.records[label]) {
      assert.equal(transaction.to, null, label);
      assert.equal(keccak256(transaction.data), m.records[label].initHash, label);
      same(getCreateAddress({from: transaction.from, nonce: transaction.nonce}), m.records[label].address);
    }
    assert.equal(receipt.fee, BigInt(t.feeWei), label);
    assert.ok(receipt.fee <= BigInt(t.feeBudgetWei), label);
    totalFee += receipt.fee;
  }
  assert.ok(totalFee <= settings.fees.totalBudget, 'Deployment fee budget');
  const timelock = bind('OriginTimelock', m.timelock);
  assert.equal(await timelock.getMinDelay(), BigInt(config.upgradeDelaySeconds));
  assert.equal(await timelock.hasRole(await timelock.PROPOSER_ROLE(), settings.proposer), true);
  assert.equal(await timelock.hasRole(await timelock.CANCELLER_ROLE(), settings.proposer), true);
  assert.equal(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ZeroAddress), true);
  assert.equal(await timelock.hasRole(ZeroHash, m.timelock), true);
  assert.equal(await timelock.hasRole(ZeroHash, m.deployer), false);
  const factory = bind('V4ProjectFactory', m.factory);
  const coordinator = bind('V4MigrationCoordinator', m.coordinator);
  const hook = bind('V4FeeHookLP', m.hook);
  const feePolicy = bind('SwapFeePolicyLP', m.feePolicy);
  const verifier = bind('AllocationVerifier', m.allocationVerifier);
  const router = bind('ProjectSwapRouter', m.swapRouter);
  const distributor = bind('LPRewardDistributor', m.lpDistributor);
  same(await factory.coordinator(), m.coordinator);
  same(await factory.platformTreasury(), settings.platform);
  assert.equal(await factory.CREATION_FEE(), 20_000_000_000_000_000n);
  assert.equal(await factory.CONTRACT_VERSION(), BigInt(m.contractVersion));
  assert.equal(await coordinator.fundraisingPolicyVersion(), 2n);
  same(await coordinator.bootstrapper(), m.deployer);
  same(await coordinator.poolManager(), settings.manager);
  same(await coordinator.factory(), m.factory);
  same(await coordinator.hook(), m.hook);
  same(await coordinator.allocationVerifier(), m.allocationVerifier);
  same(await coordinator.swapRouter(), m.swapRouter);
  same(await coordinator.feeRewardsDeployer(), m.records.projectProxyDeployer.address);
  assert.equal(await coordinator.upgradeServicesConfigured(), true);
  same(await coordinator.migrationFeeAuthority(), m.timelock);
  same(await hook.poolManager(), settings.manager);
  same(await hook.coordinator(), m.coordinator);
  same(await hook.platform(), settings.platform);
  assert.equal(await hook.MAX_EXTRA_SELL_TAX_BPS(), 2500n);
  assert.equal(await hook.LAUNCH_PROTECTION_DURATION(), 600n);
  assert.equal(await hook.FEE_BPS(), 100n);
  same(await hook.feePolicy(), m.feePolicy);
  assert.equal(BigInt(m.hook) & 0x3fffn, 0x20ccn);
  assertArtifactRuntime(savedArtifact('V4FeeHookLP'), await p.getCode(m.hook));
  same(await router.manager(), settings.manager); same(await router.hook(), m.hook);
  same(await feePolicy.upgradeAuthority(), m.timelock);
  same(await feePolicy.implementationAddress(), m.records.feePolicyImplementation.address);
  assert.deepEqual(Array.from(await feePolicy.split(100n, false)), [20n, 40n]);
  assert.deepEqual(Array.from(await feePolicy.split(100n, true)), [0n, 60n]);
  assert.deepEqual(Array.from(await feePolicy.splitWithLP(100n, false)), [20n, 40n, 10n]);
  assert.deepEqual(Array.from(await feePolicy.splitWithLP(100n, true)), [0n, 60n, 10n]);
  same(await distributor.poolManager(), settings.manager); same(await distributor.coordinator(), m.coordinator);
  same(await distributor.hook(), m.hook); same(await hook.lpDistributor(), m.lpDistributor);
  same(await coordinator.lpDistributor(), m.lpDistributor);
  same(await bind('ProjectProxyDeployer', m.records.projectProxyDeployer.address).authority(), m.timelock);
  assert.equal(await verifier.threshold(), BigInt(config.validatorThreshold));
  for (const v of settings.validators) assert.equal(await verifier.isValidator(v), true);
  const quoteTarget = 1_000_000_000_000_000_000n;
  const q = await coordinator.quote(quoteTarget);
  const migrationFeeBps = await coordinator.migrationFeeBps();
  const migrationGasRefundLimit = await coordinator.migrationGasRefundLimit();
  assert.ok(migrationFeeBps >= 0n && migrationFeeBps <= 100n);
  assert.equal(await coordinator.MAX_MIGRATION_GAS_REFUND(), 300_000_000_000_000_000n);
  assert.ok(migrationGasRefundLimit <= 300_000_000_000_000_000n);
  assert.equal(q.ethAmount, quoteTarget / 2n - quoteTarget * migrationFeeBps / 10_000n);
  assert.equal(q.saleSupply + q.tokenAmount + q.lockedTokenRemainder, 95_000_000n * 10n ** 18n);
  same(await coordinator.migrationExecutor(), '0x8330F65fa8DEd47ED944f1981fAe9D9a7633E1d9');
  assert.equal(await coordinator.migrationReimbursementGasUnits(), BigInt(config.migrationReimbursementGasUnits));
  assert.equal(migrationGasRefundLimit, 100_000_000_000_000_000n);
  const deployerAddress = await coordinator.liquidityDeployer();
  assertArtifactRuntime(savedArtifact('PermanentLiquidityDeployer'), await p.getCode(deployerAddress));
  same(deployerAddress, getCreateAddress({from:m.coordinator, nonce:1}));
  const report = {chainId: config.chainId, migrationExecutor:m.migrationExecutor, reimbursementGasUnits:String(await coordinator.migrationReimbursementGasUnits()), feeMode: settings.feeMode, factory: m.factory, timelock: m.timelock, hook: m.hook,
    deploymentVerified: true, runtimeArtifactsVerified: true, permissionsVerified: true,
    feeSplitsVerified: true, migrationQuoteVerified: true, feeBudgetVerified: true,
    projectCount: String(await factory.projectCount()), migrationFeeBps: Number(migrationFeeBps),
    migrationGasRefundLimitWei: String(migrationGasRefundLimit), totalDeploymentFeeETH: formatEther(totalFee),
    remainingBalanceETH: formatEther(await p.getBalance(m.deployer)), verifiedAt: new Date().toISOString()};
  fs.writeFileSync(manifestPath.replace(/\.json$/, '.verified.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(String(error.shortMessage ?? error.message).replaceAll(config.rpcUrl, '[RPC]').replace(/0x[a-fA-F0-9]{64}/g, '[hash-or-key]'));
  process.exitCode = 1;
} finally { p.destroy(); }
