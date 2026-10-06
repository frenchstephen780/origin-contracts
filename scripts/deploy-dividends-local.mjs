import {localValidators} from './local-validator.mjs';
import fs from 'node:fs';
import {JsonRpcProvider,ContractFactory,Contract} from 'ethers';
import {artifact} from './local-chain.mjs';
const p=new JsonRpcProvider('http://127.0.0.1:8545',undefined,{cacheTimeout:-1});
try{
 if((await p.getNetwork()).chainId!==31337n)throw Error('Local test chain only');
 const file=new URL('../deployments/local.json',import.meta.url),m=JSON.parse(fs.readFileSync(file,'utf8'));
 if((await p.getBlock(m.deploymentBlock))?.hash!==m.deploymentBlockHash)throw Error('Deployment mismatch');
 const a=artifact('ProjectDividends');
 if(m.dividends&&await p.getCode(m.dividends)!=='0x'){
  const c=new Contract(m.dividends,a.abi,p);if((await c.factory()).toLowerCase()!==m.factory.toLowerCase())throw Error('Dividend factory mismatch');
  if((await p.getCode(m.dividends)).toLowerCase()!==a.deployedBytecode.toLowerCase())console.log('Existing immutable dividend deployment retained; no funds moved.');
  console.log('Dividends already deployed:',m.dividends);
 }else{
  const validators = localValidators();
  if(!validators.length)throw Error('ALLOCATION_VALIDATORS is required');
  const va=artifact('AllocationVerifier');
  const verifier=await new ContractFactory(va.abi,va.bytecode,await p.getSigner(0)).deploy(validators,Number(process.env.ALLOCATION_THRESHOLD||1));await verifier.waitForDeployment();
  m.allocationVerifier=verifier.target;
  const c=await new ContractFactory(a.abi,a.bytecode,await p.getSigner(0)).deploy(m.factory,verifier.target);await c.waitForDeployment();
  fs.copyFileSync(file,new URL(`../deployments/local-before-${Date.now()}.json`,import.meta.url));
  m.dividends=c.target;fs.writeFileSync(file,JSON.stringify(m,null,2)+'\n');console.log('Independent dividends deployed:',c.target);
 }
}finally{p.destroy();}
