import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Contract, ContractFactory, FetchRequest, JsonRpcProvider, Wallet, ZeroAddress,
  getAddress, getCreateAddress, keccak256, formatEther} from 'ethers';
import {compiled, assertInitcode, deployUpgradeableSuite} from './upgradeable-suite.mjs';
import {assertArtifactRuntime} from './storage-layout.mjs';
import {liveFeeLimits, budgetUsed} from './mainnet-config.mjs';

// Replaces only coordinator-bound services. Existing projects and shared custody
// implementations remain at their original addresses. No funds are transferred.
const configPath = path.resolve(process.argv[2] ?? '');
const broadcast = process.argv[3] === '--broadcast';
if (!process.argv[2] || process.argv.length > 4 || (process.argv[3] && !broadcast))
  throw Error('Usage: node scripts/deploy-migration-update.mjs CONFIG.json [--broadcast]');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const executor = getAddress('0x8330F65fa8DEd47ED944f1981fAe9D9a7633E1d9');
if (![1, 11155111].includes(config.chainId) || config.contractVersion !== 16)
  throw Error('Migration update requires a v16 Ethereum or Sepolia configuration');
if (getAddress(config.expectedDeployer) !== executor) throw Error('Deployment signer must match the migration executor');
const manager = getAddress(config.poolManager);
const officialManager = config.chainId === 1 ? '0x000000000004444c5dc75cb358380d2e3de08a90' : '0xe03a1074c86cfedd5c142c4f04f1a1536e203543';
if (manager !== getAddress(officialManager)) throw Error('PoolManager is not the official deployment for this chain');
const units = BigInt(config.migrationReimbursementGasUnits);
const totalBudget = BigInt(config.maximumDeploymentFeeWei);
if (units < 21000n || units > 4294967295n || totalBudget <= 0n || !Number.isSafeInteger(config.confirmations) || config.confirmations < 1)
  throw Error('Invalid migration policy, deployment budget or confirmations');
if (getAddress(config.platformTreasury) === ZeroAddress || getAddress(config.upgradeProposer) === ZeroAddress ||
    !Array.isArray(config.validators) || config.validators.length < 1 || config.validators.length > 16 ||
    config.validators.some(v => getAddress(v) === ZeroAddress) || new Set(config.validators.map(getAddress)).size !== config.validators.length ||
    !Number.isInteger(config.validatorThreshold) || config.validatorThreshold < 1 || config.validatorThreshold > config.validators.length ||
    !Number.isSafeInteger(config.upgradeDelaySeconds) || config.upgradeDelaySeconds < 172800)
  throw Error('Invalid treasury, upgrade authority, validator quorum or delay');
const previousPath = path.resolve(path.dirname(configPath), config.reuseDeployment);
const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
if (previous.chainId !== config.chainId || !previous.complete || !previous.records || !previous.artifactArchive)
  throw Error('Reuse baseline must be a complete same-chain deployment with archived artifacts');
const sharedLabels = new Set(['timelock', 'governanceImplementation', 'rewardsImplementation',
  'operatingImplementation', 'feePolicyImplementation', 'feePolicy', 'projectProxyDeployer',
  'allocationVerifier', 'tokenDeployer', 'hookDeployer']);
