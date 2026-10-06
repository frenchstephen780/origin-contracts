import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {Contract, id, parseEther, Wallet, parseEther as eth, ZeroHash, ZeroAddress} from 'ethers';
import {artifact, createLocalChain} from '../scripts/local-chain.mjs';
import {deployV4Fixture, fundAndLaunch} from '../scripts/local-v4.mjs';
import {withV4Fixture, tx, withLocalChain} from './helpers.mjs';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';

describe("Reserve vesting and initial withdrawal", {concurrency: false}, () => {
  const DAY = 86400n, TOTAL = parseEther('100000000'), RESERVE = TOTAL / 20n;
  async function endProject(chain, f) {
    const [, , alice, bob] = chain.signers;
    await (await f.gov.connect(alice).proposeTermination(id('stop'), 'ipfs://stop')).wait();
    await (await f.gov.connect(alice).voteToTerminate(1)).wait();
    await (await f.gov.connect(bob).voteToTerminate(1)).wait();
    assert.equal(await f.gov.terminated(), true);
  }

  test('reserve cannot release before launch or after failed fundraising', async () => withV4Fixture(async (chain, f) => {
    const dev = chain.signers[1];
    assert.equal(await f.project.CREATOR_SUPPLY(), RESERVE);
    assert.equal(await f.project.claimableCreatorTokens(), 0n);
    await assert.rejects(() => f.project.connect(dev).claimCreatorTokens.staticCall());
    await chain.mineAt(await f.project.deadline());
    assert.equal(await f.project.state(), 2n);
    assert.equal(await f.project.creatorTokensVested(), 0n);
    await assert.rejects(() => f.project.connect(dev).claimCreatorTokens.staticCall());
  }));

  test('all four inclusive cliffs conserve supply and accrue wallet votes/age only on claim', async () => withV4Fixture(async (chain, f) => {
    await fundAndLaunch(chain, f, {automatic:true});
    const dev = chain.signers[1], start = await f.project.launchTime();
    assert.equal(await f.token.publicPower(), await f.project.SALE_SUPPLY());
    assert.equal(await f.token.currentShares(dev.address), 0n);
    assert.equal(await f.project.SALE_SUPPLY() + await f.project.LIQUIDITY_SUPPLY() + RESERVE, TOTAL);
    for (const [day, cumulativeBps] of [[15n,50n],[30n,100n],[60n,250n],[180n,500n]]) {
      const before = await f.project.creatorTokensClaimed();
      await chain.mineAt(start + day * DAY - 1n);
      assert.equal(await f.project.claimableCreatorTokens(), 0n);
      await chain.mineAt(start + day * DAY);
      const vested = TOTAL * cumulativeBps / 10000n;
      assert.equal(await f.project.creatorTokensVested(), vested);
      assert.equal(await f.project.claimableCreatorTokens(), vested - before);
      await assert.rejects(() => f.project.connect(chain.signers[2]).claimCreatorTokens.staticCall());
      await (await f.project.connect(dev).claimCreatorTokens({gasLimit:1000000})).wait();
      assert.equal(await f.token.balanceOf(dev.address), vested);
      assert.equal(await f.token.publicPower(), await f.project.SALE_SUPPLY() + vested);
      assert.equal(await f.project.creatorTokensClaimed(), vested);
      assert.equal(await f.token.balanceOf(f.project.target), RESERVE - vested);
      assert.equal(await f.token.totalSupply(), TOTAL - (await f.locker.initialQuote()).lockedTokenRemainder);
      await assert.rejects(() => f.project.connect(dev).claimCreatorTokens.staticCall());
    }
    await chain.mineAt(start + 360n * DAY);
    assert.equal(await f.project.claimableCreatorTokens(), 0n);
  }));

  test('unclaimed unlocked reserve survives termination but future cliffs stop permanently', async () => withV4Fixture(async (chain, f) => {
    await fundAndLaunch(chain, f);
    const dev = chain.signers[1], start = await f.project.launchTime();
    await chain.mineAt(start + 40n * DAY);
    await endProject(chain, f);
    assert.equal(await f.project.creatorTokensVested(), TOTAL / 100n);
    await chain.mineAt(start + 200n * DAY);
    assert.equal(await f.project.creatorTokensVested(), TOTAL / 100n);
    await (await f.project.connect(dev).claimCreatorTokens()).wait();
    assert.equal(await f.token.balanceOf(dev.address), TOTAL / 100n);
    assert.equal(await f.project.claimableCreatorTokens(), 0n);
    assert.equal(await f.token.totalSupply(), TOTAL - (await f.locker.initialQuote()).lockedTokenRemainder); // The unreleased reserve remains in escrow.
  }));

  test('termination before day 15 releases no reserve and freezes the vote-free initial withdrawal', async () => withV4Fixture(async (chain, f) => {
    await fundAndLaunch(chain, f);
    const [,dev,alice,bob] = chain.signers;
    await chain.mineAt(await f.gov.anchor());
    await (await f.gov.connect(alice).proposeTermination(id('stop'),'ipfs://stop')).wait();
    await (await f.gov.connect(alice).voteToTerminate(1)).wait();
    assert.equal(await f.gov.withdrawalsFrozen(), true);
    assert.equal(await f.gov.terminated(), false);
    await assert.rejects(() => f.gov.connect(dev).claimInitialWithdrawal.staticCall());
    await (await f.gov.connect(bob).voteToTerminate(1)).wait();
    await assert.rejects(() => f.gov.connect(dev).claimInitialWithdrawal.staticCall());
    await chain.mineAt(await f.project.launchTime() + 180n * DAY);
    assert.equal(await f.project.claimableCreatorTokens(), 0n);
    assert.equal(await f.gov.initialWithdrawalClaimed(), false);
  }));

  test('initial quarter is authorized once at exactly 24h without votes or claimed investor tokens', async () => withV4Fixture(async (chain, f) => {
    await fundAndLaunch(chain, f);
    const [,dev,alice] = chain.signers, anchor = await f.gov.anchor();
    assert.equal(await f.token.publicPower(), await f.project.SALE_SUPPLY());
    await chain.mineAt(anchor - 1n);
    await assert.rejects(() => f.gov.connect(dev).claimInitialWithdrawal.staticCall());
    await assert.rejects(() => f.gov.connect(alice).claimInitialWithdrawal.staticCall());
    await chain.rpc('evm_setNextBlockTimestamp', [Number(anchor)]);
    const before = await chain.balance(dev.address);
    const receipt = await (await f.gov.connect(dev).claimInitialWithdrawal({gasLimit:500000})).wait();
    assert.equal(await chain.balance(dev.address) - before + receipt.gasUsed * receipt.gasPrice, parseEther('7.125'));
    assert.equal(await f.devVault.availableFunds(), parseEther('21.375'));
    assert.equal(await f.gov.withdrawalCount(), 0n);
    assert.equal(await f.gov.cyclePaid(0), true);
    assert.equal(await f.gov.initialWithdrawalClaimed(), true);
    await assert.rejects(() => f.gov.connect(dev).claimInitialWithdrawal.staticCall());
    await assert.rejects(() => f.gov.connect(dev).requestWithdrawal.staticCall(id('update'), 'ipfs://update'));
    await chain.mineAt(anchor + 7n * DAY);
    await (await f.gov.connect(dev).requestWithdrawal(id('update'), 'ipfs://update')).wait();
    assert.equal(await f.gov.withdrawalState(1), 1n);
    await assert.rejects(() => f.gov.executeWithdrawal.staticCall(1));
    await chain.mineAt((await f.gov.withdrawals(1)).endsAt);
    await (await f.gov.executeWithdrawal(1)).wait();
    assert.equal(await f.devVault.availableFunds(), parseEther('16.03125'));
  }));

  test('delayed initial claim consumes its cycle and failed recipient does not consume it', async () => withV4Fixture(async (chain, f) => {
    await fundAndLaunch(chain, f);
    const dev = chain.signers[1], anchor = await f.gov.anchor();
    const receiver = await chain.deploy('WithdrawalReceiver');
    await (await receiver.configure(f.gov.target, 0, true, false)).wait();
    await (await f.gov.connect(dev).setDevRecipient(receiver.target)).wait();
    await chain.mineAt(anchor + 7n * DAY - 60n);
    await assert.rejects(async () => (await f.gov.connect(dev).claimInitialWithdrawal({gasLimit:500000})).wait());
    assert.equal(await f.gov.initialWithdrawalClaimed(), false);
    assert.equal(await f.gov.lastSuccessfulWithdrawal(), 0n);
    assert.equal(await f.gov.cyclePaid(0), false);
    await (await f.gov.connect(dev).setDevRecipient(dev.address)).wait();
    await (await f.gov.connect(dev).claimInitialWithdrawal()).wait();
    const last = await f.gov.lastSuccessfulWithdrawal();
    await chain.mineAt(anchor + 7n * DAY);
    await assert.rejects(() => f.gov.connect(dev).requestWithdrawal.staticCall(id('update'), 'ipfs://update'));
    await chain.mineAt(last + 7n * DAY - 12n * 3600n);
    await (await f.gov.connect(dev).requestWithdrawal(id('update'), 'ipfs://update')).wait();
    await chain.mineAt((await f.gov.withdrawals(1)).endsAt);
    await (await f.gov.executeWithdrawal(1)).wait();
    assert.ok(await f.gov.lastSuccessfulWithdrawal() >= last + 7n * DAY);
  }));

  test('developer handover transfers the remaining creator reserve without resetting initial withdrawal', async () => withV4Fixture(async (chain, f) => {
    await fundAndLaunch(chain, f);
    const [,dev,successor] = chain.signers;
    await chain.mineAt(await f.gov.anchor());
    await (await f.gov.connect(dev).claimInitialWithdrawal()).wait();
    await (await f.gov.connect(dev).proposeDeveloperTransfer(successor.address)).wait();
    await chain.mineAt(await f.gov.developerTransferReadyAt());
    await (await f.gov.connect(successor).acceptDeveloperTransfer()).wait();
    await assert.rejects(() => f.gov.connect(successor).claimInitialWithdrawal.staticCall());
    await chain.mineAt(await f.project.launchTime() + 180n * DAY);
    await assert.rejects(() => f.project.connect(dev).claimCreatorTokens.staticCall());
    const before = await f.token.balanceOf(successor.address);
    await (await f.project.connect(successor).claimCreatorTokens()).wait();
    assert.equal(await f.token.balanceOf(successor.address), before + RESERVE);
    assert.equal(await f.token.balanceOf(dev.address), 0n);
  }));
});

