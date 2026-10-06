import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {Contract, Interface, parseEther as eth, id, ZeroHash, ZeroAddress} from 'ethers';
import {artifact, createLocalChain} from '../scripts/local-chain.mjs';
import {deployV4Fixture} from '../scripts/local-v4.mjs';
import {prepareMigration} from '../scripts/migration-gas.mjs';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';
import {tx, withLocalChain} from './helpers.mjs';

describe("Contract metering and reimbursement", {concurrency: false}, () => {
  const TOTAL=eth('100000000'), CREATOR=eth('5000000');
  function fixture(run) {
    return withLocalChain(async c => {
    const f=await deployV4Fixture(c,{withProject:false});
    f.project=await c.createProject(f.factory,{target:eth('1')});
    f.token=new Contract(await f.project.token(),artifact('ProjectToken').abi,c.signers[0]);
    f.router=await c.deploy('V4TestRouter',[f.manager.target]);
    f.key=['0x0000000000000000000000000000000000000000',f.token.target,3000,60,f.hook.target];
    await run(c,f);

    });
  }
  async function fund(c,p){
   for(const [i,amount] of [[2,'0.5'],[3,'0.25'],[4,'0.25']]){
    const who=c.signers[i],before=await c.balance(who.address);
    const receipt=await tx(p.connect(who).contribute(0,{value:eth(amount),gasLimit:16000000}));
    assert.equal(before-await c.balance(who.address),eth(amount)+receipt.gasUsed*receipt.gasPrice);
    assert.ok(receipt.gasUsed<600000n);
   }
   assert.equal(await p.state(),1n);
   assert.equal(await p.governance(),'0x0000000000000000000000000000000000000000');
  }
  async function checkLaunch(c,f,baseline){
   const p=f.project,refund=await p.migrationGasRefund();
   const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
   const final=await locker.initialQuote(),burned=await locker.migrationTokensBurned();
   const gov=new Contract(await p.governance(),artifact('ProjectGovernance').abi,c.signers[0]);
   const platformFee=eth('1')*await p.migrationFeeBps()/10000n;
   const vault=new Contract(await gov.devVault(),artifact('ProjectVault').abi,c.signers[0]);
   assert.equal(await p.state(),3n);assert.equal(await locker.migrationFinalized(),true);
   assert.equal(await p.SALE_SUPPLY(),baseline.saleSupply);assert.equal(final.saleSupply,baseline.saleSupply);
   assert.equal(final.sqrtPriceX96,baseline.sqrtPriceX96);
   assert.equal((await f.router.poolState(f.key))[0],baseline.sqrtPriceX96);
   assert.equal(final.ethAmount,baseline.ethAmount-refund);
   assert.equal(final.tokenAmount,baseline.tokenAmount-burned);
   assert.equal(final.lockedTokenRemainder,baseline.lockedTokenRemainder+burned);
   assert.equal(await c.balance(f.manager.target),final.ethAmount);
   assert.equal(await f.token.balanceOf(f.manager.target),final.tokenAmount);
   assert.equal(await locker.positionLiquidity(),final.liquidity);
   assert.equal(await c.balance(locker.target),0n);assert.equal(await f.token.balanceOf(locker.target),0n);
   assert.equal(await c.balance(f.coordinator.target),0n);
   assert.equal(await vault.availableFunds(),eth('0.5'));
   assert.equal(await f.factory.accruedMigrationFees(),platformFee);
   assert.equal(final.ethAmount+refund+eth('0.5')+platformFee,eth('1'));
   assert.equal(await f.token.balanceOf(p.target),CREATOR);
   assert.equal(await f.token.totalSupply(),TOTAL-final.lockedTokenRemainder);
   assert.ok(refund<baseline.ethAmount);
   await assert.rejects(()=>locker.finalizeMigration.staticCall(1));
   await assert.rejects(()=>c.rpc('eth_call',[{from:p.target,to:locker.target,data:locker.interface.encodeFunctionData('finalizeMigration',[1])},'latest']));
   await assert.rejects(()=>p.migrate.staticCall());
   return {locker,refund,burned,final};
  }

  test('all new projects enforce 1 ETH minimum, independently of the pure curve math',async()=>fixture(async(c,f)=>{
   const legacy=await c.deploy('ProjectFactory',[c.signers[0].address]);
   for(const factory of [legacy,f.factory]){
     for(const target of [eth('0.01'),eth('0.1'),eth('0.5'),eth('1')-2n]){
     await assert.rejects(()=>factory.createProjectDays.staticCall(target,3,id('minimum'),'ipfs://minimum',{value:eth('0.02')}));
    }
    const exact=await c.createProject(factory,{target:eth('1')});
    assert.equal(await exact.MIN_FUNDRAISING_TARGET(),eth('1'));
    assert.equal(await exact.getFunction('target')(),eth('1'));
    const p=await c.createProject(factory,{target:eth('1')+2n});
    assert.equal(await p.getFunction('target')(),eth('1')+2n);
   }
   await assert.rejects(()=>f.coordinator.quote(eth('1')-2n));
  }));

  test('migration reimburses its caller while preserving every subscription, creator reserve and 1.5P opening price',async()=>fixture(async(c,f)=>{
   const baseline=await f.coordinator.quote(eth('1'));
   await fund(c,f.project);
   const entries=await Promise.all(c.signers.slice(2,5).map(w=>f.project.contributions(w.address)));
   const keeper=c.signers[5],before=await c.balance(keeper.address);
   const receipt=await tx(f.project.connect(keeper).migrate({gasLimit:16000000}));
   const result=await checkLaunch(c,f,baseline);
   assert.equal(await c.balance(keeper.address)-before,result.refund-receipt.gasUsed*receipt.gasPrice);
   assert.equal(await f.project.migrationGasBeneficiary(),keeper.address);
   assert.equal(await f.project.migrationGasPrice(),receipt.gasPrice);
   const units=await f.project.migrationGasUnits();
   const requested=units*receipt.gasPrice;
   assert.ok(result.refund<=requested && requested-result.refund<=2n);
    // Accepted calls cover the measured receipt fee with a bounded allowance.
   assert.ok(result.refund>=receipt.gasUsed*receipt.gasPrice,`refund units=${units}, receipt units=${receipt.gasUsed}`);
   assert.ok(units-receipt.gasUsed<500000n);
   assert.ok(result.burned>0n);
   for(let i=0;i<3;i++){
    const who=c.signers[i+2];
    assert.deepEqual(Array.from(await f.project.contributions(who.address)),Array.from(entries[i]));
    assert.equal(await f.token.balanceOf(who.address),entries[i].tokenUnits);
   }
   assert.equal(await f.token.balanceOf(f.project.target),CREATOR);
   assert.equal(await f.project.migrationGasRefundPending(),0n);
   assert.equal(await f.project.unaccountedSurplus(),0n);
   await assert.rejects(()=>f.project.connect(keeper).claimMigrationGasRefund.staticCall(keeper.address));
   console.log(JSON.stringify({targetETH:'1',gasUsed:String(receipt.gasUsed),gasAllowanceUnits:String(units),gasPriceWei:String(receipt.gasPrice),refundWei:String(result.refund),lpETHWei:String(result.final.ethAmount),burnedTokensWei:String(result.final.lockedTokenRemainder),saleTokensWei:String(baseline.saleSupply),openingSqrtPriceX96:String(result.final.sqrtPriceX96)}));
  }));

  test('current projects enforce the default 0.1 ETH migration budget, reject excess atomically, and fully reimburse accepted migrations',async()=>{
   const c=await createLocalChain();
   try{
    const owner=c.signers[0],manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[owner.address],fundraisingPolicyVersion:2});
    const metadata=id('minimum current project'),fee={value:eth('0.02')};
    const deadline=(await c.timestamp())+3*86400;
    for(const tooSmall of [eth('0.1'),eth('1')-2n]){
     await assert.rejects(()=>s.factory.createProjectDays.staticCall(tooSmall,3,metadata,'ipfs://minimum',fee));
     await assert.rejects(()=>s.factory.createNamedProjectDays.staticCall(tooSmall,3,metadata,'ipfs://minimum','Minimum project','MIN',fee));
     await assert.rejects(()=>s.factory.createProject.staticCall(tooSmall,deadline,metadata,'ipfs://minimum',fee));
    }
    const project=await c.createProject(s.factory,{target:eth('1')});
    const people=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i)));
    for(const who of people)await tx(project.connect(who).contribute(0,{value:eth('0.05')}));
    const keeper=c.signers[5],p=project.connect(keeper),budget=await p.migrationGasRefundLimit();
    assert.equal(budget,eth('0.1'));
    assert.equal(await p.MAX_MIGRATION_GAS_REFUND(),eth('0.3'));
    const prepared=await prepareMigration(p,{gasPrice:1000000000n});
    assert.equal(prepared.reimbursementLimit,budget);
    const units=prepared.onchainGasUnits,acceptedPrice=budget/units,excessPrice=acceptedPrice+1n;
    const token=new Contract(await p.token(),artifact('ProjectToken').abi,owner);
    const balances=await Promise.all(people.map(w=>token.balanceOf(w.address)));
    // Forced ETH cannot enlarge the currently configured reimbursement budget.
    await c.deploy('ForceEther',[p.target],owner,{value:eth('0.5')});
    await assert.rejects(()=>p.migrate.staticCall({gasPrice:excessPrice,gasLimit:16000000}),
     error=>error.revert?.name==='MigrationGasBudgetExceeded'&&error.revert.args[2]===budget);
    await assert.rejects(async()=>tx(p.migrate({gasPrice:excessPrice,gasLimit:16000000})));
    assert.equal(await p.state(),1n);
    assert.equal(await c.balance(p.target),eth('1.5'));
    assert.equal(await c.balance(manager.target),0n);
    assert.equal(await c.balance(s.coordinator.target),0n);
    assert.equal(await s.coordinator.migrated(p.target),false);
    assert.equal(await p.liquidityLocker(),'0x0000000000000000000000000000000000000000');
    assert.equal(await p.migrationGasRefund(),0n);
    assert.equal(await token.totalSupply(),TOTAL);
    assert.deepEqual(await Promise.all(people.map(w=>token.balanceOf(w.address))),balances);
    const before=await c.balance(keeper.address),receipt=await tx(p.migrate({gasPrice:acceptedPrice,gasLimit:16000000}));
    const refund=await p.migrationGasRefund();
    assert.equal(await p.state(),3n);
    assert.equal(await p.migrationGasUnits(),units);
    assert.equal(refund,units*acceptedPrice);
    assert.ok(refund<=budget&&budget-refund<units);
    assert.ok(refund>=receipt.fee);
    assert.equal(await c.balance(keeper.address)-before,refund-receipt.fee);
    assert.equal(await p.unaccountedSurplus(),eth('0.5'));
    const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,owner);
    assert.equal((await locker.initialQuote()).ethAmount,eth('0.49')-refund);
    assert.ok((await locker.initialQuote()).ethAmount>=eth('0.39'));
    await assert.rejects(()=>p.migrate.staticCall());
    console.log(JSON.stringify({migrationBudgetWei:String(budget),acceptedGasPriceWei:String(acceptedPrice),rejectedGasPriceWei:String(excessPrice),onchainUnits:String(units),actualFeeWei:String(receipt.fee),refundWei:String(refund),remainingLpWei:String((await locker.initialQuote()).ethAmount),forcedEthCannotRaiseBudget:true}));
   }finally{await c.close();}
  });

  test('real transaction gas price can reimburse above 0.01 ETH without consuming forced ETH',async()=>fixture(async(c,f)=>{
   const baseline=await f.coordinator.quote(eth('1'));
   await fund(c,f.project);
   await c.deploy('ForceEther',[f.project.target],c.signers[0],{value:eth('0.03')});
   const keeper=c.signers[5],before=await c.balance(keeper.address);
   const receipt=await tx(f.project.connect(keeper).migrate({gasLimit:16000000,gasPrice:3000000000n}));
   const result=await checkLaunch(c,f,baseline);
   assert.ok(result.refund>eth('0.01'));
   assert.equal(result.refund,await f.project.migrationGasUnits()*receipt.gasPrice);
   assert.equal(await c.balance(keeper.address)-before,result.refund-receipt.gasUsed*receipt.gasPrice);
   assert.equal(await c.balance(f.project.target),eth('0.03'));
   assert.equal(await f.project.unaccountedSurplus(),eth('0.03'));
  }));

  test('rejecting migration wallets retain a single payable credit without blocking the launch',async()=>fixture(async(c,f)=>{
   const baseline=await f.coordinator.quote(eth('1'));
   await fund(c,f.project);
   const wallet=await c.deploy('TestWallet');
   await tx(wallet.configure(true,false,f.project.target));
   await tx(wallet.migrate(f.project.target,{gasLimit:16000000}));
   const {refund}=await checkLaunch(c,f,baseline);
   assert.equal(await f.project.migrationGasBeneficiary(),wallet.target);
   assert.equal(await f.project.migrationGasRefundPending(),refund);
   assert.equal(await c.balance(f.project.target),refund);
   assert.equal(await f.project.unaccountedSurplus(),0n);
   await assert.rejects(()=>f.project.claimMigrationGasRefund.staticCall(c.signers[0].address));
   const recipient=c.signers[3],before=await c.balance(recipient.address);
   await tx(wallet.claimMigrationGas(f.project.target,recipient.address));
   assert.equal(await c.balance(recipient.address)-before,refund);
   assert.equal(await f.project.migrationGasRefundPending(),0n);
   await assert.rejects(()=>wallet.claimMigrationGas.staticCall(f.project.target,recipient.address));
  }));

  test('zero gas price finalizes without reimbursement or extra token burning',async()=>fixture(async(c,f)=>{
   const baseline=await f.coordinator.quote(eth('1'));
   await fund(c,f.project);
   await c.rpc('hardhat_setNextBlockBaseFeePerGas',['0x0']);
   await tx(f.project.migrate({gasLimit:16000000,gasPrice:0n}));
   const result=await checkLaunch(c,f,baseline);
   assert.equal(result.refund,0n);assert.equal(result.burned,0n);
  }));

  test('the 1% platform ceiling keeps LP backed and an unaffordable migration rolls back',async()=>fixture(async(c,f)=>{
   await assert.rejects(()=>f.coordinator.setMigrationFeeBps.staticCall(4999));
   assert.equal(await f.coordinator.migrationFeeBps(),100n);
   const baseline=await f.coordinator.quote(eth('1'));
   await fund(c,f.project);
   await assert.rejects(()=>f.project.migrate.staticCall({gasPrice:100000000000n}));
   assert.equal(await f.project.state(),1n);
   assert.equal(await c.balance(f.project.target),eth('1'));
   assert.equal(await c.balance(f.manager.target),0n);
   assert.equal(await f.token.totalSupply(),TOTAL);
   assert.equal(await f.coordinator.migrated(f.project.target),false);
   assert.equal(await f.project.migrationGasRefund(),0n);
   assert.equal(baseline.ethAmount,eth('0.49'));
  }));

  test('RPC prepares a parameter-free migration and previews the contract-metered reimbursement before the only positive LP deposit',async()=>fixture(async(c,f)=>{
   const baseline=await f.coordinator.quote(eth('1'));
   await fund(c,f.project);
   const keeper=c.signers[5],gasPrice=1000000000n;
   const prepared=await prepareMigration(f.project.connect(keeper),{gasPrice});
   const estimated=prepared.estimatedGasUnits;
   assert.equal(prepared.request.data,f.project.interface.encodeFunctionData('migrate'));
   assert.equal(prepared.estimatedReimbursementUnits,prepared.onchainGasUnits);
   assert.equal(prepared.estimatedGasCost,prepared.onchainGasUnits*gasPrice);
   assert.equal(prepared.estimatedTransactionCost,estimated*gasPrice);
   assert.equal(await f.project.state(),1n);assert.equal(await c.balance(f.manager.target),0n);
   const receipt=await tx(keeper.sendTransaction(prepared.request));
   const result=await checkLaunch(c,f,baseline);
   assert.equal(await f.project.migrationGasUnits(),prepared.onchainGasUnits);
   assert.equal(await f.project.migrationGasMeteredUnits(),prepared.onchainGasUnits);
   assert.equal(result.refund,prepared.onchainGasUnits*receipt.gasPrice);
   assert.equal(result.final.ethAmount,baseline.ethAmount-result.refund);
   assert.deepEqual(Array.from(result.final),Array.from(prepared.afterGas));
   const difference=estimated>receipt.gasUsed?estimated-receipt.gasUsed:receipt.gasUsed-estimated;
   assert.ok(difference*100n<receipt.gasUsed*5n,`estimate=${estimated}, receipt=${receipt.gasUsed}`);
   // Only the initial positive ModifyLiquidity event is allowed.
   const modifies=receipt.logs.map(l=>{try{return f.manager.interface.parseLog(l)}catch{return null}}).filter(e=>e?.name==='ModifyLiquidity');
   assert.equal(modifies.length,1);assert.ok(modifies[0].args.liquidityDelta>0n);
   console.log(JSON.stringify({rpcEstimatedGas:String(estimated),onchainGasUnits:String(prepared.onchainGasUnits),receiptGasUsed:String(receipt.gasUsed),gasPriceWei:String(receipt.gasPrice),refundWei:String(result.refund),lpETHWei:String(result.final.ethAmount),burnedTokensWei:String(result.final.lockedTokenRemainder)}));
  }));

  test('the removed external-estimate selector rejects even a maximum uint256 before changing custody',async()=>fixture(async(c,f)=>{
   await fund(c,f.project);
   assert.equal(f.project.interface.getFunction('migrateWithGasEstimate'),null);
   const obsolete=new Interface(['function migrateWithGasEstimate(uint256)']);
   for(const units of [0n,16000000n,(1n<<256n)-1n]){
    await assert.rejects(()=>c.signers[5].call({to:f.project.target,data:obsolete.encodeFunctionData('migrateWithGasEstimate',[units]),gasPrice:1000000000n}));
   }
   assert.equal(await f.project.state(),1n);assert.equal(await c.balance(f.project.target),eth('1'));
   assert.equal(await c.balance(f.manager.target),0n);assert.equal(await f.project.migrationGasRefund(),0n);
  }));

  test('the production LP suite uses onchain reimbursement and the same simulated final allocation',async()=>{
   const c=await createLocalChain();
   try{
    const owner=c.signers[0],manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[owner.address]});
    const project=await c.createProject(s.factory,{target:eth('1')});
    const token=new Contract(await project.token(),artifact('ProjectToken').abi,owner);
    const router=await c.deploy('V4TestRouter',[manager.target]);
    const f={manager,factory:s.factory,coordinator:s.coordinator,project,token,router,key:['0x0000000000000000000000000000000000000000',token.target,3000,60,s.hook.target]};
    const baseline=await s.coordinator.quote(eth('1'));
    await fund(c,project);
    const prepared=await prepareMigration(project.connect(c.signers[5]),{gasPrice:1000000000n});
    const receipt=await tx(c.signers[5].sendTransaction(prepared.request));
    const result=await checkLaunch(c,f,baseline);
    assert.deepEqual(Array.from(result.final),Array.from(prepared.afterGas));
    const difference=prepared.estimatedGasUnits-receipt.gasUsed;
    assert.ok(difference>=0n && difference*100n<receipt.gasUsed*5n);
    assert.equal(await project.migrationGasUnits(),prepared.onchainGasUnits);
    assert.equal(await project.migrationGasMeteredUnits(),prepared.onchainGasUnits);
    assert.equal(await s.factory.CONTRACT_VERSION(),13n);
    console.log(JSON.stringify({productionLP:true,rpcEstimatedGas:String(prepared.estimatedGasUnits),receiptGasUsed:String(receipt.gasUsed),refundWei:String(result.refund),lpETHWei:String(result.final.ethAmount),burnedTokensWei:String(result.final.lockedTokenRemainder)}));
   }finally{await c.close();}
  });

  test('current capped fundraising meters internally, covers normal migration gas, and does not reimburse a larger transaction gas limit',async()=>{
   const c=await createLocalChain();
   try{
    const owner=c.signers[0],manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[owner.address],fundraisingPolicyVersion:2});
    const project=await c.createProject(s.factory,{target:eth('1')});
    const wallets=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i)));
    for(const w of wallets)await tx(project.connect(w).contribute(0,{value:eth('0.05')}));
    assert.equal(await project.raised(),eth('1'));
    assert.equal(await project.contributorCount(),20n);
    const keeper=c.signers[5],p=project.connect(keeper),gasPrice=1000000000n;
    const prepared=await prepareMigration(p,{gasPrice});
    assert.equal(await project.state(),1n);
    assert.equal(await c.balance(manager.target),0n);
    assert.equal(await project.migrationGasUnits(),0n);
    assert.equal(prepared.request.data,project.interface.encodeFunctionData('migrate'));
    const snapshot=await c.rpc('evm_snapshot'),receipts=[],units=[],fees=[];
    for(const gasLimit of [14000000n,16000000n]){
     const before=await c.balance(keeper.address),receipt=await tx(p.migrate({gasPrice,gasLimit}));
     const metered=await project.migrationGasUnits(),refund=await project.migrationGasRefund();
     assert.equal(metered,await project.migrationGasMeteredUnits());
     assert.equal(metered,prepared.onchainGasUnits);
     assert.equal(refund,metered*receipt.gasPrice);
     assert.equal(await c.balance(keeper.address)-before,refund-receipt.fee);
     assert.ok(metered>=receipt.gasUsed,'normal migration gas must be covered');
     assert.ok((metered-receipt.gasUsed)*100n<receipt.gasUsed,'metering error stays below 1% in the current production suite');
     receipts.push(receipt.gasUsed);units.push(metered);fees.push(receipt.fee);
     if(gasLimit===14000000n)assert.equal(await c.rpc('evm_revert',[snapshot]),true);
    }
    assert.equal(units[0],units[1]);assert.equal(receipts[0],receipts[1]);
    assert.equal(await project.state(),3n);
    const locker=new Contract(await project.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,owner);
    assert.deepEqual(Array.from(await locker.initialQuote()),Array.from(prepared.afterGas));
    const refund=await project.migrationGasRefund();
    console.log(JSON.stringify({currentPolicy:true,projectAddress:project.target,targetWei:String(eth('1')),raisedWei:String(await project.raised()),contributorCount:20,state:'Launched',migrationGasPriceWei:String(await project.migrationGasPrice()),rpcEstimatedGas:String(prepared.estimatedGasUnits),onchainGasUnits:String(units[1]),receiptGasUsed:String(receipts[1]),actualPaidWei:String(fees[1]),refundWei:String(refund),differenceGas:String(units[1]-receipts[1]),differenceWei:String(refund-fees[1]),estimateAboveReceiptPercent:Number(units[1]-receipts[1])*100/Number(receipts[1])}));
   }finally{await c.close();}
  });

  test('a reimbursement callback cannot claim its credit twice or reenter migration',async()=>fixture(async(c,f)=>{
   const baseline=await f.coordinator.quote(eth('1'));
   await fund(c,f.project);
   const wallet=await c.deploy('MigrationGasWallet');
   await tx(wallet.migrate(f.project.target,{gasLimit:16000000}));
   const {refund}=await checkLaunch(c,f,baseline);
   assert.equal(await wallet.reentryResult(),1n);
   assert.equal(await c.balance(wallet.target),refund);
   assert.equal(await f.project.migrationGasRefundPending(),0n);
  }));
});

