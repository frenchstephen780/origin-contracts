import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {Contract, Interface, parseEther as eth, id, ZeroHash, ZeroAddress} from 'ethers';
import {artifact} from '../scripts/local-chain.mjs';
import {deployV4Fixture} from '../scripts/local-v4.mjs';
import {prepareMigration} from '../scripts/migration-gas.mjs';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';
import {tx, withLocalChain} from './helpers.mjs';

const EXECUTOR='0x8330F65fa8DEd47ED944f1981fAe9D9a7633E1d9';
const DEFAULT_UNITS=8_000_000n, TOTAL=eth('100000000'), CREATOR=eth('5000000');
const DAY=86400;

async function fixture(run) {
 return withLocalChain(async c=>{
  const f=await deployV4Fixture(c,{withProject:false});
  f.project=await c.createProject(f.factory,{target:eth('1')});
  f.token=new Contract(await f.project.token(),artifact('ProjectToken').abi,c.signers[0]);
  f.router=await c.deploy('V4TestRouter',[f.manager.target]);
  f.key=[ZeroAddress,f.token.target,3000,60,f.hook.target];
  for(const [i,amount] of [[2,'0.5'],[3,'0.25'],[4,'0.25']])
   await tx(f.project.connect(c.signers[i]).contribute(0,{value:eth(amount),gasLimit:600000}));
  f.authorized=f.project.connect(c.migrationSigner);
  await run(c,f);
 });
}

async function checkLaunch(c,f,baseline) {
 const p=f.project,refund=await p.migrationGasRefund();
 const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
 const final=await locker.initialQuote(),burned=await locker.migrationTokensBurned();
 const gov=new Contract(await p.governance(),artifact('ProjectGovernance').abi,c.signers[0]);
 const vault=new Contract(await gov.devVault(),artifact('ProjectVault').abi,c.signers[0]);
 const platformFee=eth('1')*await p.migrationFeeBps()/10000n;
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
 assert.equal(await p.migrationGasBeneficiary(),EXECUTOR);
 assert.equal(await p.migrationGasRefundPending(),0n);
 assert.equal(await p.migrationGasMeteredUnits(),await p.migrationGasUnits());
 await assert.rejects(()=>f.authorized.migrate.staticCall(),e=>e.revert?.name==='MigrationUnavailable');
 await assert.rejects(()=>locker.finalizeMigration.staticCall(1));
 return {locker,refund,burned,final};
}

