import fs from 'node:fs';
import {Contract, ContractFactory, getCreate2Address, keccak256, toBeHex, ZeroAddress} from 'ethers';
import {assertArtifactRuntime} from './storage-layout.mjs';

export function compiled(name) {
  return JSON.parse(fs.readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), 'utf8'));
}

export function assertInitcode(data) {
  if ((data.length - 2) / 2 > 49152) throw Error('EIP-3860: deployment initcode including arguments exceeds 49152 bytes');
}

export async function mineHook(deployer, initcode) {
  assertInitcode(initcode);
  const hash = keccak256(initcode);
  for (let i = 0n; i < 1_000_000n; ++i) {
    const salt = toBeHex(i, 32);
    const address = getCreate2Address(deployer, salt, hash);
    if ((BigInt(address) & 0x3fffn) === 0x20ccn) return {salt, address};
  }
  throw Error('Hook salt search exhausted; choose another deployer');
}

/// One workflow, multiple bounded contracts. Also used by isolated EVM tests.
/// deploy() and configure() can journal each transaction for safe resumption.
export async function deployUpgradeableSuite({signer, manager, platform, proposer, validators, threshold = 1,
  delay = 172800, deploy, sharedDeployers, lpRewards = true, factoryArtifact, fundraisingPolicyVersion = 1,
  configure = async (_label, send) => (await send()).wait()}) {
  if (![1, 2].includes(fundraisingPolicyVersion) || (fundraisingPolicyVersion === 2 && !lpRewards)) throw Error('Unsupported fundraising suite');
  factoryArtifact ??= fundraisingPolicyVersion === 2 ? 'CommunityV4ProjectFactory' : lpRewards ? 'LPV4ProjectFactory' : 'RefundableV4ProjectFactory';
  if (sharedDeployers?.tokens) {
    // Reuse requires matching deployment bytecode, not just a matching ABI.
    assertArtifactRuntime(compiled('ProjectTokenDeployer'), await signer.provider.getCode(sharedDeployers.tokens));
  }
  const bind = (name, address) => new Contract(address, compiled(name).abi, signer);
  deploy ??= async (_label, name, args = []) => {
    const a = compiled(name), f = new ContractFactory(a.abi, a.bytecode, signer);
    assertInitcode((await f.getDeployTransaction(...args)).data);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const timelock = await deploy('timelock', 'OriginTimelock', [delay, [proposer], [ZeroAddress]]);
  const governanceImplementation = await deploy('governanceImplementation', 'UpgradeableCommunityGovernance');
  const rewardsImplementation = await deploy('rewardsImplementation', 'UpgradeableProjectRewards');
  const operatingImplementation = lpRewards ? await deploy('operatingImplementation', 'OperatingRewardsLP') : null;
  const feePolicyImplementation = await deploy('feePolicyImplementation', lpRewards ? 'SwapFeePolicyLP' : 'SwapFeePolicy');
  const init = feePolicyImplementation.interface.encodeFunctionData('initialize', [timelock.target]);
  const feePolicyProxy = await deploy('feePolicy', 'OriginProxy', [feePolicyImplementation.target, init]);
  const feePolicy = bind(lpRewards ? 'SwapFeePolicyLP' : 'SwapFeePolicy', feePolicyProxy.target);
  const governanceDeployer = await deploy('projectProxyDeployer', 'ProjectProxyDeployer',
    [governanceImplementation.target,rewardsImplementation.target,operatingImplementation?.target ?? rewardsImplementation.target,timelock.target]);
  const rewardsDeployer = governanceDeployer;
  const verifier = await deploy('allocationVerifier', 'AllocationVerifier', [validators, threshold]);
  // Do not deploy an unused rewards factory inside a coordinator constructor.
  const tokenDeployer = sharedDeployers ? null : await deploy('tokenDeployer','ProjectTokenDeployer');
  const coordinator = await deploy('coordinator', fundraisingPolicyVersion === 2 ? 'CommunityV4MigrationCoordinator' : 'SharedV4MigrationCoordinator',
    [manager, governanceDeployer.target, rewardsDeployer.target, sharedDeployers?.tokens ?? tokenDeployer.target]);
  const factory = await deploy('factory', factoryArtifact, [platform, coordinator.target]);
  const lpDistributor = lpRewards ? await deploy('lpDistributor', 'LPRewardDistributor', [manager, coordinator.target]) : null;
  const hookDeployer = await deploy('hookDeployer', lpRewards ? 'LPHookDeployer' : 'HookDeployer');
  const hookArtifact = compiled(lpRewards ? 'V4FeeHookLP' : 'V4FeeHook');
  const hookArgs = [manager, coordinator.target, platform, ...(lpRewards ? [lpDistributor.target] : [])];
  const hookInit = await new ContractFactory(hookArtifact.abi, hookArtifact.bytecode, signer)
    .getDeployTransaction(...hookArgs);
  const {salt, address} = await mineHook(hookDeployer.target, hookInit.data);
  await configure('hook', () => hookDeployer.deploy(salt, ...hookArgs),
    async () => (await signer.provider.getCode(address)) !== '0x');
  const hook = bind(lpRewards ? 'V4FeeHookLP' : 'V4FeeHook', address);
  if (lpRewards) await configure('lpServices', () => coordinator.configureLPServices(lpDistributor.target, hook.target),
    async () => (await coordinator.lpDistributor()).toLowerCase() === lpDistributor.target.toLowerCase());
  const router = await deploy('swapRouter', 'ProjectSwapRouter', [manager, hook.target]);
  await configure('services', () => coordinator.configureServices(ZeroAddress, verifier.target, router.target),
    async () => (await coordinator.allocationVerifier()).toLowerCase() === verifier.target.toLowerCase());
  await configure('upgradeServices', () => coordinator.configureUpgradeServices(rewardsDeployer.target, hook.target, feePolicy.target),
    () => coordinator.upgradeServicesConfigured());
  await configure('activate', () => coordinator.configure(factory.target, hook.target),
    async () => (await coordinator.factory()).toLowerCase() === factory.target.toLowerCase());
  if ((await hook.feePolicy()).toLowerCase() !== feePolicy.target.toLowerCase() ||
      (await coordinator.feeRewardsDeployer()).toLowerCase() !== rewardsDeployer.target.toLowerCase() ||
      (await coordinator.swapRouter()).toLowerCase() !== router.target.toLowerCase() ||
      (await coordinator.hook()).toLowerCase() !== hook.target.toLowerCase() ||
      (await coordinator.migrationFeeAuthority()).toLowerCase() !== timelock.target.toLowerCase() ||
      await coordinator.migrationFeeBps() > 100n ||
      await coordinator.migrationGasRefundLimit() > 300_000_000_000_000_000n ||
      (await feePolicy.upgradeAuthority()).toLowerCase() !== timelock.target.toLowerCase()) throw Error('Suite wiring mismatch');
  return {timelock, governanceImplementation, rewardsImplementation, operatingImplementation, lpDistributor, feePolicyImplementation, feePolicy,
    governanceDeployer, rewardsDeployer, tokenDeployer, verifier, coordinator, factory, hookDeployer, hook, router, salt};
}
