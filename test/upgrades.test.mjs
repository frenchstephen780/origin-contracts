import {describe, test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Contract, Wallet, parseEther, id, ZeroAddress, ZeroHash, MaxUint256, parseEther as eth} from 'ethers';
import {artifact, createLocalChain} from '../scripts/local-chain.mjs';
import {deployUpgradeableSuite, assertInitcode} from '../scripts/upgradeable-suite.mjs';
import {assertCompatibleStorage, assertArtifactRuntime} from '../scripts/storage-layout.mjs';
import {swap} from '../scripts/local-v4.mjs';
import {tx} from './helpers.mjs';

describe("UUPS compatibility and Timelock execution", {concurrency: false}, () => {
  const DAY = 86400, WEEK = 7 * DAY, eth = parseEther;
  let chain, owner, dev, alice, bob, carol, validator, suite, token, gov, vault, rewards, operating, project;
  beforeEach(async () => {
    chain = await createLocalChain(); [owner, dev, alice, bob, carol] = chain.signers; validator = Wallet.createRandom();
    const manager = await chain.deploy('PoolManager', [owner.address]);
    suite = await deployUpgradeableSuite({signer: owner, manager: manager.target, platform: owner.address,
      proposer: owner.address, validators: [validator.address], lpRewards: false});
    suite.manager = manager;
  });
  afterEach(async () => chain?.close());
  async function launch() {
    project = await chain.createProject(suite.factory);
    token = new Contract(await project.token(), artifact('ProjectToken').abi, owner);
    for (const [who, amount] of [[alice, '28.5'], [bob, '14.25'], [carol, '14.25']]) await tx(project.connect(who).contribute(0, {value: eth(amount), gasLimit: 600000}));
    await tx(project.migrate({gasLimit: 16000000}));
    gov = new Contract(await project.governance(), artifact('UpgradeableCommunityGovernance').abi, dev);
    vault = new Contract(await gov.devVault(), artifact('ProjectVault').abi, owner);
    rewards = new Contract(await token.feeRewards(), artifact('UpgradeableProjectRewards').abi, owner);
    operating = new Contract(await token.operatingRewards(), artifact('UpgradeableProjectRewards').abi, dev);
  }
  async function schedule(proxy, candidate, salt = id('test upgrade')) {
    const data = proxy.interface.encodeFunctionData('upgradeToAndCall', [candidate.target, '0x']);
    await tx(suite.timelock.schedule(proxy.target, 0, data, ZeroHash, salt, 2 * DAY));
    return [proxy.target, 0, data, ZeroHash, salt];
  }
  async function upgrade(proxy, candidate, salt) {
    const args = await schedule(proxy, candidate, salt);
    await chain.mineAt(await chain.timestamp() + 2 * DAY);
    await tx(suite.timelock.execute(...args));
    return new Contract(proxy.target, candidate.interface, proxy.runner);
  }
  async function finish(r) {
    for (let i = 0; i < 80; ++i) {
      await tx(r.process(1500000, {gasLimit: 1700000}));
      if ((await r.currentRound()).phase === 0n) return;
    }
    assert.fail('reward round did not finish');
  }
  async function ballot(who, proposalId, support) {
    const p = await gov.proposals(proposalId);
    return who.signTypedData({name:'OriginCommunityGovernance',version:'1',chainId:31337,verifyingContract:gov.target},
      {Ballot:[{name:'proposalId',type:'uint256'},{name:'snapshotHash',type:'bytes32'},{name:'voter',type:'address'},{name:'support',type:'uint8'}]},
      {proposalId, snapshotHash:p.snapshotHash, voter:who.address, support});
  }
  async function finalize(proposalId, forVotes) {
    const p = await gov.proposals(proposalId);
    const support = p.kind===3n ? 0 : 1;
    const r = {proposalId, forVotes: support===1 ? forVotes : 0n, againstVotes:support===0 ? forVotes : 0n, abstainVotes:0, archiveHash:id('public archive'),
      cid:'bafypublicarchive', uploader:alice.address, deadline:p.uploadEndsAt};
    await tx(gov.connect(alice).finalizeResult(r,support,await ballot(alice,proposalId,support),[validator.address],
      [validator.signingKey.sign(await gov.resultDigest(r)).serialized]));
  }

  test('one deployment workflow migrates real V4 liquidity into independently initialized UUPS governance and reward vaults', async () => {
    await launch({automatic: true});
    assert.equal(await project.state(), 3n);
    assert.equal(await vault.availableFunds(), eth('28.5'));
    assert.equal(await suite.factory.accruedMigrationFees(), eth('0.57'));
    const locker = new Contract(await project.liquidityLocker(), artifact('PermanentLiquidityLocker').abi, owner);
    assert.ok(await locker.positionLiquidity() > 0n);
    assert.equal(await chain.balance(locker.target), 0n);
    assert.equal(await chain.balance(suite.manager.target), eth('27.93') - await project.migrationGasRefund());
    assert.equal(await vault.controller(), gov.target);
    assert.equal(await gov.upgradeAuthority(), suite.timelock.target);
    assert.equal(await rewards.upgradeAuthority(), suite.timelock.target);
    assert.equal(await rewards.token(), token.target);
    assert.equal(await operating.governance(), gov.target);
    assert.notEqual(rewards.target, operating.target);
    assert.equal(await suite.coordinator.dividendService(), ZeroAddress); // no obsolete Merkle service deployment
    assert.equal(await token.excluded(gov.target), true);
    for(const address of [suite.timelock.target,suite.feePolicy.target,suite.feePolicyImplementation.target,
      suite.governanceImplementation.target,suite.rewardsImplementation.target,suite.governanceDeployer.target,
      suite.rewardsDeployer.target,suite.hookDeployer.target]) assert.equal(await token.excluded(address),true);
    const eligible=await token.eligiblePower();
    await tx(token.connect(alice).transfer(suite.governanceImplementation.target,eth('5000')));
    assert.equal(await token.getPastPower(suite.governanceImplementation.target,await chain.provider.getBlockNumber()-1),0n);
    assert.equal(await token.eligiblePower(),eligible-eth('5000'));
    await assert.rejects(() => gov.initialize.staticCall(dev.address, token.target, suite.verifier.target, suite.timelock.target));
    await assert.rejects(() => rewards.initialize.staticCall(token.target, gov.target, suite.hook.target, suite.timelock.target));
    await assert.rejects(() => suite.governanceImplementation.initialize.staticCall(dev.address, token.target, suite.verifier.target, suite.timelock.target));
    await assert.rejects(() => suite.feePolicyImplementation.initialize.staticCall(suite.timelock.target));
    await assert.rejects(() => chain.deploy('OriginProxy', [suite.feePolicyImplementation.target, '0x']));
    await assert.rejects(() => suite.coordinator.configureUpgradeServices.staticCall(suite.rewardsDeployer.target, suite.hook.target, suite.feePolicy.target));
  });

  test('only the timelock upgrades, delay cannot be bypassed/reduced, incompatible module families cannot be installed', async () => {
    await launch(); const next = await chain.deploy('GovernanceV2Test');
    await assert.rejects(() => gov.connect(dev).upgradeToAndCall.staticCall(next.target, '0x'));
    await assert.rejects(() => gov.connect(owner).upgradeToAndCall.staticCall(next.target, '0x'));
    await assert.rejects(() => suite.timelock.connect(alice).schedule.staticCall(gov.target,0,'0x',ZeroHash,id('unauthorized'),2*DAY));
    const args = await schedule(gov, next);
    await assert.rejects(() => suite.timelock.execute.staticCall(...args));
    await chain.mineAt(await chain.timestamp() + 2 * DAY); await tx(suite.timelock.execute(...args));
    const updated = new Contract(gov.target, next.interface, dev);
    assert.equal(await updated.version(), 2n); assert.equal(await updated.devVault(), vault.target);
    assert.equal(await updated.developer(), dev.address);
    await assert.rejects(() => suite.timelock.execute.staticCall(...args));
    const invalid = await schedule(updated, suite.rewardsImplementation, id('wrong family'));
    await chain.mineAt(await chain.timestamp() + 2 * DAY); await assert.rejects(() => suite.timelock.execute.staticCall(...invalid));
    const data = suite.timelock.interface.encodeFunctionData('updateDelay', [1]);
    await tx(suite.timelock.schedule(suite.timelock.target,0,data,ZeroHash,id('reduce delay'),2*DAY));
    await chain.mineAt(await chain.timestamp()+2*DAY);
    await assert.rejects(() => suite.timelock.execute.staticCall(suite.timelock.target,0,data,ZeroHash,id('reduce delay')));
    assert.equal(await suite.timelock.getMinDelay(), 2n*BigInt(DAY));
  });

  test('upgraded withdrawal logic changes future weekly payouts while preserving the first quarter, vault funds and weekly spacing', async () => {
    await launch(); const anchor = Number(await gov.anchor());
    await chain.mineAt(anchor); await tx(gov.claimInitialWithdrawal()); assert.equal(await vault.availableFunds(), eth('21.375'));
    gov = await upgrade(gov, await chain.deploy('GovernanceV2Test'));
    assert.equal(await gov.initialWithdrawalClaimed(), true);
    await chain.mineAt(anchor + WEEK + 2); await tx(gov.claimWeeklyWithdrawal());
    assert.equal(await vault.availableFunds(), eth('17.1')); // upgraded 1/5 instead of 1/4
    await assert.rejects(() => gov.claimWeeklyWithdrawal.staticCall());
  });

  test('proxy EIP-712 domain verifies ballots and results; pending termination blocks upgrades and final settlement stays immutable', async () => {
    await launch();
    await chain.mineAt(Number(await gov.anchor()));
    await tx(gov.connect(alice).proposeTermination(id('end project'), 'ipfs://disclosure'));
    const n = await gov.proposalCount(), p = await gov.proposals(n);
    const sig = await ballot(alice,n,1); assert.equal(await gov.validBallot(n,alice.address,1,sig),true);
    const next = await chain.deploy('GovernanceV2Test'), args = await schedule(gov,next);
    await chain.mineAt(await chain.timestamp()+2*DAY); await assert.rejects(() => suite.timelock.execute.staticCall(...args));
    await chain.mineAt(Number(p.endsAt)); await finalize(n, (p.totalPower*2n+2n)/3n);
    assert.equal(await gov.terminated(),true);
    await assert.rejects(() => suite.timelock.execute.staticCall(...args));
    const settlement = new Contract(await gov.settlement(),artifact('ProjectSettlement').abi,owner);
    assert.equal(await settlement.totalDeposited(),0n);
    assert.equal(await rewards.queuedFunds(),eth('28.5'));
    assert.equal(await vault.availableFunds(),0n);
    await chain.mineAt(Number(await gov.terminatedAt())+7*DAY);
    await assert.rejects(()=>settlement.connect(alice).claimDirect.staticCall(dev.address));
    await chain.mineAt(Math.max(await chain.timestamp()+1,Number(await rewards.nextRoundAt()))); await finish(rewards);
    assert.ok(await rewards.claimable(alice.address)>0n);
    const before=await chain.balance(dev.address);await tx(rewards.connect(alice).claimTo(dev.address));
    assert.ok(await chain.balance(dev.address)>before);
  });

  test('a veto cannot block the delayed first vote-free withdrawal; veto still blocks subsequent payment in its cycle', async () => {
    await launch();
    await chain.mineAt(Number(await gov.anchor()));
    await tx(gov.connect(alice).proposeWithdrawalVeto(1,id('veto'),'ipfs://veto'));
    const n=await gov.proposalCount(), p=await gov.proposals(n);
    await chain.mineAt(Number(p.endsAt)); await finalize(n,(p.totalPower+1n)/2n);
    await chain.mineAt(Number(await gov.anchor())+WEEK);
    assert.equal(await gov.cycleBlocked(1),true);
    await tx(gov.claimInitialWithdrawal()); assert.equal(await vault.availableFunds(),eth('21.375'));
    await assert.rejects(()=>gov.claimWeeklyWithdrawal.staticCall());
  });

  test('idle reward upgrade preserves earned balances and both ETH vaults; future rounds use the upgraded share algorithm', async () => {
    await launch(); await tx(operating.deposit({value:eth('1')}));
    await chain.mineAt(Number(await operating.nextRoundAt())); await finish(operating);
    const earned=await operating.claimable(alice.address), liability=await operating.totalClaimable();
    assert.ok(earned>0n); assert.equal(await rewards.totalClaimable(),0n);
    await chain.mineAt(await chain.timestamp()+23*DAY);
    await tx(token.connect(bob).transfer(carol.address,eth('6000'))); // different receipt ages
    operating = await upgrade(operating,await chain.deploy('RewardsV2Test'));
    assert.equal(await operating.claimable(alice.address),earned); assert.equal(await operating.totalClaimable(),liability);
    await tx(operating.deposit({value:eth('2')})); await finish(operating);
    const r=await operating.currentRound();
    const raw=await token.recentWeight(alice.address,r.snapshotBlock,r.weightTime);
    assert.equal((await operating.frozenWeights(alice.address)).shares,(raw.balance+raw.shares)/2n);
    assert.equal(await chain.balance(operating.target),await operating.accountedFunds());
    const before=await chain.balance(dev.address); const all=await operating.claimable(alice.address);
    await tx(operating.connect(alice).claimTo(dev.address)); assert.equal(await chain.balance(dev.address)-before,all);
  });

  test('an active reward round prevents algorithm upgrades; copy-before-write still captures shares across proxy callbacks', async () => {
    await launch();
    for(let i=0;i<16;i++) await tx(token.connect(alice).transfer(Wallet.createRandom().address,eth('100')));
    const args=await schedule(operating,await chain.deploy('RewardsV2Test')); await chain.mineAt(await chain.timestamp()+2*DAY);
    await tx(operating.deposit({value:eth('1')})); await tx(operating.process(250000,{gasLimit:310000}));
    let r=await operating.currentRound(); assert.notEqual(r.phase,0n);
    await assert.rejects(()=>suite.timelock.execute.staticCall(...args));
    const expected=(await token.recentWeight(bob.address,r.snapshotBlock,r.weightTime)).shares;
    await tx(token.connect(bob).transfer(carol.address,eth('1000'),{gasLimit:500000}));
    assert.equal((await operating.frozenWeights(bob.address)).shares,expected);
    await finish(operating); await tx(suite.timelock.execute(...args));
    assert.equal(await chain.balance(operating.target),await operating.accountedFunds());
  });

  test('fee split upgrades preserve accrued fees; faulty policies fall back to backed defaults without stopping swaps', async () => {
    await launch();
    const f={...suite,key:[ZeroAddress,token.target,3000,60,suite.hook.target],router:await chain.deploy('V4TestRouter',[suite.manager.target])};
    await swap(f,alice,true,-eth('1'),{value:eth('1')});
    const poolId=await project.poolId(), accrued=await suite.hook.projects(poolId);
    assert.equal(accrued.devAccrued,eth('0.004')); assert.equal(accrued.rewardsAccrued,eth('0.003'));
    suite.feePolicy=await upgrade(suite.feePolicy,await chain.deploy('FeePolicyV2Test'));
    await swap(f,alice,true,-eth('1'),{value:eth('1')});
    const after=await suite.hook.projects(poolId);
    assert.equal(after.devAccrued,eth('0.009')); assert.equal(after.rewardsAccrued,eth('0.005'));
    await tx(suite.hook.distribute(poolId)); assert.equal(await rewards.queuedFunds(),eth('0.005'));
    const supply=await token.totalSupply();
    suite.feePolicy=await upgrade(suite.feePolicy,await chain.deploy('InvalidFeePolicyTest'),id('bad policy'));
    await swap(f,alice,true,-eth('1'),{value:eth('1')});
    const fallback=await suite.hook.projects(poolId);
    assert.equal(fallback.devAccrued,eth('0.004')); assert.equal(fallback.rewardsAccrued,eth('0.003'));
    assert.equal(await token.totalSupply(),supply);
  });

  test('storage compatibility rejects reorder/type/struct changes and initcode limit includes constructor arguments',()=>{
    for(const [base,next] of [['UpgradeableCommunityGovernance','GovernanceV2Test'],['UpgradeableProjectRewards','RewardsV2Test'],['SwapFeePolicy','FeePolicyV2Test']])
      assertCompatibleStorage(artifact(base).storageLayout,artifact(next).storageLayout);
    const layout=artifact('UpgradeableCommunityGovernance').storageLayout, bad=structuredClone(layout);
    [bad.storage[0],bad.storage[1]]=[bad.storage[1],bad.storage[0]];
    assert.throws(()=>assertCompatibleStorage(layout,bad));
    const badType=structuredClone(layout); badType.types[badType.storage[0].type].numberOfBytes='1';
    assert.throws(()=>assertCompatibleStorage(layout,badType));
    assert.doesNotThrow(()=>assertInitcode('0x'+'00'.repeat(49152)));
    assert.throws(()=>assertInitcode('0x'+'00'.repeat(49153)));
    const a=artifact('UpgradeableProjectRewards');
    assert.doesNotThrow(()=>assertArtifactRuntime(a,a.deployedBytecode));
    assert.throws(()=>assertArtifactRuntime(a,'0x00'));
  });

  test('attestor rotation requires the timelock and idle governance and installs the configured validator set',async()=>{
    await launch();
    const replacement=await chain.deploy('AllocationVerifier',[[bob.address],1]);
    await assert.rejects(()=>gov.setResultVerifier.staticCall(replacement.target));
    const data=gov.interface.encodeFunctionData('setResultVerifier',[replacement.target]), salt=id('attestor rotation');
    await tx(suite.timelock.schedule(gov.target,0,data,ZeroHash,salt,2*DAY));
    await chain.mineAt(Number(await gov.anchor()));
    await tx(gov.connect(alice).proposeTermination(id('review'),'ipfs://review'));
    const p=await gov.proposals(await gov.proposalCount());
    await chain.mineAt(await chain.timestamp()+2*DAY);
    await assert.rejects(()=>suite.timelock.execute.staticCall(gov.target,0,data,ZeroHash,salt));
    await chain.mineAt(Number(p.uploadEndsAt));
    await tx(suite.timelock.execute(gov.target,0,data,ZeroHash,salt));
    assert.equal(await gov.resultVerifier(),replacement.target);
    assert.equal(await replacement.isValidator(bob.address),true);
  });

  test('upgrade preparation CLI validates live implementation bytecode and storage and emits exact timelock calldata without broadcasting',async()=>{
    await launch(); const candidate=await chain.deploy('GovernanceV2Test');
    let writes=0;
    const server=http.createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;
      const handle=async input=>{
        if(input.method.includes('send') || input.method.includes('sign')) ++writes;
        try{return {jsonrpc:'2.0',id:input.id,result:await chain.rpc(input.method,input.params??[])}}
        catch(e){return {jsonrpc:'2.0',id:input.id,error:{code:-32000,message:e.message}}}
      };
      const input=JSON.parse(raw);res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(Array.isArray(input)?await Promise.all(input.map(handle)):await handle(input)));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'origin-upgrade-test-')),output=path.join(dir,'proposal.json');
    try{
      const salt=id('CLI operation');
      await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/prepare-upgrade.mjs',import.meta.url)),
        gov.target,suite.timelock.target,fileURLToPath(new URL('../artifacts/UpgradeableCommunityGovernance.json',import.meta.url)),
        fileURLToPath(new URL('../artifacts/GovernanceV2Test.json',import.meta.url)),candidate.target,salt,output],
        {env:{...process.env,UPGRADE_RPC_URL:`http://127.0.0.1:${server.address().port}`},timeout:30000});
      const prepared=JSON.parse(fs.readFileSync(output,'utf8'));
      assert.equal(prepared.currentImplementation,suite.governanceImplementation.target);
      assert.equal(prepared.delaySeconds,2*DAY);assert.equal(prepared.storageLayoutCompatible,true);
      const data=gov.interface.encodeFunctionData('upgradeToAndCall',[candidate.target,'0x']);
      assert.equal(prepared.operationId,await suite.timelock.hashOperation(gov.target,0,data,ZeroHash,salt));
      assert.equal(prepared.schedule.data,suite.timelock.interface.encodeFunctionData('schedule',[gov.target,0,data,ZeroHash,salt,2*DAY]));
      assert.equal(writes,0);
    }finally{
      await new Promise(resolve=>server.close(resolve));
      if(fs.existsSync(output))fs.unlinkSync(output);fs.rmdirSync(dir);
    }
  });
});

