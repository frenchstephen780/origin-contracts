import fs from 'node:fs';
import {JsonRpcProvider,Wallet,Contract} from 'ethers';
import {artifact} from './local-chain.mjs';
// Run only after reviewing the evidence. Writes a signed decision for any wallet to relay.
// Input: {chainId,distributor,project,round,root,objectionsHash,accepted,reason}.
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(typeof input.accepted!=='boolean'||!input.reason?.trim())throw Error('A reviewed decision and reason are required');
const provider=new JsonRpcProvider(process.env.RPC_URL||'http://127.0.0.1:8545');
try{
 if(Number((await provider.getNetwork()).chainId)!==input.chainId)throw Error('Chain mismatch');
 const c=new Contract(input.distributor,artifact('ProjectDividends').abi,provider);
 const [r,v,b]=await Promise.all([c.rounds(input.project,input.round),c.reviews(input.project,input.round),provider.getBlock('latest')]);
 if(!v.disputed||r.root!==input.root||v.objectionsHash!==input.objectionsHash)throw Error('Review changed; inspect all current objections again');
 const validator=new Wallet(process.env.ALLOCATION_SIGNER_PRIVATE_KEY);
 const verifier=new Contract(await c.verifier(),artifact('AllocationVerifier').abi,provider);
 if(!await verifier.isValidator(validator.address))throw Error('Not a validator');
 const deadline=b.timestamp+3600,digest=await c.resolutionDigest(input.project,input.round,input.accepted,deadline);
 const result={...input,deadline,signers:[validator.address],signatures:[validator.signingKey.sign(digest).serialized]};
 const output=process.argv[3];if(!output)throw Error('Provide a new output filename');
 fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log('Signed resolution saved. Relay it through the project dividend panel.');
}finally{provider.destroy()}
