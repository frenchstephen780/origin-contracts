import fs from 'node:fs';
import {JsonRpcProvider, Contract, Interface, keccak256, ZeroHash, getAddress} from 'ethers';
import {compiled} from './upgradeable-suite.mjs';
import {assertCompatibleStorage, assertArtifactRuntime} from './storage-layout.mjs';

// Read-only preparation: emits exact timelock calldata, never broadcasts.
// Input: RPC via env, proxy, timelock, old artifact snapshot, new artifact,
// candidate implementation address, unique salt, output path.
const [proxyAddress, timelockAddress, oldPath, nextPath, candidateAddress, salt, outputPath] = process.argv.slice(2);
if (!outputPath || !process.env.UPGRADE_RPC_URL) throw Error('Usage: UPGRADE_RPC_URL=... npm run upgrade:prepare -- proxy timelock old-artifact.json new-artifact.json candidate bytes32-salt output.json');
const old = JSON.parse(fs.readFileSync(oldPath, 'utf8')), next = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
assertCompatibleStorage(old.storageLayout, next.storageLayout);
const provider = new JsonRpcProvider(process.env.UPGRADE_RPC_URL);
try {
  const network = await provider.getNetwork();
  if (network.chainId !== 11155111n && network.chainId !== 31337n) throw Error('Preparation supports Sepolia or isolated local test networks');
  const proxy = new Contract(getAddress(proxyAddress), old.abi, provider);
  const candidate = new Contract(getAddress(candidateAddress), next.abi, provider);
  const timelock = new Contract(getAddress(timelockAddress), compiled('OriginTimelock').abi, provider);
  if ((await proxy.upgradeAuthority()).toLowerCase() !== timelock.target.toLowerCase() ||
      await proxy.upgradeFamily() !== await candidate.upgradeFamily()) throw Error('Authority/family mismatch');
  const code = await provider.getCode(candidate.target);
  if (code === '0x') throw Error('Candidate implementation missing');
  const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const currentImplementation = getAddress('0x' + (await provider.getStorage(proxy.target, implementationSlot)).slice(-40));
  assertArtifactRuntime(old, await provider.getCode(currentImplementation));
  assertArtifactRuntime(next, code);
  const uuid = await candidate.proxiableUUID();
  if (uuid !== '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') throw Error('Not an ERC-1967 UUPS implementation');
  const delay = await timelock.getMinDelay();
  if (delay < 172800n) throw Error('Upgrade delay below 48 hours');
  const data = new Interface(old.abi).encodeFunctionData('upgradeToAndCall', [candidate.target, '0x']);
  const operationId = await timelock.hashOperation(proxy.target, 0n, data, ZeroHash, salt);
  fs.writeFileSync(outputPath, JSON.stringify({chainId: Number(network.chainId), proxy: proxy.target,
    timelock: timelock.target, currentImplementation, candidate: candidate.target, candidateRuntimeHash: keccak256(code),
    oldArtifact: oldPath, nextArtifact: nextPath, storageLayoutCompatible: true,
    namespaceReviewRequired: 'Review origin.upgrade.control ERC-7201 namespace and all implementation code before scheduling',
    operationId, delaySeconds: Number(delay), salt,
    schedule: {to: timelock.target, value: '0', data: timelock.interface.encodeFunctionData('schedule', [proxy.target, 0, data, ZeroHash, salt, delay])},
    execute: {to: timelock.target, value: '0', data: timelock.interface.encodeFunctionData('execute', [proxy.target, 0, data, ZeroHash, salt])},
  }, null, 2) + '\n');
  console.log(`Prepared upgrade operation ${operationId}; no transaction sent`);
} finally { provider.destroy(); }
