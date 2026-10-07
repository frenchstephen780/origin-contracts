import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {JsonRpcProvider, FetchRequest, Wallet, ContractFactory, Contract, getCreateAddress, keccak256, ZeroAddress, formatEther} from 'ethers';
import {compiled, assertInitcode, deployUpgradeableSuite} from './upgradeable-suite.mjs';
import {assertArtifactRuntime} from './storage-layout.mjs';
import {mainnetArguments, validateMainnetConfig, budgetUsed, liveFeeLimits} from './mainnet-config.mjs';

// Independent mainnet entry. Default preflight never reads a private key or writes a journal.
const args = mainnetArguments(process.argv.slice(2));
const configPath = path.resolve(args.configPath);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const settings = validateMainnetConfig(config, args);
const {manager, expectedDeployer, platform, proposer, validators, receiptTimeoutMs, feeMode, fees} = settings;
const artifactDir = new URL('../artifacts/', import.meta.url);
const artifactFiles = fs.readdirSync(artifactDir).filter(n => n.endsWith('.json')).sort();
const digest = data => createHash('sha256').update(data).digest('hex');
const artifactHashes = Object.fromEntries(artifactFiles.map(n => [n, digest(fs.readFileSync(new URL(n, artifactDir)))]));
const buildHash = artifactHashes['build-manifest.json'];
if (!buildHash) throw Error('Compile the current suite before mainnet preflight');
const configHash = digest(JSON.stringify({...config, rpcUrl: ''}));
const outputPath = configPath.replace(/\.json$/i, '') + '.deployed.json';
const archive = outputPath.replace(/\.json$/i, '') + '.build';
const lockPath = outputPath + '.lock';
const request = new FetchRequest(config.rpcUrl);
request.setThrottleParams({maxAttempts: 1});
request.retryFunc = async () => false;
const provider = new JsonRpcProvider(request, undefined, {batchMaxCount: 1});
let manifest, activeLabel, activeDeployment, lockDescriptor;
const save = () => {
  const temporary = fs.openSync(outputPath + '.tmp', 'w');
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n');
    fs.fsyncSync(temporary);
  } finally { fs.closeSync(temporary); }
  fs.renameSync(outputPath + '.tmp', outputPath);
  const published = fs.openSync(outputPath, 'r+');
  try { fs.fsyncSync(published); } finally { fs.closeSync(published); }
};

async function confirmed(label) {
  const entry = manifest.transactions[label];
  if (!entry?.hash) throw Error(`Missing transaction journal: ${label}`);
  const receipt = await provider.waitForTransaction(entry.hash, config.confirmations, receiptTimeoutMs);
  if (!receipt) throw Error(`Transaction ${label} is unconfirmed. Inspect its recorded hash; this script never rebroadcasts it`);
  Object.assign(entry, {blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    gasUsed: String(receipt.gasUsed), gasPrice: String(receipt.gasPrice), feeWei: String(receipt.fee),
    status: receipt.status, state: receipt.status === 1 ? 'confirmed' : 'failed'});
  save();
  if (receipt.status !== 1) throw Error(`Transaction ${label} failed. This journal cannot automatically retry it`);
  if (receipt.fee > BigInt(entry.feeBudgetWei) || budgetUsed(manifest) > fees.totalBudget) throw Error('Receipt exceeded the configured fee budget');
  return receipt;
}