describe("Handover, maintenance and recovery", {concurrency: false}, () => {
  const DAY=86400;
  function fixture(run) {
    return withLocalChain(async c => {
    const [owner,founder,alice,bob]=c.signers, validator=Wallet.createRandom();
    const manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[validator.address]});
    const p=await c.createProject(s.factory,{target:eth('1'),creator:founder});
    await tx(p.connect(alice).contribute(0,{value:eth('1'),gasLimit:16000000}));
    await tx(p.migrate({gasLimit:16000000}));
    const t=new Contract(await p.token(),artifact('ProjectToken').abi,alice);
    const g=new Contract(await p.governance(),artifact('UpgradeableCommunityGovernance').abi,founder);
    const r=new Contract(await t.feeRewards(),artifact('UpgradeableProjectRewards').abi,founder);
    const o=new Contract(await t.operatingRewards(),artifact('UpgradeableProjectRewards').abi,founder);
    await c.rpc('evm_mine',[]);
    await run({c,s,p,t,g,r,o,owner,founder,alice,bob,validator});

    });
  }
  async function schedule(f,target,data,salt){await tx(f.s.timelock.schedule(target,0,data,ZeroHash,id(salt),172800));}
  async function execute(f,target,data,salt){return tx(f.s.timelock.execute(target,0,data,ZeroHash,id(salt)));}
  test('handover moves unclaimed vested reserve, deposit and treasury authority without resetting history',async()=>fixture(async f=>{
   const {c,s,p,t,g,founder,bob}=f;
   await c.mineAt(Number(await g.anchor())); await tx(g.claimInitialWithdrawal());
   await c.mineAt(Number(await p.launchTime())+16*DAY); await tx(p.claimCreatorTokens());
   const claimed=await p.creatorTokensClaimed(), oldTokens=await t.balanceOf(founder.address), last=await g.lastSuccessfulWithdrawal();
   await tx(g.proposeDeveloperTransfer(bob.address)); await c.mineAt(Number(await g.developerTransferReadyAt()));
   await tx(g.connect(bob).acceptDeveloperTransfer());
   assert.equal(await p.creatorBeneficiary(),bob.address); assert.equal(await g.devRecipient(),bob.address);
   assert.equal(await g.lastSuccessfulWithdrawal(),last); assert.equal(await g.initialWithdrawalClaimed(),true);
   await assert.rejects(()=>g.claimWeeklyWithdrawal.staticCall());
   await assert.rejects(()=>s.factory.connect(founder).claimCreationDeposit.staticCall(p.target,founder.address));
   await tx(s.factory.connect(bob).claimCreationDeposit(p.target,bob.address));
   await c.mineAt(Number(await p.launchTime())+31*DAY);
   await assert.rejects(()=>p.claimCreatorTokens.staticCall()); await tx(p.connect(bob).claimCreatorTokens());
   assert.equal(await t.balanceOf(founder.address),oldTokens);
   assert.equal(await t.balanceOf(bob.address),await p.creatorTokensVested()-claimed);
   await tx(g.connect(bob).claimWeeklyWithdrawal());
  }));
  test('manager is exempt only from termination proposal threshold; pending/expired proposals freeze/release treasury',async()=>fixture(async f=>{
   const {c,t,g,founder,bob}=f;
   assert.equal(await t.balanceOf(founder.address),0n);
   await assert.rejects(()=>g.connect(bob).proposeTermination.staticCall(id('outsider'),'ipfs://reason'));
   await c.mineAt(Number(await g.anchor()));
   await tx(g.proposeTermination(id('manager exit'),'ipfs://reason'));
   const p=await g.proposals(1); assert.equal(p.totalPower,await t.eligiblePower()); assert.equal(await g.withdrawalsFrozen(),true);
   await assert.rejects(()=>g.claimInitialWithdrawal.staticCall());
   await c.mineAt(Number(p.uploadEndsAt)); assert.equal(await g.withdrawalsFrozen(),false); await tx(g.claimInitialWithdrawal());
   assert.equal(await g.terminated(),false);
  }));
  test('changing the legacy governance minimum cannot alter token-defined eligibility or the denominator',async()=>fixture(async f=>{
   const {c,t,g,alice,bob}=f;
   await tx(t.transfer(bob.address,eth('4999'))); await c.rpc('evm_mine',[]);
   const candidate=await c.deploy('GovernanceMinimumTest'), data=g.interface.encodeFunctionData('upgradeToAndCall',[candidate.target,'0x']);
   await schedule(f,g.target,data,'minimum'); await c.mineAt((await c.timestamp())+172800); await execute(f,g.target,data,'minimum');
   const changed=new Contract(g.target,artifact('GovernanceMinimumTest').abi,alice); await tx(changed.setOldMinimum(eth('1')));
   assert.equal(await changed.votingMinimum(),eth('5000'));
   const cycle=await changed.nextWithdrawalCycle();
   await assert.rejects(()=>changed.connect(bob).proposeWithdrawalVeto.staticCall(cycle,id('veto'),'ipfs://reason'));
   await tx(changed.proposeWithdrawalVeto(cycle,id('veto'),'ipfs://reason'));
   assert.equal((await changed.proposals(1)).totalPower,await t.eligiblePower());
  }));
  test('delayed maintenance cannot cancel ongoing votes but stops proposals from perpetually blocking repair',async()=>fixture(async f=>{
   const {c,g,alice}=f, candidate=await c.deploy('GovernanceV2Test');
   const upgrade=g.interface.encodeFunctionData('upgradeToAndCall',[candidate.target,'0x']),pause=g.interface.encodeFunctionData('pauseNewProposals');
   await schedule(f,g.target,upgrade,'repair'); await schedule(f,g.target,pause,'pause'); await c.mineAt((await c.timestamp())+172800);
   await tx(g.connect(alice).proposeWithdrawalVeto(await g.nextWithdrawalCycle(),id('veto'),'ipfs://reason'));
   await assert.rejects(()=>f.s.timelock.execute.staticCall(g.target,0,upgrade,ZeroHash,id('repair')));
   await execute(f,g.target,pause,'pause'); const proposal=await g.proposals(1);
   await assert.rejects(()=>g.proposeTermination.staticCall(id('spam'),'ipfs://reason'));
   assert.equal((await g.proposals(1)).endsAt,proposal.endsAt);
   await c.mineAt(Number(proposal.uploadEndsAt)); await execute(f,g.target,upgrade,'repair');
   assert.equal(await new Contract(g.target,artifact('GovernanceV2Test').abi,alice).version(),2n);
   await c.mineAt(Number(await g.proposalsPausedUntil())); await tx(g.proposeTermination(id('resumed'),'ipfs://reason'));
  }));
  test('recovery preserves credited liabilities, carries uncredited funds and restores transfers after broken callbacks',async()=>fixture(async f=>{
   const {c,s,t,r,o,alice,bob}=f;
   assert.equal(await t.rewardRecoveryAuthority(),s.timelock.target);
   await tx(r.deposit({value:eth('1')})); await c.mineAt(Number(await r.nextRoundAt())); await tx(r.process(1500000,{gasLimit:1700000}));
   const owed=await r.claimable(alice.address); assert.equal(owed,eth('1'));
   for(let i=0;i<20;++i)await tx(t.transfer(Wallet.createRandom().address,eth('5000')));
   await tx(r.deposit({value:eth('2')})); await c.mineAt(Number(await r.nextRoundAt())); await tx(r.process(220000,{gasLimit:350000}));
   assert.notEqual((await r.currentRound()).phase,0n);
   await assert.rejects(()=>t.pruneHolders.staticCall(200)); await assert.rejects(()=>t.connect(bob).setRewardRecovery(true));
   const bad=await c.deploy('BrokenRewardsTest');
   const enable=t.interface.encodeFunctionData('setRewardRecovery',[true]),upgrade=r.interface.encodeFunctionData('upgradeToAndCall',[bad.target,'0x']);
   await schedule(f,t.target,enable,'recover'); await schedule(f,r.target,upgrade,'broken'); await c.mineAt((await c.timestamp())+172800);
   await assert.rejects(()=>s.timelock.execute.staticCall(r.target,0,upgrade,ZeroHash,id('broken')));
   await execute(f,t.target,enable,'recover'); await execute(f,r.target,upgrade,'broken');
   await tx(t.transfer(bob.address,eth('5000')));
   const phase=(await r.currentRound()).phase; await tx(r.process(1000000,{gasLimit:1200000})); assert.equal((await r.currentRound()).phase,phase);
   const abort=r.interface.encodeFunctionData('abortRoundForRecovery'),restore=r.interface.encodeFunctionData('upgradeToAndCall',[s.rewardsImplementation.target,'0x']),resume=t.interface.encodeFunctionData('setRewardRecovery',[false]);
   await schedule(f,r.target,abort,'abort'); await schedule(f,r.target,restore,'restore'); await schedule(f,t.target,resume,'resume');
   await c.mineAt((await c.timestamp())+172800);
   await assert.rejects(()=>s.timelock.execute.staticCall(t.target,0,resume,ZeroHash,id('resume')));
   await execute(f,r.target,abort,'abort'); await execute(f,r.target,restore,'restore'); await execute(f,t.target,resume,'resume');
   assert.equal(await r.claimable(alice.address),owed); assert.equal(await r.queuedFunds(),eth('2')); assert.equal(await o.totalClaimable(),0n);
   await tx(t.connect(bob).transfer(alice.address,eth('5000'))); await tx(r.connect(alice).claim()); assert.equal(await r.claimable(alice.address),0n);
  }));
  test('empty identities can be pruned only between rounds and re-register on receipt',async()=>fixture(async f=>{
   const {c,t,alice,bob}=f, before=await t.holderCount();
   await tx(t.transfer(bob.address,eth('5000'))); assert.equal(await t.holderCount(),before+1n);
   await tx(t.connect(bob).transfer(alice.address,eth('5000'))); await c.rpc('evm_mine',[]);
   await tx(t.pruneHolders(200)); assert.equal(await t.holderCount(),before);
   await tx(t.transfer(bob.address,eth('5000'))); assert.equal(await t.holderCount(),before+1n);
  }));
});

