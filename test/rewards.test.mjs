import {describe, beforeEach, afterEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {Contract, parseEther, ZeroAddress, MaxUint256, Wallet, parseEther as eth, id, ZeroHash, AbiCoder, keccak256, concat} from 'ethers';
import {artifact, createLocalChain} from '../scripts/local-chain.mjs';
import {deployV4Fixture, fundAndLaunch, swap} from '../scripts/local-v4.mjs';
import {tx, withLocalChain} from './helpers.mjs';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';

describe("Holding age and holder claims", {concurrency: false}, () => {
  let chain,h,token,rewards,owner,a,b,c,start;
  const eth=parseEther,DAY=86400,DEAD='0x000000000000000000000000000000000000dEaD';
  const weight=t=>7-6*20**(-t/23);
  const close=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(Number(actual)/1e18-expected)<tolerance,`${actual} != ${expected}`);
  beforeEach(async()=>{
   chain=await createLocalChain();[owner,a,b,c]=chain.signers;
   h=await chain.deploy('FeeRewardsHarness');
   const standaloneToken=await chain.deploy('ProjectToken',[h.target,h.target,'0x0000000000000000000000000000000000001234']);
   await tx(h.initialize(standaloneToken.target));
   token=new Contract(await h.token(),artifact('ProjectToken').abi,owner);
   rewards=new Contract(await h.rewards(),artifact('ProjectFeeRewards').abi,owner);
   start=await chain.timestamp()+10;
  });
  afterEach(async()=>chain?.close());
  async function at(seconds){await chain.rpc('evm_setNextBlockTimestamp',[start+seconds]);}
  async function ready(){await chain.mineAt(Math.max(Number(await rewards.nextRoundAt()),await chain.timestamp()+1));}
  async function finish(){
   for(let i=0;i<60;i++){
    await tx(rewards.process(1_500_000,{gasLimit:1_700_000}));
    if((await rewards.currentRound()).phase===0n)return;
   }
   assert.fail('round did not finish');
  }

  test('weight is 6.7 at 23 days, 6.985 at 46 days and stays strictly below seven',async()=>{
   await at(0);await tx(h.give(a.address,eth('1000')));
   await chain.mineAt(start+23*DAY);close(await token.currentShares(a.address),6700);
   await chain.mineAt(start+46*DAY);close(await token.currentShares(a.address),6985);
   await chain.mineAt(start+10000*DAY);assert.ok(await token.currentShares(a.address)<eth('7000'));
  });

  test('onchain weights reproduce both user examples without receipt lots',async()=>{
   await at(0);await tx(h.give(a.address,eth('1000')));
   await at(5*DAY);await tx(token.connect(a).transfer(h.target,eth('500')));
   await at(15*DAY);await tx(h.give(a.address,eth('800')));
   await at(17*DAY);await tx(token.connect(a).transfer(h.target,eth('1100')));
   await chain.mineAt(start+19*DAY);
   close(await token.currentShares(a.address),(500*weight(19)+800*weight(4))*200/1300);
   await at(19*DAY+1);await tx(h.give(a.address,eth('600')));
   await chain.mineAt(start+21*DAY+1);
   close(await token.currentShares(a.address),(500*weight(21+1/DAY)+800*weight(6+1/DAY))*200/1300+600*weight(2));
   assert.equal(await token.holderCount(),1n);
  });

  test('balance <= one clears age, re-entry restarts all balance, zero/self transfers preserve age',async()=>{
   await at(0);await tx(h.give(a.address,eth('1000')));
   await at(90*DAY);await tx(token.connect(a).transfer(h.target,eth('999')));
   assert.equal(await token.currentShares(a.address),0n);
   await at(110*DAY);await tx(h.give(a.address,eth('99')));
   close(await token.currentShares(a.address),100);
   await at(112*DAY);await tx(token.connect(a).transfer(a.address,eth('100')));
   close(await token.currentShares(a.address),100*weight(2));
   await at(114*DAY);await tx(token.connect(b).transfer(a.address,0));
   close(await token.currentShares(a.address),100*weight(4));
   await tx(token.connect(a).burn(eth('100')));assert.equal(await token.currentShares(a.address),0n);
   assert.equal(await token.holderCount(),1n);
  });

  test('round threshold is totalSupply / 20000, includes equality and ignores dead balance',async()=>{
   const threshold=await token.totalSupply()/20000n;
   await tx(h.give(a.address,threshold));await tx(h.give(b.address,threshold-1n));
   await tx(h.give(DEAD,eth('1000000')));
   await tx(h.fund({value:eth('1')}));await ready();await finish();
   const r=await rewards.currentRound();
   assert.equal(r.threshold,threshold);assert.equal(r.totalShares,await rewards.frozenWeights(a.address).then(x=>x.shares));
   assert.equal(await rewards.claimable(a.address),eth('1'));assert.equal(await rewards.claimable(b.address),0n);
   assert.equal(await token.currentShares(DEAD),0n);assert.equal(await rewards.claimable(h.target),0n);
  });

  test('burn adjusts NEXT round threshold, rounding requires ceil and old pending survives selling out',async()=>{
   await tx(h.give(a.address,eth('6000')));await tx(h.give(b.address,eth('6000')));
   await tx(token.connect(b).burn(1));
   await tx(h.fund({value:1001n}));await ready();await finish();
   assert.equal((await rewards.currentRound()).threshold,(await token.totalSupply()+19999n)/20000n);
   const pending=await rewards.claimable(a.address);assert.ok(pending>0n);
   await tx(token.connect(a).transfer(h.target,eth('6000')));
   assert.equal(await token.currentShares(a.address),0n);assert.equal(await rewards.claimable(a.address),pending);
   const before=await chain.balance(c.address);await tx(rewards.connect(a).claimTo(c.address));
   assert.equal(await chain.balance(c.address)-before,pending);
   await assert.rejects(()=>rewards.connect(a).claim.staticCall());
   assert.equal(await chain.balance(rewards.target),await rewards.accountedFunds());
  });

  test('processing is bounded, freezes shares before transfers and credits only after denominator pass',async()=>{
   await tx(h.give(a.address,eth('10000')));await tx(h.give(b.address,eth('10000')));
   await tx(token.connect(b).approve(h.target,MaxUint256));
   for(let i=0;i<12;i++)await tx(h.give(Wallet.createRandom().address,eth('4000')));
   await tx(h.fund({value:eth('1')}));await ready();
   await tx(rewards.process(250000,{gasLimit:300000}));
   let r=await rewards.currentRound();assert.equal(r.phase,1n);assert.equal(await rewards.totalClaimable(),0n);
   const expected=(await token.recentWeight(b.address,r.snapshotBlock,r.weightTime)).shares;
   // Low transaction gas deliberately prevents optional auto batching; mandatory
   // capture and transfer accounting must still persist.
   await tx(token.connect(b).transfer(h.target,eth('10000'),{gasLimit:300000}));
   await tx(h.give(c.address,eth('10000'),{gasLimit:350000}));
   await tx(h.changeTwice(b.address,eth('5000'),{gasLimit:700000}));
   await tx(h.fund({value:eth('2')}));
   await finish();r=await rewards.currentRound();
   assert.equal((await rewards.frozenWeights(b.address)).shares,expected);
   assert.equal(await rewards.claimable(b.address),r.amount*expected/r.totalShares);
   assert.equal(await rewards.claimable(c.address),0n);
   assert.ok(await rewards.queuedFunds()>=eth('2'));
   assert.equal(await chain.balance(rewards.target),await rewards.accountedFunds());
  });

  test('a transfer advances a due round and only accrues pending rewards, never sends ETH',async(t)=>{
   await tx(h.give(a.address,eth('10000')));await tx(h.give(b.address,eth('10000')));
   const ordinary=await tx(token.connect(a).transfer(h.target,1n,{gasLimit:900000}));
   await tx(h.fund({value:eth('1')}));await ready();
   const balanceB=await chain.balance(b.address);
   let transfers=0;const gas=[];
   do {const receipt=await tx(token.connect(a).transfer(h.target,1n,{gasLimit:900000}));gas.push(receipt.gasUsed.toString());transfers++;}
   while((await rewards.roundCount()===0n||(await rewards.currentRound()).phase!==0n)&&transfers<15);
   assert.ok(transfers<15);assert.equal(await rewards.roundCount(),1n);
   assert.ok(await rewards.claimable(b.address)>0n);assert.equal(await chain.balance(b.address),balanceB);
   await tx(token.connect(a).transfer(h.target,1n,{gasLimit:900000}));assert.equal(await rewards.roundCount(),1n);
   t.diagnostic(`same holder -> protocol transfer gas: ordinary=${ordinary.gasUsed}; due/processing=${gas.join(',')}; auto call cap=350000`);
  });

  test('same-transaction temporary tokens cannot obtain the round snapshot shares',async()=>{
   await tx(h.give(a.address,eth('10000')));
   await tx(token.connect(b).approve(h.target,MaxUint256));
   await tx(h.fund({value:eth('1')}));await ready();
   await tx(h.roundTrip(b.address,eth('10000'),{gasLimit:2000000}));await finish();
   assert.equal(await rewards.claimable(b.address),0n);assert.equal(await rewards.claimable(a.address),eth('1'));
  });

  test('no eligible holders carries funds forward, failed receive preserves debt, unauthorized funding rejected',async()=>{
   await tx(h.give(a.address,eth('1')));await tx(h.fund({value:eth('1')}));await ready();await finish();
   assert.equal(await rewards.queuedFunds(),eth('1'));assert.equal(await rewards.totalClaimable(),0n);
   await assert.rejects(()=>rewards.connect(b).deposit.staticCall({value:1}));
   await assert.rejects(()=>rewards.capture(a.address));
   await assert.rejects(()=>token.connect(a).configureFeeRewards(rewards.target));
   const reject=await chain.deploy('RejectFeeRewardRecipient');await tx(h.give(reject.target,eth('10000')));
   await ready();await finish();const owed=await rewards.claimable(reject.target);assert.equal(owed,eth('1'));
   await assert.rejects(()=>reject.collect.staticCall(rewards.target));assert.equal(await rewards.claimable(reject.target),owed);
   await tx(reject.collectTo(rewards.target,c.address));assert.equal(await rewards.claimable(reject.target),0n);
  });

  test('arbitrary elapsed time stays below 7x, principal is reserved after termination',async()=>{
   await tx(h.give(a.address,eth('10000')));await tx(h.fund({value:eth('1')}));
   await chain.mineAt((await chain.timestamp())+80*365*DAY);
   const shares=await token.currentShares(a.address);assert.ok(shares<eth('70000'));assert.ok(shares>eth('69999'));
   await tx(h.end());await assert.rejects(()=>h.fund.staticCall({value:1}));
   await finish();assert.equal(await rewards.claimable(a.address),eth('1'));
   await tx(rewards.connect(a).claim());assert.equal(await rewards.accountedFunds(),0n);
  });

  test('successive rounds preserve old debts, use fresh snapshots and isolate forced ETH',async()=>{
   await tx(h.give(a.address,eth('10000')));await tx(h.give(b.address,eth('5000')));
   await tx(h.fund({value:10001n}));await ready();await finish();
   const firstA=await rewards.claimable(a.address),firstB=await rewards.claimable(b.address);
   await tx(token.connect(a).transfer(b.address,eth('10000')));
   await tx(h.fund({value:20000n}));await ready();await finish();
   assert.equal(await rewards.roundCount(),2n);
   assert.equal(await rewards.claimable(a.address),firstA);
   assert.ok(await rewards.claimable(b.address)>=firstB+20000n);
   assert.equal(await rewards.accountedFunds(),30001n);
   await chain.deploy('ForceEther',[rewards.target],owner,{value:123n});
   assert.equal(await rewards.unaccountedSurplus(),123n);
   await tx(rewards.connect(a).claimTo(c.address));await tx(rewards.connect(b).claimTo(c.address));
   assert.equal(await chain.balance(rewards.target),(await rewards.accountedFunds())+123n);
  });

  test('proportional age accounting matches independent virtual lots over randomized balance changes',async()=>{
   const people=[a,b,c],lots=people.map(()=>[]);let time=start;
   let seed=713;const rng=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
   function receive(i,q){const old=lots[i].reduce((s,x)=>s+x.q,0);if(old<=1)lots[i]=old+q>1?[{q:old+q,t:time}]:[{q:old+q,t:time}];else lots[i].push({q,t:time});}
   function send(i,q){const old=lots[i].reduce((s,x)=>s+x.q,0),next=old-q;if(next<=1)lots[i]=[{q:next,t:time}];else for(const x of lots[i])x.q*=next/old;}
   for(let n=0;n<60;n++){
    time+=3600+Math.floor(rng()*3*DAY);await chain.rpc('evm_setNextBlockTimestamp',[time]);
    const i=Math.floor(rng()*3),j=(i+1)%3;
    const balance=await token.balanceOf(people[i].address);
    if(balance===0n||rng()<.45){const q=2+Math.floor(rng()*1000);await tx(h.give(people[i].address,eth(String(q))));receive(i,q);}
    else {const q=rng()<.1?balance:balance*BigInt(1+Math.floor(rng()*80))/100n;
     await tx(token.connect(people[i]).transfer(people[j].address,q));send(i,Number(q)/1e18);receive(j,Number(q)/1e18);}
    for(let j=0;j<3;j++){
     const balance=await token.balanceOf(people[j].address);
     const expected=balance<=eth('1')?0:lots[j].reduce((s,x)=>s+x.q*weight((time-x.t)/DAY),0);
     close(await token.currentShares(people[j].address),expected,1e-7);
    }
   }
  });

  test('real V4 swaps advance a funded reward round while the manager is unlocked',async()=>{
   const f=await deployV4Fixture(chain);await fundAndLaunch(chain,f,{automatic:true});
   const dev=chain.signers[1],alice=chain.signers[2],bob=chain.signers[3];
   const poolRewards=new Contract(await f.token.feeRewards(),artifact('ProjectFeeRewards').abi,dev);
   assert.equal(await poolRewards.token(),f.token.target);assert.equal(await f.token.excluded(poolRewards.target),true);
   await tx(poolRewards.deposit({value:eth('0.25')}));
   await chain.mineAt(Number(await poolRewards.nextRoundAt()));
   const nativeBefore=await chain.balance(bob.address);
   for(let i=0;i<10;i++){
    await swap(f,alice,true,-eth('0.01'),{value:eth('0.01')});
    if(await poolRewards.roundCount()>0n&&(await poolRewards.currentRound()).phase===0n)break;
   }
   assert.equal((await poolRewards.currentRound()).phase,0n);assert.equal(await poolRewards.roundCount(),1n);
   assert.ok(await poolRewards.claimable(bob.address)>0n);
   assert.equal(await chain.balance(bob.address),nativeBefore);
   const owed=await poolRewards.claimable(bob.address),before=await chain.balance(owner.address);
   await tx(poolRewards.connect(bob).claimTo(owner.address));
   assert.equal(await chain.balance(owner.address)-before,owed);
   assert.equal(await chain.balance(poolRewards.target),await poolRewards.accountedFunds());
  });

  test('operating dividends use a separate onchain ETH vault and the same frozen holder weights',async()=>{
   const f=await deployV4Fixture(chain);await fundAndLaunch(chain,f,{automatic:true});
   const dev=chain.signers[1],alice=chain.signers[2],bob=chain.signers[3];
   const fee=new Contract(await f.token.feeRewards(),artifact('ProjectFeeRewards').abi,dev);
   const operating=new Contract(await f.token.operatingRewards(),artifact('ProjectFeeRewards').abi,dev);
   assert.notEqual(fee.target,operating.target);
   assert.equal(await operating.token(),f.token.target);
   assert.equal(await f.token.excluded(operating.target),true);
   await assert.rejects(()=>operating.connect(alice).deposit.staticCall({value:eth('1')}));
   await assert.rejects(()=>operating.connect(dev).depositFees.staticCall({value:eth('1')}));
   await tx(operating.deposit({value:eth('0.4')}));
   await tx(fee.deposit({value:eth('0.2')}));
   assert.equal(await operating.queuedFunds(),eth('0.4'));
   assert.equal(await fee.queuedFunds(),eth('0.2'));
   await chain.mineAt(Math.max(Number(await fee.nextRoundAt()),Number(await operating.nextRoundAt())));
   for(const vault of [fee,operating]){
    for(let i=0;i<12;i++){
     await tx(vault.process(1_500_000,{gasLimit:1_700_000}));
     if(await vault.roundCount()>0n&&(await vault.currentRound()).phase===0n)break;
    }
    assert.equal((await vault.currentRound()).phase,0n);
    assert.ok(await vault.claimable(bob.address)>0n);
   }
   const feeOwed=await fee.claimable(bob.address),operatingOwed=await operating.claimable(bob.address);
   const before=await chain.balance(owner.address);
   await tx(operating.connect(bob).claimTo(owner.address));
   assert.equal(await chain.balance(owner.address)-before,operatingOwed);
   assert.equal(await fee.claimable(bob.address),feeOwed);
   assert.equal(await chain.balance(operating.target),await operating.accountedFunds());
   assert.equal(await chain.balance(fee.target),await fee.accountedFunds());
  });

  test('a transfer during both vault scans preserves both pre-transfer shares',async()=>{
   const f=await deployV4Fixture(chain);await fundAndLaunch(chain,f,{automatic:true});
   const dev=chain.signers[1],alice=chain.signers[2],bob=chain.signers[3];
   for(let i=0;i<12;i++)await tx(f.token.connect(alice).transfer(Wallet.createRandom().address,eth('6000')));
   const fee=new Contract(await f.token.feeRewards(),artifact('ProjectFeeRewards').abi,dev);
   const operating=new Contract(await f.token.operatingRewards(),artifact('ProjectFeeRewards').abi,dev);
   await tx(fee.deposit({value:eth('0.2')}));await tx(operating.deposit({value:eth('0.4')}));
   await chain.mineAt(Math.max(Number(await fee.nextRoundAt()),Number(await operating.nextRoundAt())));
   for(const vault of [fee,operating]){
    await tx(vault.process(250_000,{gasLimit:300_000}));
    assert.equal((await vault.currentRound()).phase,1n);
   }
   const feeRound=await fee.currentRound(),operatingRound=await operating.currentRound();
   const expectedFee=(await f.token.recentWeight(bob.address,feeRound.snapshotBlock,feeRound.weightTime)).shares;
   const expectedOperating=(await f.token.recentWeight(bob.address,operatingRound.snapshotBlock,operatingRound.weightTime)).shares;
   await tx(f.token.connect(bob).transfer(alice.address,eth('10000'),{gasLimit:1_200_000}));
   assert.equal((await fee.frozenWeights(bob.address)).shares,expectedFee);
   assert.equal((await operating.frozenWeights(bob.address)).shares,expectedOperating);
   for(const vault of [fee,operating]){
    for(let i=0;i<50;i++){
     await tx(vault.process(1_500_000,{gasLimit:1_700_000}));
     if((await vault.currentRound()).phase===0n)break;
    }
    assert.equal((await vault.currentRound()).phase,0n);
    assert.ok(await vault.claimable(bob.address)>0n);
   }
  });

  test('official router collects the 1% ETH fee into 40/30/30 and later swaps credit fee-funded rewards',async()=>{
   const f=await deployV4Fixture(chain);await fundAndLaunch(chain,f,{automatic:true});
   const alice=chain.signers[2],bob=chain.signers[3],dev=chain.signers[1];
   const router=await chain.deploy('ProjectSwapRouter',[f.manager.target,f.hook.target]);
   const vault=new Contract(await f.token.feeRewards(),artifact('ProjectFeeRewards').abi,alice);
   const initial=await f.devVault.availableFunds();
   const buy=async()=>router.connect(alice).swap(f.key,[true,-eth('1'),4295128740n],eth('1'),1,alice.address,(await chain.timestamp())+100,{value:eth('1'),gasLimit:2500000});
   const receipt=await tx(buy());
   assert.ok(!receipt.logs.some(log=>{try{return router.interface.parseLog(log)?.name==='FeeCollectionDeferred';}catch{return false;}}));
   assert.equal(await f.devVault.availableFunds()-initial,eth('0.004'));
   assert.equal(await vault.queuedFunds(),eth('0.003'));
   assert.equal(await f.hook.platformAccrued(),eth('0.003'));
   assert.equal(await f.insurance.availableFunds(),0n);
   assert.equal((await f.hook.projects(f.poolId)).rewardsAccrued,0n);
   assert.equal(await f.manager.balanceOf(f.hook.target,0),eth('0.003'));
   await chain.mineAt(Number(await vault.nextRoundAt()));
   for(let i=0;i<10;i++){
    await tx(buy());
    if((await vault.currentRound()).phase===0n&&await vault.roundCount()>0n)break;
   }
   assert.equal((await vault.currentRound()).amount,eth('0.003'));
   assert.ok(await vault.claimable(bob.address)>0n);
   const owed=await vault.claimable(bob.address),before=await chain.balance(owner.address);
   await tx(vault.connect(bob).claimTo(owner.address));
   assert.equal(await chain.balance(owner.address)-before,owed);
   assert.equal(await chain.balance(vault.target),await vault.accountedFunds());
   await assert.rejects(()=>vault.connect(dev).depositFees.staticCall({value:1n}));
  });
});

