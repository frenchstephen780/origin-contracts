import {describe, afterEach, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {id, parseEther, parseUnits, ZeroAddress, Contract, ContractFactory, parseEther as eth, MaxUint256} from 'ethers';
import {createLocalChain, artifact} from '../scripts/local-chain.mjs';
import fs from 'node:fs';
import solc from 'solc';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';
import {tx, withLocalChain} from './helpers.mjs';
import {deployV4Fixture} from '../scripts/local-v4.mjs';
import {prepareMigration} from '../scripts/migration-gas.mjs';

describe("Base subscription curve and refunds", {concurrency: false}, () => {
  const eth = parseEther;
  const tokens = (amount) => parseUnits(String(amount), 18);
  const DAY = 86400;
  const FEE = eth("0.02");
  const SALE = tokens(100_000_000) * 95n / 100n / 36n * 26n;
  let chain, factory, project, platform, dev, alice, bob, carol;

  beforeEach(async () => {
    chain = await createLocalChain();
    [platform, dev, alice, bob, carol] = chain.signers;
    factory = await chain.deploy("ProjectFactory", [await platform.getAddress()]);
    project = await chain.createProject(factory);
  });
  afterEach(async () => { await chain?.close(); });

  test("day-based creation enforces inclusive 1–15 days and default 3 days", async () => {
    assert.equal(await factory.DEFAULT_FUNDING_DAYS(),3n);
    assert.equal(await factory.MAX_FUNDING_DAYS(),15n);
    for(const duration of [0,16]) await expectError(factory,"InvalidDuration",()=>factory.createProjectDays.staticCall(eth("1"),duration,id("days"),"ipfs://days",{value:FEE}));
    for(const duration of [1,3,10,15]) {
      const receipt=await(await factory.createProjectDays(eth("1"),duration,id("days"),"ipfs://days",{value:FEE})).wait();
      const created=receipt.logs.map(l=>{try{return factory.interface.parseLog(l)}catch{return null}}).find(l=>l?.name==="ProjectCreated");
      const block=await chain.provider.getBlock(receipt.blockNumber);
      assert.equal(created.args.deadline,BigInt(block.timestamp+duration*DAY));
    }
  });

  async function buy(signer, amount, minimum = 0n, targetProject = project) {
    return (await targetProject.connect(signer).contribute(minimum, { value: amount })).wait();
  }
  async function expectError(contract, name, action) {
    const selector = contract.interface.getError(name).selector.toLowerCase();
    await assert.rejects(action, (error) => {
      const serialized = JSON.stringify(error, (_, value) => typeof value === "bigint" ? value.toString() : value);
      assert.ok(serialized.toLowerCase().includes(selector) || String(error).includes(name),
        `Expected ${name} (${selector}), got ${String(error)}`);
      return true;
    });
  }

  test("creation fee stays in factory; project principal and permissions are isolated", async () => {
    assert.equal(await factory.projectCount(), 1n);
    assert.equal(await factory.isProject(project.target), true);
    assert.equal(await factory.accruedCreationFees(), FEE);
    assert.equal(await chain.balance(project.target), 0n);
    assert.equal(await project.creator(), await dev.getAddress());
    assert.equal(await project.factory(), factory.target);
    await buy(alice, eth("3"));
    assert.equal(await chain.balance(project.target), eth("3"));
    assert.equal(await chain.balance(factory.target), FEE);
    await expectError(factory, "Unauthorized", () => factory.connect(dev).claimCreationFees.staticCall(dev.address));
    const before = await chain.balance(carol.address);
    await (await factory.claimCreationFees(carol.address)).wait();
    assert.equal(await chain.balance(carol.address) - before, FEE);
    assert.equal(await factory.accruedCreationFees(), 0n);
    assert.equal(await chain.balance(project.target), eth("3"));
    await expectError(factory, "NothingToClaim", () => factory.claimCreationFees.staticCall(carol.address));
  });

  test("creation validates exact fee, target, deadline and disclosure without keeping failed fees", async () => {
    const deadline = (await chain.timestamp()) + DAY;
    const args = [eth("1"), deadline, id("terms"), "ipfs://terms"];
    for (const value of [0n, FEE - 1n, FEE + 1n]) {
      await expectError(factory, "IncorrectCreationFee", () => factory.createProject.staticCall(...args, { value }));
    }
    for (const target of [0n, 1n, 3n, 1n << 128n]) {
      await assert.rejects(() => factory.createProject.staticCall(target, deadline, id("terms"), "ipfs://terms", { value: FEE }));
    }
    for (const end of [await chain.timestamp(), (await chain.timestamp()) + 15 * DAY + 1]) {
      await assert.rejects(() => factory.createProject.staticCall(eth("1"), end, id("terms"), "ipfs://terms", { value: FEE }));
    }
    await assert.rejects(() => factory.createProject.staticCall(eth("1"), deadline, id("terms"), "", { value: FEE }));
    await assert.rejects(() => factory.createProject.staticCall(eth("1"), deadline, "0x" + "00".repeat(32), "ipfs://terms", { value: FEE }));
    await assert.rejects(() => factory.createProject.staticCall(eth("1"), deadline, id("terms"), "x".repeat(2049), { value: FEE }));
    assert.equal(await factory.projectCount(), 1n);
    assert.equal(await chain.balance(factory.target), FEE);
  });

  test("15-day duration boundary is inclusive and supply uses the 95% public allocation with the 13/18 ideal budget", async () => {
    const nextBlock = (await chain.timestamp()) + 10;
    await chain.rpc("evm_setNextBlockTimestamp", [nextBlock]);
    const boundary = await chain.createProject(factory, { deadline: nextBlock + 15 * DAY });
    assert.equal(await boundary.deadline(), BigInt(nextBlock + 15 * DAY));
    assert.equal(await boundary.TOTAL_SUPPLY(), tokens(100_000_000));
    assert.equal(await boundary.SALE_SUPPLY(), SALE);
    assert.equal(await boundary.LIQUIDITY_SUPPLY(), tokens(100_000_000) * 95n / 100n - SALE);
  });

  test("ETH budgets are 50/25/25 percent while token budgets are 15/6/5", async () => {
    const first = SALE * 15n / 26n, second = SALE * 6n / 26n, third = SALE * 5n / 26n;
    assert.deepEqual([...await project.quoteContribution(eth("28.5"))], [eth("28.5"), first, 0n]);
    await buy(alice, eth("28.5"), first);
    await buy(bob, eth("14.25"), second);
    await buy(carol, eth("14.25"), third);
    assert.equal(await project.raised(), eth("57"));
    assert.equal(await project.totalTokenUnits(), SALE);
    assert.equal(await project.remainingCapacity(), 0n);
    assert.equal(await project.state(), 1n);
    assert.equal(await chain.balance(project.target), eth("57"));
    assert.equal(await project.contributorCount(), 3n);
    assert.equal((await project.contributions(alice.address)).ethPaid, eth("28.5"));
    assert.equal((await project.contributions(bob.address)).tokenUnits, second);
    assert.equal((await project.contributions(carol.address)).tokenUnits, third);
    assert.equal(second * 5n, third * 6n);
  });

  test("a single contribution crossing BOTH ETH boundaries is priced piecewise", async () => {
    await buy(alice, eth("27.5"));
    const before = eth("27.5") * 15n * SALE / (eth("57") * 13n);
    // 1 ETH in tier 1, 14.25 ETH in tier 2, 1.5 ETH in tier 3.
    const after = (eth("44.25") * 10n + eth("57") * 3n) * SALE / (eth("57") * 13n);
    const quote = await project.quoteContribution(eth("16.75"));
    assert.equal(quote.tokenUnits, after - before);
    await buy(bob, eth("16.75"), quote.tokenUnits);
    assert.equal(await project.totalTokenUnits(), after);
  });

  test("stale minimum token quote reverts and does not change contribution accounting", async () => {
    const quoted = await project.quoteContribution(eth("1"));
    await buy(alice, eth("28.5"));
    await expectError(project, "SlippageExceeded", () => project.connect(bob).contribute.staticCall(quoted.tokenUnits, { value: eth("1") }));
    assert.equal((await project.contributions(bob.address)).ethPaid, 0n);
    assert.equal(await project.raised(), eth("28.5"));
  });

  test("last buyer receives excess ETH; overfunding and post-target purchases are rejected", async () => {
    await buy(alice, eth("56"));
    const before = await chain.balance(bob.address);
    const quote = await project.quoteContribution(eth("3"));
    assert.equal(quote.acceptedEth, eth("1"));
    assert.equal(quote.excessEth, eth("2"));
    const receipt = await buy(bob, eth("3"), quote.tokenUnits);
    const gas = receipt.gasUsed * receipt.gasPrice;
    assert.equal(before - await chain.balance(bob.address), eth("1") + gas);
    assert.equal((await project.contributions(bob.address)).ethPaid, eth("1"));
    assert.equal(await project.raised(), eth("57"));
    assert.equal(await project.totalTokenUnits(), SALE);
    await expectError(project, "NotFunding", () => project.connect(carol).contribute.staticCall(0n, { value: 1n }));
  });

  test("deadline is exclusive for contributions, inclusive for individual principal refunds", async () => {
    await buy(alice, eth("24"));
    await buy(bob, eth("15"));
    const deadline = await project.deadline();
    await chain.mineAt(deadline - 1n);
    assert.equal(await project.state(), 0n);
    await expectError(project, "NotRefunding", () => project.connect(alice).refund.staticCall(alice.address));
    await chain.mineAt(deadline);
    assert.equal(await project.state(), 2n);
    await expectError(project, "NotFunding", () => project.connect(carol).contribute.staticCall(0n, { value: 1n }));
    const before = await chain.balance(carol.address);
    await (await project.connect(alice).refund(carol.address)).wait();
    assert.equal(await chain.balance(carol.address) - before, eth("24"));
    assert.equal(await project.refundableAmount(bob.address), eth("15"));
    assert.equal(await project.accountedPrincipal(), eth("15"));
    await (await project.connect(bob).refund(carol.address)).wait();
    assert.equal(await chain.balance(carol.address) - before, eth("39"));
    assert.equal(await project.refundedTotal(), eth("39"));
    assert.equal(await project.accountedPrincipal(), 0n);
    assert.equal(await chain.balance(project.target), 0n);
    assert.equal(await chain.balance(factory.target), FEE);
    await expectError(project, "NothingToRefund", () => project.connect(alice).refund.staticCall(carol.address));
    await expectError(project, "NothingToRefund", () => project.connect(dev).refund.staticCall(dev.address));
  });

  test("funded prototype refunds at migration timeout, never exposes a fake migration success", async () => {
    await buy(alice, eth("57"));
    const timeout = await project.fundedAt() + 72n * 3600n;
    await chain.mineAt(timeout - 1n);
    assert.equal(await project.state(), 1n);
    await expectError(project, "NotRefunding", () => project.connect(alice).refund.staticCall(alice.address));
    await chain.mineAt(timeout);
    assert.equal(await project.state(), 2n);
    assert.equal(await project.refundableAmount(alice.address), eth("57"));
    await (await project.connect(alice).refund(alice.address)).wait();
    assert.equal(await chain.balance(project.target), 0n);
  });

  test("projects cannot use each other's funds or refund records", async () => {
    const second = await chain.createProject(factory, { target: eth("2") });
    await buy(alice, eth("1"));
    await buy(bob, eth("2"), 0n, second);
    const firstDeadline=await project.deadline(),secondRefundAt=await second.fundedAt()+await second.MIGRATION_TIMEOUT();
    await chain.mineAt(firstDeadline>secondRefundAt?firstDeadline:secondRefundAt);
    await expectError(second, "NothingToRefund", () => second.connect(alice).refund.staticCall(alice.address));
    await (await project.connect(alice).refund(alice.address)).wait();
    assert.equal(await chain.balance(second.target), eth("2"));
    assert.equal(await second.accountedPrincipal(), eth("2"));
    assert.equal(await factory.accruedCreationFees(), FEE * 2n);
  });

  test("rejects zero payments, direct ETH and non-existent admin withdrawal ABI", async () => {
    await expectError(project, "ZeroContribution", () => project.contribute.staticCall(0n));
    await expectError(project, "DirectEtherNotAccepted", () => alice.sendTransaction({ to: project.target, value: 1n }));
    await expectError(factory, "DirectEtherNotAccepted", () => alice.sendTransaction({ to: factory.target, value: 1n }));
    await buy(alice, eth("1"));
    for (const caller of [dev, platform]) {
      await assert.rejects(() => caller.sendTransaction({ to: project.target, data: id("withdraw()").slice(0, 10) }));
    }
    assert.equal(await chain.balance(project.target), eth("1"));
  });

  test("refusing excess ETH reverts only that purchase, including target and allocation updates", async () => {
    const wallet = await chain.deploy("TestWallet");
    await (await wallet.configure(true, false, project.target)).wait();
    await buy(alice, eth("56"));
    await assert.rejects(() => wallet.buy(project.target, 0n, { value: eth("2") }));
    assert.equal(await project.raised(), eth("56"));
    assert.equal(await project.fundedAt(), 0n);
    assert.equal((await project.contributions(wallet.target)).ethPaid, 0n);
    await (await wallet.buy(project.target, 0n, { value: eth("1") })).wait();
    assert.equal(await project.raised(), eth("57"));
  });

  test("failed refund restores entitlement and contract wallet can choose another recipient", async () => {
    const wallet = await chain.deploy("TestWallet");
    await (await wallet.configure(true, false, project.target)).wait();
    await (await wallet.buy(project.target, 0n, { value: eth("1") })).wait();
    await chain.mineAt(await project.deadline());
    await assert.rejects(() => wallet.claimRefund(project.target, wallet.target));
    assert.equal(await project.refundableAmount(wallet.target), eth("1"));
    assert.equal(await project.refundedTotal(), 0n);
    const before = await chain.balance(carol.address);
    await (await wallet.claimRefund(project.target, carol.address)).wait();
    assert.equal(await chain.balance(carol.address) - before, eth("1"));
    await expectError(project, "InvalidRecipient", () => project.connect(alice).refund.staticCall(ZeroAddress));
    await expectError(project, "InvalidRecipient", () => project.connect(alice).refund.staticCall(project.target));
  });

  test("reentrant refund cannot collect twice or consume another investor's funds", async () => {
    const wallet = await chain.deploy("TestWallet");
    await (await wallet.buy(project.target, 0n, { value: eth("1") })).wait();
    await buy(alice, eth("2"));
    await (await wallet.configure(false, true, project.target)).wait();
    await chain.mineAt(await project.deadline());
    await (await wallet.claimRefund(project.target, wallet.target)).wait();
    assert.equal(await wallet.reentryAttempts(), 1n);
    assert.equal(await wallet.reentrySucceeded(), false);
    assert.equal(await chain.balance(wallet.target), eth("1"));
    assert.equal(await chain.balance(project.target), eth("2"));
    assert.equal(await project.refundedTotal(), eth("1"));
  });

  test("forced ETH does not advance fundraising or enlarge refund entitlements", async () => {
    await buy(alice, eth("1"));
    await chain.deploy("ForceEther", [project.target], platform, { value: eth("57") });
    assert.equal(await project.raised(), eth("1"));
    assert.equal(await project.state(), 0n);
    assert.equal(await project.unaccountedSurplus(), eth("57"));
    await chain.mineAt(await project.deadline());
    await (await project.connect(alice).refund(alice.address)).wait();
    assert.equal(await chain.balance(project.target), eth("57"));
    assert.equal(await project.accountedPrincipal(), 0n);
  });

  test("a rejecting platform treasury cannot block creation or steal project principal", async () => {
    const treasury = await chain.deploy("TestWallet");
    await (await treasury.configure(true, false, project.target)).wait();
    const otherFactory = await chain.deploy("ProjectFactory", [treasury.target]);
    const otherProject = await chain.createProject(otherFactory, { target: eth("1") });
    await buy(alice, eth("0.5"), 0n, otherProject);
    await assert.rejects(() => treasury.claimFactoryFees(otherFactory.target, treasury.target));
    assert.equal(await otherFactory.accruedCreationFees(), FEE);
    const before = await chain.balance(carol.address);
    await (await treasury.claimFactoryFees(otherFactory.target, carol.address)).wait();
    assert.equal(await chain.balance(carol.address) - before, FEE);
    assert.equal(await chain.balance(otherProject.target), eth("0.5"));
  });

  test("split purchases conserve cumulative allocation through both tier boundaries", async () => {
    const single = await chain.createProject(factory);
    await buy(alice, eth("57"), 0n, single);
    let seed = 123456789n;
    let remaining = eth("57");
    let expectedPaid = 0n;
    for (let index = 0; index < 28 && remaining > 0n; index++) {
      seed = (seed * 1103515245n + 12345n) % (1n << 31n);
      const payment = index === 27 ? remaining : 1n + seed * (remaining / 4n) / (1n << 31n);
      await buy(alice, payment);
      remaining -= payment;
      expectedPaid += payment;
      assert.equal(await project.raised(), expectedPaid);
      assert.equal(await chain.balance(project.target), expectedPaid);
      assert.ok(await project.totalTokenUnits() <= SALE);
    }
    assert.equal(remaining, 0n);
    assert.equal(await project.contributorCount(), 1n);
    assert.equal((await project.contributions(alice.address)).tokenUnits,
      (await single.contributions(alice.address)).tokenUnits);
  });

  test("curve remains monotonic, bounded and fully allocated across extreme targets and boundary wei", async () => {
    const curve = await chain.deploy("CurveHarness");
    for (const target of [2n, 38n, eth("0.1"), eth("57"), (1n << 128n) - 2n]) {
      const points = new Set([0n, 1n, target - 1n, target]);
      for (const numerator of [2n, 3n]) {
        const boundary = target * numerator / 4n;
        for (const offset of [-1n, 0n, 1n]) {
          if (boundary + offset >= 0n && boundary + offset <= target) points.add(boundary + offset);
        }
      }
      let previous = -1n;
      for (const amount of [...points].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
        const allocated = await curve.tokensAt(amount, target);
        // Independent piecewise integral: spend ETH budgets in order at inverse
        // price weights 15:12:10. Keep quarter-wei boundaries rational.
        const cap=(v,max)=>v<0n?0n:v>max?max:v;
        const weighted=15n*cap(amount*4n,target*2n)
          +12n*cap(amount*4n-target*2n,target)
          +10n*cap(amount*4n-target*3n,target);
        assert.equal(allocated,SALE*weighted/(target*52n));
        assert.ok(allocated >= previous && allocated <= SALE);
        previous = allocated;
      }
      assert.equal(await curve.tokensAt(0, target), 0n);
      assert.equal(await curve.tokensAt(target, target), SALE);
    }
    await assert.rejects(() => curve.tokensAt(3n, 2n));
    await assert.rejects(() => curve.tokensAt(0n, 0n));
  });

  test("payments yielding zero token units revert rather than silently donating principal", async () => {
    const huge = await chain.createProject(factory, { target: (1n << 128n) - 2n });
    assert.equal((await huge.quoteContribution(1n)).tokenUnits, 0n);
    await expectError(huge, "ZeroAllocation", () => huge.connect(alice).contribute.staticCall(0n, { value: 1n }));
    assert.equal(await huge.raised(), 0n);
  });
});

describe("Community pricing and address caps", {concurrency: false}, () => {
  function fixture(run) {
    return withLocalChain(async c => {
    const owner=c.signers[0],manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[c.signers[5].address],fundraisingPolicyVersion:2});
    await run(c,s);

    });
  }

  test('community factory enforces 1–15 days in every creation entry and subscriptions remain open after day 10',async()=>fixture(async(c,s)=>{
   const DAY=86400,f=s.factory,fee={value:eth('0.02')},hash=id('duration policy');
   assert.equal(await f.DEFAULT_FUNDING_DAYS(),3n);
   assert.equal(await f.MAX_FUNDING_DAYS(),15n);
   for(const days of [0,16]){
    await assert.rejects(()=>f.createProjectDays.staticCall(eth('1'),days,hash,'ipfs://duration',fee));
    await assert.rejects(()=>f.createNamedProjectDays.staticCall(eth('1'),days,hash,'ipfs://duration','Duration test','DAY15',fee));
   }
   const now=await c.timestamp();
   for(const seconds of [DAY-1,15*DAY+1])await assert.rejects(()=>f.createProject.staticCall(eth('1'),now+seconds,hash,'ipfs://duration',fee));
   const receipt=await tx(f.createNamedProjectDays(eth('1'),15,hash,'ipfs://duration','Duration test','DAY15',fee));
   const event=receipt.logs.map(l=>{try{return f.interface.parseLog(l)}catch{return null}}).find(l=>l?.name==='ProjectCreated');
   const p=new Contract(event.args.project,artifact('ProjectEscrow').abi,c.signers[2]),created=await c.provider.getBlock(receipt.blockNumber);
   assert.equal(await p.MAX_FUNDING_DURATION(),BigInt(15*DAY));
   assert.equal(await p.deadline(),BigInt(created.timestamp+15*DAY));
   await c.mineAt(created.timestamp+11*DAY);
   await tx(p.contribute(0,{value:eth('0.01')}));
   assert.equal(await p.state(),0n);
   await c.mineAt(await p.deadline());
   await assert.rejects(()=>p.contribute.staticCall(0,{value:eth('0.01')}));
  }));
  test('community migration solver encodes 1.45P across fees/target boundaries without losing supply or changing sale after gas',async()=>fixture(async(c,s)=>{
   assert.equal(await s.factory.CONTRACT_VERSION(),15n);
   for(const fee of [0n,1n,50n,99n,100n])for(const r of [eth('1'),eth('1')+2n,eth('57'),eth('1000000')]){
    const q=await s.coordinator.quoteForFee(r,fee),den=r*1972n,num=q.saleSupply*1495n*(1n<<192n);
    assert.equal(q.saleSupply%544n,0n);
    assert.equal(q.ethAmount,r/2n-r*fee/10000n);
    assert.equal(q.saleSupply+q.tokenAmount+q.lockedTokenRemainder,eth('95000000'));
    assert.ok(q.sqrtPriceX96**2n*den<=num && (q.sqrtPriceX96+1n)**2n*den>num);
    const final=await s.coordinator.quoteAfterGas(r,fee,q.ethAmount/10n);
    assert.equal(final.saleSupply,q.saleSupply);assert.equal(final.sqrtPriceX96,q.sqrtPriceX96);
    assert.equal(final.ethAmount,q.ethAmount-q.ethAmount/10n);
    assert.ok(final.tokenAmount<=q.tokenAmount);
   }
   for(const fee of [101n,1000n,4999n,5000n])await assert.rejects(()=>s.coordinator.quoteForFee(eth('1'),fee));
   const legacy=await c.deploy('SharedV4MigrationCoordinator',[await s.coordinator.poolManager(),s.governanceDeployer.target,s.rewardsDeployer.target,s.tokenDeployer.target]);
   await assert.rejects(()=>c.deploy('CommunityV4ProjectFactory',[c.signers[0].address,legacy.target]));
  }));
  test('20 addresses fund exact 1/1.15/1.3 tiers, cumulative 5% cap refunds excess, migration keeps opening and delivered balances',async()=>fixture(async(c,s)=>{
   const p=await c.createProject(s.factory,{target:eth('1')}),t=new Contract(await p.token(),artifact('ProjectToken').abi,c.signers[0]);
   const wallets=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i))),q=await s.coordinator.quote(eth('1'));
   assert.equal(await p.maxContributionPerAddress(),eth('0.05'));assert.equal(await p.fundraisingPolicyVersion(),2n);
   await tx(p.connect(wallets[0]).contribute(0,{value:eth('0.02')}));
   const offer=await p.quoteContributionFor(wallets[0].address,eth('0.04'));
   assert.equal(offer.acceptedEth,eth('0.03'));assert.equal(offer.excessEth,eth('0.01'));
   const before=await c.balance(wallets[0].address),receipt=await tx(p.connect(wallets[0]).contribute(offer.tokenUnits,{value:eth('0.04')}));
   assert.equal(before-await c.balance(wallets[0].address)-receipt.fee,eth('0.03'));
   assert.equal(await p.remainingContributionFor(wallets[0].address),0n);
   await assert.rejects(()=>p.connect(wallets[0]).contribute.staticCall(0,{value:1n}));
   await assert.rejects(()=>t.connect(wallets[0]).transfer.staticCall(wallets[1].address,1));
   for(let i=1;i<20;i++){
    const quote=await p.quoteContributionFor(wallets[i].address,eth('0.05'));
    await tx(p.connect(wallets[i]).contribute(quote.tokenUnits,{value:eth('0.05')}));
    if(i===9)assert.equal(await p.totalTokenUnits(),q.saleSupply*299n/544n);
    if(i===14)assert.equal(await p.totalTokenUnits(),q.saleSupply*429n/544n);
   }
   assert.equal(await p.raised(),eth('1'));assert.equal(await p.contributorCount(),20n);
   assert.equal(await p.totalTokenUnits(),q.saleSupply);
   const balances=await Promise.all(wallets.map(w=>t.balanceOf(w.address)));
   await tx(p.migrate({gasLimit:16000000,gasPrice:1000000000n}));
   const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]),final=await locker.initialQuote();
   assert.equal(final.sqrtPriceX96,q.sqrtPriceX96);assert.equal(final.saleSupply,q.saleSupply);
   assert.equal(final.ethAmount,q.ethAmount-await p.migrationGasRefund());
   assert.deepEqual(await Promise.all(wallets.map(w=>t.balanceOf(w.address))),balances);
   assert.equal(await t.totalSupply(),q.saleSupply+eth('5000000')+final.tokenAmount);
   await tx(t.connect(wallets[0]).transfer(wallets[1].address,1));
  }));
  test('new capped subscriptions refund accepted principal and burn tokens once after failed funding',async()=>fixture(async(c,s)=>{
   const p=await c.createProject(s.factory,{target:eth('1')}),alice=c.signers[2],recipient=c.signers[3],t=new Contract(await p.token(),artifact('ProjectToken').abi,alice);
   await tx(p.connect(alice).contribute(0,{value:eth('0.1')}));
   assert.equal((await p.contributions(alice.address)).ethPaid,eth('0.05'));
   await c.mineAt(await p.deadline());const before=await c.balance(recipient.address);
   await tx(p.connect(alice).refund(recipient.address));assert.equal(await c.balance(recipient.address)-before,eth('0.05'));
   assert.equal(await t.balanceOf(alice.address),0n);assert.equal(await p.accountedPrincipal(),0n);
   await assert.rejects(()=>p.connect(alice).refund.staticCall(recipient.address));
  }));
  test('new cumulative curve is continuous and splitting cannot add token units, including indivisible boundaries',async()=>{
   const c=await createLocalChain();try{
    const source='pragma solidity 0.8.30; import {FundraisingCurve} from "src/libraries/FundraisingCurve.sol"; contract CommunityCurveHarness { function tokensAt(uint256 r,uint256 t,uint256 q) external pure returns(uint256){return FundraisingCurve.communityTokensAt(r,t,q);} }';
    const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Harness.sol':{content:source}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}}),{import:p=>({contents:fs.readFileSync(new URL('../'+(p.startsWith('@')?'node_modules/':'')+p,import.meta.url),'utf8')})}));
    assert.equal((output.errors||[]).filter(e=>e.severity==='error').length,0);
    const compiled=output.contracts['Harness.sol'].CommunityCurveHarness;
    const curve=await new ContractFactory(compiled.abi,'0x'+compiled.evm.bytecode.object,c.signers[0]).deploy(),q=544n*123456789n;
    await curve.waitForDeployment();
    for(const r of [eth('0.1'),eth('0.1')+2n,eth('57')]){
     const f=x=> x*4n<=r*2n?x*299n*q/(r*272n):x*4n<=r*3n?(x*520n+r*39n)*q/(r*544n):(x*460n+r*84n)*q/(r*544n);
     for(const x of [0n,1n,r/2n-1n,r/2n,r/2n+1n,r*3n/4n-1n,r*3n/4n,r*3n/4n+1n,r])assert.equal(await curve.tokensAt(x,r,q),f(x));
     let total=0n,previous=0n;for(let i=1n;i<=97n;i++){const x=r*i/97n;total+=f(x)-f(previous);previous=x;}assert.equal(total,q);
     // Equal-size purchases in tiers have price ratios 23/20 and 13/10.
     if(r%4n===0n){const a=f(r/2n),b=f(r*3n/4n)-a,d=q-f(r*3n/4n);assert.equal(a*10n,b*23n);assert.equal(a*5n,d*13n);}
    }
   }finally{await c.close();}
  });
});