describe("Direct settlement claims", {concurrency: false}, () => {
  test('termination fixes preceding-block balances; bad root cannot overpay, omitted holders fall back, later fees remain claimable',async()=>{
   const chain=await createLocalChain();
   try{
    const[platform,dev,a,b,c]=chain.signers;
    const token=await chain.deploy('MockVotingToken',[[a.address,b.address],[200n,100n]]);
    const gov=await chain.deploy('ProjectGovernance',[dev.address,token.target]);
    const treasury=new Contract(await gov.devVault(),artifact('ProjectVault').abi,platform);
    const insurance=new Contract(await gov.insuranceVault(),artifact('ProjectVault').abi,platform);
    const settlement=new Contract(await gov.settlement(),artifact('ProjectSettlement').abi,platform);
    await(await treasury.deposit({value:600n})).wait();await(await insurance.deposit({value:300n})).wait();
    const proposal=await(await gov.connect(a).proposeTermination(id('stop'),'ipfs://stop')).wait();
    await(await token.connect(a).transfer(c.address,200n)).wait();
    await(await gov.connect(a).voteToTerminate(1)).wait();
    assert.equal(await gov.terminated(),true); // exactly 2/3
    assert.equal(await settlement.snapshotBlock(),BigInt(proposal.blockNumber-1));
    assert.equal(await settlement.totalDeposited(),900n);assert.equal(await treasury.availableFunds(),0n);
    await assert.rejects(()=>settlement.activate(a.address,proposal.blockNumber-1));
    await assert.rejects(()=>settlement.connect(b).publish(id('root'),id('hash'),'cid'));
    await assert.rejects(()=>settlement.connect(a).claimDirect.staticCall(a.address));
    // Proposer submits a root with an inflated weight. Onchain checkpoints reject it.
    await(await settlement.connect(a).publish(await settlement.leaf(a.address,300),id('hash'),'bafymanifest')).wait();
    await assert.rejects(()=>settlement.connect(a).claim.staticCall(300,[],a.address));
    await chain.mineAt(Number(await settlement.activatedAt())+7*86400);
    await assert.rejects(()=>settlement.connect(c).claimDirect.staticCall(c.address));
    await assert.rejects(()=>settlement.connect(a).claimDirect.staticCall(ZeroAddress));
    const before=await chain.balance(c.address);
    await(await settlement.connect(a).claimDirect(c.address)).wait();
    assert.equal(await chain.balance(c.address)-before,600n);
    await(await settlement.connect(b).claimDirect(b.address)).wait();
    assert.equal(await settlement.totalPaid(),900n);
    await assert.rejects(()=>settlement.connect(a).claimDirect.staticCall(a.address));
    await(await settlement.deposit({value:300n})).wait();
    assert.equal(await settlement.claimable(a.address),200n);assert.equal(await settlement.claimable(b.address),100n);
    await(await settlement.connect(a).claimDirect(a.address)).wait();await(await settlement.connect(b).claimDirect(b.address)).wait();
    assert.equal(await settlement.totalPaid(),1200n);
   }finally{await chain.close();}
  });
  test('valid manifest permits immediate individual claim, even when proposer never pays another transaction',async()=>{
   const chain=await createLocalChain();try{
    const[platform,dev,a]=chain.signers;
    const token=await chain.deploy('MockVotingToken',[[a.address],[100n]]);
    const gov=await chain.deploy('ProjectGovernance',[dev.address,token.target]);
    const treasury=new Contract(await gov.devVault(),artifact('ProjectVault').abi,platform);
    const s=new Contract(await gov.settlement(),artifact('ProjectSettlement').abi,a);
    await(await treasury.deposit({value:1000n})).wait();
    await(await gov.connect(a).proposeTermination(id('stop'),'ipfs://stop')).wait();
    await(await gov.connect(a).voteToTerminate(1)).wait();
    await(await s.publish(await s.leaf(a.address,100n),id('snapshot'),'bafysnapshot')).wait();
    await(await s.claim(100n,[],a.address)).wait();assert.equal(await s.totalPaid(),1000n);
   }finally{await chain.close();}
  });
});