const artifactDir = new URL('../artifacts/', import.meta.url);
const files = fs.readdirSync(artifactDir).filter(n => n.endsWith('.json')).sort();
const digest = data => createHash('sha256').update(data).digest('hex');
const artifactHashes = Object.fromEntries(files.map(n => [n, digest(fs.readFileSync(new URL(n, artifactDir)))]));
const buildHash = artifactHashes['build-manifest.json'];
if (!buildHash) throw Error('Compile before deploying');
const configHash = digest(JSON.stringify({...config, rpcUrl: ''}));
const output = configPath.replace(/\.json$/i, '') + '.deployed.json';
const archive = output.replace(/\.json$/i, '') + '.build';
const lockPath = output + '.lock';
const request = new FetchRequest(config.rpcUrl);
request.setThrottleParams({maxAttempts: 1}); request.retryFunc = async () => false;
const provider = new JsonRpcProvider(request, undefined, {batchMaxCount: 1});
const estimationURL = process.env.ESTIMATION_RPC_URL ?? config.rpcUrl;
const estimationRequest = new FetchRequest(estimationURL);
estimationRequest.setThrottleParams({maxAttempts: 1}); estimationRequest.retryFunc = async () => false;
const estimationProvider = estimationURL === config.rpcUrl ? provider
  : new JsonRpcProvider(estimationRequest, undefined, {batchMaxCount: 1});