describe("Timelock budget and hard ceiling", {concurrency: false}, () => {
  test('migration reimbursement defaults to 0.1 ETH and configuration cannot exceed the 0.3 ETH hard ceiling',async()=>{
   const c=await createLocalChain();
   try{
    const f=await deployV4Fixture(c,{withProject:false});
    assert.equal(await f.coordinator.migrationGasRefundLimit(),eth('0.1'));
    assert.equal(await f.coordinator.MAX_MIGRATION_GAS_REFUND(),eth('0.3'));
    await assert.rejects(()=>f.coordinator.connect(c.signers[2]).setMigrationGasRefundLimit.staticCall(eth('0.2')),
     error=>error.revert?.name==='Unauthorized');
    for(const limit of [eth('0.1'),eth('0.2'),eth('0.3'),0n,eth('0.1')]){
     const previous=await f.coordinator.migrationGasRefundLimit();
     const receipt=await tx(f.coordinator.setMigrationGasRefundLimit(limit));
     const event=receipt.logs.map(l=>{try{return f.coordinator.interface.parseLog(l)}catch{return null}})
      .find(l=>l?.name==='MigrationGasRefundLimitChanged');
     assert.equal(event.args.previousLimit,previous);assert.equal(event.args.newLimit,limit);
     assert.equal(await f.coordinator.migrationGasRefundLimit(),limit);
    }
    for(const limit of [eth('0.3')+1n,eth('0.5'),eth('1'),(1n<<256n)-1n]){
     await assert.rejects(()=>f.coordinator.setMigrationGasRefundLimit.staticCall(limit),
      error=>error.revert?.name==='InvalidMigrationGasRefundLimit');
     await assert.rejects(()=>tx(f.coordinator.setMigrationGasRefundLimit(limit,{gasLimit:100000})));
     assert.equal(await f.coordinator.migrationGasRefundLimit(),eth('0.1'));
    }
   }finally{await c.close();}
  });

  test('only a delayed Timelock operation changes the shared gas budget and an existing project uses it at migration',async()=>{
   const c=await createLocalChain();
   try{
    const owner=c.signers[0],manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,
     validators:[c.signers[5].address],fundraisingPolicyVersion:2});
    const p=await c.createProject(s.factory,{target:eth('2')});
    assert.equal(await p.migrationGasRefundLimit(),eth('0.1'));
    assert.equal(await p.MAX_MIGRATION_GAS_REFUND(),eth('0.3'));
    for(const who of [owner,c.signers[2],c.signers[5]])
     await assert.rejects(()=>s.coordinator.connect(who).setMigrationGasRefundLimit.staticCall(eth('0.2')),
      error=>error.revert?.name==='Unauthorized');
    const data=s.coordinator.interface.encodeFunctionData('setMigrationGasRefundLimit',[eth('0.2')]);
    const args=[s.coordinator.target,0,data,ZeroHash,id('raise migration budget to 0.2 ETH')];
    await tx(s.timelock.schedule(...args,172800));
    await assert.rejects(()=>s.timelock.execute.staticCall(...args));
    assert.equal(await p.migrationGasRefundLimit(),eth('0.1'));
    await c.mineAt(await c.timestamp()+172800);
    await tx(s.timelock.execute(...args));
    assert.equal(await p.migrationGasRefundLimit(),eth('0.2'));
    assert.equal(await p.migrationFeeBps(),100n);
    const wallets=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i)));
    for(const who of wallets)await tx(p.connect(who).contribute(0,{value:eth('0.1')}));
    const keeper=c.signers[5],project=p.connect(keeper),prepared=await prepareMigration(project,{gasPrice:1000000000n});
    assert.equal(prepared.reimbursementLimit,eth('0.2'));
    const price=eth('0.15')/prepared.onchainGasUnits;
    const before=await c.balance(keeper.address),receipt=await tx(project.migrate({gasPrice:price,gasLimit:16000000}));
    const refund=await project.migrationGasRefund();
    assert.ok(refund>eth('0.1')&&refund<=eth('0.2'));
    assert.ok(refund>=receipt.fee);
    assert.equal(await c.balance(keeper.address)-before,refund-receipt.fee);
    const locker=new Contract(await project.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,owner);
    assert.equal((await locker.initialQuote()).ethAmount,eth('0.98')-refund);
    assert.equal(await project.state(),3n);
    assert.equal(await project.migrationGasRefundPending(),0n);
    async function configure(limit,salt){
     const payload=s.coordinator.interface.encodeFunctionData('setMigrationGasRefundLimit',[limit]);
     const operation=[s.coordinator.target,0,payload,ZeroHash,id(salt)];
     await tx(s.timelock.schedule(...operation,172800));
     await c.mineAt(await c.timestamp()+172800);
     return operation;
    }
    await tx(s.timelock.execute(...await configure(eth('0.3'),'inclusive 0.3 ETH limit')));
    assert.equal(await project.migrationGasRefundLimit(),eth('0.3'));
    const invalid=await configure(eth('0.3')+1n,'cannot exceed 0.3 ETH by one wei');
    await assert.rejects(()=>s.timelock.execute.staticCall(...invalid));
    await assert.rejects(()=>tx(s.timelock.execute(...invalid,{gasLimit:200000})));
    assert.equal(await project.migrationGasRefundLimit(),eth('0.3'));
    await tx(s.timelock.execute(...await configure(eth('0.1'),'lower gas limit again')));
    assert.equal(await project.migrationGasRefundLimit(),eth('0.1'));
    assert.equal(await project.migrationGasRefund(),refund);
   }finally{await c.close();}
  });

  test('the 0.3 ETH maximum rejects excess gas charges and preserves at least 0.19 ETH LP at the minimum target',async()=>{
   const c=await createLocalChain();
   try{
    const f=await deployV4Fixture(c,{withProject:false});
    f.project=await c.createProject(f.factory,{target:eth('1')});
    await tx(f.coordinator.setMigrationGasRefundLimit(eth('0.3')));
    for(const [i,amount] of [[2,'0.5'],[3,'0.25'],[4,'0.25']])
     await tx(f.project.connect(c.signers[i]).contribute(0,{value:eth(amount)}));
    const p=f.project.connect(c.signers[5]),prepared=await prepareMigration(p,{gasPrice:1000000000n});
    assert.equal(prepared.reimbursementLimit,eth('0.3'));
    const units=prepared.onchainGasUnits,price=eth('0.3')/units+1n;
    assert.ok(units*price>eth('0.3'));
    await assert.rejects(()=>p.migrate.staticCall({gasPrice:price,gasLimit:16000000}),
     error=>error.revert?.name==='MigrationGasBudgetExceeded');
    await assert.rejects(()=>tx(p.migrate({gasPrice:price,gasLimit:16000000})));
    assert.equal(await p.state(),1n);assert.equal(await c.balance(p.target),eth('1'));
    assert.equal(await c.balance(f.manager.target),0n);assert.equal(await p.liquidityLocker(),ZeroAddress);
    assert.equal(await f.coordinator.migrated(p.target),false);assert.equal(await p.migrationGasRefund(),0n);
    // A charge just below the hard ceiling remains reimbursable. For a one-ETH
    // target and one-percent platform fee, at least 0.19 ETH stays in initial LP.
    const allowedPrice=eth('0.3')/units;
    await tx(p.migrate({gasPrice:allowedPrice,gasLimit:16000000}));
    const refund=await p.migrationGasRefund();
    const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
    const remaining=(await locker.initialQuote()).ethAmount;
    assert.ok(refund<=eth('0.3')&&eth('0.3')-refund<units);
    assert.equal(remaining,eth('0.49')-refund);
    assert.ok(remaining>=eth('0.19')&&remaining-eth('0.19')<units);
    console.log(JSON.stringify({configuredLimitWei:String(await p.migrationGasRefundLimit()),
     refundWei:String(refund),remainingLpWei:String(remaining),positiveLpGuardIsNotReserveFloor:true}));
   }finally{await c.close();}
  });
});
