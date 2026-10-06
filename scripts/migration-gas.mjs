import {Contract} from 'ethers';
import {artifact} from './local-chain.mjs';

// Read-only preparation. It never sends a transaction or loads credentials.
export async function prepareMigration(project, feeOptions = {}) {
 const provider=project.runner?.provider;
 if(!provider)throw Error('A project connected to a signer/provider is required');
 if(await project.state()!==1n)throw Error('Project is not awaiting migration');
 const fees=await provider.getFeeData();
 const fee=Object.keys(feeOptions).length ? {...feeOptions} : fees.maxFeePerGas!=null
  ? {maxFeePerGas:fees.maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas}
  : {gasPrice:fees.gasPrice};
 if(fee.gasPrice==null)fee.maxPriorityFeePerGas??=fees.maxPriorityFeePerGas??0n;
 const maximumPrice=fee.gasPrice??fee.maxFeePerGas;
 if(maximumPrice==null)throw Error('RPC did not provide a gas price');
 const method=project.getFunction('migrate');
 const estimatedGasUnits=await method.estimateGas(fee);
 const gasLimit=estimatedGasUnits+estimatedGasUnits/10n+10000n;
 const request=await method.populateTransaction({...fee,gasLimit});
 if(typeof project.runner.getAddress!=='function')throw Error('A signer-connected project is required');
 // eth_call executes the same migration without persisting writes. New escrows
 // return their internally metered units; no estimate is passed as calldata.
 const simulated=await provider.call({...request,from:await project.runner.getAddress()});
 let onchainGasUnits=null;
 if(simulated!=='0x'){
  if(simulated.length!==66)throw Error('Unexpected migration simulation result');
  onchainGasUnits=BigInt(simulated);
  if(onchainGasUnits===0n)throw Error('Migration simulation returned zero metered gas');
 }
 // Older fixed escrows return no data. Their RPC-based display is approximate;
 // their migrate() entry still computes its reimbursement onchain.
 const estimatedReimbursementUnits=onchainGasUnits??estimatedGasUnits;
 const coordinator=new Contract(await project.coordinator(),artifact('V4MigrationCoordinator').abi,project.runner);
 const target=await project.getFunction('target')(),rate=await project.migrationFeeBps();
 const beforeGas=await coordinator.quoteForFee(target,rate);
 async function optionalLimit(name){
  if(!project.interface.getFunction(name))return null;
  try{return await project.getFunction(name)();}
  catch(error){
   // Historical escrows have no such getter. RPC failures must propagate.
   if(!((error.code==='CALL_EXCEPTION'&&error.data==='0x')||
        (error.code==='BAD_DATA'&&error.value==='0x')))throw error;
   return null;
  }
 }
 let reimbursementLimit=await optionalLimit('migrationGasRefundLimit');
 if(reimbursementLimit===null)reimbursementLimit=await optionalLimit('MAX_MIGRATION_GAS_REFUND');
 const maximumGasCost=estimatedReimbursementUnits*maximumPrice;
 if(reimbursementLimit!==null&&maximumGasCost>reimbursementLimit)throw Error('Maximum transaction fee exceeds the project migration reimbursement limit; wait for lower gas or lower the wallet fee ceiling');
 if(maximumGasCost>=beforeGas.ethAmount)throw Error('Maximum transaction fee would consume LP funds; wait for lower gas or lower the wallet fee ceiling');
 const block=await provider.getBlock('latest');
 const proposedPrice=(block.baseFeePerGas??0n)+(fee.maxPriorityFeePerGas??0n);
 const livePrice=fee.gasPrice??(proposedPrice>fee.maxFeePerGas?fee.maxFeePerGas:proposedPrice);
 const estimatedGasCost=estimatedReimbursementUnits*livePrice;
 const estimatedTransactionCost=estimatedGasUnits*livePrice;
 const afterGas=await coordinator.quoteAfterGas(target,rate,estimatedGasCost);
 return {estimatedGasUnits,onchainGasUnits,estimatedReimbursementUnits,reimbursementLimit,estimatedGasPrice:livePrice,estimatedGasCost,estimatedTransactionCost,maximumGasCost,beforeGas,afterGas,request};
}

// Sending is explicit and belongs to the connected wallet. Applications can use
// prepareMigration alone to display and review the ETH/token preview first.
export async function estimateAndMigrate(project,feeOptions){
 const prepared=await prepareMigration(project,feeOptions);
 return project.runner.sendTransaction(prepared.request);
}