describe("Independent vault scans", {concurrency: false}, () => {
  const eth = parseEther, DAY = 86400;
  const multiplier = days => 7 - 6 * 20 ** (-days / 23);
  let chain, owner, alice, bob, harness, token, fee, operating;

  beforeEach(async () => {
    chain = await createLocalChain();
    [owner, alice, bob] = chain.signers;
    harness = await chain.deploy('FeeRewardsHarness');
    token = await chain.deploy('ProjectToken', [harness.target, harness.target,
      '0x0000000000000000000000000000000000001234']);
    await tx(harness.initializeBoth(token.target));
    fee = new Contract(await harness.rewards(), artifact('ProjectFeeRewards').abi, owner);
    operating = new Contract(await harness.operating(), artifact('ProjectFeeRewards').abi, owner);
  });
  afterEach(async () => chain?.close());

  function events(receipt, vault, name) {
    return receipt.logs.filter(log => log.address.toLowerCase() === vault.target.toLowerCase())
      .map(log => { try { return vault.interface.parseLog(log); } catch { return null; } })
      .filter(event => event?.name === name);
  }
  async function ready() {
    await chain.mineAt(Math.max(await chain.timestamp() + 1,
      Number(await fee.nextRoundAt()), Number(await operating.nextRoundAt())));
  }
  async function finish(vault) {
    const receipts = [];
    for (let i = 0; i < 80; ++i) {
      receipts.push(await tx(vault.process(1_500_000, {gasLimit: 1_700_000})));
      if ((await vault.currentRound()).phase === 0n) return receipts;
    }
    assert.fail('bounded reward processing did not finish');
  }
  function close(actual, expected, tolerance = 1e-10) {
    assert.ok(Math.abs(Number(actual) / 1e18 - expected) < tolerance,
      `${actual} differs from independent expected value ${expected}`);
  }

  test('multiple token callbacks advance both vaults beyond two entries using only their gas allowance', async t => {
    await tx(harness.give(alice.address, eth('10000')));
    await tx(harness.give(bob.address, eth('10000')));
    for (let i = 0; i < 30; ++i) await tx(harness.give(Wallet.createRandom().address, eth('6000')));
    await tx(harness.fund({value: eth('0.2')}));
    await tx(harness.fundOperating({value: eth('0.4')}));
    await ready();
    for (const vault of [fee, operating]) {
      await tx(vault.process(250_000, {gasLimit: 310_000}));
      assert.equal((await vault.currentRound()).phase, 1n);
    }
    const observed = [];
    for (let n = 0; n < 2; ++n) {
      const before = await Promise.all([fee.currentRound(), operating.currentRound()]);
      const receipt = await tx(harness.giveMany(alice.address, 1n, 2, {gasLimit: 2_000_000}));
      const checks = [];
      for (const [i, vault] of [fee, operating].entries()) {
        const advances = events(receipt, vault, 'RoundAdvanced');
        assert.equal(advances.length, 2);
        assert.ok(advances.every(event => event.args.automatic && event.args.checks > 2n));
        const count = advances.reduce((sum, event) => sum + event.args.checks, 0n);
        assert.ok(count > 2n);
        assert.equal((await vault.currentRound()).cursor - before[i].cursor, count);
        checks.push(Number(count));
      }
      observed.push({transfers: 2, feeChecks: checks[0], operatingChecks: checks[1], gasUsed: receipt.gasUsed.toString()});
    }
    for (const vault of [fee, operating]) {
      const receipts = await finish(vault);
      assert.ok(receipts.flatMap(receipt => events(receipt, vault, 'RoundAdvanced'))
        .some(event => !event.args.automatic && event.args.checks > 2n));
      assert.equal(await chain.balance(vault.target), await vault.accountedFunds());
    }
    const balances = await Promise.all([fee.totalClaimable(), operating.totalClaimable()]);
    const idle = await tx(harness.giveMany(alice.address, 1n, 2, {gasLimit: 2_000_000}));
    for (const [i, vault] of [fee, operating].entries()) {
      assert.equal(events(idle, vault, 'RoundAdvanced').length, 0);
      assert.equal(await vault.roundCount(), 1n);
      assert.equal((await vault.currentRound()).phase, 0n);
      assert.equal(await vault.totalClaimable(), balances[i]);
    }
    t.diagnostic(JSON.stringify({perTransactionAutomaticWork: observed}));
  });

  test('same-round balance changes never refreeze shares or credit a wallet twice; later rounds use fresh shares', async () => {
    await tx(harness.give(alice.address, eth('10000')));
    await tx(harness.give(bob.address, eth('10000')));
    for (let i = 0; i < 20; ++i) await tx(harness.give(Wallet.createRandom().address, eth('2')));
    await tx(harness.fund({value: eth('1')}));
    await tx(harness.fundOperating({value: eth('2')}));
    await ready();
    const expected = [];
    for (const vault of [fee, operating]) {
      await tx(vault.process(250_000, {gasLimit: 310_000}));
      const round = await vault.currentRound();
      expected.push((await token.recentWeight(bob.address, round.snapshotBlock, round.weightTime)).shares);
    }
    const receipt = await tx(harness.giveMany(bob.address, eth('6000'), 3, {gasLimit: 4_000_000}));
    for (const [i, vault] of [fee, operating].entries()) {
      const frozen = await vault.frozenWeights(bob.address);
      assert.equal(frozen.roundId, 1n);
      assert.equal(frozen.shares, expected[i]);
      const receipts = [receipt, ...await finish(vault)];
      const credits = receipts.flatMap(receipt => events(receipt, vault, 'Credited'));
      assert.equal(new Set(credits.map(event => event.args.account.toLowerCase())).size, credits.length);
      assert.equal(credits.filter(event => event.args.account === bob.address).length, 1);
      const round = await vault.currentRound();
      const owed = round.amount * expected[i] / round.totalShares;
      assert.equal(await vault.claimable(bob.address), owed);
      assert.equal((await vault.frozenWeights(bob.address)).shares, expected[i]);
      for (let n = 0; n < 3; ++n) await tx(vault.process(1_500_000, {gasLimit: 1_700_000}));
      assert.equal(await vault.claimable(bob.address), owed);
    }
    const oldDebts = await Promise.all([fee.claimable(bob.address), operating.claimable(bob.address)]);
    await tx(harness.fund({value: eth('1')}));
    await tx(harness.fundOperating({value: eth('2')}));
    await ready();
    for (const [i, vault] of [fee, operating].entries()) {
      const receipts = await finish(vault), round = await vault.currentRound();
      const frozen = await vault.frozenWeights(bob.address);
      assert.equal(frozen.roundId, 2n);
      assert.ok(frozen.shares > expected[i]);
      assert.equal(await vault.claimable(bob.address), oldDebts[i] + round.amount * frozen.shares / round.totalShares);
      assert.equal(receipts.flatMap(receipt => events(receipt, vault, 'Credited'))
        .filter(event => event.args.account === bob.address).length, 1);
      assert.equal(await chain.balance(vault.target), await vault.accountedFunds());
    }
  });

  test('equal token balances with old and fresh age receive different actual ETH rewards in both vaults', async t => {
    const start = await chain.timestamp() + 10;
    await chain.rpc('evm_setNextBlockTimestamp', [start]);
    await tx(harness.give(alice.address, eth('10000')));
    await chain.rpc('evm_setNextBlockTimestamp', [start + 23 * DAY]);
    await tx(harness.give(bob.address, eth('10000')));
    await tx(harness.fund({value: eth('1')}));
    await tx(harness.fundOperating({value: eth('2')}));
    const observations = [];
    for (const vault of [fee, operating]) {
      await finish(vault);
      const round = await vault.currentRound();
      const time = Number(round.weightTime);
      const oldWeight = multiplier((time - start) / DAY);
      const freshWeight = multiplier((time - start - 23 * DAY) / DAY);
      close((await vault.frozenWeights(alice.address)).shares, 10000 * oldWeight, 1e-7);
      close((await vault.frozenWeights(bob.address)).shares, 10000 * freshWeight, 1e-7);
      const amount = Number(round.amount) / 1e18;
      close(await vault.claimable(alice.address), amount * oldWeight / (oldWeight + freshWeight));
      close(await vault.claimable(bob.address), amount * freshWeight / (oldWeight + freshWeight));
      assert.ok(await vault.claimable(alice.address) > await vault.claimable(bob.address) * 6n);
      const owed = await vault.claimable(alice.address), before = await chain.balance(owner.address);
      await tx(vault.connect(alice).claimTo(owner.address));
      assert.equal(await chain.balance(owner.address) - before, owed);
      assert.equal(await chain.balance(vault.target), await vault.accountedFunds());
      observations.push({vault: vault === fee ? 'fee' : 'operating', oldWeight, freshWeight,
        oldHolderETH: Number(owed) / 1e18, freshHolderETH: Number(await vault.claimable(bob.address)) / 1e18});
    }
    t.diagnostic(JSON.stringify({actualAgeWeightedPayouts: observations}));
  });
});