// Journal the locally known hash before submission. Unknown outcomes only resume by receipt lookup.
class BudgetWallet extends Wallet {
  async sendTransaction(tx) {
    if (!activeLabel || manifest.transactions[activeLabel]) throw Error('An existing or unlabelled transaction must never be resent');
    for (const [name, hash] of Object.entries(artifactHashes)) {
      if (digest(fs.readFileSync(new URL(name, artifactDir))) !== hash) throw Error(`Build artifact changed during deployment: ${name}`);
    }
    if (budgetUsed(manifest) >= fees.totalBudget) throw Error('Deployment fee budget exhausted');
    const [latestNonce, pendingNonce, block, balance, recommendation] = await Promise.all([
      provider.getTransactionCount(this.address, 'latest'), provider.getTransactionCount(this.address, 'pending'),
      provider.getBlock('latest'), provider.getBalance(this.address),
      feeMode === 'live' ? provider.getFeeData() : Promise.resolve(null)
    ]);
    if (latestNonce !== pendingNonce) throw Error('Deployer has pending transactions; inspect them before continuing');
    if (latestNonce !== manifest.startingNonce + Object.keys(manifest.transactions).length) {
      throw Error('Deployer nonce is inconsistent with this journal. Inspect external transactions or a missing journal entry; no automatic resend');
    }
    const limits = feeMode === 'live' ? liveFeeLimits(recommendation, block.baseFeePerGas) : fees;
    if ((block.baseFeePerGas ?? 0n) + limits.maxPriorityFeePerGas > limits.maxFeePerGas) throw Error('Current base fee exceeds the configured transaction fee cap');
    const populated = await this.populateTransaction({...tx, nonce: latestNonce, chainId: 1,
      type: 2, maxFeePerGas: limits.maxFeePerGas, maxPriorityFeePerGas: limits.maxPriorityFeePerGas});
    if (BigInt(populated.chainId) !== 1n || BigInt(populated.value ?? 0) !== 0n) throw Error('Mainnet deployment transaction must use chainId 1 and zero value');
    // A bounded 20% gas cushion is also included in the maximum fee reservation.
    populated.gasLimit = (BigInt(populated.gasLimit) * 120n + 99n) / 100n;
    const reserve = populated.gasLimit * limits.maxFeePerGas;
    if (budgetUsed(manifest) + reserve > fees.totalBudget) throw Error('Next transaction would exceed the total deployment fee budget');
    if (balance < reserve) throw Error('Deployer balance cannot cover the next transaction fee cap');
    const raw = await this.signTransaction(populated);
    const hash = keccak256(raw);
    manifest.transactions[activeLabel] = {hash, nonce: latestNonce, gasLimit: String(populated.gasLimit),
      maxFeePerGasWei: String(limits.maxFeePerGas), maxPriorityFeePerGasWei: String(limits.maxPriorityFeePerGas),
      feeMode, feeSource: limits.feeSource ?? 'fixed-configuration',
      baseFeePerGasWei: String(block.baseFeePerGas ?? 0n), networkGasPriceWei: recommendation?.gasPrice == null ? null : String(recommendation.gasPrice),
      feeBudgetWei: String(reserve), state: 'prepared', preparedAt: new Date().toISOString()};
    if (activeDeployment) manifest.records[activeLabel] = {...activeDeployment,
      address: getCreateAddress({from: this.address, nonce: latestNonce})};
    save();
    try {
      const response = await provider.broadcastTransaction(raw);
      if (response.hash !== hash) throw Error('RPC returned a different transaction hash');
      manifest.transactions[activeLabel].state = 'broadcast'; save();
      return response;
    } catch {
      manifest.transactions[activeLabel].state = 'broadcast_unknown'; save();
      throw Error(`Submission outcome is unknown for ${activeLabel}. Inspect the journaled hash before resuming; no automatic resend`);
    }
  }
}