describe("Refundable creation deposits", {concurrency: false}, () => {
  const eth=parseEther;
  function fixture(run) {
    return withLocalChain(async c => {const [owner,founder,investor]=c.signers;const manager=await c.deploy('PoolManager',[owner.address]);const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[owner.address],lpRewards:false});const p=await c.createProject(s.factory,{target:eth('1')});await run(c,s,p,founder,investor);
    });
  }
  test('creation deposit is reserved for its founder and cannot be claimed early, by platform or twice',async()=>fixture(async(c,s,p,founder,investor)=>{
   assert.equal(await s.factory.CONTRACT_VERSION(),8n);assert.equal(await s.factory.accruedCreationFees(),0n);assert.equal(await s.factory.outstandingCreationDeposits(),eth('0.02'));
   assert.equal(await s.factory.creationDepositClaimable(p.target),false);
   await assert.rejects(()=>s.factory.claimCreationFees.staticCall(investor.address));
   await assert.rejects(()=>s.factory.claimCreationDeposit.staticCall(p.target,investor.address));
   await assert.rejects(()=>s.factory.connect(founder).claimCreationDeposit.staticCall(p.target,founder.address));
   await(await p.connect(investor).contribute(0,{value:eth('1'),gasLimit:600000})).wait();await(await p.migrate({gasLimit:16000000})).wait();assert.equal(await p.state(),3n);
   assert.equal(await s.factory.creationDepositClaimable(p.target),true);
   await assert.rejects(()=>s.factory.connect(founder).claimCreationDeposit.staticCall(p.target,ZeroAddress));
   await assert.rejects(()=>s.factory.connect(founder).claimCreationDeposit.staticCall(p.target,s.factory.target));
   const before=await c.balance(investor.address);await(await s.factory.connect(founder).claimCreationDeposit(p.target,investor.address)).wait();assert.equal(await c.balance(investor.address)-before,eth('0.02'));
   assert.equal(await s.factory.outstandingCreationDeposits(),0n);assert.equal(await s.factory.creationDepositClaimable(p.target),false);
   await assert.rejects(()=>s.factory.connect(founder).claimCreationDeposit.staticCall(p.target,founder.address));
   const gov=new Contract(await p.governance(),artifact('ProjectGovernance').abi,c.signers[0]);const vault=new Contract(await gov.devVault(),artifact('ProjectVault').abi,c.signers[0]);assert.equal(await vault.availableFunds(),eth('0.5'));assert.equal(await s.factory.accruedMigrationFees(),eth('0.01'));
  }));
  test('failure at deadline releases only this deposit; contributor principal and other deposits remain isolated',async()=>fixture(async(c,s,p,founder,investor)=>{
   const another=await c.createProject(s.factory,{target:eth('1'),deadline:Number(await p.deadline())+86400});
   await(await p.connect(investor).contribute(0,{value:eth('0.005')})).wait();await c.mineAt(Number(await p.deadline()));
   assert.equal(await s.factory.creationDepositClaimable(p.target),true);assert.equal(await s.factory.creationDepositClaimable(another.target),false);
   await(await s.factory.connect(founder).claimCreationDeposit(p.target,founder.address)).wait();assert.equal(await s.factory.outstandingCreationDeposits(),eth('0.02'));assert.equal(await c.balance(p.target),eth('0.005'));
   await(await p.connect(investor).refund(investor.address)).wait();assert.equal(await c.balance(p.target),0n);
  }));
  test('a full raise with deferred migration cannot reclaim until the migration timeout produces a refund outcome',async()=>fixture(async(c,s,p,founder,investor)=>{
   await(await p.connect(investor).contribute(0,{value:eth('1'),gasLimit:600000})).wait();assert.equal(await p.state(),1n);assert.equal(await s.factory.creationDepositClaimable(p.target),false);
   await c.mineAt(Number(await p.fundedAt())+72*3600);assert.equal(await s.factory.creationDepositClaimable(p.target),true);
   await(await s.factory.connect(founder).claimCreationDeposit(p.target,founder.address)).wait();assert.equal(await c.balance(p.target),eth('1'));
  }));
  test('stateless deployment services can be reused while the new factory, tokens, hook and LP bind the new coordinator',async()=>fixture(async(c,s,p,founder,investor)=>{
   const old=s.coordinator,rows=[];
   const reuseLabels=['timelock','governanceImplementation','rewardsImplementation','feePolicyImplementation','feePolicy','projectProxyDeployer','allocationVerifier','hookDeployer'];
   const deploy=async(label,name,args=[])=>{if(reuseLabels.includes(label))return s[label==='allocationVerifier'?'verifier':label==='projectProxyDeployer'?'governanceDeployer':label];const v=await c.deploy(name,args);rows.push(label);return v;};
   const next=await deployUpgradeableSuite({signer:c.signers[0],manager:await old.poolManager(),platform:c.signers[0].address,proposer:c.signers[0].address,validators:[c.signers[0].address],lpRewards:false,sharedDeployers:{tokens:await old.tokenDeployer(),rewards:await old.upgradeProtocolAddresses(7)},deploy});
   assert.deepEqual(rows,['coordinator','factory','swapRouter']);assert.notEqual(next.coordinator.target,old.target);
   const q=await c.createProject(next.factory,{target:eth('1')});await(await q.connect(investor).contribute(0,{value:eth('1'),gasLimit:600000})).wait();await(await q.migrate({gasLimit:16000000})).wait();assert.equal(await q.state(),3n);
   const token=new Contract(await q.token(),artifact('ProjectToken').abi,founder);assert.equal(await token.coordinator(),next.coordinator.target);assert.equal(await next.factory.creationDepositClaimable(q.target),true);
  }));
});

