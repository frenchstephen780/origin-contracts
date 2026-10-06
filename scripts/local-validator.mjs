import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Wallet} from 'ethers';
// Local test deployments only. The un-funded signing key never pays transaction gas.
export function localValidators(){
 const file=process.env.CONTRACTS_ENV_FILE || new URL('../.env.local',import.meta.url);
 if(fs.existsSync(file))for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
  const at=line.indexOf('=');if(at<0)continue;const key=line.slice(0,at).trim();
  if(['ALLOCATION_VALIDATORS','ALLOCATION_THRESHOLD','ALLOCATION_SIGNER_PRIVATE_KEY','ALLOCATION_SIGNER_FILE'].includes(key)&&!process.env[key])process.env[key]=line.slice(at+1).trim().replace(/^['"]|['"]$/g,'');
 }
 if(process.env.ALLOCATION_VALIDATORS)return process.env.ALLOCATION_VALIDATORS.split(',').map(x=>x.trim()).filter(Boolean);
 const directory=process.env.CONTRACTS_RUN_DIR ? pathToFileURL(path.resolve(process.env.CONTRACTS_RUN_DIR)+path.sep) : new URL('../.run/',import.meta.url);fs.mkdirSync(directory,{recursive:true});
 const keyFile=process.env.ALLOCATION_SIGNER_FILE||new URL('allocation-validator.key',directory);
 let key=process.env.ALLOCATION_SIGNER_PRIVATE_KEY;
 if(!key){if(fs.existsSync(keyFile))key=fs.readFileSync(keyFile,'utf8').trim();else{key=Wallet.createRandom().privateKey;fs.writeFileSync(keyFile,key+'\n',{flag:'wx',mode:0o600});}}
 return [new Wallet(key).address];
}
