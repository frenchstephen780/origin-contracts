import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, getAddress, keccak256, ZeroAddress} from 'ethers';
import {compiled, assertInitcode, deployUpgradeableSuite} from './upgradeable-suite.mjs';
import {assertArtifactRuntime} from './storage-layout.mjs';

// Intentionally testnet-only. No implicit RPC/key and no mainnet fallback.
const configPath = process.argv[2];
if (!configPath) throw Error('Usage: npm run deploy:testnet -- deployments/sepolia.json [--broadcast]');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.contractVersion !== undefined && config.contractVersion !== 15) throw Error('Configuration must target the current community factory');
if (config.chainId !== 11155111) throw Error('This deployment entry supports Ethereum Sepolia (11155111) only');
const broadcast = process.argv.includes('--broadcast');
if (!config.rpcUrl) throw Error('Fill rpcUrl in the deployment configuration');
const address = (value, label) => {
  const a = getAddress(value);
  if (a === ZeroAddress) throw Error(`${label} cannot be zero`);
  return a;
};
const manager = address(config.poolManager, 'poolManager');
if (manager.toLowerCase() !== '0xe03a1074c86cfedd5c142c4f04f1a1536e203543') throw Error('PoolManager differs from the official Sepolia deployment');
const platform = address(config.platformTreasury, 'platformTreasury');
const proposer = address(config.upgradeProposer, 'upgradeProposer');
const validators = config.validators.map(v => address(v, 'validator'));
if (!validators.length || validators.length > 16 || new Set(validators).size !== validators.length ||
    !Number.isInteger(config.validatorThreshold) || config.validatorThreshold < 1 || config.validatorThreshold > validators.length) throw Error('Invalid validator quorum');
if (!Number.isSafeInteger(config.upgradeDelaySeconds) || config.upgradeDelaySeconds < 172800 ||
    !Number.isSafeInteger(config.confirmations) || config.confirmations < 1) throw Error('Invalid delay/confirmations');
