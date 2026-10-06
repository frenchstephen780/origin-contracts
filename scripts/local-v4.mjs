import { Contract, ContractFactory, getCreate2Address, keccak256, toBeHex, ZeroAddress, parseEther } from "ethers";
import { artifact } from "./local-chain.mjs";
import {estimateAndMigrate} from './migration-gas.mjs';

const salts = new Map();
export async function deployV4Fixture(chain, { configure = true, governanceDeployerName = "GovernanceDeployer", withProject = true } = {}) {
  const [platform] = chain.signers;
  const manager = await chain.deploy("PoolManager", [platform.address]);
  const governanceDeployer = await chain.deploy(governanceDeployerName);
  const rewardsDeployer = await chain.deploy("FeeRewardsDeployer");
  const tokenDeployer = await chain.deploy("ProjectTokenDeployer");
  const coordinator = await chain.deploy("V4MigrationCoordinator", [manager.target, governanceDeployer.target,rewardsDeployer.target,tokenDeployer.target]);
  const factory = await chain.deploy("V4ProjectFactory", [platform.address, coordinator.target]);
  const hookDeployer = await chain.deploy("HookDeployer");
  const hookArtifact = artifact("V4FeeHook");
  const init = await new ContractFactory(hookArtifact.abi, hookArtifact.bytecode, platform)
    .getDeployTransaction(manager.target, coordinator.target, platform.address);
  const hash = keccak256(init.data);
  const cacheKey = `${hookDeployer.target}:${hash}`;
  let salt = salts.get(cacheKey);
  if (!salt) {
    for (let i = 0n; ; ++i) {
      const candidate = toBeHex(i, 32);
      const address = getCreate2Address(hookDeployer.target, candidate, hash);
      if ((BigInt(address) & 0x3fffn) === 0x20ccn) { salt = candidate; break; }
    }
    salts.set(cacheKey, salt);
  }
  const hookAddress = getCreate2Address(hookDeployer.target, salt, hash);
  await (await hookDeployer.deploy(salt, manager.target, coordinator.target, platform.address)).wait();
  const hook = new Contract(hookAddress, hookArtifact.abi, platform);
  if (configure) await (await coordinator.configure(factory.target, hook.target)).wait();
  if (!withProject) return { manager, governanceDeployer, coordinator, factory, hookDeployer, hook, salt };
  const router = await chain.deploy("V4TestRouter", [manager.target]);
  const project = await chain.createProject(factory);
  const token = new Contract(await project.token(), artifact("ProjectToken").abi, platform);
  const key = [ZeroAddress, token.target, 3000, 60, hook.target];
  return { manager, governanceDeployer, coordinator, factory, hookDeployer, hook, router, project, token, key, salt };
}

export async function fundAndLaunch(chain, f) {
  for (const [index, amount] of [[2, "28.5"], [3, "14.25"], [4, "14.25"]]) {
    await (await f.project.connect(chain.signers[index]).contribute(0, {
      value: parseEther(amount), gasLimit: 600_000,
    })).wait();
  }
  await (await estimateAndMigrate(f.project)).wait();
  if (await f.project.state() !== 3n) throw new Error("Migration did not complete");
  f.gov = new Contract(await f.project.governance(), artifact("ProjectGovernance").abi, chain.signers[0]);
  f.locker = new Contract(await f.project.liquidityLocker(), artifact("PermanentLiquidityLocker").abi, chain.signers[0]);
  f.devVault = new Contract(await f.gov.devVault(), artifact("ProjectVault").abi, chain.signers[0]);
  f.insurance = new Contract(await f.gov.insuranceVault(), artifact("ProjectVault").abi, chain.signers[0]);
  f.poolId = await f.project.poolId();
  return f;
}

export async function swap(f, signer, zeroForOne, amountSpecified, { value = 0n, priceLimit } = {}) {
  priceLimit ??= zeroForOne ? 4295128740n : 1461446703485210103287273052203988822378723970341n;
  const receipt = await (await f.router.connect(signer).swap(f.key, [zeroForOne, amountSpecified, priceLimit], {
    value, gasLimit: 2_000_000,
  })).wait();
  const event = receipt.logs.map(log => { try { return f.router.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === "Delta");
  return { receipt, ethDelta: event.args.ethDelta, tokenDelta: event.args.tokenDelta };
}
