import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {Contract, parseEther as eth, ZeroAddress, id, parseEther, MaxUint256} from 'ethers';
import {createLocalChain, artifact} from '../scripts/local-chain.mjs';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';
import {settleLaunchProtection} from '../scripts/launch-protection.mjs';
import {tx, withLocalChain} from './helpers.mjs';
import {deployV4Fixture, fundAndLaunch} from '../scripts/local-v4.mjs';
import fs from 'node:fs';

describe("Opening taxes and permanent liquidity", {concurrency: false}, () => {
  const BUY_LIMIT = 4295128740n;
  const SELL_LIMIT = 1461446703485210103287273052203988822378723970341n;
  const parsed = (receipt, contract, name) => receipt.logs.map(l => {
    try { return contract.interface.parseLog(l); } catch { return null; }
  }).filter(e => e?.name === name);
  function fixture(run) {
    return withLocalChain(async c => {
      const [owner, founder, alice, bob, carol, keeper] = c.signers;
      const manager = await c.deploy('PoolManager', [owner.address]);
      const s = await deployUpgradeableSuite({signer: owner, manager: manager.target, platform: owner.address,
        proposer: owner.address, validators: [owner.address]});
      const project = await c.createProject(s.factory, {target: eth('1'), creator: founder});
      for (const [who, amount] of [[alice, '0.5'], [bob, '0.25'], [carol, '0.25']])
        await tx(project.connect(who).contribute(0, {value: eth(amount), gasLimit: 600000}));
      await tx(project.connect(c.migrationSigner).migrate({gasLimit: 16000000}));
      const token = new Contract(await project.token(), artifact('ProjectToken').abi, owner);
      const locker = new Contract(await project.liquidityLocker(), artifact('PermanentLiquidityLocker').abi, owner);
      const driver = await c.deploy('V4TestRouter', [manager.target]);
      await tx(token.connect(alice).approve(driver.target, eth('100000000')));
      await tx(token.connect(alice).approve(s.router.target, eth('100000000')));
      const poolId = await project.poolId(), start = Number(await project.launchTime());
      const key = [ZeroAddress, token.target, 3000, 60, s.hook.target];
      await run({c, s, project, token, locker, driver, manager, key, poolId, start, owner, founder, alice, bob, carol, keeper});

    });
  }
  async function direct(f, buy, amount, value = 0n, priceLimit = buy ? BUY_LIMIT : SELL_LIMIT) {
    const receipt = await tx(f.driver.connect(f.alice).swap(f.key, [buy, amount, priceLimit], {value, gasLimit: 2500000}));
    return {receipt, delta: parsed(receipt, f.driver, 'Delta')[0].args,
      base: parsed(receipt, f.s.hook, 'FeesAccrued')[0].args,
      extra: parsed(receipt, f.s.hook, 'LaunchProtectionTaxAccrued')[0]?.args};
  }

  test('launch sell tax decays by project time to zero at exactly ten minutes; buys stay at 1%', async () => fixture(async f => {
    assert.equal(await f.s.factory.CONTRACT_VERSION(), 13n);
    assert.equal(await f.s.hook.protectionStartedAt(f.poolId), BigInt(f.start));
    for (const elapsed of [30, 60, 120, 300, 480, 599, 600, 601]) {
      await f.c.mineAt(f.start + elapsed);
      assert.equal(await f.s.hook.extraSellTaxBps(f.poolId), elapsed >= 600 ? 0n : 2500n * BigInt(600 - elapsed) / 600n);
    }
    assert.equal(await f.s.hook.FEE_BPS(), 100n);
    const result = await direct(f, true, -eth('0.01'), eth('0.01'));
    assert.equal(result.base.ethFee, eth('0.0001')); assert.equal(result.extra, undefined);
    assert.equal(await f.s.hook.totalProtectionAccrued(f.poolId), 0n);
    await assert.rejects(() => f.s.hook.register(f.key, f.locker.target, f.project.target, 1));
    assert.equal(await f.s.hook.protectionStartedAt(f.poolId), BigInt(f.start));
  }));

  test('all four swap modes separate ordinary fees and decaying tax, including net exact ETH output', async () => fixture(async f => {
    let extraTotal = 0n;
    for (const [buy, amount, value] of [[true, -eth('0.01'), eth('0.01')], [true, eth('1000'), eth('0.01')],
      [false, -eth('100000'), 0n], [false, eth('0.001'), 0n], [false, 100n, 0n]]) {
      const r = await direct(f, buy, amount, value);
      if (buy) {
        assert.equal(r.extra, undefined);
        const expected = amount < 0n ? -amount / 100n : (-r.delta.ethDelta - r.base.ethFee + 98n) / 99n;
        assert.equal(r.base.ethFee, expected);
      } else {
        const block = await f.c.provider.getBlock(r.receipt.blockNumber);
        const rate = 2500n * BigInt(600 - (block.timestamp - f.start)) / 600n;
        assert.equal(r.extra.rateBps, rate);
        const gross = r.delta.ethDelta + r.base.ethFee + r.extra.ethAmount;
        if (amount < 0n) {
          assert.equal(r.base.ethFee, gross / 100n);
          assert.equal(r.extra.ethAmount, gross * rate / 10000n);
        } else {
          assert.equal(r.delta.ethDelta, amount);
          const totalFee = (amount * (100n + rate) + (10000n - 100n - rate) - 1n) / (10000n - 100n - rate);
          assert.equal(r.base.ethFee + r.extra.ethAmount, totalFee);
          assert.equal(r.base.ethFee, gross / 100n);
        }
        extraTotal += r.extra.ethAmount;
      }
      assert.equal(r.base.devPart, r.base.ethFee * 20n / 100n);
      assert.equal(r.base.rewardsPart, r.base.ethFee * 40n / 100n);
    }
    assert.equal(await f.s.hook.protectionAccrued(f.poolId), extraTotal);
    assert.equal(await f.s.hook.totalProtectionAccrued(f.poolId), extraTotal);
  }));

  test('protection proceeds buy tokens and increase the official permanently locked position', async () => fixture(async f => {
    const before = await f.locker.positionLiquidity(), supply = await f.token.totalSupply();
    const sellerBefore = await f.token.balanceOf(f.alice.address);
    const r = await direct(f, false, -eth('1000000'));
    const extra = r.extra.ethAmount;
    assert.ok(extra > 0n);
    const receipt = await tx(f.s.hook.distribute(f.poolId, {gasLimit: 2500000}));
    const additions = parsed(receipt, f.locker, 'ProtectionLiquidityAdded');
    assert.equal(additions.length, 1);
    assert.ok(await f.locker.positionLiquidity() > before);
    assert.equal(await f.locker.totalProtectionFunded(), extra);
    assert.equal(await f.locker.totalProtectionETHUsed() + await f.locker.queuedProtectionETH(), extra);
    assert.equal(await f.s.hook.protectionAccrued(f.poolId), 0n);
    assert.ok(await f.locker.totalProtectionTokensBought() > 0n);
    assert.ok(await f.token.totalSupply() <= supply);
    assert.equal(await f.token.balanceOf(f.alice.address), sellerBefore - eth('1000000'));
    assert.equal(await f.token.excluded(f.locker.target), true);
    assert.equal(await f.token.getPastPower(f.locker.target, r.receipt.blockNumber), 0n);
    assert.equal(await f.token.balanceOf(f.locker.target), await f.locker.queuedProtectionTokens());
    assert.equal(await f.c.balance(f.locker.target), await f.locker.queuedProtectionETH());
    console.log(JSON.stringify({taxETHWei: String(extra), liquidityBefore: String(before),
      liquidityAfter: String(await f.locker.positionLiquidity()), taxETHUsedWei: String(await f.locker.totalProtectionETHUsed())}));
  }));

  test('automatic router settlement preserves net output and compounds protection without a keeper payout', async () => fixture(async f => {
    const before = await f.locker.positionLiquidity();
    const receipt = await tx(f.s.router.connect(f.alice).swap(f.key, [false, -eth('100000'), SELL_LIMIT],
      eth('100000'), 1, f.alice.address, (await f.c.timestamp()) + 100, {gasLimit: 2500000}));
    const swap = parsed(receipt, f.s.router, 'Swapped')[0].args;
    assert.equal(swap.input, eth('100000')); assert.ok(swap.output > 0n);
    assert.equal(parsed(receipt, f.s.router, 'FeeCollectionDeferred').length, 0);
    assert.equal(parsed(receipt, f.locker, 'ProtectionLiquidityAdded').length, 1);
    assert.ok(await f.locker.positionLiquidity() > before);
    assert.ok(await f.locker.totalProtectionFunded() > 0n);
  }));

  test('deferred tax funds are isolated and permissionlessly retried; invalid limits cannot spend them', async () => fixture(async f => {
    await direct(f, false, -eth('1000000'));
    const receipt = await tx(f.s.hook.forwardProtection(f.poolId));
    assert.equal(parsed(receipt, f.s.hook, 'ProtectionTaxForwarded').length, 1);
    const queued = await f.locker.queuedProtectionETH(), tokens = await f.locker.queuedProtectionTokens();
    assert.ok(queued > 0n); assert.equal(await f.s.hook.protectionAccrued(f.poolId), 0n);
    await assert.rejects(() => f.s.hook.forwardProtection.staticCall(f.poolId));
    const state = await f.driver.poolState(f.key), now = await f.c.timestamp();
    await assert.rejects(() => f.locker.compoundProtection.staticCall(state[0], now + 100));
    // A valid but extremely tight bound fails during the real swap, atomically.
    await assert.rejects(() => f.locker.compoundProtection.staticCall(state[0] - 1n, now + 100));
    await assert.rejects(() => f.locker.compoundProtection.staticCall(state[0] * 97n / 100n, now + 100));
    await assert.rejects(() => f.locker.compoundProtection.staticCall(0, now - 1));
    await assert.rejects(() => f.locker.fundProtection({value: 1}));
    await assert.rejects(() => f.locker.compoundProtection(0, now + 100, {gasLimit: 150000}));
    assert.equal(await f.locker.queuedProtectionETH(), queued);
    assert.equal(await f.locker.queuedProtectionTokens(), tokens);
    await f.c.deploy('ForceEther', [f.locker.target], f.owner, {value: eth('0.03')});
    const keeperTokens = await f.token.balanceOf(f.keeper.address), before = await f.locker.positionLiquidity();
    await tx(f.locker.connect(f.keeper).compoundProtection(0, now + 100, {gasLimit: 1600000}));
    assert.ok(await f.locker.positionLiquidity() > before);
    assert.equal(await f.token.balanceOf(f.keeper.address), keeperTokens);
    assert.equal(await f.locker.totalProtectionETHUsed() + await f.locker.queuedProtectionETH(), queued);
    assert.equal(await f.c.balance(f.locker.target), await f.locker.queuedProtectionETH() + eth('0.03'));
    await assert.rejects(() => f.locker.unlockCallback('0x'));
    assert.equal(f.locker.interface.getFunction('withdraw'), null);
  }));

  test('large taxes compound in bounded positive batches and fee collection cannot remove principal', async () => fixture(async f => {
    await direct(f, false, -eth('10000000'));
    await tx(f.s.hook.forwardProtection(f.poolId));
    const funded = await f.locker.totalProtectionFunded(), before = await f.locker.positionLiquidity();
    let count = 0;
    while (await f.locker.queuedProtectionETH() >= 10000n && count < 20) {
      const old = await f.locker.positionLiquidity();
      const receipt = await tx(f.locker.connect(f.keeper).compoundProtection(0, (await f.c.timestamp()) + 100, {gasLimit: 1600000}));
      assert.ok(await f.locker.positionLiquidity() > old);
      assert.equal(parsed(receipt, f.locker, 'ProtectionLiquidityAdded').length, 1);
      count++;
    }
    assert.ok(count > 1 && count < 20);
    assert.ok(await f.locker.positionLiquidity() > before);
    assert.equal(await f.locker.totalProtectionETHUsed() + await f.locker.queuedProtectionETH(), funded);
    const locked = await f.locker.positionLiquidity();
    await tx(f.locker.collectFees()); assert.equal(await f.locker.positionLiquidity(), locked);
    assert.equal(await f.token.balanceOf(f.locker.target), await f.locker.queuedProtectionTokens());
  }));

  test('after ten minutes new sells stop accruing protection tax and retain the normal 1% fee', async () => fixture(async f => {
    await direct(f, false, -eth('100000'));
    const total = await f.s.hook.totalProtectionAccrued(f.poolId);
    await f.c.mineAt(f.start + 600);
    const r = await direct(f, false, -eth('100000'));
    assert.equal(r.extra, undefined);
    assert.equal(r.base.ethFee, (r.delta.ethDelta + r.base.ethFee) / 100n);
    assert.equal(await f.s.hook.totalProtectionAccrued(f.poolId), total);
    assert.equal(await f.s.hook.extraSellTaxBps(f.poolId), 0n);
  }));

  test('the keeper helper forwards only taxes and respects its replenishment batch limit', async () => fixture(async f => {
    await direct(f, false, -eth('10000000'));
    const accrued = await f.s.hook.protectionAccrued(f.poolId), before = await f.locker.positionLiquidity();
    const result = await settleLaunchProtection(f.project.connect(f.keeper), {maxBatches: 1});
    assert.equal(result.receipts.length, 2);
    assert.ok(result.queuedETH >= 10000n);
    assert.ok(await f.locker.positionLiquidity() > before);
    assert.equal(await f.locker.totalProtectionFunded(), accrued);
    assert.equal(await f.locker.totalProtectionETHUsed() + result.queuedETH, accrued);
    await assert.rejects(() => settleLaunchProtection(f.project, {maxBatches: 21}));
  }));

  test('token-specified partial sells pay actual-output tax; partial exact ETH sells roll back all accrual', async () => fixture(async f => {
    let state = await f.driver.poolState(f.key);
    const r = await direct(f, false, -eth('1000000'), 0n, state[0] * 1001n / 1000n);
    assert.ok(-r.delta.tokenDelta < eth('1000000'));
    const gross = r.delta.ethDelta + r.base.ethFee + r.extra.ethAmount;
    assert.equal(r.extra.ethAmount, gross * r.extra.rateBps / 10000n);
    const accrued = await f.s.hook.protectionAccrued(f.poolId), claims = await f.manager.balanceOf(f.s.hook.target, 0);
    state = await f.driver.poolState(f.key);
    await assert.rejects(() => f.driver.connect(f.alice).swap.staticCall(f.key,
      [false, eth('0.05'), state[0] * 1001n / 1000n]));
    assert.equal(await f.s.hook.protectionAccrued(f.poolId), accrued);
    assert.equal(await f.manager.balanceOf(f.s.hook.target, 0), claims);
    assert.equal((await f.driver.poolState(f.key))[0], state[0]);
  }));

  test('launch windows and protection ledgers remain isolated between projects in one suite', async () => fixture(async f => {
    await direct(f, false, -eth('100000'));
    const oldTax = await f.s.hook.protectionAccrued(f.poolId);
    await f.c.mineAt(f.start + 300);
    const other = await f.c.createProject(f.s.factory, {target: eth('1'), creator: f.bob});
    await tx(other.connect(f.carol).contribute(0, {value: eth('1'), gasLimit: 600000}));
    await tx(other.connect(f.c.migrationSigner).migrate({gasLimit: 16000000}));
    const otherId = await other.poolId();
    assert.equal(await f.s.hook.extraSellTaxBps(otherId), 2500n);
    assert.ok(await f.s.hook.extraSellTaxBps(f.poolId) < 1250n);
    assert.equal(await f.s.hook.protectionStartedAt(f.poolId), BigInt(f.start));
    assert.equal(await f.s.hook.protectionStartedAt(otherId), await other.launchTime());
    assert.equal(await f.s.hook.protectionAccrued(otherId), 0n);
    assert.equal(await f.s.hook.protectionAccrued(f.poolId), oldTax);
  }));
});