try {
  if ((await provider.getNetwork()).chainId !== 1n) throw Error('RPC chain ID is not Ethereum mainnet');
  if ((await provider.getCode(manager)) === '0x') throw Error('Official mainnet PoolManager has no code at this RPC');
  const [block, balance, recommendation] = await Promise.all([provider.getBlock('latest'), provider.getBalance(expectedDeployer),
    feeMode === 'live' ? provider.getFeeData() : Promise.resolve(null)]);
  const preview = feeMode === 'live' ? liveFeeLimits(recommendation, block.baseFeePerGas) : fees;
  console.log(JSON.stringify({preflightOnly: !args.broadcast, chainId: 1, poolManager: manager,
    expectedDeployer, buildHash, feeMode, feeCapsConfigured: feeMode === 'fixed' && fees !== null,
    deploymentBudgetConfigured: fees !== null,
    recommendedMaxFeePerGasWei: preview ? String(preview.maxFeePerGas) : null,
    recommendedMaxPriorityFeePerGasWei: preview ? String(preview.maxPriorityFeePerGas) : null,
    baseFeePerGasWei: String(block.baseFeePerGas ?? 0n), deployerBalanceETH: formatEther(balance),
    maximumDeploymentFeeETH: fees ? formatEther(fees.totalBudget) : null}));
  if (!args.broadcast) {
    console.log('Read-only preflight. An explicit --broadcast, matching DEPLOYER_PRIVATE_KEY and complete fee budget are required to deploy');
  } else {
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw Error('Set DEPLOYER_PRIVATE_KEY in the process environment; never store it in deployment JSON');
    let signer;
    try { signer = new BudgetWallet(process.env.DEPLOYER_PRIVATE_KEY, provider); }
    catch { throw Error('DEPLOYER_PRIVATE_KEY is invalid; its value has not been logged'); }
    if (signer.address !== expectedDeployer) throw Error('DEPLOYER_PRIVATE_KEY address does not match expectedDeployer');
    try { lockDescriptor = fs.openSync(lockPath, 'wx'); }
    catch { throw Error('Deployment operation is locked. Inspect the running process and journal before removing a stale lock'); }
    fs.writeFileSync(lockDescriptor, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}) + '\n');
    const existed = fs.existsSync(outputPath);
    const [startingNonce, pendingNonce] = await Promise.all([
      provider.getTransactionCount(signer.address, 'latest'), provider.getTransactionCount(signer.address, 'pending')
    ]);
    if (!existed && startingNonce !== pendingNonce) throw Error('Deployer has pending transactions before this operation starts');
    manifest = existed ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : {
      chainId: 1, network: config.network, contractVersion: 16, deployer: signer.address, feeMode,
      buildHash, artifactHashes, configHash, artifactArchive: archive, startingNonce,
      maximumDeploymentFeeWei: String(fees.totalBudget), records: {}, transactions: {}, complete: false
    };
    if (manifest.chainId !== 1 || (manifest.feeMode ?? 'fixed') !== feeMode || manifest.deployer !== signer.address || manifest.buildHash !== buildHash ||
        manifest.configHash !== configHash || JSON.stringify(manifest.artifactHashes) !== JSON.stringify(artifactHashes) ||
        manifest.maximumDeploymentFeeWei !== String(fees.totalBudget)) throw Error('Cannot resume with a different chain, build, configuration, budget or deployer');
    if (!Number.isSafeInteger(manifest.startingNonce) || manifest.startingNonce < 0) throw Error('Missing valid startingNonce in mainnet journal');
    if (!existed) {
      // Archive before the first transaction; never overwrite the baseline of an interrupted run.
      if (fs.existsSync(archive)) throw Error('Build archive already exists without a matching manifest; inspect it before continuing');
      fs.mkdirSync(archive);
      for (const name of artifactFiles) fs.copyFileSync(new URL(name, artifactDir), path.join(archive, name));
      save();
    }
    for (const [name, hash] of Object.entries(artifactHashes)) {
      if (digest(fs.readFileSync(path.join(archive, name))) !== hash) throw Error(`Archived artifact changed: ${name}`);
    }
    // Resume by confirming the same hashes first, including prepared/unknown submissions.
    for (const label of Object.keys(manifest.transactions)) await confirmed(label);
    if (budgetUsed(manifest) > fees.totalBudget) throw Error('Deployment fee budget exceeded');
    async function deploy(label, name, args = []) {
      const a = compiled(name), factory = new ContractFactory(a.abi, a.bytecode, signer);
      const init = (await factory.getDeployTransaction(...args)).data; assertInitcode(init);
      let record = manifest.records[label];
      if (record && (record.initHash !== keccak256(init) || record.artifact !== name)) throw Error(`Constructor/artifact mismatch: ${label}`);
      if (!record) {
        activeLabel = label; activeDeployment = {artifact: name, initHash: keccak256(init), storageLayout: a.storageLayout};
        try { await factory.deploy(...args); } finally { activeLabel = undefined; activeDeployment = undefined; }
        record = manifest.records[label];
      }
      await confirmed(label);
      const code = await provider.getCode(record.address);
      assertArtifactRuntime(a, code);
      if (record.runtimeHash && record.runtimeHash !== keccak256(code)) throw Error(`Deployed code changed: ${label}`);
      record.runtimeHash = keccak256(code); save(); console.log(`${label}: ${record.address}`);
      return new Contract(record.address, a.abi, signer);
    }
    async function configure(label, send, done) {
      if (manifest.transactions[label]) {
        await confirmed(label);
        if (!await done()) throw Error(`Confirmed configuration ${label} is not applied; do not retry automatically`);
      } else if (!await done()) {
        activeLabel = label;
        try { await send(); } finally { activeLabel = undefined; }
        await confirmed(label);
      }
      if (!await done()) throw Error(`Configuration not applied: ${label}`);
    }
    const suite = await deployUpgradeableSuite({signer, manager, platform, proposer, validators,
      threshold: config.validatorThreshold, delay: config.upgradeDelaySeconds, deploy, configure,
      lpRewards: true, fundraisingPolicyVersion: 2});
    const activationBlock = await provider.getBlock(manifest.transactions.activate.blockNumber);
    Object.assign(manifest, {factory: suite.factory.target, coordinator: suite.coordinator.target,
      poolManager: manager, hook: suite.hook.target, swapRouter: suite.router.target,
      allocationVerifier: suite.verifier.target, dividends: ZeroAddress, timelock: suite.timelock.target,
      feePolicy: suite.feePolicy.target, lpDistributor: suite.lpDistributor.target,
      contractVersion: Number(await suite.factory.CONTRACT_VERSION()),
      migrationFeeBps: Number(await suite.coordinator.migrationFeeBps()), migrationFeeAuthority: await suite.coordinator.migrationFeeAuthority(),
      migrationGasRefundLimitWei: String(await suite.coordinator.migrationGasRefundLimit()),
      maximumMigrationGasRefundWei: String(await suite.coordinator.MAX_MIGRATION_GAS_REFUND()),
      deploymentBlock: activationBlock.number, deploymentBlockHash: activationBlock.hash, complete: true});
    save(); console.log(`Mainnet deployment journal completed: ${outputPath}. Run verify-mainnet.mjs before using it`);
  }
} catch (error) {
  const message = String(error.shortMessage ?? error.message).replaceAll(config.rpcUrl, '[RPC]').replace(/0x[a-fA-F0-9]{64}/g, '[hash-or-key]');
  console.error(message); process.exitCode = 1;
} finally {
  provider.destroy();
  if (lockDescriptor !== undefined) {
    fs.closeSync(lockDescriptor);
    fs.unlinkSync(lockPath);
  }
}
