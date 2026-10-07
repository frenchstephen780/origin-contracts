import {getAddress, parseUnits, ZeroAddress} from 'ethers';

// Ethereum: 1 at https://developers.uniswap.org/docs/protocols/v4/deployments
export const MAINNET_POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';

export function mainnetArguments(argv, {verification = false} = {}) {
  if (!argv[0] || !/\.json$/i.test(argv[0]) || argv.length > (verification ? 1 : 2) ||
      (argv[1] !== undefined && (verification || argv[1] !== '--broadcast'))) {
    throw Error(`Usage: node scripts/${verification ? 'verify' : 'deploy'}-mainnet.mjs CONFIG.json${verification ? '' : ' [--broadcast]'}`);
  }
  return {configPath: argv[0], broadcast: argv[1] === '--broadcast'};
}

function requiredAddress(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`Set ${label} in the mainnet configuration`);
  const result = getAddress(value);
  if (result === ZeroAddress) throw Error(`${label} cannot be zero`);
  return result;
}

function decimal(value, label, unit, {allowZero = false} = {}) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw Error(`${label} must be an explicit decimal string`);
  }
  const result = parseUnits(value, unit);
  if (allowZero ? result < 0n : result <= 0n) throw Error(`${label} must be ${allowZero ? 'non-negative' : 'positive'}`);
  return result;
}

export function validateMainnetConfig(config, {broadcast = false} = {}) {
  if (config.chainId !== 1 || config.network !== 'ethereum-mainnet') throw Error('Mainnet entry requires Ethereum chainId 1 and network ethereum-mainnet');
  if (config.contractVersion !== 16) throw Error('Mainnet configuration must target contractVersion 16');
  if (config.reuseDeployment !== undefined) throw Error('Mainnet entry requires an independent suite; remove reuseDeployment');
  if (typeof config.rpcUrl !== 'string' || !config.rpcUrl.trim()) throw Error('Set rpcUrl in the mainnet configuration');
  const manager = requiredAddress(config.poolManager, 'poolManager');
  if (manager !== MAINNET_POOL_MANAGER) throw Error('PoolManager differs from the official Ethereum mainnet deployment');
  const expectedDeployer = requiredAddress(config.expectedDeployer, 'expectedDeployer');
  const platform = requiredAddress(config.platformTreasury, 'platformTreasury');
  const proposer = requiredAddress(config.upgradeProposer, 'upgradeProposer');
  if (!Array.isArray(config.validators)) throw Error('validators must be an array');
  const validators = config.validators.map(v => requiredAddress(v, 'validator'));
  if (!validators.length || validators.length > 16 || new Set(validators).size !== validators.length ||
      !Number.isInteger(config.validatorThreshold) || config.validatorThreshold < 1 || config.validatorThreshold > validators.length) throw Error('Invalid validator quorum');
  if (!Number.isSafeInteger(config.upgradeDelaySeconds) || config.upgradeDelaySeconds < 172800 ||
      !Number.isSafeInteger(config.confirmations) || config.confirmations < 1) throw Error('Invalid delay/confirmations');
  const receiptTimeoutMs = config.receiptTimeoutMs ?? 300000;
  if (!Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs < 1000 || receiptTimeoutMs > 3600000) throw Error('Invalid receiptTimeoutMs');
  const feeMode = config.feeMode ?? 'fixed';
  if (!['fixed', 'live'].includes(feeMode)) throw Error('feeMode must be fixed or live');
  const fields = ['maxFeePerGasGwei', 'maxPriorityFeePerGasGwei', 'maximumDeploymentFeeEther'];
  const requiredFields = feeMode === 'live' ? fields.slice(2) : fields;
  const configured = requiredFields.every(k => typeof config[k] === 'string' && config[k].length > 0);
  if (!configured && (broadcast || requiredFields.some(k => config[k] !== undefined && config[k] !== ''))) {
    throw Error(feeMode === 'live' ? 'Live broadcast requires maximumDeploymentFeeEther from the available operation balance' :
      'Broadcast requires explicit maxFeePerGasGwei, maxPriorityFeePerGasGwei and maximumDeploymentFeeEther');
  }
  const fees = configured ? {
    totalBudget: decimal(config.maximumDeploymentFeeEther, fields[2], 'ether'),
    ...(feeMode === 'fixed' ? {
      maxFeePerGas: decimal(config.maxFeePerGasGwei, fields[0], 'gwei'),
      maxPriorityFeePerGas: decimal(config.maxPriorityFeePerGasGwei, fields[1], 'gwei', {allowZero: true})
    } : {})
  } : null;
  if (feeMode === 'fixed' && fees && fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw Error('Priority fee exceeds max fee');
  return {manager, expectedDeployer, platform, proposer, validators, receiptTimeoutMs, feeMode, fees};
}

export function liveFeeLimits(data, baseFeePerGas) {
  const baseFee = BigInt(baseFeePerGas ?? 0n);
  if (baseFee < 0n) throw Error('Invalid live base fee');
  let maxPriorityFeePerGas = data.maxPriorityFeePerGas;
  let feeSource = 'rpc-recommendation';
  if (maxPriorityFeePerGas == null || maxPriorityFeePerGas <= 0n) {
    const gasPrice = data.gasPrice ?? 0n;
    maxPriorityFeePerGas = gasPrice > baseFee ? gasPrice - baseFee : parseUnits('0.01', 'gwei');
    feeSource = gasPrice > baseFee ? 'rpc-gasPrice-minus-baseFee' : 'minimum-tip-0.01-gwei';
  }
  let maxFeePerGas = data.maxFeePerGas ?? (baseFee * 2n + maxPriorityFeePerGas);
  if (maxFeePerGas < baseFee + maxPriorityFeePerGas) {
    maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    feeSource += '-adjusted-for-current-base';
  }
  if (maxFeePerGas <= 0n || maxPriorityFeePerGas < 0n) throw Error('Invalid live fee recommendation');
  return {maxFeePerGas, maxPriorityFeePerGas, feeSource};
}

export function budgetUsed(manifest) {
  return Object.values(manifest.transactions).reduce((sum, t) =>
    sum + BigInt(t.feeWei ?? t.feeBudgetWei), 0n);
}