const provider = new JsonRpcProvider(config.rpcUrl, undefined, {batchMaxCount: 1});
try {
  if ((await provider.getNetwork()).chainId !== 11155111n) throw Error('RPC chain ID mismatch');
  if ((await provider.getCode(manager)) === '0x') throw Error('PoolManager has no code at this RPC');
  const build = fs.readFileSync(new URL('../artifacts/build-manifest.json', import.meta.url));
  const buildHash = createHash('sha256').update(build).digest('hex');
  console.log(`Preflight OK: Ethereum Sepolia; build ${buildHash}; minimum delay ${config.upgradeDelaySeconds}s`);
  if (!broadcast) {
    console.log('Preflight only. Add --broadcast to execute the deployment workflow with DEPLOYER_PRIVATE_KEY.');
    process.exitCode = 0;
  } else {
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw Error('Set DEPLOYER_PRIVATE_KEY in the shell; do not put it in JSON or source');
    let wallet;
    try { wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider); }
    catch { throw Error('DEPLOYER_PRIVATE_KEY is invalid; its value has not been logged'); }
    const signer = new NonceManager(wallet);
    let reuse, sharedDeployers;
    if (config.reuseDeployment) {
      reuse = JSON.parse(fs.readFileSync(path.resolve(path.dirname(configPath), config.reuseDeployment), 'utf8'));
      if (!reuse.complete || reuse.contractVersion !== 15 || reuse.chainId !== config.chainId || reuse.deployer !== wallet.address) throw Error('Invalid current-suite deployment to reuse');
      const oldCoordinator = new Contract(reuse.coordinator, compiled('V4MigrationCoordinator').abi, provider);
      if (await new Contract(reuse.factory, compiled('V4ProjectFactory').abi, provider).projectCount() !== 0n) throw Error('Do not replace a factory with active projects using this bootstrap workflow');
      sharedDeployers = {tokens: await oldCoordinator.tokenDeployer(), rewards: await oldCoordinator.upgradeProtocolAddresses(7)};
      assertArtifactRuntime(compiled('ProjectTokenDeployer'), await provider.getCode(sharedDeployers.tokens));
      assertArtifactRuntime(compiled('FeeRewardsDeployer'), await provider.getCode(sharedDeployers.rewards));
    }
    const outputPath = path.resolve(configPath.replace(/\.json$/i, '') + '.deployed.json');
    const configHash = createHash('sha256').update(JSON.stringify({...config, rpcUrl: ''})).digest('hex');
    const manifest = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) :
      {chainId: config.chainId, network: config.network, deployer: wallet.address, buildHash, configHash, records: {}, transactions: {}};
    if (manifest.buildHash !== buildHash || manifest.configHash !== configHash || manifest.deployer !== wallet.address) throw Error('Cannot resume with a different build, configuration or deployer');
    const save = () => {
      fs.writeFileSync(outputPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
      fs.renameSync(outputPath + '.tmp', outputPath);
    };
    async function confirmed(label, tx) {
      const map = manifest.transactions;
      if (tx) { map[label] = {hash: tx.hash}; save(); }
      const receipt = await provider.waitForTransaction(map[label].hash, config.confirmations, 300000);
      if (!receipt || receipt.status !== 1) throw Error(`Transaction ${label} failed or unconfirmed; inspect manifest before retry`);
      map[label].blockNumber = receipt.blockNumber; map[label].blockHash = receipt.blockHash;
      map[label].gasUsed = String(receipt.gasUsed); map[label].gasPrice = String(receipt.gasPrice);
      map[label].feeWei = String(receipt.fee); save();
      return receipt;
    }
    async function deploy(label, name, args = []) {
      const a = compiled(name), f = new ContractFactory(a.abi, a.bytecode, signer);
      const init = (await f.getDeployTransaction(...args)).data; assertInitcode(init);
      let record = manifest.records[label];
      const reusable = new Set(['timelock','governanceImplementation','rewardsImplementation','feePolicyImplementation','feePolicy','governanceDeployer','rewardsDeployer','allocationVerifier','hookDeployer']);
      if (!record && reuse && reusable.has(label)) {
        const previous = reuse.records[label];
        if (!previous || previous.artifact !== name || previous.initHash !== keccak256(init)) throw Error(`Reused constructor/artifact mismatch: ${label}`);
        assertArtifactRuntime(a, await provider.getCode(previous.address));
        record = manifest.records[label] = {...previous, reused: true, reusedFrom: config.reuseDeployment}; save();
      }
      if (record && (record.initHash !== keccak256(init) || record.artifact !== name)) throw Error(`Resume mismatch: ${label}`);
      if (!record) {
        const c = await f.deploy(...args);
        record = manifest.records[label] = {address: c.target, artifact: name, initHash: keccak256(init), storageLayout: a.storageLayout};
        manifest.transactions[label] = {hash: c.deploymentTransaction().hash}; save();
      }
      if (!record.reused) await confirmed(label);
      const code = await provider.getCode(record.address);
      if (code === '0x' || (record.runtimeHash && record.runtimeHash !== keccak256(code))) throw Error(`Missing/mismatched deployed code: ${label}`);
      record.runtimeHash = keccak256(code); save(); console.log(`${label}: ${record.address}`);
      return new Contract(record.address, a.abi, signer);
    }
    async function configure(label, send, done) {
      if (manifest.transactions[label]) await confirmed(label);
      if (!await done()) await confirmed(label, await send());
      if (!await done()) throw Error(`Configuration not applied: ${label}`);
    }
    const suite = await deployUpgradeableSuite({signer, manager, platform, proposer, validators,
      threshold: config.validatorThreshold, delay: config.upgradeDelaySeconds, deploy, configure, sharedDeployers,
      lpRewards: true, fundraisingPolicyVersion: 2});
    const block = await provider.getBlock(manifest.transactions.activate.blockNumber);
    Object.assign(manifest, {factory: suite.factory.target, coordinator: suite.coordinator.target,
      poolManager: manager, hook: suite.hook.target, swapRouter: suite.router.target,
      allocationVerifier: suite.verifier.target, dividends: ZeroAddress, timelock: suite.timelock.target,
      feePolicy: suite.feePolicy.target, lpDistributor: suite.lpDistributor?.target, contractVersion: Number(await suite.factory.CONTRACT_VERSION()),
      migrationFeeBps: Number(await suite.coordinator.migrationFeeBps()), migrationFeeAuthority: await suite.coordinator.migrationFeeAuthority(),
      migrationGasRefundLimitWei: String(await suite.coordinator.migrationGasRefundLimit()),
      maximumMigrationGasRefundWei: String(await suite.coordinator.MAX_MIGRATION_GAS_REFUND()),
      deploymentBlock: block.number, deploymentBlockHash: block.hash, complete: true});
    // Preserve exact ABI/bytecode/layout baselines for future upgrade reviews.
    const archive = outputPath.replace(/\.json$/i, '') + '.build';
    fs.mkdirSync(archive, {recursive: true});
    for (const entry of fs.readdirSync(new URL('../artifacts/', import.meta.url))) {
      if (entry.endsWith('.json')) fs.copyFileSync(new URL(`../artifacts/${entry}`, import.meta.url), path.join(archive, entry));
    }
    manifest.artifactArchive = archive;
    save(); console.log(`Deployment complete: ${outputPath}`);
  }
} finally { provider.destroy(); }
