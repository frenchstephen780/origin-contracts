import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {JsonRpcProvider, Contract, ZeroAddress, ZeroHash, formatEther} from 'ethers';
import {compiled} from './upgradeable-suite.mjs';
import {assertArtifactRuntime} from './storage-layout.mjs';

// Read-only verification. Never loads a deployment private key or sends a transaction.
const configPath = process.argv[2] || 'deployments/sepolia.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const manifestPath = configPath.replace(/\.json$/i, '') + '.deployed.json';
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const savedArtifact = name => m.artifactArchive && fs.existsSync(path.join(m.artifactArchive, name+'.json'))
  ? JSON.parse(fs.readFileSync(path.join(m.artifactArchive,name+'.json'),'utf8')) : compiled(name);
assert.equal(m.complete, true, 'Deployment is incomplete');
assert.equal(config.chainId, 11155111);
assert.ok([15, 16].includes(m.contractVersion), 'Use a supported manifest and its exact archived build');
const p = new JsonRpcProvider(config.rpcUrl, undefined, {batchMaxCount: 1});
const bind = (name, address) => new Contract(address, savedArtifact(name).abi, p);
const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
try {
  assert.equal((await p.getNetwork()).chainId, 11155111n);
  assert.equal((await p.getBlock(m.deploymentBlock)).hash, m.deploymentBlockHash);
  for (const [label, r] of Object.entries(m.records)) {
    assertArtifactRuntime(savedArtifact(r.artifact), await p.getCode(r.address));
    if (!r.reused) {
      const receipt = await p.getTransactionReceipt(m.transactions[label].hash);
      assert.equal(receipt.status, 1, label);
    }
  }
  for (const [label, t] of Object.entries(m.transactions)) {
    const receipt = await p.getTransactionReceipt(t.hash);
    assert.equal(receipt.status, 1, label);
    assert.equal(receipt.blockHash, t.blockHash, label);
  }
  const timelock = bind('OriginTimelock', m.timelock);
  assert.equal(await timelock.getMinDelay(), BigInt(config.upgradeDelaySeconds));
  assert.equal(await timelock.hasRole(await timelock.PROPOSER_ROLE(), config.upgradeProposer), true);
  assert.equal(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ZeroAddress), true);
  assert.equal(await timelock.hasRole(ZeroHash, m.timelock), true);
  assert.equal(await timelock.hasRole(ZeroHash, m.deployer), false);
  const factory = bind('V4ProjectFactory', m.factory);
  const coordinator = bind('V4MigrationCoordinator', m.coordinator);
  assert.equal(await coordinator.fundraisingPolicyVersion(), 2n);
  assert.ok(m.lpDistributor, 'Current suite requires LP services');
  const lpEnabled = true;
  const hook = bind(lpEnabled ? 'V4FeeHookLP' : 'V4FeeHook', m.hook);
  const feePolicy = bind(lpEnabled ? 'SwapFeePolicyLP' : 'SwapFeePolicy', m.feePolicy);
  const verifier = bind('AllocationVerifier', m.allocationVerifier);
  const router = bind('ProjectSwapRouter', m.swapRouter);
  same(await factory.coordinator(), m.coordinator);
  same(await factory.platformTreasury(), config.platformTreasury);
  assert.equal(await factory.CREATION_FEE(), 20_000_000_000_000_000n);
  assert.equal(await factory.CONTRACT_VERSION(), BigInt(m.contractVersion));
  same(await coordinator.factory(), m.factory);
  same(await coordinator.hook(), m.hook);
  same(await coordinator.allocationVerifier(), m.allocationVerifier);
  same(await coordinator.swapRouter(), m.swapRouter);
  same(await coordinator.feeRewardsDeployer(), (m.records.projectProxyDeployer ?? m.records.rewardsDeployer).address);
  assert.equal(await coordinator.upgradeServicesConfigured(), true);
  same(await coordinator.migrationFeeAuthority(), m.timelock);
  same(await hook.poolManager(), m.poolManager);
  same(await hook.coordinator(), m.coordinator);
  same(await hook.platform(), config.platformTreasury);
  {
    assert.equal(await hook.MAX_EXTRA_SELL_TAX_BPS(), 2500n);
    assert.equal(await hook.LAUNCH_PROTECTION_DURATION(), 600n);
    assert.equal(await hook.FEE_BPS(), 100n);
  }
  same(await hook.feePolicy(), m.feePolicy);
  assert.equal(BigInt(m.hook) & 0x3fffn, 0x20ccn);
  assertArtifactRuntime(savedArtifact(lpEnabled ? 'V4FeeHookLP' : 'V4FeeHook'), await p.getCode(m.hook));
  same(await router.manager(), m.poolManager); same(await router.hook(), m.hook);
  same(await feePolicy.upgradeAuthority(), m.timelock);
  same(await feePolicy.implementationAddress(), m.records.feePolicyImplementation.address);
  assert.deepEqual(Array.from(await feePolicy.split(100n, false)), lpEnabled ? [20n, 40n] : [40n, 30n]);
  assert.deepEqual(Array.from(await feePolicy.split(100n, true)), lpEnabled ? [0n, 60n] : [0n, 70n]);
  if(lpEnabled){
    assert.deepEqual(Array.from(await feePolicy.splitWithLP(100n,false)),[20n,40n,10n]);
    assert.deepEqual(Array.from(await feePolicy.splitWithLP(100n,true)),[0n,60n,10n]);
    const d=bind('LPRewardDistributor',m.lpDistributor);
    same(await d.poolManager(),m.poolManager);same(await d.coordinator(),m.coordinator);same(await d.hook(),m.hook);
    same(await hook.lpDistributor(),m.lpDistributor);same(await coordinator.lpDistributor(),m.lpDistributor);
  }
  for (const [label, name] of [['projectProxyDeployer','ProjectProxyDeployer']]) {
    const d = bind(name, m.records[label].address);
    same(await d.authority(), m.timelock);
  }
  assert.equal(await verifier.threshold(), BigInt(config.validatorThreshold));
  for (const v of config.validators) assert.equal(await verifier.isValidator(v), true);
  // Verify the minimum funding target against the current policy.
  const quoteTarget = 1_000_000_000_000_000_000n;
  const q = await coordinator.quote(quoteTarget);
  const migrationFeeBps = await coordinator.migrationFeeBps();
  assert.ok(migrationFeeBps >= 0n && migrationFeeBps <= 100n);
  let migrationGasRefundLimit = null;
  {
    assert.equal(await coordinator.MAX_MIGRATION_GAS_REFUND(), 300_000_000_000_000_000n);
    migrationGasRefundLimit = await coordinator.migrationGasRefundLimit();
    assert.ok(migrationGasRefundLimit <= 300_000_000_000_000_000n);
  }
  assert.equal(q.ethAmount, quoteTarget / 2n - quoteTarget * migrationFeeBps / 10_000n);
  assert.equal(q.saleSupply + q.tokenAmount + q.lockedTokenRemainder, 95_000_000n * 10n**18n);
  const fee = Object.values(m.transactions).reduce((n,t)=>n+BigInt(t.feeWei),0n);
  const report = {chainId:11155111, factory:m.factory, timelock:m.timelock, hook:m.hook,
    deploymentVerified:true, runtimeArtifactsVerified:true, permissionsVerified:true, feeSplitsVerified:true,
    migrationQuoteVerified:true, projectCount:String(await factory.projectCount()),
    migrationFeeBps:Number(migrationFeeBps),
    migrationGasRefundLimitWei:migrationGasRefundLimit === null ? null : String(migrationGasRefundLimit),
    totalDeploymentFeeETH:formatEther(fee), remainingBalanceETH:formatEther(await p.getBalance(m.deployer)),
    verifiedAt:new Date().toISOString()};
  fs.writeFileSync(manifestPath.replace(/\.json$/, '.verified.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {p.destroy();}