describe('Backend authorization and fixed reimbursement allowance',{concurrency:false},()=>{
 test('migrate keeps a parameter-free ABI and rejects founders, holders, platform and contract wallets',async()=>fixture(async(c,f)=>{
  assert.equal(f.project.interface.getFunction('migrate').inputs.length,0);
  assert.equal(await f.coordinator.migrationExecutor(),EXECUTOR);
  assert.equal(await f.project.migrationExecutor(),EXECUTOR);
  assert.equal(await f.coordinator.migrationReimbursementGasUnits(),DEFAULT_UNITS);
  for(const who of c.signers)
   await assert.rejects(()=>f.project.connect(who).migrate.staticCall({gasPrice:1_000_000_000n}),e=>e.revert?.name==='Unauthorized');
  const wallet=await c.deploy('TestWallet');
  await assert.rejects(()=>wallet.migrate.staticCall(f.project.target));
  const removed=new Interface(['function migrate(uint256)','function migrateWithGasEstimate(uint256)']);
  for(const signature of ['migrate(uint256)','migrateWithGasEstimate'])
   await assert.rejects(()=>c.migrationSigner.call({to:f.project.target,data:removed.encodeFunctionData(signature,[DEFAULT_UNITS])}));
  assert.equal(await f.project.state(),1n);assert.equal(await c.balance(f.project.target),eth('1'));
  assert.equal(await f.coordinator.migrated(f.project.target),false);
  assert.equal(await f.project.migrationGasRefund(),0n);
 }));

 test('allowance times actual transaction gas price preserves subscriptions, founder reserve, price and allocation',async()=>fixture(async(c,f)=>{
  const baseline=await f.coordinator.quote(eth('1'));
  const entries=await Promise.all(c.signers.slice(2,5).map(w=>f.project.contributions(w.address)));
  const before=await c.balance(EXECUTOR);
  const receipt=await tx(f.authorized.migrate({gasLimit:16_000_000,gasPrice:1_000_000_000n}));
  const result=await checkLaunch(c,f,baseline);
  assert.equal(await f.project.migrationGasUnits(),DEFAULT_UNITS);
  assert.equal(await f.project.migrationGasPrice(),receipt.gasPrice);
  assert.equal(result.refund,DEFAULT_UNITS*receipt.gasPrice);
  assert.equal(await c.balance(EXECUTOR)-before,result.refund-receipt.fee);
  for(let i=0;i<entries.length;i++) {
   const who=c.signers[i+2];
   assert.deepEqual(Array.from(await f.project.contributions(who.address)),Array.from(entries[i]));
   assert.equal(await f.token.balanceOf(who.address),entries[i].tokenUnits);
  }
  assert.equal(await f.project.unaccountedSurplus(),0n);
  assert.ok(result.burned>0n);
  console.log(JSON.stringify({fixedAllowanceUnits:String(DEFAULT_UNITS),actualGasUsed:String(receipt.gasUsed),refundWei:String(result.refund),actualFeeWei:String(receipt.fee),openingPriceUnchanged:true}));
 }));

 test('increasing transaction gasLimit does not increase the reimbursement',async()=>fixture(async(c,f)=>{
  const checkpoint=await c.rpc('evm_snapshot'),refunds=[],gasUsed=[];
  for(const gasLimit of [14_000_000n,16_000_000n]) {
   const receipt=await tx(f.authorized.migrate({gasLimit,gasPrice:1_000_000_000n}));
   refunds.push(await f.project.migrationGasRefund());gasUsed.push(receipt.gasUsed);
   assert.equal(await f.project.migrationGasUnits(),DEFAULT_UNITS);
   if(gasLimit===14_000_000n)assert.equal(await c.rpc('evm_revert',[checkpoint]),true);
  }
  assert.equal(refunds[0],refunds[1]);assert.equal(gasUsed[0],gasUsed[1]);
 }));

 test('effective EIP-1559 gas price is used instead of the sender maximum fee',async()=>fixture(async(c,f)=>{
  await c.rpc('hardhat_setNextBlockBaseFeePerGas',['0x3b9aca00']);
  const receipt=await tx(f.authorized.migrate({gasLimit:16_000_000,maxFeePerGas:10_000_000_000n,maxPriorityFeePerGas:500_000_000n}));
  assert.equal(receipt.gasPrice,1_500_000_000n);
  assert.equal(await f.project.migrationGasPrice(),receipt.gasPrice);
  assert.equal(await f.project.migrationGasRefund(),DEFAULT_UNITS*receipt.gasPrice);
  assert.ok(receipt.gasPrice<10_000_000_000n);
 }));

 test('excess reimbursement rejects atomically and forced ETH cannot increase the budget',async()=>fixture(async(c,f)=>{
  await c.deploy('ForceEther',[f.project.target],c.signers[0],{value:eth('0.5')});
  const balances=await Promise.all(c.signers.slice(2,5).map(w=>f.token.balanceOf(w.address)));
  const excessive=eth('0.1')/DEFAULT_UNITS+1n;
  await assert.rejects(()=>f.authorized.migrate.staticCall({gasLimit:16_000_000,gasPrice:excessive}),e=>e.revert?.name==='MigrationGasBudgetExceeded');
  await assert.rejects(()=>tx(f.authorized.migrate({gasLimit:16_000_000,gasPrice:excessive})));
  assert.equal(await f.project.state(),1n);assert.equal(await c.balance(f.project.target),eth('1.5'));
  assert.equal(await c.balance(f.manager.target),0n);assert.equal(await c.balance(f.coordinator.target),0n);
  assert.equal(await f.project.liquidityLocker(),ZeroAddress);assert.equal(await f.project.governance(),ZeroAddress);
  assert.equal(await f.coordinator.migrated(f.project.target),false);assert.equal(await f.project.migrationGasUnits(),0n);
  assert.equal(await f.token.totalSupply(),TOTAL);
  assert.deepEqual(await Promise.all(c.signers.slice(2,5).map(w=>f.token.balanceOf(w.address))),balances);
  await tx(f.authorized.migrate({gasLimit:16_000_000,gasPrice:eth('0.1')/DEFAULT_UNITS}));
  assert.equal(await f.project.migrationGasRefund(),eth('0.1'));
  const locker=new Contract(await f.project.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
  assert.equal((await locker.initialQuote()).ethAmount,eth('0.39'));
  assert.equal(await f.project.unaccountedSurplus(),eth('0.5'));
 }));

 test('an execution gas shortage rolls back and a retry can use enough transaction gas',async()=>fixture(async(c,f)=>{
  await assert.rejects(()=>tx(f.authorized.migrate({gasLimit:1_000_000,gasPrice:1_000_000_000n})));
  assert.equal(await c.balance(f.project.target),eth('1'));assert.equal(await f.project.state(),1n);
  assert.equal(await f.coordinator.migrated(f.project.target),false);assert.equal(await f.project.migrationGasRefund(),0n);
  await tx(f.authorized.migrate({gasLimit:16_000_000,gasPrice:1_000_000_000n}));
  assert.equal(await f.project.state(),3n);
 }));

 test('zero gas price produces no reimbursement and no extra liquidity-token burn',async()=>fixture(async(c,f)=>{
  const baseline=await f.coordinator.quote(eth('1'));
  await c.rpc('hardhat_setNextBlockBaseFeePerGas',['0x0']);
  await tx(f.authorized.migrate({gasLimit:16_000_000,gasPrice:0n}));
  const result=await checkLaunch(c,f,baseline);
  assert.equal(result.refund,0n);assert.equal(result.burned,0n);
 }));

 test('backend failure does not prevent refunds after the migration timeout',async()=>fixture(async(c,f)=>{
  await c.mineAt(await f.project.fundedAt()+3n*BigInt(DAY));
  assert.equal(await f.project.state(),2n);
  await assert.rejects(()=>f.authorized.migrate.staticCall(),e=>e.revert?.name==='MigrationUnavailable');
  for(const [i,amount] of [[2,'0.5'],[3,'0.25'],[4,'0.25']]) {
   const who=c.signers[i],before=await c.balance(who.address),receipt=await tx(f.project.connect(who).refund(who.address));
   assert.equal(await c.balance(who.address)-before,eth(amount)-receipt.fee);
   assert.equal(await f.token.balanceOf(who.address),0n);
  }
  assert.equal(await c.balance(f.project.target),0n);
 }));

 test('RPC execution estimate and policy reimbursement remain separate in no-argument migrate',async()=>fixture(async(c,f)=>{
  const prepared=await prepareMigration(f.authorized,{gasPrice:1_000_000_000n});
  assert.equal(prepared.request.data,f.project.interface.encodeFunctionData('migrate'));
  assert.equal(prepared.onchainGasUnits,DEFAULT_UNITS);
  assert.equal(prepared.estimatedGasCost,DEFAULT_UNITS*1_000_000_000n);
  assert.ok(prepared.request.gasLimit>prepared.estimatedGasUnits);
  assert.equal(await f.project.state(),1n);
  const receipt=await tx(c.migrationSigner.sendTransaction(prepared.request));
  assert.equal(await f.project.migrationGasRefund(),DEFAULT_UNITS*receipt.gasPrice);
  const locker=new Contract(await f.project.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
  assert.deepEqual(Array.from(await locker.initialQuote()),Array.from(prepared.afterGas));
 }));
});

describe('Reimbursement policy configuration and hard budget',{concurrency:false},()=>{
 test('Gas-unit configuration validates values, restricts authority and emits previous and new amounts',async()=>fixture(async(c,f)=>{
  await assert.rejects(()=>f.coordinator.connect(c.migrationSigner).setMigrationReimbursementGasUnits.staticCall(9_000_000),e=>e.revert?.name==='Unauthorized');
  for(const units of [0n,20_999n,1n<<32n,(1n<<256n)-1n]) {
   await assert.rejects(()=>f.coordinator.setMigrationReimbursementGasUnits.staticCall(units),e=>e.revert?.name==='InvalidMigrationReimbursementGasUnits');
   assert.equal(await f.coordinator.migrationReimbursementGasUnits(),DEFAULT_UNITS);
  }
  const receipt=await tx(f.coordinator.setMigrationReimbursementGasUnits(9_000_000));
  const event=receipt.logs.map(l=>{try{return f.coordinator.interface.parseLog(l)}catch{return null}}).find(l=>l?.name==='MigrationReimbursementGasUnitsChanged');
  assert.equal(event.args.previousUnits,DEFAULT_UNITS);assert.equal(event.args.newUnits,9_000_000n);
  await tx(f.authorized.migrate({gasLimit:16_000_000,gasPrice:1_000_000_000n}));
  assert.equal(await f.project.migrationGasUnits(),9_000_000n);assert.equal(await f.project.migrationGasRefund(),eth('0.009'));
  await tx(f.coordinator.setMigrationReimbursementGasUnits(10_000_000));
  assert.equal(await f.project.migrationGasUnits(),9_000_000n);assert.equal(await f.project.migrationGasRefund(),eth('0.009'));
 }));

 test('default budget stays 0.1 ETH and the 0.3 ETH ceiling retains positive minimum-target liquidity',async()=>fixture(async(c,f)=>{
  assert.equal(await f.coordinator.migrationGasRefundLimit(),eth('0.1'));
  assert.equal(await f.coordinator.MAX_MIGRATION_GAS_REFUND(),eth('0.3'));
  await assert.rejects(()=>f.coordinator.connect(c.migrationSigner).setMigrationGasRefundLimit.staticCall(eth('0.3')),e=>e.revert?.name==='Unauthorized');
  for(const limit of [eth('0.3')+1n,eth('0.5'),(1n<<256n)-1n])
   await assert.rejects(()=>f.coordinator.setMigrationGasRefundLimit.staticCall(limit),e=>e.revert?.name==='InvalidMigrationGasRefundLimit');
  await tx(f.coordinator.setMigrationGasRefundLimit(eth('0.3')));
  await assert.rejects(()=>f.authorized.migrate.staticCall({gasLimit:16_000_000,gasPrice:eth('0.3')/DEFAULT_UNITS+1n}),e=>e.revert?.name==='MigrationGasBudgetExceeded');
  await tx(f.authorized.migrate({gasLimit:16_000_000,gasPrice:eth('0.3')/DEFAULT_UNITS}));
  assert.equal(await f.project.migrationGasRefund(),eth('0.3'));
  const locker=new Contract(await f.project.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
  assert.equal((await locker.initialQuote()).ethAmount,eth('0.19'));
 }));

 test('a delayed Timelock update reaches already-created projects while keeping economic allocations and ABI',async()=>withLocalChain(async c=>{
  const owner=c.signers[0],manager=await c.deploy('PoolManager',[owner.address]);
  const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[owner.address],fundraisingPolicyVersion:2});
  assert.equal(await s.factory.CONTRACT_VERSION(),16n);
  const p=await c.createProject(s.factory,{target:eth('1')}),sale=await p.SALE_SUPPLY();
  const people=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i)));
  for(const who of people)await tx(p.connect(who).contribute(0,{value:eth('0.05')}));
  const token=new Contract(await p.token(),artifact('ProjectToken').abi,owner);
  const balances=await Promise.all(people.map(w=>token.balanceOf(w.address))),baseline=await s.coordinator.quote(eth('1'));
  for(const who of [owner,c.signers[2],c.migrationSigner])
   await assert.rejects(()=>s.coordinator.connect(who).setMigrationReimbursementGasUnits.staticCall(50_000_000),e=>e.revert?.name==='Unauthorized');
  const data=s.coordinator.interface.encodeFunctionData('setMigrationReimbursementGasUnits',[50_000_000]);
  const args=[s.coordinator.target,0,data,ZeroHash,id('network gas schedule allowance')];
  await tx(s.timelock.schedule(...args,2*DAY));await assert.rejects(()=>s.timelock.execute.staticCall(...args));
  assert.equal(await s.coordinator.migrationReimbursementGasUnits(),DEFAULT_UNITS);
  await c.mineAt(await c.timestamp()+2*DAY);await tx(s.timelock.execute(...args));
  assert.equal(await s.coordinator.migrationReimbursementGasUnits(),50_000_000n);
  assert.equal(await p.migrationGasUnits(),0n);assert.equal(await p.migrationGasRefundLimit(),eth('0.1'));
  const receipt=await tx(p.connect(c.migrationSigner).migrate({gasLimit:16_000_000,gasPrice:1_000_000_000n}));
  console.log(JSON.stringify({productionCommunityPolicy:true,actualGasUsed:String(receipt.gasUsed),configuredGasUnits:'50000000',actualFeeWei:String(receipt.fee)}));
  assert.equal(await p.migrationGasUnits(),50_000_000n);assert.equal(await p.migrationGasRefund(),eth('0.05'));
  assert.equal(await p.migrationGasPrice(),receipt.gasPrice);assert.equal(await p.SALE_SUPPLY(),sale);assert.equal(await p.migrationFeeBps(),100n);
  assert.deepEqual(await Promise.all(people.map(w=>token.balanceOf(w.address))),balances);
  assert.equal(await token.balanceOf(p.target),CREATOR);
  const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,owner),final=await locker.initialQuote();
  assert.equal(final.sqrtPriceX96,baseline.sqrtPriceX96);assert.equal(final.saleSupply,sale);
  assert.equal(final.ethAmount,eth('0.44'));assert.ok(final.tokenAmount<baseline.tokenAmount);
  assert.equal(await token.totalSupply(),TOTAL-final.lockedTokenRemainder);
  const gov=new Contract(await p.governance(),artifact('CommunityGovernance').abi,owner);
  const vault=new Contract(await gov.devVault(),artifact('ProjectVault').abi,owner);
  assert.equal(await vault.availableFunds(),eth('0.5'));assert.equal(await p.state(),3n);
 }));
});