describe("Token checkpoints, metadata and router bounds", {concurrency: false}, () => {
  test('wallet checkpoints exclude unclaimed balances, protocol addresses and burns', async()=>{
   const chain=await createLocalChain();
   try {
    const f=await deployV4Fixture(chain); await fundAndLaunch(chain,f);
    const holder=chain.signers[2], other=chain.signers[3];
    const sale=await f.project.SALE_SUPPLY();
    assert.equal(await f.token.publicPower(),sale);
    const initial=await f.token.balanceOf(holder.address);
    const snapshot=Number(await chain.rpc('eth_blockNumber'));
    await(await f.token.connect(holder).transfer('0x000000000000000000000000000000000000dEaD',100n)).wait();
    await(await f.token.connect(holder).burn(100n)).wait();
    await(await f.token.connect(holder).transfer(await f.gov.devVault(),100n)).wait();
    assert.equal(await f.token.publicPower(),sale-300n);
    assert.equal(await f.token.getPastPower(holder.address,snapshot),initial);
    assert.equal(await f.token.getPastTotalPower(snapshot),sale);
    assert.equal(await f.token.getPastPower(other.address,snapshot),(await f.project.contributions(other.address)).tokenUnits);
    await assert.rejects(()=>f.token.connect(holder).configureMetadata('Changed','BAD'));
   } finally {await chain.close();}
  });

  test('named tokens are fixed at creation and developer transfer is delayed without resetting cycles', async()=>{
   const chain=await createLocalChain();
   try {
    const f=await deployV4Fixture(chain,{withProject:false,configure:false});
    const [,dev,next]=chain.signers;
    const verifier=await chain.deploy('AllocationVerifier',[[dev.address],1]);
    const dividends=await chain.deploy('ProjectDividends',[f.factory.target,verifier.target]);
    const router=await chain.deploy('ProjectSwapRouter',[f.manager.target,f.hook.target]);
    await(await f.coordinator.configureServices(dividends.target,verifier.target,router.target)).wait();
    await(await f.coordinator.configure(f.factory.target,f.hook.target)).wait();
    await(await f.factory.connect(dev).createNamedProjectDays(parseEther('1'),3,id('metadata'),'ipfs://metadata','Example Project','EXAMPLE',{value:parseEther('0.02')})).wait();
    const project=new Contract(await f.factory.projects(0),artifact('ProjectEscrow').abi,dev);
    const token=new Contract(await project.token(),artifact('ProjectToken').abi,dev);
    assert.equal(await token.name(),'Example Project'); assert.equal(await token.symbol(),'EXAMPLE');
    await assert.rejects(()=>project.configureTokenMetadata('Changed','BAD'));
    await(await project.connect(next).contribute(0,{value:parseEther('1'),gasLimit:600000})).wait();
    await(await project.connect(chain.migrationSigner).migrate({gasLimit:12000000})).wait();
    const gov=new Contract(await project.governance(),artifact('ProjectGovernance').abi,dev);
    for(const address of [f.factory.target,f.hook.target,dividends.target,verifier.target,router.target,await gov.settlement()])assert.equal(await token.excluded(address),true);
    await assert.rejects(()=>f.coordinator.configureServices(dividends.target,verifier.target,router.target));
    await(await gov.proposeDeveloperTransfer(next.address)).wait();
    await assert.rejects(()=>gov.connect(next).acceptDeveloperTransfer.staticCall());
    await chain.mineAt(Number(await gov.developerTransferReadyAt()));
    await(await gov.connect(next).acceptDeveloperTransfer()).wait();
    assert.equal(await gov.developer(),next.address); assert.equal(await gov.devRecipient(),next.address);
    assert.equal(await gov.withdrawalCount(),0n); assert.equal(await gov.lastSuccessfulWithdrawal(),0n);
    await assert.rejects(()=>gov.setDevRecipient(dev.address));
   } finally {await chain.close();}
  });

  test('bounded router rejects stale orders, insufficient output and unauthorized callbacks; trades refund excess', async()=>{
   const chain=await createLocalChain();
   try {
    const f=await deployV4Fixture(chain); await fundAndLaunch(chain,f);
    const buyer=chain.signers[2], recipient=chain.signers[3];
    const router=await chain.deploy('ProjectSwapRouter',[f.manager.target,f.hook.target]);
    const now=await chain.timestamp(), offered=parseEther('1'), params=[true,-offered,4295128740n];
    await assert.rejects(()=>router.connect(buyer).swap.staticCall(f.key,params,offered,1,recipient.address,now-1,{value:offered}));
    await assert.rejects(()=>router.connect(buyer).swap.staticCall(f.key,params,offered,parseEther('67000000'),recipient.address,now+3600,{value:offered}));
    await assert.rejects(()=>router.unlockCallback('0x'));
    await(await router.connect(buyer).swap(f.key,params,offered,1,recipient.address,now+3600,{value:offered})).wait();
    assert.ok(await f.token.balanceOf(recipient.address)>0n);
    await(await f.token.connect(recipient).approve(router.target,MaxUint256)).wait();
    await(await router.connect(recipient).swap(f.key,[false,-parseEther("1000"),1461446703485210103287273052203988822378723970341n],parseEther("1000"),1,recipient.address,now+3600)).wait();
    assert.equal(await chain.balance(router.target),0n);
    assert.equal(await f.token.balanceOf(router.target),0n);
    // Exact output buys return unused ETH; exact output sells respect the net ETH minimum.
    const out=parseEther('100'),buy=[true,out,4295128740n];
    const quote=await router.connect(buyer).swap.staticCall(f.key,buy,offered,out,recipient.address,now+3600,{value:offered});
    const before=await chain.balance(buyer.address);
    const receipt=await(await router.connect(buyer).swap(f.key,buy,offered,out,recipient.address,now+3600,{value:offered})).wait();
    assert.equal(before-await chain.balance(buyer.address),quote[0]+receipt.gasUsed*receipt.gasPrice);
    const ethOut=parseEther('0.00001');
    await(await router.connect(recipient).swap(f.key,[false,ethOut,1461446703485210103287273052203988822378723970341n],parseEther('1000'),ethOut,recipient.address,now+3600)).wait();
    await assert.rejects(()=>router.connect(recipient).swap.staticCall(f.key,[false,ethOut,1461446703485210103287273052203988822378723970341n],1n,ethOut,recipient.address,now+3600));
    assert.equal(await chain.balance(router.target),0n);
    await assert.rejects(()=>router.connect(buyer).swap.staticCall(f.key,params,offered,0,ZeroAddress,now+3600,{value:offered}));
   } finally {await chain.close();}
  });
});

