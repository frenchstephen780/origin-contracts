import {localValidators} from './local-validator.mjs';
import http from 'node:http';
import fs from 'node:fs';
import { createLocalChain } from './local-chain.mjs';
import { deployUpgradeableSuite } from './upgradeable-suite.mjs';
import {ZeroAddress} from 'ethers';

// Fresh, isolated development chain. Never connects to a public network.
const chain = await createLocalChain();
const validators = localValidators();
if (!validators.length) throw Error('ALLOCATION_VALIDATORS must name the attestation wallet(s)');
const [platform] = chain.signers;
const manager = await chain.deploy('PoolManager',[platform.address]);
const quoter = await chain.deploy('LocalProjectQuoter',[manager.target]);
const f = await deployUpgradeableSuite({signer:platform, manager:manager.target, platform:platform.address,
  proposer:platform.address, validators, threshold:Number(process.env.ALLOCATION_THRESHOLD || 1), fundraisingPolicyVersion:2});
const block = await chain.rpc('eth_getBlockByNumber', ['latest', false]);
fs.mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../deployments/local.json', import.meta.url), JSON.stringify({
  chainId: 31337, network: 'Ethereum Local', factory: f.factory.target,
  dividends: ZeroAddress, allocationVerifier: f.verifier.target, swapRouter: f.router.target,
  coordinator: f.coordinator.target, poolManager: manager.target, hook: f.hook.target, quoter: quoter.target,
  contractVersion: Number(await f.factory.CONTRACT_VERSION()), lpDistributor: f.lpDistributor.target,
  migrationFeeBps: Number(await f.coordinator.migrationFeeBps()),
  timelock:f.timelock.target, feePolicy:f.feePolicy.target,
  implementations:{governance:f.governanceImplementation.target,rewards:f.rewardsImplementation.target,operatingRewards:f.operatingImplementation.target,feePolicy:f.feePolicyImplementation.target},
  deploymentBlock: Number(BigInt(block.number)), deploymentBlockHash: block.hash,
}, null, 2));
const server = http.createServer(async (req, res) => {
  // Wallet extensions need CORS access. This endpoint deliberately exposes local test accounts only.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let raw = ''; for await (const part of req) { raw += part; if (raw.length > 1_000_000) { res.writeHead(413); return res.end(); } }
  async function handle(input) {
    try { return { jsonrpc: '2.0', id: input.id, result: await chain.rpc(input.method, input.params ?? []) }; }
    catch (e) { return { jsonrpc: '2.0', id: input.id, error: { code: Number.isInteger(e.code) ? e.code : -32000, message: e.message, data: e.data } }; }
  }
  try { const input = JSON.parse(raw); const result = Array.isArray(input) ? await Promise.all(input.map(handle)) : await handle(input); res.end(JSON.stringify(result)); }
  catch { res.writeHead(400); res.end(JSON.stringify({error:'Invalid JSON'})); }
});
server.listen(8545, '127.0.0.1', () => console.log('Local chain ready on 127.0.0.1:8545; fresh V4 deployment written. Test funds only.'));
for (const event of ['SIGINT','SIGTERM']) process.on(event, async () => { server.close(); await chain.close(); process.exit(0); });
