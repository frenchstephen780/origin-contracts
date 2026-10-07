import {describe, after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Contract, Interface, id, parseEther as eth, ZeroAddress, Wallet, getCreateAddress} from 'ethers';
import {artifact, createLocalChain} from '../scripts/local-chain.mjs';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';
import {tx, withLocalChain} from './helpers.mjs';

describe("Isolated attack reproductions", {concurrency: false}, () => {
  // Reproductions run only in independent in-process EVMs. No JsonRpcProvider,
  // environment RPC URL, real wallet key or broadcast script is used here.
  const DAY = 86400, WEEK = 7 * DAY;
  const evidence = [];
  function record(id, data) {
    const result = JSON.parse(JSON.stringify({id, ...data}, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    evidence.push(result);
    console.log(JSON.stringify(result));
  }
  after(() => {
    fs.mkdirSync(new URL('../.run/', import.meta.url), {recursive: true});
    fs.writeFileSync(new URL('../.run/local-security-results.json', import.meta.url), JSON.stringify({
      scope: 'isolated Hardhat simulated EVM, chain 31337; no external transactions',
      generatedAt: new Date().toISOString(), results: evidence,
    }, null, 2) + '\n');
  });
  function isolated(run) {
    return withLocalChain(async chain => {
      assert.equal((await chain.provider.getNetwork()).chainId, 31337n);
      await run(chain);
    });
  }
  async function production(c, target = eth('1')) {
    const [owner, founder, alice, bob, carol, keeper] = c.signers;
    const manager = await c.deploy('PoolManager', [owner.address]);
    const s = await deployUpgradeableSuite({signer: owner, manager: manager.target,
      platform: owner.address, proposer: owner.address, validators: [owner.address]});
    const p = await c.createProject(s.factory, {target, creator: founder});
    await tx(p.connect(alice).contribute(0, {value: target, gasLimit: 1000000}));
    const token = new Contract(await p.token(), artifact('ProjectToken').abi, owner);
    return {s, p, token, manager, owner, founder, alice, bob, carol, keeper:c.migrationSigner};
  }
  async function governance(c) {
    const [owner, founder, attacker, honest] = c.signers;
    const token = await c.deploy('ProjectToken', [owner.address, owner.address, ZeroAddress]);
    await tx(token.registerLocker(founder.address));
    await tx(token.launch());
    await tx(token.transfer(attacker.address, eth('500000')));
    await tx(token.transfer(honest.address, eth('1000000')));
    const verifier = await c.deploy('AllocationVerifier', [[owner.address], 1]);
    const g = await c.deploy('CommunityGovernance', [founder.address, token.target, verifier.target]);
    const vault = new Contract(await g.devVault(), artifact('ProjectVault').abi, owner);
    await tx(vault.deposit({value: eth('1')}));
    await c.mineAt(Number(await g.anchor()));
    await tx(g.connect(founder).claimInitialWithdrawal());
    return {owner, founder, attacker, honest, token, g, vault};
  }

  test('DEFENSE S-01: backend-only migration rejects other wallets and caps an expensive authorized transaction', async () => isolated(async c => {
    const {s, p, token, keeper, alice, manager} = await production(c);
    const quote = await s.coordinator.quote(eth('1'));
    const sale = await token.balanceOf(alice.address);
    const checkpoint = await c.rpc('evm_snapshot');
    const normal = await tx(p.connect(keeper).migrate({gasLimit: 16000000, gasPrice: 1000000000n}));
    const units = await p.migrationGasUnits();
    assert.equal(await c.rpc('evm_revert', [checkpoint]), true);
    await assert.rejects(() => p.connect(alice).migrate.staticCall({gasLimit:16000000,gasPrice:1000000000n}),
      error => error.revert?.name === 'Unauthorized');
    // Even the authorized sender remains subject to the shared ETH budget.
    const highPrice = quote.ethAmount * 98n / 100n / units;
    await assert.rejects(() => p.connect(keeper).migrate.staticCall({gasLimit: 16000000, gasPrice: highPrice}),
      error => error.revert?.name === 'MigrationGasBudgetExceeded');
    await assert.rejects(async () => tx(p.connect(keeper).migrate({gasLimit: 16000000, gasPrice: highPrice})));
    assert.equal(await p.state(), 1n);
    assert.equal(await c.balance(p.target), eth('1'));
    assert.equal(await c.balance(s.coordinator.target), 0n);
    assert.equal(await c.balance(manager.target), 0n);
    assert.equal(await p.migrationGasRefund(), 0n);
    assert.equal(await s.coordinator.migrated(p.target), false);
    const before = await c.balance(keeper.address);
    const successful = await tx(p.connect(keeper).migrate({gasLimit: 16000000, gasPrice: 1000000000n}));
    const refund = await p.migrationGasRefund();
    const locker = new Contract(await p.liquidityLocker(), artifact('PermanentLiquidityLocker').abi, keeper);
    const final = await locker.initialQuote();
    const fee = successful.gasUsed * successful.gasPrice;
    const profit = await c.balance(keeper.address) - before;
    assert.equal(await p.state(), 3n);
    assert.ok(refund <= await p.migrationGasRefundLimit());
    assert.ok(final.ethAmount * 100n >= quote.ethAmount * 98n);
    assert.equal(profit, refund - fee);
    assert.equal(await token.balanceOf(alice.address), sale);
    assert.equal(final.sqrtPriceX96, quote.sqrtPriceX96);
    record('S-01-fixed', {normalGasUsed: normal.gasUsed, reimbursedGasUnits: units,
      rejectedGasPriceWei: highPrice, reimbursementLimitWei: await p.migrationGasRefundLimit(), actualGasUsed: successful.gasUsed,
      originalLpWei: quote.ethAmount, refundWei: refund, actualFeeWei: fee,
      callerProfitWei: profit, remainingLpWei: final.ethAmount,
      unchangedOpeningPrice: true, unchangedSubscriberTokens: true});
  }));

  test('REPRO S-02: an expired early veto occupies the upcoming cycle and prevents replacement', async () => isolated(async c => {
    const {attacker, honest, g, vault, founder} = await governance(c);
    // Reduce the attacker to the public 0.005% proposer minimum.
    const token = new Contract(await g.votingPower(), artifact('ProjectToken').abi, attacker);
    await tx(token.transfer(c.signers[0].address, eth('495000')));
    await tx(g.connect(attacker).proposeWithdrawalVeto(1, id('empty early vote'), 'local://empty'));
    const early = await g.proposals(1);
    await c.mineAt(Number(early.uploadEndsAt) + 1);
    assert.equal(await g.proposalState(1), 5n);
    assert.ok(Number(await g.cycleUnlockAt(1)) - await c.timestamp() > 2 * DAY);
    await assert.rejects(() => g.connect(honest).proposeWithdrawalVeto.staticCall(1, id('actual objection'), 'local://objection'));
    assert.equal(await g.cycleProposal(1), 1n);
    await c.mineAt(Number(await g.cycleUnlockAt(1)) + 1);
    const before = await vault.availableFunds();
    await tx(g.connect(founder).claimWeeklyWithdrawal());
    assert.equal(await vault.availableFunds(), before * 3n / 4n);
    record('S-02', {requiredTokens: eth('5000'), expiredProposalStillReservesCycle: true,
      replacementRejected: true, withdrawalExecutedWithoutFinalizedResult: true});
  }));

  test('REPRO S-03: an unsupported termination proposal freezes withdrawals for three voting days plus one upload day', async () => isolated(async c => {
    const {attacker, founder, g, vault} = await governance(c);
    const before = await vault.availableFunds();
    await tx(g.connect(attacker).proposeTermination(id('unsupported proposal'), 'local://no-ballots'));
    const p = await g.proposals(1);
    assert.equal(await g.withdrawalsFrozen(), true);
    assert.equal(p.uploadEndsAt-p.startsAt,4n*BigInt(DAY));
    await c.mineAt(Number(p.endsAt));
    await assert.rejects(() => g.connect(founder).claimWeeklyWithdrawal.staticCall());
    assert.equal(await vault.availableFunds(), before);
    await c.mineAt(Number(p.uploadEndsAt));
    assert.equal(await g.withdrawalsFrozen(), false);
    assert.equal(await g.terminated(), false);
    await c.mineAt(Number(await g.cycleUnlockAt(1)) + 1);
    await tx(g.connect(founder).claimWeeklyWithdrawal());
    await c.mineAt(Number(p.startsAt) + WEEK + 10);
    await tx(g.connect(attacker).proposeTermination(id('repeat unsupported proposal'), 'local://no-ballots-2'));
    assert.equal(await g.withdrawalsFrozen(), true);
    record('S-03', {requiredTokens: eth('500000'), firstFreezeSeconds: p.uploadEndsAt - p.startsAt,
      cooldownFromStartSeconds: WEEK, noBallotsOrValidatorSignatureRequired: true,
      repeatFreezePossible: true, fundsNotStolen: true});
  }));

  test('REPRO S-04: short-lived personal liquidity captures almost all of a scheduled LP donation', async () => isolated(async c => {
    const {s, p, token, manager, alice, founder} = await production(c, eth('1'));
    await tx(p.connect(c.migrationSigner).migrate({gasLimit: 16000000}));
    const key = [ZeroAddress, token.target, 3000, 60, s.hook.target];
    const locker = new Contract(await p.liquidityLocker(), artifact('PermanentLiquidityLocker').abi, alice);
    const operating = new Contract(await token.operatingRewards(), artifact('OperatingRewardsLP').abi, founder);
    const driver = await c.deploy('V4TestRouter', [manager.target]);
    await tx(token.connect(alice).approve(driver.target, eth('100000000')));
    const officialLiquidity = await locker.positionLiquidity();
    // A narrow in-range position needs substantially less capital than full-range LP.
    const [, currentTick] = await driver.poolState(key);
    const lower = Math.floor(Number(currentTick) / 60) * 60 - 60;
    const upper = lower + 180;
    const liquidity = officialLiquidity * 100n, salt = id('one-block JIT position');
    await tx(driver.connect(alice).modify(key, [lower, upper, liquidity, salt], {value: eth('100'), gasLimit: 2500000}));
    const addedAt = await c.timestamp();
    const checkpoint = await c.rpc('evm_snapshot');
    const withoutDonation = await tx(driver.connect(alice).modify(key, [lower, upper, -liquidity, salt], {gasLimit: 2500000}));
    const principal = withoutDonation.logs.map(l => { try { return driver.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'Delta').args.ethDelta;
    assert.equal(await c.rpc('evm_revert', [checkpoint]), true);
    await tx(operating.deposit({value: eth('1'), gasLimit: 2500000}));
    const before = await c.balance(alice.address);
    const removal = await tx(driver.connect(alice).modify(key, [lower, upper, -liquidity, salt], {gasLimit: 2500000}));
    const delta = removal.logs.map(l => { try { return driver.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'Delta').args;
    // Removing principal + income, then separately collect the official fees.
    const officialBefore = await c.balance(locker.target);
    await tx(locker.collectFees({gasLimit: 1500000}));
    const donated = await s.lpDistributor.totalDonatedETH(token.target);
    assert.equal(donated, eth('0.2'));
    const expectedIncome = donated * 100n / 101n;
    const claimedIncome = delta.ethDelta - principal;
    assert.ok(claimedIncome >= expectedIncome - 2n && claimedIncome <= expectedIncome);
    const removalAt = (await c.provider.getBlock(removal.blockNumber)).timestamp;
    assert.ok(removalAt - addedAt < 10);
    assert.equal(await s.lpDistributor.totalQueuedETH(), 0n);
    assert.ok(await c.balance(alice.address) > before);
    record('S-04', {donationWei: donated, attackerLiquidity: liquidity, officialLiquidity,
      actualAttackerIncomeWei: claimedIncome, expectedIncomeShareBps: 9900,
      positionLifetimeSeconds: removalAt - addedAt, removalEthPrincipalPlusFeesWei: delta.ethDelta,
      officialLockerBalanceBefore: officialBefore, currentLiquidityDonationModel: true});
  }));

  test('DEFENSE: prelaunch token locks, failed refund recipients and double refunds are isolated', async () => isolated(async c => {
    const [owner, founder, alice, bob] = c.signers;
    const manager = await c.deploy('PoolManager', [owner.address]);
    const s = await deployUpgradeableSuite({signer: owner, manager: manager.target, platform: owner.address,
      proposer: owner.address, validators: [owner.address]});
    const p = await c.createProject(s.factory, {target: eth('1'), creator: founder});
    await tx(p.connect(alice).contribute(0, {value: eth('0.03')}));
    const token = new Contract(await p.token(), artifact('ProjectToken').abi, alice);
    const allocation = await token.balanceOf(alice.address);
    await tx(token.approve(bob.address, allocation));
    await assert.rejects(() => token.transfer.staticCall(bob.address, 1));
    await assert.rejects(() => token.connect(bob).transferFrom.staticCall(alice.address, bob.address, 1));
    await assert.rejects(() => token.burn.staticCall(1));
    await c.mineAt(Number(await p.deadline()));
    const receiver = await c.deploy('TestWallet');
    await tx(receiver.configure(true, false, p.target));
    await assert.rejects(() => p.connect(alice).refund.staticCall(receiver.target));
    assert.equal((await p.contributions(alice.address)).refunded, false);
    assert.equal(await token.balanceOf(alice.address), allocation);
    const before = await c.balance(bob.address);
    await tx(p.connect(alice).refund(bob.address));
    assert.equal(await c.balance(bob.address) - before, eth('0.03'));
    assert.equal(await token.balanceOf(alice.address), 0n);
    await assert.rejects(() => p.connect(alice).refund.staticCall(bob.address));
    assert.equal(await p.accountedPrincipal(), 0n);
    record('D-01', {prelaunchTransferAndBurnRejected: true, failedRecipientRolledBack: true,
      exactPrincipalReturned: true, subscriptionBurned: true, doubleRefundRejected: true});
  }));

  test('DEFENSE: removed migration estimate entry and forged callbacks do not alter custody', async () => isolated(async c => {
    const {s, p, token, manager, keeper} = await production(c);
    const saleSupply = await token.totalSupply();
    assert.equal(p.interface.getFunction('migrateWithGasEstimate'),null);
    const removed=new Interface(['function migrateWithGasEstimate(uint256)']);
    await assert.rejects(() => keeper.call({to:p.target,data:removed.encodeFunctionData('migrateWithGasEstimate',[(1n<<256n)-1n]),gasPrice:1000000000n}));
    await assert.rejects(() => s.router.unlockCallback.staticCall('0x'));
    await assert.rejects(() => s.hook.unlockCallback.staticCall('0x'));
    await assert.rejects(() => s.lpDistributor.unlockCallback.staticCall('0x'));
    assert.equal(await c.balance(p.target), eth('1'));
    assert.equal(await c.balance(manager.target), 0n);
    assert.equal(await token.totalSupply(), saleSupply);
    assert.equal(await s.coordinator.migrated(p.target), false);
    record('D-02', {inflatedGasUnitsRejected: true, forgedCallbacksRejected: true,
      escrowPrincipalUnchanged: true, migrationRolledBack: true});
  }));

  test('DEFENSE: a one-day project funded to 85% expires and returns all principal plus founder deposit', async () => isolated(async c => {
    const [owner, founder, alice, bob, carol] = c.signers;
    const manager = await c.deploy('PoolManager', [owner.address]);
    const s = await deployUpgradeableSuite({signer: owner, manager: manager.target,
      platform: owner.address, proposer: owner.address, validators: [owner.address]});
    const created = await tx(s.factory.connect(founder).createNamedProjectDays(eth('1'), 1,
      id('one-day 85 percent local refund verification'), 'local://one-day-refund',
      'Local one-day refund verification', 'REFUND85', {value: eth('0.02')}));
    const event = created.logs.map(l => {try {return s.factory.interface.parseLog(l);} catch {return null;}}).find(l => l?.name === 'ProjectCreated');
    const p = new Contract(event.args.project, artifact('ProjectEscrow').abi, founder);
    const token = new Contract(await p.token(), artifact('ProjectToken').abi, owner);
    const block = await c.provider.getBlock(created.blockNumber);
    assert.equal(await p.deadline(), BigInt(block.timestamp + DAY));
    const payments = [[alice, eth('0.4')], [bob, eth('0.25')], [carol, eth('0.2')]];
    for (const [who, amount] of payments) await tx(p.connect(who).contribute(0, {value: amount}));
    assert.equal(await p.raised(), eth('0.85'));
    assert.equal(await p.state(), 0n);
    await c.mineAt(Number(await p.deadline()) - 1);
    await assert.rejects(() => p.connect(alice).refund.staticCall(alice.address));
    await c.mineAt(Number(await p.deadline()));
    assert.equal(await p.state(), 2n);
    await assert.rejects(() => p.contribute.staticCall(0, {value: 1n}));
    await assert.rejects(() => p.migrate.staticCall());
    for (const [who, amount] of payments) {
      const before = await c.balance(who.address);
      const receipt = await tx(p.connect(who).refund(who.address));
      assert.equal(await c.balance(who.address) - before + receipt.gasUsed * receipt.gasPrice, amount);
      assert.equal(await token.balanceOf(who.address), 0n);
      assert.equal(await p.refundableAmount(who.address), 0n);
      await assert.rejects(() => p.connect(who).refund.staticCall(who.address));
    }
    assert.equal(await c.balance(p.target), 0n);
    assert.equal(await p.refundedTotal(), eth('0.85'));
    assert.equal(await p.accountedPrincipal(), 0n);
    const founderBefore = await c.balance(founder.address);
    const depositRefund = await tx(s.factory.connect(founder).claimCreationDeposit(p.target, founder.address));
    assert.equal(await c.balance(founder.address) - founderBefore + depositRefund.gasUsed * depositRefund.gasPrice, eth('0.02'));
    assert.equal(await s.factory.outstandingCreationDeposits(), 0n);
    record('D-03', {simulatedClockOnly: true, durationSeconds: DAY, targetWei: eth('1'),
      raisedWei: eth('0.85'), failureAtExactDeadline: true, principalRefundedWei: await p.refundedTotal(),
      creatorDepositRefundedWei: eth('0.02'), subscriptionTokensBurned: true, gasExcludedFromPrincipal: true});
  }));
});

describe("Refund and termination integration", {concurrency: false}, () => {
  function fixture(run) {
    return withLocalChain(async c => {
    const [owner,founder]=c.signers,validator=Wallet.createRandom();
    const manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,
     proposer:owner.address,validators:[validator.address],fundraisingPolicyVersion:2});
    const receipt=await tx(s.factory.connect(founder).createNamedProjectDays(
     eth('1'),15,id('project outcomes verification'),'ipfs://project-outcomes','Outcome test','OUTCOME',{value:eth('0.02')}));
    const event=receipt.logs.map(log=>{try{return s.factory.interface.parseLog(log)}catch{return null}}).find(log=>log?.name==='ProjectCreated');
    const p=new Contract(event.args.project,artifact('ProjectEscrow').abi,founder);
    const t=new Contract(await p.token(),artifact('ProjectToken').abi,owner);
    const wallets=await Promise.all(Array.from({length:20},(_,index)=>c.provider.getSigner(index)));
    await run({c,s,p,t,owner,founder,validator,wallets});

    });
  }

  test('85% funding expires at its deadline and all 17 subscribers recover exact accepted ETH while their locked tokens burn',async()=>fixture(async({c,s,p,t,founder,wallets})=>{
   const contributors=wallets.slice(2,19);
   // The first address offers 0.06 ETH across two transactions. Its 5% cap
   // accepts only 0.05 ETH; the other 0.01 ETH is returned immediately.
   const beforePurchase=await c.balance(contributors[0].address);
   const first=await tx(p.connect(contributors[0]).contribute(0,{value:eth('0.02')}));
   const second=await tx(p.connect(contributors[0]).contribute(0,{value:eth('0.04')}));
   assert.equal(beforePurchase-await c.balance(contributors[0].address)-first.fee-second.fee,eth('0.05'));
   for(const wallet of contributors.slice(1))await tx(p.connect(wallet).contribute(0,{value:eth('0.05')}));
   assert.equal(await p.raised(),eth('0.85'));
   assert.equal(await p.accountedPrincipal(),eth('0.85'));
   assert.equal(await c.balance(p.target),eth('0.85'));
   assert.equal(await s.factory.creationDeposits(p.target),eth('0.02'));
   await assert.rejects(()=>t.connect(contributors[0]).transfer.staticCall(founder.address,1n));
   const deadline=await p.deadline();
   await c.mineAt(deadline-1n);
   assert.equal(await p.state(),0n);
   assert.equal(await p.refundableAmount(contributors[0].address),0n);
   await assert.rejects(()=>p.connect(contributors[0]).refund.staticCall(contributors[0].address));
   await c.mineAt(deadline);
   assert.equal(await p.state(),2n);
   await assert.rejects(()=>p.connect(founder).contribute.staticCall(0,{value:1n}));
   await assert.rejects(()=>p.connect(founder).refund.staticCall(founder.address));
   for(const wallet of contributors){
    assert.equal(await p.refundableAmount(wallet.address),eth('0.05'));
    assert.ok(await t.balanceOf(wallet.address)>0n);
    const beforeRefund=await c.balance(wallet.address);
    const receipt=await tx(p.connect(wallet).refund(wallet.address));
    // Refund is paid in full. The caller pays its separate network gas fee.
    assert.equal(await c.balance(wallet.address)-beforeRefund+receipt.fee,eth('0.05'));
    assert.equal(await t.balanceOf(wallet.address),0n);
    assert.equal(await t.subscriptionBalance(wallet.address),0n);
    assert.equal(await p.refundableAmount(wallet.address),0n);
    assert.equal((await p.contributions(wallet.address)).refunded,true);
    await assert.rejects(()=>p.connect(wallet).refund.staticCall(wallet.address));
   }
   assert.equal(await p.refundedTotal(),eth('0.85'));
   assert.equal(await p.accountedPrincipal(),0n);
   assert.equal(await c.balance(p.target),0n);
   // Founder deposit is a separate entitlement and cannot consume refunds.
   const beforeDeposit=await c.balance(founder.address);
   const depositReceipt=await tx(s.factory.connect(founder).claimCreationDeposit(p.target,founder.address));
   assert.equal(await c.balance(founder.address)-beforeDeposit+depositReceipt.fee,eth('0.02'));
   assert.equal(await s.factory.creationDeposits(p.target),0n);
  }));

  test('early project termination leaves the real V4 pool tradable in both directions and all four swap modes',async()=>fixture(async({c,s,p,t,founder,validator,wallets})=>{
   for(const wallet of wallets)await tx(p.connect(wallet).contribute(0,{value:eth('0.05')}));
   await tx(p.connect(c.migrationSigner).migrate({gasLimit:16000000}));
   const alice=wallets[2],bob=wallets[3];
   for(const wallet of wallets){
    if(wallet.address===alice.address)continue;
    const balance=await t.balanceOf(wallet.address);
    if(balance>0n)await tx(t.connect(wallet).transfer(alice.address,balance));
   }
   const g=new Contract(await p.governance(),artifact('UpgradeableCommunityGovernance').abi,founder);
   const v=new Contract(await g.devVault(),artifact('ProjectVault').abi,founder);
   const l=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,founder);
   const rewards=new Contract(await t.feeRewards(),artifact('ProjectFeeRewards').abi,founder);
   await c.mineAt(await g.anchor());
   await tx(g.proposeTermination(id('community stops project'),'ipfs://termination'));
   const proposal=await g.proposals(1),support=1;
   const ballot=await alice.signTypedData({name:'OriginCommunityGovernance',version:'1',chainId:31337,verifyingContract:g.target},
    {Ballot:[{name:'proposalId',type:'uint256'},{name:'snapshotHash',type:'bytes32'},{name:'voter',type:'address'},{name:'support',type:'uint8'}]},
    {proposalId:1,snapshotHash:proposal.snapshotHash,voter:alice.address,support});
   const result={proposalId:1,forVotes:proposal.totalPower,againstVotes:0n,abstainVotes:0n,
    archiveHash:id('verified termination archive'),cid:'bafy-project-outcomes',uploader:alice.address,deadline:proposal.uploadEndsAt};
   const attestation=validator.signingKey.sign(await g.resultDigest(result)).serialized;
   await tx(g.connect(alice).finalizeResult(result,support,ballot,[validator.address],[attestation]));
   assert.ok(await c.timestamp()<Number(proposal.endsAt));
   assert.equal(await g.terminated(),true);
   assert.equal(await p.state(),3n);
   assert.equal(await t.launched(),true);
   assert.equal(await v.availableFunds(),0n);
   assert.equal(await rewards.accountedFunds(),eth('0.5'));
   assert.equal(await p.refundableAmount(alice.address),0n);
   await assert.rejects(()=>p.connect(alice).refund.staticCall(alice.address));
   await assert.rejects(()=>g.claimInitialWithdrawal.staticCall());
   const bobBefore=await t.balanceOf(bob.address);
   await tx(t.connect(alice).transfer(bob.address,eth('10')));
   assert.equal(await t.balanceOf(bob.address)-bobBefore,eth('10'));
   const liquidity=await l.positionLiquidity();
   await tx(t.connect(alice).approve(s.router.target,eth('1000000')));
   const key=[ZeroAddress,t.target,3000,60,s.hook.target];
   const quoter=await c.deploy('LocalProjectQuoter',[await s.coordinator.poolManager()]);
   await assert.rejects(()=>quoter.unlockCallback.staticCall('0x'));
   for(const [buy,amount,maxInput] of [
    [true,-eth('0.005'),eth('0.005')],
    [false,-eth('1000'),eth('1000')],
    [true,eth('1000'),eth('0.005')],
    [false,eth('0.000001'),eth('1000000')],
   ]){
    const ethBefore=await c.balance(alice.address),tokenBefore=await t.balanceOf(alice.address);
    let quoted;
    if(amount<0n){
     const rewardsBefore=await rewards.accountedFunds(),platformBefore=await s.hook.platformAccrued();
     quoted=await quoter.quoteExactInputSingle.staticCall([key,buy,-amount,'0x']);
     assert.ok(quoted.amountOut>0n&&quoted.gasEstimate>0n);
     const quoteReceipt=await tx(quoter.quoteExactInputSingle([key,buy,-amount,'0x']));
     assert.equal(quoteReceipt.logs.length,0);
     assert.equal(await rewards.accountedFunds(),rewardsBefore);
     assert.equal(await s.hook.platformAccrued(),platformBefore);
     assert.equal(await t.balanceOf(alice.address),tokenBefore);
    }
    const receipt=await tx(s.router.connect(alice).swap(key,
     [buy,amount,buy?4295128740n:1461446703485210103287273052203988822378723970341n],
     maxInput,amount>0n?amount:1n,alice.address,(await c.timestamp())+1000,{value:buy?maxInput:0n}));
    assert.equal(receipt.status,1);
    const trade=receipt.logs.map(log=>{try{return s.router.interface.parseLog(log)}catch{return null}}).find(log=>log?.name==='Swapped').args;
    assert.equal(trade.buy,buy);
    assert.ok(trade.input>0n&&trade.input<=maxInput&&trade.output>0n);
    if(quoted)assert.equal(trade.output,quoted.amountOut);
    if(amount>0n)assert.ok(trade.output>=amount);else assert.equal(trade.input,-amount);
    if(buy){
     assert.equal(ethBefore-await c.balance(alice.address)-receipt.fee,trade.input);
     assert.equal(await t.balanceOf(alice.address)-tokenBefore,trade.output);
    }else{
     assert.equal(tokenBefore-await t.balanceOf(alice.address),trade.input);
     assert.equal(await c.balance(alice.address)-ethBefore+receipt.fee,trade.output);
    }
    const fee=receipt.logs.map(log=>{try{return s.hook.interface.parseLog(log)}catch{return null}}).find(log=>log?.name==='FeesAccrued').args;
    assert.equal(fee.devPart,0n);
    assert.equal(await v.availableFunds(),0n);
    assert.equal(await g.terminated(),true);
    assert.equal(await p.state(),3n);
   }
   assert.equal(await l.positionLiquidity(),liquidity);
   assert.ok(await rewards.accountedFunds()>eth('0.5'));
  }));
});

describe("Production ABI authority matrix", {concurrency: false}, () => {
  const restricted={
   CommunityV4ProjectFactory:['claimCreationDeposit','claimCreationFees','claimMigrationFees','depositMigrationFee'],
   CommunityV4MigrationCoordinator:['configure','configureLPServices','configureServices','configureUpgradeServices','migrate','setMigrationFeeBps','setMigrationGasRefundLimit','setMigrationReimbursementGasUnits'],
   V4FeeHookLP:['afterSwap','beforeSwap','claimPlatform','configureFeePolicy','register','unlockCallback','receive'],
   ProjectSwapRouter:['unlockCallback'],LPRewardDistributor:['configureHook','fund','register','unlockCallback'],
   SwapFeePolicyLP:['initialize','upgradeToAndCall'],
   OriginTimelock:['cancel','grantRole','revokeRole','schedule','scheduleBatch','updateDelay'],
   ProjectEscrow:['configureTokenMetadata','claimCreatorTokens','claimMigrationGasRefund','migrate'],
   ProjectToken:['burnSubscription','claim','configureFeeRewards','configureMetadata','configureOperatingRewards',
    'configureRecoveryAuthority','creditEntitlement','issueSubscription','launch','registerLocker','registerProtocolAddresses','setRewardRecovery'],
   UpgradeableCommunityGovernance:['acceptDeveloperTransfer','cancelDeveloperTransfer','cancelWithdrawal','claimInitialWithdrawal',
    'claimWeeklyWithdrawal','initialize','pauseNewProposals','proposeDeveloperTransfer','proposeTopic','setDevRecipient',
    'setResultVerifier','supplementWithdrawal','upgradeToAndCall'],
   UpgradeableProjectRewards:['abortRoundForRecovery','capture','deposit','depositFees','initialize','upgradeToAndCall','receive'],
   OperatingRewardsLP:['abortRoundForRecovery','capture','deposit','depositFees','initialize','upgradeToAndCall','receive'],
   ProjectVault:['release','seal','settleTo'],ProjectSettlement:['activate','publish'],
   PermanentLiquidityLocker:['finalizeMigration','fundProtection','initialize','unlockCallback','receive'],
  };

  test('current production suite: directly exercise every ABI entry and prove unprivileged writes cannot change custody/authority',
   {timeout:240000},async()=>{
   const c=await createLocalChain(),evidence=[];
   try{
    const wallets=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i)));
    const [owner,founder,alice]=wallets,manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,
      proposer:owner.address,validators:[owner.address],fundraisingPolicyVersion:2});
    const p=await c.createProject(s.factory,{target:eth('1'),creator:founder});
    for(const w of wallets)await tx(p.connect(w).contribute(0,{value:eth('0.05')}));
    await tx(p.connect(c.migrationSigner).migrate({gasLimit:16000000,gasPrice:1000000000n}));
    const bind=(name,address)=>new Contract(address,artifact(name).abi,alice);
    const token=bind('ProjectToken',await p.token()),g=bind('UpgradeableCommunityGovernance',await p.governance());
    const vault=bind('ProjectVault',await g.devVault()),locker=bind('PermanentLiquidityLocker',await p.liquidityLocker());
    const instances={CommunityV4ProjectFactory:s.factory,CommunityV4MigrationCoordinator:s.coordinator,
     ProjectTokenDeployer:s.tokenDeployer,ProjectProxyDeployer:s.governanceDeployer,AllocationVerifier:s.verifier,
     LPHookDeployer:s.hookDeployer,V4FeeHookLP:s.hook,ProjectSwapRouter:s.router,LPRewardDistributor:s.lpDistributor,
     SwapFeePolicyLP:s.feePolicy,OriginTimelock:s.timelock,ProjectEscrow:p,ProjectToken:token,
     UpgradeableCommunityGovernance:g,UpgradeableProjectRewards:bind('UpgradeableProjectRewards',await token.feeRewards()),
     OperatingRewardsLP:bind('OperatingRewardsLP',await token.operatingRewards()),ProjectVault:vault,
     ProjectSettlement:bind('ProjectSettlement',await g.settlement()),
     PermanentLiquidityDeployer:bind('PermanentLiquidityDeployer',await s.coordinator.liquidityDeployer()),
     PermanentLiquidityLocker:locker,
     GovernanceCustodyFactory:bind('GovernanceCustodyFactory',getCreateAddress({from:s.governanceImplementation.target,nonce:1})),
     OriginProxy:bind('OriginProxy',s.feePolicy.target)};
    function sample(param){
     if(param.baseType==='array')return param.arrayLength<0?[]:Array.from({length:param.arrayLength},()=>sample(param.arrayChildren));
     if(param.baseType==='tuple'){
      if(param.components[0]?.name==='currency0')return [ZeroAddress,token.target,3000,60,s.hook.target];
      return param.components.map(sample);
     }
     if(param.type==='address')return /token/i.test(param.name)?token.target:alice.address;
     if(param.type==='bool')return false;
     if(param.type==='string')return 'local://entrypoint-audit';
     if(param.type==='bytes')return '0x';
     if(param.type.startsWith('bytes'))return '0x'+'12'.repeat(Number(param.type.slice(5)));
     if(/^(u?int)/.test(param.type))return 1n;
     throw Error('Unhandled ABI input '+param.type);
    }
    for(const [name,instance] of Object.entries(instances)){
     const contract=instance.connect(alice),a=artifact(name),i=new Interface(a.abi);
     for(const f of i.fragments.filter(f=>f.type==='function')){
      const signature=f.format('sighash'),args=f.inputs.map(sample),read=['view','pure'].includes(f.stateMutability);
      if(read){
       try{await contract.getFunction(signature).staticCall(...args);evidence.push({contract:name,signature,kind:'read',outcome:'returned'});}
       catch(error){
        assert.ok(error.code==='CALL_EXCEPTION',`${name}.${signature}: unexpected read infrastructure failure`);
        evidence.push({contract:name,signature,kind:'read',outcome:'reverted-for-sample-input',reason:error.revert?.name??null});
       }
       continue;
      }
      const snapshot=await c.rpc('evm_snapshot'),before={founder:await g.developer(),recipient:await g.devRecipient(),
        vault:await vault.availableFunds(),liquidity:await locker.positionLiquidity(),escrow:await c.balance(p.target)};
      try{
       const payload=contract.interface.encodeFunctionData(signature,args);
       let receipt,error;
       try{receipt=await tx(alice.sendTransaction({to:contract.target,data:payload,gasLimit:16000000}));}
       catch(e){error=e;}
       if(restricted[name]?.includes(f.name))assert.ok(error,`${name}.${signature}: unprivileged state change unexpectedly succeeded`);
       if(error)assert.ok(error.code==='CALL_EXCEPTION'||error.code==='UNKNOWN_ERROR',`${name}.${signature}: unexpected send failure`);
       assert.equal(await g.developer(),before.founder,`${signature} changed Founder`);
       assert.equal(await g.devRecipient(),before.recipient,`${signature} changed treasury recipient`);
       assert.equal(await vault.availableFunds(),before.vault,`${signature} moved Founder principal`);
       assert.equal(await locker.positionLiquidity(),before.liquidity,`${signature} removed locked liquidity`);
       assert.equal(await c.balance(p.target),before.escrow,`${signature} moved escrow funds`);
       if(name==='CommunityV4MigrationCoordinator'&&f.name==='createToken'){
        assert.ok(receipt,'Public createToken must still work for the caller');
        assert.equal(await s.factory.projectCount(),1n,'An orphan token must not register an official project');
        assert.equal(await s.factory.isProject(alice.address),false);
       }
       evidence.push({contract:name,signature,kind:'write',outcome:error?'reverted':'committed',
        restricted:Boolean(restricted[name]?.includes(f.name)),gasUsed:receipt?String(receipt.gasUsed):undefined});
      }finally{assert.equal(await c.rpc('evm_revert',[snapshot]),true);}
     }
     for(const f of a.abi.filter(f=>f.type==='receive'||f.type==='fallback')){
      const snapshot=await c.rpc('evm_snapshot');
      try{
       let error;
       try{await tx(alice.sendTransaction({to:contract.target,value:1n,data:f.type==='fallback'?'0x12345678':'0x',gasLimit:1000000}));}catch(e){error=e;}
       if(restricted[name]?.includes(f.type))assert.ok(error,`${name}.${f.type}: unprivileged ETH accepted`);
       evidence.push({contract:name,signature:f.type+'()',kind:'write',outcome:error?'reverted':'committed',restricted:Boolean(restricted[name]?.includes(f.type))});
      }finally{assert.equal(await c.rpc('evm_revert',[snapshot]),true);}
     }
    }
    const writes=evidence.filter(e=>e.kind==='write');
    assert.equal(writes.length,139);
    fs.mkdirSync(new URL('../.run/',import.meta.url),{recursive:true});
    fs.writeFileSync(new URL('../.run/latest-entrypoint-matrix.json',import.meta.url),JSON.stringify({generatedAt:new Date().toISOString(),
     scope:'Latest complete suite deployed to independent local EVM; sample reads and unprivileged writes. This matrix complements business success-path tests.',
     contractTypes:Object.keys(instances).length,totalEntries:evidence.length,writeEntries:writes.length,
     restrictedWrites:writes.filter(e=>e.restricted).length,results:evidence},null,2)+'\n');
   }finally{await c.close();}
  });
});
