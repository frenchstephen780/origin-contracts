// Opt-in local-test evidence only. Does not connect to any external RPC.
import fs from 'node:fs';
import path from 'node:path';
import {Interface} from 'ethers';
const SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export function observeEntrypoints(connection, directory) {
  fs.mkdirSync(directory,{recursive:true});
  const output=path.join(directory,`${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const artifacts=fs.readdirSync(new URL('../artifacts/',import.meta.url)).filter(n=>n.endsWith('.json'))
    .map(n=>JSON.parse(fs.readFileSync(new URL('../artifacts/'+n,import.meta.url),'utf8')))
    .filter(a=>a.abi&&a.deployedBytecode&&a.deployedBytecode!=='0x')
    .map(a=>({...a,interface:new Interface(a.abi)}));
  const request=connection.provider.request.bind(connection.provider), cache=new Map();
  const match=(a,code)=>{
    const x=Buffer.from(a.deployedBytecode.slice(2),'hex'),y=Buffer.from(code.slice(2),'hex');
    if(x.length!==y.length)return false;
    for(const refs of Object.values(a.immutableReferences??{}))for(const {start,length} of refs){x.fill(0,start,start+length);y.fill(0,start,start+length);}
    return x.equals(y);
  };
  async function identify(address){
    const code=await request({method:'eth_getCode',params:[address,'latest']});
    if(code==='0x')return null;
    const key=address.toLowerCase()+':'+code;
    let a=cache.get(key);
    if(!a){a=artifacts.find(a=>match(a,code))??null;cache.set(key,a);}
    if(a?.contractName==='OriginProxy'){
      const slot=await request({method:'eth_getStorageAt',params:[address,SLOT,'latest']});
      if(BigInt(slot)!==0n)return identify('0x'+slot.slice(-40));
    }
    return a;
  }
  connection.provider.request=async input=>{
    const observe=['eth_sendTransaction','eth_call','eth_estimateGas'].includes(input.method);
    const transaction=input.params?.[0];
    let entry;
    if(observe&&transaction?.to){
      const a=await identify(transaction.to);
      if(a){
        const data=transaction.data??transaction.input??'0x';
        const f=data.length>=10?a.interface.getFunction(data.slice(0,10)):null;
        if(!f||!['view','pure'].includes(f.stateMutability))entry={contract:a.contractName,
          signature:f?.format('sighash')??'receive()',rpc:input.method};
      }
    }
    try{
      const result=await request(input);
      if(entry)fs.appendFileSync(output,JSON.stringify({...entry,outcome:'accepted',
        ...(input.method==='eth_sendTransaction'?{txHash:result}:{}),file:process.argv[1]})+'\n');
      return result;
    }catch(error){
      if(entry)fs.appendFileSync(output,JSON.stringify({...entry,outcome:'reverted',file:process.argv[1]})+'\n');
      throw error;
    }
  };
}