describe("Secondary pool permissions", {concurrency: false}, () => {
  test('opening/base hook charges bind the official pool; a separately funded no-hook pool can trade without them',async()=>{
   const c=await createLocalChain();
   try{
    const wallets=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i))),owner=wallets[0],alice=wallets[2];
    const manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,
     proposer:owner.address,validators:[owner.address],fundraisingPolicyVersion:2});
    const p=await c.createProject(s.factory,{target:eth('1')});
    for(const w of wallets)await tx(p.connect(w).contribute(0,{value:eth('0.05')}));
    await tx(p.connect(c.migrationSigner).migrate({gasLimit:16000000,gasPrice:1000000000n}));
    const token=new Contract(await p.token(),artifact('ProjectToken').abi,alice);
    const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,owner);
    const driver=await c.deploy('V4TestRouter',[manager.target]);
    const official=[ZeroAddress,token.target,3000,60,s.hook.target],secondary=[ZeroAddress,token.target,3000,60,ZeroAddress];
    await tx(manager.initialize(secondary,(await locker.initialQuote()).sqrtPriceX96));
    await tx(token.approve(driver.target,eth('10000000')));
    await tx(driver.connect(alice).modify(secondary,[-887220,887220,(await locker.positionLiquidity())/100n,id('secondary LP')],
     {value:eth('1'),gasLimit:2500000}));
    const poolId=await p.poolId(),before=await s.hook.totalProtectionAccrued(poolId),platform=await s.hook.platformAccrued();
    assert.ok(await s.hook.extraSellTaxBps(poolId)>2400n);
    const sale=await tx(driver.connect(alice).swap(secondary,[false,-eth('1000'),1461446703485210103287273052203988822378723970341n],{gasLimit:2000000}));
    const delta=sale.logs.map(l=>{try{return driver.interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='Delta');
    assert.ok(delta.args.ethDelta>0n);
    assert.equal(await s.hook.totalProtectionAccrued(poolId),before);
    assert.equal(await s.hook.platformAccrued(),platform);
    await tx(driver.connect(alice).swap(official,[false,-eth('1000'),1461446703485210103287273052203988822378723970341n],{gasLimit:2000000}));
    assert.ok(await s.hook.totalProtectionAccrued(poolId)>before);
    const report={id:'S-05',scope:'Isolated local EVM; alternate pool uses real pinned V4 core with hooks=0.',
     extraSellTaxBpsAtTest:String(await s.hook.extraSellTaxBps(poolId)),
     alternatePoolSaleEthWei:String(delta.args.ethDelta),alternatePoolProtectionChargeWei:'0',
     officialPoolChargesVerified:true,interpretation:'Fee scope/design limitation; the alternative pool requires separate liquidity and cannot withdraw official locked principal.'};
    fs.mkdirSync(new URL('../.run/',import.meta.url),{recursive:true});
    fs.writeFileSync(new URL('../.run/latest-secondary-pool-policy.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
   }finally{await c.close();}
  });
});