let manifest, activeLabel, activeDeployment, lock;
const save = () => {
  const fd = fs.openSync(output + '.tmp', 'w');
  try { fs.writeFileSync(fd, JSON.stringify(manifest, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(output + '.tmp', output);
};
async function confirm(label) {
  const t = manifest.transactions[label];
  if (!t?.hash) throw Error(`Missing journaled transaction: ${label}`);
  const receipt = await provider.waitForTransaction(t.hash, config.confirmations, config.receiptTimeoutMs ?? 180000);
  if (!receipt) throw Error(`Unconfirmed transaction ${label}; inspect the same hash before resuming`);
  Object.assign(t, {blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    gasUsed: String(receipt.gasUsed), gasPrice: String(receipt.gasPrice), feeWei: String(receipt.fee),
    status: receipt.status, state: receipt.status === 1 ? 'confirmed' : 'failed'});
  save();
  if (receipt.status !== 1 || receipt.fee > BigInt(t.feeBudgetWei) || budgetUsed(manifest) > totalBudget)
    throw Error(`Transaction failed or deployment budget exceeded: ${label}`);
  return receipt;
}
class JournalWallet extends Wallet {
  async sendTransaction(tx) {
    if (!activeLabel || manifest.transactions[activeLabel]) throw Error('Never resend an existing or unlabelled transaction');
    for (const [file, hash] of Object.entries(artifactHashes))
      if (digest(fs.readFileSync(new URL(file, artifactDir))) !== hash) throw Error('Build changed during deployment');
    const [latest, pending, block, feeData, balance] = await Promise.all([
      provider.getTransactionCount(this.address, 'latest'), provider.getTransactionCount(this.address, 'pending'),
      provider.getBlock('latest'), provider.getFeeData(), provider.getBalance(this.address)]);
    if (latest !== pending || latest !== manifest.startingNonce + Object.keys(manifest.transactions).length)
      throw Error('Signer nonce changed or a transaction is pending; inspect before resuming');
    const fee = liveFeeLimits(feeData, block.baseFeePerGas);
    // Upgraded networks may account creation state gas outside the execution
    // reservoir. Give eth_estimateGas the block budget instead of an RPC's
    // legacy default transaction cap; use its result for the actual request.
    const estimatedGas = await estimationProvider.estimateGas({...tx, from: this.address,
      gasLimit: block.gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas});
    const populated = await this.populateTransaction({...tx, nonce: latest, chainId: config.chainId, type: 2,
      gasLimit: estimatedGas, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas});
    if (BigInt(populated.value ?? 0n) !== 0n) throw Error('Deployment update must not transfer ETH principal');
    populated.gasLimit = (BigInt(populated.gasLimit) * 120n + 99n) / 100n;
    if (populated.gasLimit > block.gasLimit) throw Error('Estimated gas exceeds the block budget');
    const reserve = populated.gasLimit * fee.maxFeePerGas;
    if (budgetUsed(manifest) + reserve > totalBudget || balance < reserve)
      throw Error('Insufficient deployment fee budget or wallet balance');
    const raw = await this.signTransaction(populated), hash = keccak256(raw);
    manifest.transactions[activeLabel] = {hash, nonce: latest, gasLimit: String(populated.gasLimit),
      maxFeePerGasWei: String(fee.maxFeePerGas), maxPriorityFeePerGasWei: String(fee.maxPriorityFeePerGas),
      feeBudgetWei: String(reserve), state: 'prepared'};
    if (activeDeployment) manifest.records[activeLabel] = {...activeDeployment,
      address: getCreateAddress({from: this.address, nonce: latest})};
    save();
    try {
      const response = await provider.broadcastTransaction(raw);
      if (response.hash !== hash) throw Error('RPC transaction hash mismatch');
      manifest.transactions[activeLabel].state = 'broadcast'; save(); return response;
    } catch {
      manifest.transactions[activeLabel].state = 'broadcast_unknown'; save();
      throw Error(`Unknown broadcast result for ${activeLabel}; no automatic resend`);
    }
  }
}
try {
  if (Number((await provider.getNetwork()).chainId) !== config.chainId) throw Error('RPC chain mismatch');
  if (Number((await estimationProvider.getNetwork()).chainId) !== config.chainId) throw Error('Estimation RPC chain mismatch');
  for (const label of sharedLabels) {
    const record = previous.records[label];
    if (!record) throw Error(`Missing shared component: ${label}`);
    assertArtifactRuntime(compiled(record.artifact), await provider.getCode(record.address));
  }
  const [balance, block, data] = await Promise.all([provider.getBalance(executor), provider.getBlock('latest'), provider.getFeeData()]);
  console.log(JSON.stringify({preflightOnly: !broadcast, chainId: config.chainId, executor,
    reusedComponents: sharedLabels.size, newTopLevelContracts: 5, newInternalContracts: 1,
    reimbursementGasUnits: String(units), balanceETH: formatEther(balance), maximumFeeETH: formatEther(totalBudget),
    baseFeeWei: String(block.baseFeePerGas ?? 0n), feeSource: liveFeeLimits(data, block.baseFeePerGas).feeSource}));
  if (broadcast) {
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw Error('DEPLOYER_PRIVATE_KEY is required and must not be stored in configuration');
    const signer = new JournalWallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    if (signer.address !== executor) throw Error('Signing key does not match the fixed executor');
    lock = fs.openSync(lockPath, 'wx'); fs.writeFileSync(lock, JSON.stringify({pid: process.pid}) + '\n');
    const existed = fs.existsSync(output);
    const [latest, pending] = await Promise.all([provider.getTransactionCount(executor, 'latest'), provider.getTransactionCount(executor, 'pending')]);
    if (!existed && latest !== pending) throw Error('Existing pending transaction prevents a new deployment');
    manifest = existed ? JSON.parse(fs.readFileSync(output, 'utf8')) : {chainId: config.chainId, network: config.network,
      contractVersion: 16, deployer: executor, buildHash, configHash, artifactHashes, artifactArchive: archive,
      startingNonce: latest, maximumDeploymentFeeWei: String(totalBudget), records: {}, transactions: {}, complete: false};
    if (manifest.buildHash !== buildHash || manifest.configHash !== configHash || manifest.deployer !== executor ||
        JSON.stringify(manifest.artifactHashes) !== JSON.stringify(artifactHashes)) throw Error('Cannot resume a changed build or configuration');
    if (!existed) {
      if (fs.existsSync(archive)) throw Error('Archive exists without a matching journal');
      fs.mkdirSync(archive); for (const file of files) fs.copyFileSync(new URL(file, artifactDir), path.join(archive, file)); save();
    }
    for (const label of Object.keys(manifest.transactions)) await confirm(label);
    async function deploy(label, name, args = []) {
      const a = compiled(name), f = new ContractFactory(a.abi, a.bytecode, signer);
      const init = (await f.getDeployTransaction(...args)).data; assertInitcode(init);
      let record = manifest.records[label];
      if (!record && sharedLabels.has(label)) {
        const old = previous.records[label];
        if (old.artifact !== name || old.initHash !== keccak256(init)) throw Error(`Shared constructor or artifact mismatch: ${label}`);
        record = manifest.records[label] = {...old, reused: true, reusedFrom: previousPath}; save();
      }
      if (record && (record.artifact !== name || record.initHash !== keccak256(init))) throw Error(`Resume mismatch: ${label}`);
      if (!record) {
        activeLabel = label; activeDeployment = {artifact: name, initHash: keccak256(init), storageLayout: a.storageLayout};
        try { await f.deploy(...args); } finally { activeLabel = undefined; activeDeployment = undefined; }
        record = manifest.records[label];
      }
      if (!record.reused) await confirm(label);
      const code = await provider.getCode(record.address); assertArtifactRuntime(a, code);
      record.runtimeHash = keccak256(code); save(); console.log(`${label}: ${record.address}`);
      return new Contract(record.address, a.abi, signer);
    }
    async function configure(label, send, done) {
      if (manifest.transactions[label]) { await confirm(label); if (!await done()) throw Error(`Confirmed configuration missing: ${label}`); }
      else if (!await done()) { activeLabel = label; try { await send(); } finally { activeLabel = undefined; } await confirm(label); }
      if (!await done()) throw Error(`Configuration mismatch: ${label}`);
    }
    const suite = await deployUpgradeableSuite({signer, manager, platform: getAddress(config.platformTreasury),
      proposer: getAddress(config.upgradeProposer), validators: config.validators.map(getAddress),
      threshold: config.validatorThreshold, delay: config.upgradeDelaySeconds, deploy, configure,
      lpRewards: true, fundraisingPolicyVersion: 2, migrationReimbursementGasUnits: units});
    const activation = await provider.getBlock(manifest.transactions.activate.blockNumber);
    Object.assign(manifest, {factory: suite.factory.target, coordinator: suite.coordinator.target, poolManager: manager,
      hook: suite.hook.target, swapRouter: suite.router.target, allocationVerifier: suite.verifier.target,
      dividends: ZeroAddress, timelock: suite.timelock.target, feePolicy: suite.feePolicy.target, lpDistributor: suite.lpDistributor.target,
      migrationExecutor: await suite.coordinator.migrationExecutor(), migrationReimbursementGasUnits: String(await suite.coordinator.migrationReimbursementGasUnits()),
      migrationGasRefundLimitWei: String(await suite.coordinator.migrationGasRefundLimit()), maximumMigrationGasRefundWei: String(await suite.coordinator.MAX_MIGRATION_GAS_REFUND()),
      migrationFeeBps: Number(await suite.coordinator.migrationFeeBps()), migrationFeeAuthority: await suite.coordinator.migrationFeeAuthority(),
      upgradeProposer: config.upgradeProposer, validators: config.validators, validatorThreshold: config.validatorThreshold,
      upgradeDelaySeconds: config.upgradeDelaySeconds, deploymentBlock: activation.number, deploymentBlockHash: activation.hash,
      replacedDeployment: previousPath, complete: true});
    if (Number(await suite.factory.CONTRACT_VERSION()) !== 16 || getAddress(manifest.migrationExecutor) !== executor)
      throw Error('Deployed version or migration executor mismatch');
    save(); console.log(JSON.stringify({complete: true, manifest: output, transactions: Object.keys(manifest.transactions).length,
      actualFeesETH: formatEther(budgetUsed(manifest)), newAddresses: 6}));
  }
} catch (error) {
  const message = String(error.shortMessage ?? error.message).replaceAll(config.rpcUrl, '[RPC]').replaceAll(estimationURL, '[ESTIMATION-RPC]').replace(/0x[a-fA-F0-9]{64}/g, '[hash-or-key]');
  console.error(message); process.exitCode = 1;
} finally { provider.destroy(); if (estimationProvider !== provider) estimationProvider.destroy(); if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); } }