describe("Production maintenance integration", {concurrency: false}, () => {
  const DAY = 86400;

  test('latest suite: delayed maintenance, batching, role changes and Founder handover preserve project custody',
   {timeout:180000}, async () => {
   const c = await createLocalChain();
   try {
    const wallets = await Promise.all(Array.from({length:20}, (_,i) => c.provider.getSigner(i)));
    const [owner, founder, alice, bob] = wallets;
    const manager = await c.deploy('PoolManager', [owner.address]);
    const s = await deployUpgradeableSuite({signer:owner, manager:manager.target, platform:owner.address,
     proposer:owner.address, validators:[owner.address], fundraisingPolicyVersion:2});
    const project = await c.createProject(s.factory, {target:eth('1'), creator:founder});
    for (const w of wallets) await tx(project.connect(w).contribute(0, {value:eth('0.05')}));
    await tx(project.migrate({gasLimit:16000000, gasPrice:1000000000n}));
    const bind = (name,address,runner=founder) => new Contract(address,artifact(name).abi,runner);
    const token = bind('ProjectToken',await project.token());
    const gov = bind('UpgradeableCommunityGovernance',await project.governance());
    const rewards = bind('UpgradeableProjectRewards',await token.feeRewards());
    const operating = bind('OperatingRewardsLP',await token.operatingRewards());
    const vault = bind('ProjectVault',await gov.devVault());
    const locker = bind('PermanentLiquidityLocker',await project.liquidityLocker());
    const vaultBefore = await vault.availableFunds(), lpBefore = await locker.positionLiquidity();
    const tokenBefore = await token.balanceOf(alice.address);
    const nextVerifier = await c.deploy('AllocationVerifier',[[bob.address],1]);
    const targets = [s.coordinator.target,gov.target,gov.target];
    const values = [0,0,0];
    const calls = [s.coordinator.interface.encodeFunctionData('setMigrationFeeBps',[50]),
     gov.interface.encodeFunctionData('setResultVerifier',[nextVerifier.target]),
     gov.interface.encodeFunctionData('pauseNewProposals')];
    const salt = id('current maintenance batch');
    await assert.rejects(() => s.timelock.connect(bob).scheduleBatch.staticCall(targets,values,calls,ZeroHash,salt,2*DAY));
    await tx(s.timelock.scheduleBatch(targets,values,calls,ZeroHash,salt,2*DAY));
    await assert.rejects(() => s.timelock.executeBatch.staticCall(targets,values,calls,ZeroHash,salt));
    await c.mineAt((await c.timestamp())+2*DAY);
    await tx(s.timelock.connect(bob).executeBatch(targets,values,calls,ZeroHash,salt));
    assert.equal(await s.coordinator.migrationFeeBps(),50n);
    assert.equal(await project.migrationFeeBps(),100n);
    assert.equal(await gov.resultVerifier(),nextVerifier.target);
    assert.ok(await gov.proposalsPausedUntil()>BigInt(await c.timestamp()));
    assert.equal(await vault.availableFunds(),vaultBefore);
    assert.equal(await locker.positionLiquidity(),lpBefore);
    assert.equal(await token.balanceOf(alice.address),tokenBefore);
    await assert.rejects(() => gov.proposeTopic.staticCall(id('paused topic'),'local://topic'));

    // The public days entry and a new escrow must pick up future-project policy,
    // without changing an already created escrow's migration fee.
    const created = await tx(s.factory.connect(founder).createProjectDays(eth('1'),15,id('new fee project'),
     'local://new-fee',{value:eth('0.02')}));
    const newAddress = created.logs.map(l=>{try{return s.factory.interface.parseLog(l);}catch{return null;}})
     .find(l=>l?.name==='ProjectCreated').args.project;
    const newProject = bind('ProjectEscrow',newAddress);
    assert.equal(await newProject.migrationFeeBps(),50n);
    assert.equal((await newProject.deadline())-BigInt((await c.provider.getBlock(created.blockNumber)).timestamp),15n*BigInt(DAY));

    const canceledSalt = id('canceled delay increase');
    const delayData = s.timelock.interface.encodeFunctionData('updateDelay',[3*DAY]);
    await tx(s.timelock.schedule(s.timelock.target,0,delayData,ZeroHash,canceledSalt,2*DAY));
    const operationId = await s.timelock.hashOperation(s.timelock.target,0,delayData,ZeroHash,canceledSalt);
    await tx(s.timelock.cancel(operationId));
    assert.equal(await s.timelock.isOperation(operationId),false);
    const delaySalt = id('valid delay increase');
    await tx(s.timelock.schedule(s.timelock.target,0,delayData,ZeroHash,delaySalt,2*DAY));
    await c.mineAt((await c.timestamp())+2*DAY);
    await tx(s.timelock.execute(s.timelock.target,0,delayData,ZeroHash,delaySalt));
    assert.equal(await s.timelock.getMinDelay(),3n*BigInt(DAY));
    await assert.rejects(() => s.timelock.execute.staticCall(s.timelock.target,0,delayData,ZeroHash,canceledSalt));

    const proposerRole = await s.timelock.PROPOSER_ROLE();
    const roleSalt = id('proposer role grant');
    const grant = s.timelock.interface.encodeFunctionData('grantRole',[proposerRole,alice.address]);
    await tx(s.timelock.schedule(s.timelock.target,0,grant,ZeroHash,roleSalt,3*DAY));
    await c.mineAt((await c.timestamp())+3*DAY);
    await tx(s.timelock.execute(s.timelock.target,0,grant,ZeroHash,roleSalt));
    assert.equal(await s.timelock.hasRole(proposerRole,alice.address),true);
    const revoke = s.timelock.interface.encodeFunctionData('revokeRole',[proposerRole,alice.address]);
    const revokeSalt = id('proposer role revoke');
    await tx(s.timelock.schedule(s.timelock.target,0,revoke,ZeroHash,revokeSalt,3*DAY));
    await c.mineAt((await c.timestamp())+3*DAY);
    await tx(s.timelock.execute(s.timelock.target,0,revoke,ZeroHash,revokeSalt));
    assert.equal(await s.timelock.hasRole(proposerRole,alice.address),false);

    await tx(gov.setDevRecipient(bob.address));
    assert.equal(await gov.devRecipient(),bob.address);
    await tx(gov.proposeDeveloperTransfer(alice.address));
    await tx(gov.cancelDeveloperTransfer());
    await assert.rejects(() => gov.connect(alice).acceptDeveloperTransfer.staticCall());
    await tx(gov.proposeDeveloperTransfer(alice.address));
    await assert.rejects(() => gov.connect(alice).acceptDeveloperTransfer.staticCall());
    await c.mineAt((await c.timestamp())+2*DAY);
    await tx(gov.connect(alice).acceptDeveloperTransfer());
    assert.equal(await gov.developer(),alice.address);
    assert.equal(await gov.devRecipient(),alice.address);
    await assert.rejects(() => gov.setDevRecipient.staticCall(founder.address));
    await tx(gov.connect(alice).setDevRecipient(bob.address));
    const recipientBefore = await c.balance(bob.address);
    await tx(gov.connect(alice).claimInitialWithdrawal());
    assert.equal(await c.balance(bob.address)-recipientBefore,vaultBefore/4n);
    assert.equal(await vault.availableFunds(),vaultBefore-vaultBefore/4n);

    // Same-family upgrades on every latest proxy preserve existing project state.
    const proxies = [gov,rewards,operating,s.feePolicy];
    const names = ['UpgradeableCommunityGovernance','UpgradeableProjectRewards','OperatingRewardsLP','SwapFeePolicyLP'];
    const candidates = [];
    for (const name of names) candidates.push(await c.deploy(name));
    const upgradeTargets = proxies.map(p=>p.target);
    const upgradeCalls = proxies.map((p,i)=>p.interface.encodeFunctionData('upgradeToAndCall',[candidates[i].target,'0x']));
    const upgradeSalt = id('all current module upgrades');
    await tx(s.timelock.scheduleBatch(upgradeTargets,[0,0,0,0],upgradeCalls,ZeroHash,upgradeSalt,3*DAY));
    await c.mineAt((await c.timestamp())+3*DAY);
    await tx(s.timelock.executeBatch(upgradeTargets,[0,0,0,0],upgradeCalls,ZeroHash,upgradeSalt));
    for (let i=0;i<proxies.length;i++) assert.equal(await proxies[i].implementationAddress(),candidates[i].target);
    assert.equal(await gov.developer(),alice.address);
    assert.equal(await gov.resultVerifier(),nextVerifier.target);
    assert.equal(await gov.initialWithdrawalClaimed(),true);
    assert.equal(await vault.availableFunds(),vaultBefore-vaultBefore/4n);
    assert.equal(await locker.positionLiquidity(),lpBefore);
    assert.equal(await token.balanceOf(alice.address),tokenBefore);
    await tx(gov.connect(alice).proposeTopic(id('new Founder topic'),'local://new-founder-topic'));
    await assert.rejects(() => gov.proposeTopic.staticCall(id('old Founder topic'),'local://old-founder-topic'));
    await assert.rejects(() => s.feePolicy.initialize.staticCall(s.timelock.target));

    fs.mkdirSync(new URL('../.run/',import.meta.url),{recursive:true});
    fs.writeFileSync(new URL('../.run/latest-current-maintenance.json',import.meta.url),JSON.stringify({
     scope:'Independent local EVM, latest fundraising policy 2; no live administrative changes',
     delayedBatchVerified:true, futureProjectFeeOnlyVerified:true, cancellationVerified:true,
     delayIncreaseVerified:true, proposerGrantRevokeVerified:true, founderHandoverVerified:true,
     fourProxyUpgradesPreservedCustody:true, formerFounderPrivilegesRejected:true
    },null,2)+'\n');
   } finally { await c.close(); }
  });
});