describe("Locked token delivery", {concurrency: false}, () => {
  const TOTAL=eth('100000000'),RESERVE=eth('5000000'),DAY=86400;
  function fixture(run,options={}) {
    return withLocalChain(async c => {
    const f=await deployV4Fixture(c,{withProject:false,...options});
    f.project=await c.createProject(f.factory,{target:eth('1')});
    f.token=new Contract(await f.project.token(),artifact('ProjectToken').abi,c.signers[0]);
    await run(c,f);

    });
  }

  test('each contribution delivers its exact cumulative tier allocation; wallets stay locked until migration',async()=>fixture(async(c,f)=>{
   const [, ,alice,bob,carol]=c.signers,p=f.project,t=f.token;
   assert.equal(await p.subscriptionTokensImmediate(),true);
   let issued=0n;
   for(const [who,amount] of [[alice,'0.3'],[bob,'0.25'],[alice,'0.2'],[carol,'0.25']]){
    const before=await t.balanceOf(who.address),q=await p.quoteContribution(eth(amount));
    const receipt=await tx(p.connect(who).contribute(q.tokenUnits,{value:eth(amount),gasLimit:600000}));
    assert.equal(await t.balanceOf(who.address)-before,q.tokenUnits);
    assert.equal(await t.balanceOf(who.address),(await p.contributions(who.address)).tokenUnits);
    assert.equal(await t.unclaimed(who.address),0n);
    assert.equal(await p.tokensClaimed(who.address),true);
    assert.ok(receipt.logs.some(log=>{try{return t.interface.parseLog(log)?.name==='Transfer'}catch{return false}}));
    issued+=q.tokenUnits;
    assert.equal(await p.claimedTokenUnits(),issued);
    assert.equal(await t.currentShares(who.address),0n);
    assert.equal(await t.publicPower(),0n);
    assert.equal(await t.eligiblePower(),0n);
    await assert.rejects(()=>t.connect(who).transfer.staticCall(carol.address,1));
    await assert.rejects(()=>t.connect(who).burn.staticCall(1));
   }
   assert.equal(issued,await p.SALE_SUPPLY());
   assert.equal(await t.balanceOf(p.target),TOTAL-issued);
   await tx(t.connect(alice).approve(bob.address,MaxUint256));
   await assert.rejects(()=>t.connect(bob).transferFrom.staticCall(alice.address,bob.address,1));
   const preLaunch=Number(await c.rpc('eth_blockNumber'));
   await c.mineAt(await c.timestamp()+2*DAY);
   const baseline=await f.coordinator.quote(eth('1'));
   const prepared=await prepareMigration(p.connect(c.signers[5]),{gasPrice:1000000000n});
   await tx(c.signers[5].sendTransaction(prepared.request));
   assert.equal(await p.state(),3n);
   assert.equal(await t.balanceOf(p.target),RESERVE);
   assert.equal(await t.publicPower(),issued);
   assert.equal(await t.currentShares(alice.address),await t.balanceOf(alice.address));
   assert.equal(await t.getPastTotalPower(preLaunch),0n);
   const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
   const final=await locker.initialQuote();
   assert.equal(final.sqrtPriceX96,baseline.sqrtPriceX96);
   assert.equal(final.saleSupply,issued);
   assert.equal(final.ethAmount,baseline.ethAmount-await p.migrationGasRefund());
   assert.equal(await t.totalSupply(),issued+RESERVE+final.tokenAmount);
   assert.ok(final.lockedTokenRemainder>0n);
   for(const who of [alice,bob,carol]){
    assert.equal(await t.balanceOf(who.address),(await p.contributions(who.address)).tokenUnits);
    await assert.rejects(()=>p.connect(who).claimTokens.staticCall(who.address));
    await assert.rejects(()=>p.connect(who).refund.staticCall(who.address));
   }
   await tx(t.connect(bob).transferFrom(alice.address,bob.address,1));
   await c.mineAt(await c.timestamp()+DAY);
   assert.ok(await t.currentShares(carol.address)>await t.balanceOf(carol.address));
  }));

  test('failed fundraising atomically burns the subscriber balance and refunds only accepted ETH once',async()=>fixture(async(c,f)=>{
   const p=f.project,t=f.token,alice=c.signers[2],bob=c.signers[3],recipient=c.signers[4];
   for(const [who,amount] of [[alice,'0.15'],[bob,'0.2'],[alice,'0.25']])await tx(p.connect(who).contribute(0,{value:eth(amount)}));
   const units=(await p.contributions(alice.address)).tokenUnits,bobUnits=await t.balanceOf(bob.address);
   await c.mineAt(await p.deadline());
   const before=await c.balance(recipient.address);
   const receipt=await tx(p.connect(alice).refund(recipient.address));
   assert.equal(await c.balance(recipient.address)-before,eth('0.4'));
   assert.equal(await t.balanceOf(alice.address),0n);
   assert.equal(await t.subscriptionBalance(alice.address),0n);
   assert.equal(await t.balanceOf(bob.address),bobUnits);
   assert.equal(await t.totalSupply(),TOTAL-units);
   assert.equal(await c.balance(p.target),eth('0.2'));
   const burn=receipt.logs.map(log=>{try{return t.interface.parseLog(log)}catch{return null}}).find(e=>e?.name==='Transfer');
   assert.equal(burn.args.from,alice.address);assert.equal(burn.args.to,'0x0000000000000000000000000000000000000000');assert.equal(burn.args.value,units);
   await assert.rejects(()=>p.connect(alice).refund.staticCall(recipient.address));
   await assert.rejects(()=>t.connect(bob).transfer.staticCall(recipient.address,1));
   await assert.rejects(()=>t.connect(bob).burnSubscription.staticCall(bob.address,bobUnits));
   await tx(p.connect(bob).refund(bob.address));
   assert.equal(await p.accountedPrincipal(),0n);
   assert.equal(await t.totalSupply(),TOTAL-units-bobUnits);
  }));

  test('rejecting ETH recipients roll back both the token burn and refund ledger; reentry cannot refund twice',async()=>fixture(async(c,f)=>{
   const p=f.project,t=f.token,w=await c.deploy('TestWallet');
   await tx(w.configure(true,false,p.target));
   await tx(w.buy(p.target,0,{value:eth('0.4')}));
   const units=await t.balanceOf(w.target);
   await c.mineAt(await p.deadline());
   await assert.rejects(()=>w.claimRefund.staticCall(p.target,w.target));
   assert.equal(await t.balanceOf(w.target),units);
   assert.equal(await t.subscriptionBalance(w.target),units);
   assert.equal(await t.totalSupply(),TOTAL);
   assert.equal((await p.contributions(w.target)).refunded,false);
   assert.equal(await p.refundedTotal(),0n);
   await tx(w.configure(false,true,p.target));
   await tx(w.claimRefund(p.target,w.target));
   assert.equal(await w.reentrySucceeded(),false);
   assert.equal(await w.reentryAttempts(),1n);
   assert.equal(await c.balance(w.target),eth('0.4'));
   assert.equal(await t.balanceOf(w.target),0n);
   assert.equal(await p.refundedTotal(),eth('0.4'));
  }));

  test('unsuccessful migration keeps delivered tokens locked and burns them on timeout refunds',async()=>fixture(async(c,f)=>{
   const p=f.project,t=f.token,alice=c.signers[2];
   await tx(p.connect(alice).contribute(0,{value:eth('1')}));
   const units=await t.balanceOf(alice.address);
   await assert.rejects(()=>p.migrate.staticCall());
   assert.equal(await t.launched(),false);assert.equal(await t.balanceOf(alice.address),units);
   assert.equal(await c.balance(p.target),eth('1'));
   await assert.rejects(()=>t.connect(alice).transfer.staticCall(c.signers[3].address,1));
   await c.mineAt(await p.fundedAt()+3n*BigInt(DAY));
   await assert.rejects(()=>p.migrate.staticCall());
   await tx(p.connect(alice).refund(alice.address));
   assert.equal(await t.balanceOf(alice.address),0n);
   assert.equal(await t.totalSupply(),TOTAL-units);
   assert.equal(await c.balance(p.target),0n);
  },{configure:false}));

  test('failed excess refund rolls back token delivery and principal in the same contribution',async()=>fixture(async(c,f)=>{
   const p=f.project,t=f.token,w=await c.deploy('TestWallet');
   await tx(w.configure(true,false,p.target));
   await assert.rejects(()=>w.buy.staticCall(p.target,0,{value:eth('1.2')}));
   assert.equal(await t.balanceOf(w.target),0n);assert.equal(await t.subscriptionBalance(w.target),0n);
   assert.equal(await p.raised(),0n);assert.equal(await p.claimedTokenUnits(),0n);
   assert.equal(await c.balance(p.target),0n);assert.equal(await t.totalSupply(),TOTAL);
  }));

  test('twenty local wallets receive all three tiers before migration without a launch-time payout loop',async()=>fixture(async(c,f)=>{
   const p=f.project,t=f.token,sale=await p.SALE_SUPPLY();
   const people=await Promise.all(Array.from({length:20},(_,i)=>c.provider.getSigner(i)));
   let previous=0n;
   for(let i=0;i<people.length;i++){
    const who=people[i],q=await p.quoteContribution(eth('0.05'));
    await tx(p.connect(who).contribute(q.tokenUnits,{value:eth('0.05'),gasLimit:600000}));
    const expected=i<10?BigInt(i+1)*sale*15n/260n:i<15?(BigInt(i+1)*12n+30n)*sale/260n:(BigInt(i+1)+6n)*sale/26n;
    assert.equal(await t.balanceOf(who.address),expected-previous);
    previous=expected;
   }
   assert.equal(previous,sale);assert.equal(await p.contributorCount(),20n);
   assert.equal(await p.claimedTokenUnits(),sale);
   const receipt=await tx(p.migrate({gasLimit:16000000,gasPrice:1000000000n}));
   assert.ok(receipt.gasUsed<16000000n);
   assert.equal(await t.balanceOf(p.target),RESERVE);
   const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,c.signers[0]);
   const q=await locker.initialQuote();
   assert.equal(await t.totalSupply(),sale+RESERVE+q.tokenAmount);
   for(const who of people)assert.equal(await t.balanceOf(who.address),(await p.contributions(who.address)).tokenUnits);
  }));
});