describe("LP allocation and income", {concurrency: false}, () => {
  function fixture(run) {
    return withLocalChain(async c => {
    const [owner,founder,alice]=c.signers;
    const manager=await c.deploy('PoolManager',[owner.address]);
    const validator=Wallet.createRandom();
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[validator.address]});
    const p=await c.createProject(s.factory,{target:eth('1'),creator:founder});
    await tx(p.connect(alice).contribute(0,{value:eth('1'),gasLimit:16000000}));
    await tx(p.migrate({gasLimit:16000000}));
    assert.equal(await p.state(),3n);
    // These base fee-distribution checks exercise the ordinary post-launch rate.
    // Launch-window behavior is covered separately in trading.test.mjs.
    await c.mineAt(Number(await p.launchTime()) + 600);
    const t=new Contract(await p.token(),artifact('ProjectToken').abi,owner);
    const g=new Contract(await p.governance(),artifact('UpgradeableCommunityGovernance').abi,founder);
    const v=new Contract(await g.devVault(),artifact('ProjectVault').abi,owner);
    const r=new Contract(await t.feeRewards(),artifact('ProjectFeeRewards').abi,owner);
    const o=new Contract(await t.operatingRewards(),artifact('OperatingRewardsLP').abi,founder);
    const l=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,owner);
    const key=[ZeroAddress,t.target,3000,60,s.hook.target];
    const router=await c.deploy('V4TestRouter',[manager.target]);
    await tx(t.connect(alice).approve(router.target,eth('100000000')));
    await tx(t.connect(alice).approve(s.router.target,eth('100000000')));
    await run({c,s,p,t,g,v,r,o,l,key,router,owner,founder,alice,manager,validator});

    });
  }
  test('migration binds LP custody, excludes it from votes, and preserves refundable creation deposits',async()=>fixture(async f=>{
   const {s,p,t,l,founder}=f;
   assert.equal(await s.factory.CONTRACT_VERSION(),13n);
   assert.equal(await s.lpDistributor.hook(),s.hook.target);
   assert.equal(await s.lpDistributor.poolId(t.target),await p.poolId());
   assert.equal(await t.excluded(s.lpDistributor.target),true);
   assert.equal(await t.excluded(s.operatingImplementation.target),true);
   assert.equal(await s.factory.creationDepositClaimable(p.target),true);
   await tx(s.factory.connect(founder).claimCreationDeposit(p.target,founder.address));
   assert.equal(await s.factory.creationDeposits(p.target),0n);
   assert.ok(await l.positionLiquidity()>0n);
   await assert.rejects(()=>s.lpDistributor.configureHook(s.hook.target));
   await assert.rejects(()=>s.coordinator.configureLPServices(s.lpDistributor.target,s.hook.target));
  }));
  test('all four swap modes retain 1% ETH fee and accrue exact 20/40/10/30 shares to distinct ledgers',async()=>fixture(async f=>{
   const {c,s,t,key,alice,r,v}=f;
   let lpTotal=0n,holderTotal=0n,devTotal=0n,platformTotal=0n;
   for(const [buy,amount,value] of [[true,-eth('0.01'),eth('0.01')],[false,-eth('1000'),0n],[true,eth('1000'),eth('0.01')],[false,eth('0.001'),0n]]){
    const time=await c.timestamp();
    const receipt=await tx(s.router.connect(alice).swap(key,[buy,amount,buy?4295128740n:1461446703485210103287273052203988822378723970341n],buy?value:eth('10000000'),1,alice.address,time+1000,{value}));
    const parsed=receipt.logs.map(l=>{try{return s.hook.interface.parseLog(l)}catch{return null}});
    const fee=parsed.find(e=>e?.name==='FeesAccrued').args;
    const lp=parsed.find(e=>e?.name==='LPFeesAccrued').args.amount;
    assert.equal(fee.devPart,fee.ethFee*20n/100n);assert.equal(fee.rewardsPart,fee.ethFee*40n/100n);
    assert.equal(lp,fee.ethFee*10n/100n);assert.equal(fee.platformPart,fee.ethFee-fee.devPart-fee.rewardsPart-lp);
    assert.equal(fee.ethFee,fee.devPart+fee.rewardsPart+fee.platformPart+lp);
    const swap=receipt.logs.map(l=>{try{return s.router.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='Swapped').args;
    const expected=buy&&amount<0n?(-amount)/100n:!buy&&amount>0n?(amount+98n)/99n:buy?(swap.input-fee.ethFee+98n)/99n:(swap.output+fee.ethFee)/100n;
    assert.equal(fee.ethFee,expected);
    lpTotal+=lp;holderTotal+=fee.rewardsPart;devTotal+=fee.devPart;platformTotal+=fee.platformPart;
   }
   assert.equal(await r.queuedFunds(),holderTotal);assert.equal(await v.availableFunds(),eth('0.5')+devTotal);
   assert.equal(await s.hook.platformAccrued(),platformTotal);
   assert.equal(await s.lpDistributor.totalDonatedETH(t.target),lpTotal);
   assert.equal(await s.lpDistributor.totalQueuedETH(),0n);
  }));
  test('nested donation failure preserves LP and holder custody for permissionless retry',async()=>fixture(async f=>{
   const {c,s,t,o,g,manager}=f;
   const receiver=await c.deploy('NestedOperatingDeposit',[manager.target]);
   await tx(g.proposeDeveloperTransfer(receiver.target));
   await c.mineAt(Number(await g.developerTransferReadyAt()));await tx(receiver.accept(g.target));
   await tx(receiver.depositNested(o.target,{value:eth('1')}));
   assert.equal(await o.queuedFunds(),eth('0.8'));
   assert.equal(await s.lpDistributor.queuedETH(t.target),eth('0.2'));
   assert.equal(await s.lpDistributor.totalQueuedETH(),eth('0.2'));
   assert.equal(await c.balance(s.lpDistributor.target),eth('0.2'));
   assert.equal(await s.lpDistributor.totalDonatedETH(t.target),0n);
   await tx(s.lpDistributor.connect(f.alice).process(t.target));
   assert.equal(await s.lpDistributor.totalQueuedETH(),0n);
   assert.equal(await s.lpDistributor.totalDonatedETH(t.target),eth('0.2'));
   assert.equal(await c.balance(s.lpDistributor.target),0n);
   assert.equal(await o.queuedFunds(),eth('0.8'));
  }));
  test('termination routes new fees 0/60/10/30 and blocks new operating deposits',async()=>fixture(async f=>{
   const {c,s,t,g,o,key,alice,validator,r,v}=f;
   await c.mineAt(Number(await g.anchor()));await tx(g.connect(alice).proposeTermination(id('terminate'),'ipfs://end'));
   const proposalId=await g.proposalCount(),p=await g.proposals(proposalId);
   const support=1;
   const ballot=await alice.signTypedData({name:'OriginCommunityGovernance',version:'1',chainId:31337,verifyingContract:g.target},
    {Ballot:[{name:'proposalId',type:'uint256'},{name:'snapshotHash',type:'bytes32'},{name:'voter',type:'address'},{name:'support',type:'uint8'}]},
    {proposalId,snapshotHash:p.snapshotHash,voter:alice.address,support});
   const result={proposalId,forVotes:p.totalPower,againstVotes:0n,abstainVotes:0n,archiveHash:id('public archive'),cid:'bafytermination1234567890123456789',uploader:alice.address,deadline:p.uploadEndsAt};
   const attestation=validator.signingKey.sign(await g.resultDigest(result)).serialized;
   await c.mineAt(Number(p.endsAt));
   await tx(g.connect(alice).finalizeResult(result,support,ballot,[validator.address],[attestation]));
   assert.equal(await g.terminated(),true);
   const devBefore=await v.availableFunds(), rewardsBefore=await r.queuedFunds();
   assert.equal(devBefore,0n);assert.equal(rewardsBefore,eth('0.5'));
   const receipt=await tx(s.router.connect(alice).swap(key,[true,-eth('0.01'),4295128740n],eth('0.01'),1,alice.address,(await c.timestamp())+1000,{value:eth('0.01')}));
   const e=receipt.logs.map(l=>{try{return s.hook.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='FeesAccrued').args;
   assert.equal(e.devPart,0n);assert.equal(e.rewardsPart,e.ethFee*60n/100n);assert.equal(e.platformPart,e.ethFee*30n/100n);
   assert.equal(await v.availableFunds(),devBefore);assert.equal(await r.accountedFunds(),rewardsBefore+e.rewardsPart);
   assert.equal(await s.lpDistributor.totalDonatedETH(t.target),e.ethFee/10n);
   await assert.rejects(()=>o.deposit({value:eth('1')}));
  }));
  test('LP policy family prevents downgrade and faulty policies fall back to backed defaults',async()=>fixture(async f=>{
   const {c,s,key,alice}=f;
   const old=await c.deploy('SwapFeePolicy');
   await assert.rejects(()=>s.feePolicy.upgradeToAndCall(old.target,'0x'));
   const downgrade=s.feePolicy.interface.encodeFunctionData('upgradeToAndCall',[old.target,'0x']);
   await tx(s.timelock.schedule(s.feePolicy.target,0,downgrade,ZeroHash,id('legacy LP policy downgrade'),172800));
   await c.mineAt((await c.timestamp())+172800);
   await assert.rejects(()=>s.timelock.execute(s.feePolicy.target,0,downgrade,ZeroHash,id('legacy LP policy downgrade')));
   assert.deepEqual(Array.from(await s.feePolicy.splitWithLP(10000,false)),[2000n,4000n,1000n]);
   const bad=await c.deploy('InvalidLPFeePolicy');
   const data=s.feePolicy.interface.encodeFunctionData('upgradeToAndCall',[bad.target,'0x']);
   await tx(s.timelock.schedule(s.feePolicy.target,0,data,ZeroHash,id('invalid LP policy'),172800));
   await c.mineAt((await c.timestamp())+172800);
   await tx(s.timelock.execute(s.feePolicy.target,0,data,ZeroHash,id('invalid LP policy')));
   const receipt=await tx(s.router.connect(alice).swap(key,[true,-eth('0.01'),4295128740n],eth('0.01'),1,alice.address,(await c.timestamp())+1000,{value:eth('0.01')}));
   assert.ok(receipt.logs.some(l=>{try{return s.hook.interface.parseLog(l)?.name==='FeePolicyFallback'}catch{return false}}));
   assert.equal(await s.hook.platformAccrued(),eth('0.00003'));assert.equal(await s.lpDistributor.totalQueuedETH(),0n);
  }));
  test('operating deposit is 80/20 with no platform share; holder payouts remain independently claimable',async()=>fixture(async f=>{
   const {c,s,t,o,r,founder,alice}=f;
   const before=await s.hook.platformAccrued();
   await assert.rejects(()=>o.connect(alice).deposit({value:eth('1')}));
   await tx(o.deposit({value:eth('1')}));
   assert.equal(await o.queuedFunds(),eth('0.8'));
   assert.equal(await s.lpDistributor.totalDonatedETH(t.target),eth('0.2'));
   assert.equal(await s.hook.platformAccrued(),before);assert.equal(await r.queuedFunds(),0n);
   assert.equal(await c.balance(o.target),eth('0.8'));
   await tx(o.deposit({value:1n}));assert.equal(await o.queuedFunds(),eth('0.8')+1n);
   await c.mineAt(Number(await o.nextRoundAt()));
   await tx(o.process(1500000,{gasLimit:1700000}));
   assert.equal(await o.claimable(alice.address),eth('0.8')+1n);
   await tx(o.connect(alice).claim());assert.equal(await o.totalClaimable(),0n);
   assert.equal(await c.balance(o.target),0n);
   await assert.rejects(()=>s.lpDistributor.connect(founder).fund(t.target,{value:1n}));
   await assert.rejects(()=>s.lpDistributor.process(t.target));
   await assert.rejects(()=>s.lpDistributor.unlockCallback('0x'));
  }));
  test('a gas-exhausting policy cannot stop swaps and fixed-recipient fee forwarding cannot steal project funds',async()=>fixture(async f=>{
   const {c,s,key,alice,owner}=f;
   // Synthetic fault injection: endlessly looping code at the policy address.
   await c.rpc('hardhat_setCode',[s.feePolicy.target,'0x5b600056']);
   const receipt=await tx(s.router.connect(alice).swap(key,[true,-eth('0.01'),4295128740n],eth('0.01'),1,alice.address,(await c.timestamp())+1000,{value:eth('0.01'),gasLimit:1200000}));
   assert.ok(receipt.logs.some(l=>{try{return s.hook.interface.parseLog(l)?.name==='FeePolicyFallback'}catch{return false}}));
   const fees=await s.hook.platformAccrued(),before=await c.balance(owner.address);
   await tx(s.hook.connect(alice).collectPlatformFees()); assert.equal(await c.balance(owner.address),before+fees);
   const migration=await s.factory.accruedMigrationFees(),funds=await f.v.availableFunds(),deposit=await s.factory.creationDeposits(f.p.target),after=await c.balance(owner.address);
   await tx(s.factory.connect(alice).collectMigrationFees()); assert.equal(await c.balance(owner.address),after+migration);
   assert.equal(await f.v.availableFunds(),funds);assert.equal(await s.factory.creationDeposits(f.p.target),deposit);
  }));
  test('real personal LP receives donation income; partial exit preserves earned fees and changes future share',async()=>fixture(async f=>{
   const {c,s,t,o,l,router,key,alice}=f;
   const official=await l.positionLiquidity(),personal=official/10n,salt=id('personal income');
   await tx(router.connect(alice).modify(key,[-887220,887220,personal,salt],{value:eth('1')}));
   await tx(o.deposit({value:eth('1')}));
   const before=await c.balance(alice.address);
   const receipt=await tx(router.connect(alice).modify(key,[-887220,887220,0,salt]));
   const delta=receipt.logs.map(log=>{try{return router.interface.parseLog(log)}catch{return null}}).find(e=>e?.name==='Delta').args;
   const expected=eth('0.2')*personal/(official+personal);
   assert.ok(delta.ethDelta>0n);assert.ok(expected-delta.ethDelta<=1n);
   assert.equal(await c.balance(alice.address),before+delta.ethDelta-receipt.fee);
   await tx(o.deposit({value:eth('1')}));
   const half=personal/2n;
   await tx(router.connect(alice).modify(key,[-887220,887220,-half,salt]));
   assert.equal(await l.positionLiquidity(),official);
   await tx(o.deposit({value:eth('1')}));
   const r=await tx(router.connect(alice).modify(key,[-887220,887220,0,salt]));
   const d=r.logs.map(log=>{try{return router.interface.parseLog(log)}catch{return null}}).find(e=>e?.name==='Delta').args;
   const remaining=personal-half,want=eth('0.2')*remaining/(official+remaining);
   assert.ok(want-d.ethDelta<=1n);assert.ok(d.ethDelta<delta.ethDelta);
   const officialBefore=await l.positionLiquidity();
   await tx(l.collectFees());assert.equal(await l.positionLiquidity(),officialBefore);
   assert.ok(await s.lpDistributor.totalDonatedETH(t.target)===eth('0.6'));
  }));
});

describe("Standalone attested Merkle distributions", {concurrency: false}, () => {
  let chain,dev,a,b,c,project,vault,validator,verifier;
  beforeEach(async()=>{
   chain=await createLocalChain();[,dev,a,b,c]=chain.signers; validator=Wallet.createRandom();
   project=await chain.deploy('DividendTestProject',[dev.address]);
   verifier=await chain.deploy('AllocationVerifier',[[validator.address],1]);
   vault=await chain.deploy('ProjectDividends',[project.target,verifier.target]);
  });
  afterEach(async()=>{await chain?.close();});
  const leaf=(chainId,distributor,project,round,account,weight)=>keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','address','uint256','address','uint256'],[chainId,distributor,project,round,account,weight])));
  const pair=(a,b)=>keccak256(concat(BigInt(a)<BigInt(b)?[a,b]:[b,a]));
  async function fund(amount=101n){await(await vault.connect(dev).fund(project.target,id('snapshot'),{value:amount})).wait();return vault.roundCount(project.target);}
  async function authorization(round,root,total=3n,cid='bafyallocation'){
   const deadline=await chain.timestamp()+86400;
   const digest=await vault.allocationDigest(project.target,round,root,total,cid,deadline);
   return [project.target,round,root,total,cid,deadline,[validator.address],[validator.signingKey.sign(digest).serialized]];
  }
  async function publish(round=1n,review=true){
   const l=await vault.leaf(project.target,round,a.address,1n),r=await vault.leaf(project.target,round,b.address,2n);
   await(await vault.connect(dev).publish(...await authorization(round,pair(l,r)))).wait();
   if(review)await chain.mineAt(Number((await vault.reviews(project.target,round)).endsAt));
   return[l,r];
  }
  async function resolution(accepted){
   const deadline=await chain.timestamp()+86400;
   const digest=await vault.resolutionDigest(project.target,1,accepted,deadline);
   return [project.target,1,accepted,deadline,[validator.address],[validator.signingKey.sign(digest).serialized]];
  }
  test('attested allocation waits 12 hours, pays proportional claims to chosen recipient, prevents duplicates',async()=>{
   await fund();const[l,r]=await publish(1n,false);
   await assert.rejects(()=>vault.connect(a).claim.staticCall(project.target,1,1,[r]));
   await chain.mineAt(Number((await vault.reviews(project.target,1)).endsAt));
   await assert.rejects(()=>vault.connect(c).claim.staticCall(project.target,1,1,[r]));
   await assert.rejects(()=>vault.connect(a).claim.staticCall(project.target,1,2,[r]));
   const before=await chain.balance(c.address);
   await(await vault.connect(a).claimTo(project.target,1,1,[r],c.address)).wait();
   assert.equal(await chain.balance(c.address)-before,33n);
   await(await vault.connect(b).claim(project.target,1,2,[l])).wait();
   assert.equal((await vault.rounds(project.target,1)).paid,100n);assert.equal(await chain.balance(vault.target),1n);
   await assert.rejects(()=>vault.connect(a).claim.staticCall(project.target,1,1,[r]));
   await assert.rejects(()=>dev.sendTransaction({to:vault.target,value:1n}));
  });
  test('only developer funds; signatures bind allocation, CID, deadline, round and verifier quorum',async()=>{
   await assert.rejects(()=>vault.connect(a).fund.staticCall(project.target,id('snapshot'),{value:1n}));
   await assert.rejects(()=>vault.connect(dev).fund.staticCall(project.target,ZeroHash,{value:1n}));
   await fund();const args=await authorization(1,id('root'));
   await assert.rejects(()=>vault.connect(a).publish.staticCall(...args));
   for(const [index,value] of [[2,id('other')],[3,4n],[4,'changed'],[5,args[5]+1],[6,[]],[7,[]]]){
    const altered=[...args];altered[index]=value;await assert.rejects(()=>vault.connect(dev).publish.staticCall(...altered));
   }
   await fund();const different=[...args];different[1]=2;await assert.rejects(()=>vault.connect(dev).publish.staticCall(...different));
   await chain.mineAt(args[5]+1);await assert.rejects(()=>vault.connect(dev).publish.staticCall(...args));
  });
  test('developer inactivity permits any relayer after 7 days but never unsigned publication',async()=>{
   await fund();await chain.mineAt(Number((await vault.reviews(project.target,1)).fundedAt)+7*86400);
   const args=await authorization(1,id('root'));
   await assert.rejects(()=>vault.connect(a).publish.staticCall(...args.slice(0,6),[],[]));
   await(await vault.connect(a).publish(...args)).wait();
  });
  test('objection blocks claims; resolution binds all objections and rejected allocation needs fresh attestation and review',async()=>{
   await fund();const[,r]=await publish(1n,false);
   await(await vault.connect(a).challenge(project.target,1,id('evidence a'))).wait();
   const stale=await resolution(true);
   await(await vault.connect(b).challenge(project.target,1,id('evidence b'))).wait();
   await assert.rejects(()=>vault.resolve.staticCall(...stale));
   await assert.rejects(()=>vault.connect(a).challenge.staticCall(project.target,1,id('duplicate')));
   const oldAllocation=await authorization(1,pair(await vault.leaf(project.target,1,a.address,1),r));
   await chain.mineAt(Number((await vault.reviews(project.target,1)).endsAt));
   await assert.rejects(()=>vault.connect(a).claim.staticCall(project.target,1,1,[r]));
   await assert.rejects(()=>vault.connect(c).challenge.staticCall(project.target,1,id('late')));
   await(await vault.resolve(...await resolution(false))).wait();
   assert.equal((await vault.rounds(project.target,1)).root,ZeroHash);
   await assert.rejects(()=>vault.connect(dev).publish.staticCall(...oldAllocation));
   await publish(1n,false);
   await(await vault.connect(a).challenge(project.target,1,id('revised evidence'))).wait();
   await(await vault.resolve(...await resolution(true))).wait();
   await assert.rejects(()=>vault.connect(a).claim.staticCall(project.target,1,1,[r]));
   await chain.mineAt(Number((await vault.reviews(project.target,1)).endsAt));
   await(await vault.connect(a).claim(project.target,1,1,[r])).wait();
  });
  test('termination blocks funding; existing rounds remain claimable and malformed signed denominator cannot drain other rounds',async()=>{
   await fund();const[l,r]=await publish();await fund(10n);
   const bad=await vault.leaf(project.target,2,a.address,100);
   await(await vault.connect(dev).publish(...await authorization(2,bad,1n))).wait();
   await chain.mineAt(Number((await vault.reviews(project.target,2)).endsAt));
   await assert.rejects(()=>vault.connect(a).claim.staticCall(project.target,2,100,[]));
   await(await project.end()).wait();await assert.rejects(()=>vault.connect(dev).fund.staticCall(project.target,id('next'),{value:1n}));
   await(await vault.connect(a).claim(project.target,1,1,[r])).wait();
   assert.equal((await vault.rounds(project.target,1)).paid,33n);
   const other=await chain.deploy('ProjectDividends',[project.target,verifier.target]);
   assert.notEqual(await other.leaf(project.target,1,a.address,1),l);
  });
  test('multi-validator threshold rejects duplicate, unordered, unknown and missing signatures',async()=>{
   const keys=[Wallet.createRandom(),Wallet.createRandom()].sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
   const v=await chain.deploy('AllocationVerifier',[keys.map(k=>k.address),2]);const digest=id('quorum');
   const addresses=keys.map(k=>k.address),signatures=keys.map(k=>k.signingKey.sign(digest).serialized);
   assert.equal(await v.verify(digest,addresses,signatures),true);
   assert.equal(await v.verify(digest,[addresses[0]],[signatures[0]]),false);
   assert.equal(await v.verify(digest,[addresses[0],addresses[0]],[signatures[0],signatures[0]]),false);
   assert.equal(await v.verify(digest,[...addresses].reverse(),[...signatures].reverse()),false);
   assert.equal(await v.verify(id('tampered'),addresses,signatures),false);
  });
  test('Go/ethers shared leaf ABI vector',()=>{
   assert.equal(leaf(31337,'0x1111111111111111111111111111111111111111','0x2222222222222222222222222222222222222222',7,'0x3333333333333333333333333333333333333333',123456789),'0xeb55e217003b3a842f1768eae9bc512e30410d5a3fa6a7236714c902df0ca371');
  });
});
