import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {Contract, parseEther, id, ZeroAddress, ZeroHash, MaxUint256, parseEther as eth} from 'ethers';
import {artifact, createLocalChain} from '../scripts/local-chain.mjs';
import {deployV4Fixture, fundAndLaunch, swap} from '../scripts/local-v4.mjs';
import {withV4Fixture, tx} from './helpers.mjs';
import {deployUpgradeableSuite} from '../scripts/upgradeable-suite.mjs';

describe("Pool initialization and atomic custody", {concurrency: false}, () => {
  const eth = parseEther;
  const TOTAL = eth("100000000"), RESERVE = TOTAL / 20n, DAY = 86400;
  function fixture(options, run) { return withV4Fixture(run, options); }
  async function fundOnly(chain, f) {
    await (await f.project.connect(chain.signers[2]).contribute(0, { value: eth("57"), gasLimit: 600000 })).wait();
  }
  async function claim(chain, f) {
    await (await f.token.connect(chain.signers[2]).approve(f.router.target, MaxUint256)).wait();
  }
  async function expectRevertedTransaction(run) { await assert.rejects(async () => (await run()).wait()); }

  test("V4 quote solves post-fee LP ETH, last-tier opening price, fixed supply and integer tranche sizes", async () => {
    await fixture({}, async (chain, f) => {
      for (const target of [eth("1"), eth("1") + 2n, eth("57"), eth("1000"), eth("1000000")]) {
        const q = await f.coordinator.quote(target);
        assert.equal(q.ethAmount, target / 2n - target / 100n);
        assert.equal(q.saleSupply % 26n, 0n);
        assert.equal(q.saleSupply + q.tokenAmount + q.lockedTokenRemainder + RESERVE, TOTAL);
        assert.ok(q.saleSupply <= (TOTAL - RESERVE) * 130n / 179n);
        assert.ok(q.lockedTokenRemainder <= (q.sqrtPriceX96 + (1n << 96n) - 1n) / (1n << 96n) + 52n);
        // S is exactly floor(sqrt(10Q/(13R)) * 2^96), not a freely selected price.
        const numerator = q.saleSupply * 10n * (1n << 192n), denominator = target * 13n;
        assert.ok(q.sqrtPriceX96 ** 2n * denominator <= numerator);
        assert.ok((q.sqrtPriceX96 + 1n) ** 2n * denominator > numerator);
      }
      for (const target of [eth("1") - 2n, eth("1000000") + 2n, eth("57") + 1n]) {
        await assert.rejects(() => f.coordinator.quote(target));
      }
    });
  });

  test("separate migration reimburses its caller from real V4 liquidity and atomically funds the dev vault", async () => {
    await fixture({}, async (chain, f) => {
      const q = await f.coordinator.quote(eth("57"));
      await fundAndLaunch(chain, f, { automatic: true });
      assert.equal(await f.project.state(), 3n);
      const finalQuote = await f.locker.initialQuote();
      assert.equal(await chain.balance(f.manager.target), eth("27.93") - await f.project.migrationGasRefund());
      assert.equal(await f.devVault.availableFunds(), eth("28.5"));
      assert.equal(await f.insurance.availableFunds(), 0n);
      assert.equal(await chain.balance(f.project.target), 0n);
      assert.equal(await chain.balance(f.coordinator.target), 0n);
      assert.equal(await f.project.accountedPrincipal(), 0n);
      assert.equal(await f.project.unaccountedSurplus(), 0n);
      assert.equal(await f.token.balanceOf(f.project.target), RESERVE);
      assert.equal(await f.token.balanceOf(f.manager.target), finalQuote.tokenAmount);
      assert.equal(await f.token.balanceOf(f.locker.target), 0n);
      assert.equal(await f.locker.positionLiquidity(), finalQuote.liquidity);
      assert.equal((await f.router.poolState(f.key))[0], q.sqrtPriceX96);
      assert.equal(await f.gov.launchTime(), await f.project.launchTime());
      assert.equal(await f.gov.anchor(), await f.project.launchTime() + BigInt(DAY));
      assert.equal(await f.token.allowance(f.project.target, f.coordinator.target), 0n);
      assert.equal(await f.factory.accruedCreationFees(), eth("0.02"));
      assert.equal(await f.factory.accruedMigrationFees(), eth("0.57"));
      assert.equal(await chain.balance(f.factory.target), eth("0.59"));
      await assert.rejects(() => f.factory.connect(chain.signers[2]).claimMigrationFees.staticCall(chain.signers[2].address));
      const treasuryBefore = await chain.balance(chain.signers[0].address);
      const feeReceipt = await (await f.factory.claimMigrationFees(chain.signers[0].address)).wait();
      assert.equal(await chain.balance(chain.signers[0].address) - treasuryBefore + feeReceipt.gasUsed * feeReceipt.gasPrice, eth("0.57"));
      assert.equal(await f.factory.accruedMigrationFees(), 0n);
      assert.equal(await f.token.totalSupply(), TOTAL - finalQuote.lockedTokenRemainder);
    });
  });

  test("tranche allocations are conserved; delivered wallet balances receive voting power after launch", async () => {
    await fixture({}, async (chain, f) => {
      await fundAndLaunch(chain, f);
      const supply = await f.project.SALE_SUPPLY();
      const blockBefore = Number(await chain.rpc("eth_blockNumber"));
      const alice = chain.signers[2], bob = chain.signers[3], carol = chain.signers[4];
      assert.equal((await f.project.contributions(alice.address)).tokenUnits, supply * 15n / 26n);
      assert.equal((await f.project.contributions(bob.address)).tokenUnits, supply * 6n / 26n);
      assert.equal((await f.project.contributions(carol.address)).tokenUnits, supply * 5n / 26n);
      assert.equal(await f.token.publicPower(), supply);
      await claim(chain, f);
      assert.equal(await f.token.publicPower(), supply);
      assert.equal(await f.token.getPastPower(alice.address, blockBefore), supply * 15n / 26n);
      assert.equal(await f.token.getPastTotalPower(blockBefore), supply);
      assert.equal(await f.token.balanceOf(alice.address), supply * 15n / 26n);
      assert.equal(await f.token.unclaimed(alice.address), 0n);
      assert.equal(await f.token.balanceOf(f.project.target), RESERVE);
      assert.equal(await f.project.claimedTokenUnits(), supply);
      await assert.rejects(() => f.project.connect(alice).claimTokens(alice.address));
      await assert.rejects(() => f.project.connect(alice).refund(alice.address));
      await assert.rejects(() => f.project.migrate());
      assert.equal(f.project.interface.hasFunction('autoMigrate'), false);
    });
  });

  test("cross-tier purchases and split purchases conserve solved sale supply", async () => {
    await fixture({}, async (chain, f) => {
      const alice = chain.signers[2], bob = chain.signers[3], q = await f.project.SALE_SUPPLY();
      await (await f.project.connect(alice).contribute(0, { value: eth("23"), gasLimit: 600000 })).wait();
      const quote = await f.project.quoteContribution(eth("17.5"));
      await (await f.project.connect(bob).contribute(quote.tokenUnits, { value: eth("17.5"), gasLimit: 600000 })).wait();
      const before = await chain.balance(alice.address);
      const receipt = await (await f.project.connect(alice).contribute(0, { value: eth("20"), gasLimit: 600000 })).wait();
      assert.equal(before - await chain.balance(alice.address) - receipt.gasUsed * receipt.gasPrice, eth("16.5"));
      assert.equal(await f.project.totalTokenUnits(), q);
      assert.equal((await f.project.contributions(alice.address)).tokenUnits + (await f.project.contributions(bob.address)).tokenUnits, q);
      await (await f.project.connect(bob).migrate({ gasLimit: 16000000 })).wait();
      assert.equal(await f.project.state(), 3n);
    });
  });

  test("permissionless retry works after bootstrap is completed; before success claims and dev funding stay locked", async () => {
    await fixture({ configure: false }, async (chain, f) => {
      const alice = chain.signers[2];
      await fundOnly(chain, f);
      await assert.rejects(() => f.project.connect(alice).claimTokens(alice.address));
      await expectRevertedTransaction(() => f.project.migrate({ gasLimit: 16000000 }));
      assert.equal(await f.project.state(), 1n);
      assert.equal(await chain.balance(f.project.target), eth("57"));
      assert.equal(await f.token.balanceOf(f.project.target), TOTAL - await f.project.totalTokenUnits());
      await (await f.coordinator.configure(f.factory.target, f.hook.target)).wait();
      await (await f.project.connect(alice).migrate({ gasLimit: 16000000 })).wait();
      assert.equal(await f.project.state(), 3n);
      await assert.rejects(() => f.coordinator.configure(f.factory.target, f.hook.target));
      await assert.rejects(() => f.coordinator.connect(alice).migrate({ value: eth("57") }));
    });
  });

  test("failure AFTER real pool initialization rolls pool, LP, approvals and treasury state back", async () => {
    await fixture({ governanceDeployerName: "RejectingGovernanceDeployer" }, async (chain, f) => {
      // The final investor never executes migration, even with a large gas limit.
      const funding = await (await f.project.connect(chain.signers[2]).contribute(0, {
        value: eth("57"), gasLimit: 16000000,
      })).wait();
      assert.equal(await f.project.state(), 1n);
      assert.ok(funding.gasUsed < 600000n);
      await expectRevertedTransaction(() => f.project.migrate({ gasLimit: 16000000 }));
      assert.equal((await f.router.poolState(f.key))[0], 0n);
      assert.equal(await chain.balance(f.manager.target), 0n);
      assert.equal(await chain.balance(f.coordinator.target), 0n);
      assert.equal(await chain.balance(f.project.target), eth("57"));
      assert.equal(await f.token.balanceOf(f.project.target), TOTAL - await f.project.totalTokenUnits());
      assert.equal(await f.token.allowance(f.project.target, f.coordinator.target), 0n);
      assert.equal(await f.token.locker(), ZeroAddress);
      assert.equal(await f.coordinator.migrated(f.project.target), false);
      assert.equal(await f.project.governance(), ZeroAddress);
      await chain.mineAt(await f.project.fundedAt() + 3n * BigInt(DAY));
      await assert.rejects(() => f.project.migrate());
      const alice = chain.signers[2], before = await chain.balance(alice.address);
      const receipt = await (await f.project.connect(alice).refund(alice.address)).wait();
      assert.equal(await chain.balance(alice.address) - before + receipt.gasUsed * receipt.gasPrice, eth("57"));
      assert.equal(await chain.balance(f.project.target), 0n);
    });
  });

  test("withdrawal clock begins at actual migration, and the first quarter can execute at launch +24h", async () => {
    await fixture({}, async (chain, f) => {
      await fundOnly(chain, f);
      const fundedAt = await f.project.fundedAt();
      await chain.mineAt(fundedAt + 2n * BigInt(DAY));
      await (await f.project.migrate({ gasLimit: 16000000 })).wait();
      const gov = new Contract(await f.project.governance(), artifact("ProjectGovernance").abi, chain.signers[0]);
      const vault = new Contract(await gov.devVault(), artifact("ProjectVault").abi, chain.signers[0]);
      const [, dev] = chain.signers;
      assert.equal(await gov.launchTime(), await f.project.launchTime());
      assert.ok(await gov.launchTime() >= fundedAt + 2n * BigInt(DAY));
      const anchor = Number(await gov.anchor());
      await chain.mineAt(anchor - 1);
      await assert.rejects(() => gov.connect(dev).claimInitialWithdrawal.staticCall());
      const before = await chain.balance(dev.address);
      await chain.rpc("evm_setNextBlockTimestamp", [anchor]);
      await (await gov.connect(dev).claimInitialWithdrawal({ gasLimit: 500000 })).wait();
      // Developer pays gas for this direct claim.
      assert.equal(await gov.initialWithdrawalClaimed(), true);
      assert.equal(await vault.availableFunds(), eth("21.375"));
    });
  });

  test("front-running initialization or direct callbacks cannot steal the official pool or funds", async () => {
    await fixture({}, async (chain, f) => {
      const q = await f.coordinator.quote(eth("57"));
      await assert.rejects(() => f.manager.initialize(f.key, q.sqrtPriceX96));
      await assert.rejects(() => f.hook.beforeInitialize(chain.signers[0].address, f.key, q.sqrtPriceX96));
      await assert.rejects(() => f.hook.unlockCallback("0x"));
      await fundAndLaunch(chain, f);
      await assert.rejects(() => f.locker.initialize({ value: eth("27.93") }));
      await assert.rejects(() => f.locker.unlockCallback("0x"));
      await assert.rejects(() => f.token.registerLocker(chain.signers[2].address));
      await assert.rejects(() => f.token.creditEntitlement(chain.signers[2].address, eth("1")));
      await assert.rejects(() => f.token.launch());
      await assert.rejects(() => f.hook.register(f.key, f.locker.target, f.gov.target, q.sqrtPriceX96));
    });
  });

  test("all four full-fill swap modes charge native ETH; fees split 40/30/30 independently of LP fees", async () => {
    await fixture({}, async (chain, f) => {
      await fundAndLaunch(chain, f);
      await claim(chain, f);
      const alice = chain.signers[2];
      for (const [zeroForOne, amount, value] of [
        [true, -eth("1"), eth("1")], [true, eth("1000"), eth("1")],
        [false, -eth("1000"), 0n], [false, eth("0.01"), 0n],
      ]) {
        const trade = await swap(f, alice, zeroForOne, amount, { value });
        const fees = trade.receipt.logs.map(log => { try { return f.hook.interface.parseLog(log); } catch { return null; } })
          .filter(log => log?.name === "FeesAccrued");
        assert.equal(fees.length, 1);
        const fee = fees[0].args;
        let expected;
        if (zeroForOne && amount < 0n) expected = -amount * 100n / 10000n;
        else if (!zeroForOne && amount > 0n) expected = (amount * 100n + 9899n) / 9900n;
        else if (zeroForOne) expected = ((-trade.ethDelta - fee.ethFee) * 100n + 9899n) / 9900n;
        else expected = (trade.ethDelta + fee.ethFee) / 100n;
        assert.equal(fee.ethFee, expected);
        assert.equal(fee.devPart, fee.ethFee * 40n / 100n);
        assert.equal(fee.rewardsPart, fee.ethFee * 30n / 100n);
        assert.equal(fee.platformPart, fee.ethFee - fee.devPart - fee.rewardsPart);
        assert.equal(fee.poolId, f.poolId);
        if (amount > 0n) assert.equal(zeroForOne ? trade.tokenDelta : trade.ethDelta, amount);
        else assert.equal(zeroForOne ? trade.ethDelta : trade.tokenDelta, amount);
      }
      const pending = await f.hook.projects(f.poolId), platformFee = await f.hook.platformAccrued();
      assert.equal(await f.manager.balanceOf(f.hook.target, 0), pending.devAccrued + pending.rewardsAccrued + platformFee);
      const devBefore = await chain.balance(chain.signers[1].address);
      await (await f.hook.connect(alice).distribute(f.poolId)).wait();
      assert.equal(await f.devVault.availableFunds(), eth("28.5") + pending.devAccrued);
      assert.equal(await f.insurance.availableFunds(), 0n);
      const rewards = new Contract(await f.token.feeRewards(), artifact("ProjectFeeRewards").abi, alice);
      assert.equal(await rewards.queuedFunds(), pending.rewardsAccrued);
      assert.equal(await chain.balance(chain.signers[1].address), devBefore);
      const recipient = chain.signers[5], before = await chain.balance(recipient.address);
      await (await f.hook.claimPlatform(recipient.address)).wait();
      assert.equal(await chain.balance(recipient.address) - before, platformFee);
      assert.equal(await f.manager.balanceOf(f.hook.target, 0), 0n);
      await assert.rejects(() => f.hook.claimPlatform(recipient.address));
    });
  });

  test("ETH-specified partial fills revert atomically; token-specified partial fills charge actual ETH", async () => {
    await fixture({}, async (chain, f) => {
      await fundAndLaunch(chain, f);
      await claim(chain, f);
      const alice = chain.signers[2], price = (await f.router.poolState(f.key))[0];
      const narrowLimit = price - price / 100000n;
      const ethBefore = await chain.balance(f.manager.target), tokensBefore = await f.token.balanceOf(f.manager.target);
      await assert.rejects(() => swap(f, alice, true, -eth("1"), { value: eth("1"), priceLimit: narrowLimit }));
      assert.equal((await f.router.poolState(f.key))[0], price);
      assert.equal(await chain.balance(f.manager.target), ethBefore);
      assert.equal(await f.token.balanceOf(f.manager.target), tokensBefore);
      assert.equal(await f.hook.platformAccrued(), 0n);
      const trade = await swap(f, alice, true, eth("1000000"), { value: eth("1"), priceLimit: narrowLimit });
      assert.ok(trade.tokenDelta > 0n && trade.tokenDelta < eth("1000000"));
      assert.ok(-trade.ethDelta < eth("0.01"));
      assert.ok(await f.hook.platformAccrued() > 0n);
    });
  });

  test("official LP cannot be removed through locker ABI; LP fees can be collected without reducing liquidity", async () => {
    await fixture({}, async (chain, f) => {
      await fundAndLaunch(chain, f);
      await claim(chain, f);
      const alice = chain.signers[2];
      await swap(f, alice, true, -eth("1"), { value: eth("1") });
      await swap(f, alice, false, -eth("1000"));
      const liquidity = await f.locker.positionLiquidity(), balance = await f.devVault.availableFunds();
      await (await f.locker.connect(alice).collectFees()).wait();
      assert.equal(await f.locker.positionLiquidity(), liquidity);
      assert.ok(await f.devVault.availableFunds() > balance);
      assert.ok(await f.locker.totalTokenFeesBurned() > 0n);
      // This selector is deliberately absent; there is no arbitrary-call fallback.
      const removeSelector = id("withdraw(uint256)").slice(0, 10) + (1n).toString(16).padStart(64, "0");
      await assert.rejects(() => alice.sendTransaction({ to: f.locker.target, data: removeSelector }));
      await assert.rejects(() => f.router.modify(f.key, [-887220, 887220, -liquidity, ZeroHash]));
      assert.equal(await f.locker.positionLiquidity(), liquidity);
    });
  });

  test("personal liquidity positions remain removable and cannot remove the official position", async () => {
    await fixture({}, async (chain, f) => {
      await fundAndLaunch(chain, f);
      await claim(chain, f);
      const official = await f.locker.positionLiquidity(), personal = official / 10000n;
      await (await f.router.connect(chain.signers[2]).modify(f.key, [-887220, 887220, personal, id("personal")], { value: eth("1") })).wait();
      await (await f.router.connect(chain.signers[2]).modify(f.key, [-887220, 887220, -personal, id("personal")])).wait();
      assert.equal(await f.locker.positionLiquidity(), official);
    });
  });

  test("all subscribers can vote after launch; transfers cannot duplicate historical votes", async () => {
    await fixture({}, async (chain, f) => {
      await fundAndLaunch(chain, f);
      const [, dev, alice, bob] = chain.signers;
      await chain.mineAt(Number(await f.gov.anchor()));
      await (await f.gov.connect(dev).claimInitialWithdrawal()).wait();
      await chain.mineAt(Number(await f.gov.anchor()) + 7 * DAY);
      await (await f.gov.connect(dev).requestWithdrawal(id("progress"), "ipfs://progress")).wait();
      const info = await f.gov.withdrawals(1);
      const supply = await f.project.SALE_SUPPLY();
      assert.equal(info.totalPower, supply);
      await (await f.gov.connect(bob).objectToWithdrawal(1)).wait();
      await (await f.gov.connect(alice).objectToWithdrawal(1)).wait();
      await (await f.token.connect(alice).transfer(dev.address, supply * 15n / 26n)).wait();
      await assert.rejects(() => f.gov.connect(dev).objectToWithdrawal(1));
      await chain.mineAt(info.endsAt);
      assert.equal(await f.gov.withdrawalState(1), 2n);
      await assert.rejects(() => f.gov.executeWithdrawal(1));
      assert.equal(await f.devVault.availableFunds(), eth("21.375"));
      assert.equal(await f.token.publicPower(), info.totalPower);
      assert.equal(await f.token.unclaimed(bob.address), 0n);
    });
  });

  test("termination preserves old dev fees for settlement; reward fees continue at 70/30", async () => {
    await fixture({}, async (chain, f) => {
      await fundAndLaunch(chain, f);
      await claim(chain, f);
      const alice = chain.signers[2], bob = chain.signers[3];
      await swap(f, alice, true, -eth("1"), { value: eth("1") });
      const pending = await f.hook.projects(f.poolId);
      await (await f.gov.connect(alice).proposeTermination(id("stop"), "ipfs://stop")).wait();
      await (await f.gov.connect(alice).voteToTerminate(1)).wait();
      await (await f.gov.connect(bob).voteToTerminate(1)).wait();
      assert.equal(await f.gov.terminated(), true);
      await (await f.hook.distribute(f.poolId)).wait();
      const reserve = pending.devAccrued;
      const rewards = new Contract(await f.token.feeRewards(), artifact("ProjectFeeRewards").abi, alice);
      assert.equal(await rewards.queuedFunds(), pending.rewardsAccrued);
      assert.equal((await f.hook.projects(f.poolId)).settlementReserve, 0n);
      assert.equal(await chain.balance(await f.gov.settlement()), eth("28.5") + reserve);
      assert.equal(await chain.balance(f.hook.target), 0n);
      const beforePlatform = await f.hook.platformAccrued();
      const postTrade = await swap(f, alice, false, -eth("1000"));
      const fee = postTrade.receipt.logs.map(log => { try { return f.hook.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === "FeesAccrued").args;
      assert.equal(fee.devPart, 0n);
      assert.equal(fee.rewardsPart, fee.ethFee * 70n / 100n);
      assert.equal(await f.hook.platformAccrued() - beforePlatform, fee.ethFee - fee.rewardsPart);
      assert.equal((await f.hook.projects(f.poolId)).devAccrued, 0n);
      assert.equal((await f.hook.projects(f.poolId)).rewardsAccrued, fee.rewardsPart);
      await (await f.hook.distribute(f.poolId)).wait();
      assert.equal(await rewards.queuedFunds(), pending.rewardsAccrued + fee.rewardsPart);
      assert.equal(await chain.balance(await f.gov.settlement()), eth("28.5") + reserve);
      // Existing and new holder fees remain claimable after termination. They do
      // not enter compensation or become withdrawable by the developer.
      await assert.rejects(() => rewards.connect(chain.signers[1]).deposit.staticCall({value:1n}));
      await assert.rejects(() => rewards.connect(chain.signers[1]).depositFees.staticCall({value:1n}));
      await chain.mineAt(Number(await rewards.nextRoundAt()));
      for (let i=0;i<10;i++) {
        await (await rewards.process(1500000,{gasLimit:1700000})).wait();
        if ((await rewards.currentRound()).phase === 0n) break;
      }
      const owed = await rewards.claimable(alice.address);
      assert.ok(owed > 0n);
      const recipient = chain.signers[5], before = await chain.balance(recipient.address);
      await (await rewards.connect(alice).claimTo(recipient.address)).wait();
      assert.equal(await chain.balance(recipient.address)-before,owed);
      assert.equal(await chain.balance(rewards.target),await rewards.accountedFunds());
      const liquidity = await f.locker.positionLiquidity();
      await (await f.locker.collectFees()).wait();
      assert.equal(await f.locker.positionLiquidity(), liquidity);
      assert.ok(await f.locker.settlementEthFees() > 0n);
      assert.equal(await f.devVault.availableFunds(), 0n);
    });
  });
});

describe("Fee configuration and project snapshots", {concurrency: false}, () => {
  const TOTAL=eth('100000000'), RESERVE=TOTAL/20n;
  const fields=q=>['saleSupply','sqrtPriceX96','liquidity','ethAmount','tokenAmount','lockedTokenRemainder'].map(k=>q[k]);

  test('migration fees start at 1%, can move within 0–1%, and preserve exact ETH and supply at allowed rates',async()=>{
   const c=await createLocalChain();
   try{
    const f=await deployV4Fixture(c,{withProject:false});
    assert.equal(await f.coordinator.migrationFeeBps(),100n);
    assert.equal(await f.coordinator.migrationFeeAuthority(),c.signers[0].address);
    await assert.rejects(()=>f.coordinator.connect(c.signers[2]).setMigrationFeeBps.staticCall(50));
    for(const rate of [0n,1n,50n,99n,100n,50n,100n,0n]){
     await tx(f.coordinator.setMigrationFeeBps(rate));
     assert.equal(await f.coordinator.migrationFeeBps(),rate);
     for(const target of [eth('1'),eth('1')+2n,eth('57'),eth('1000000')]){
      const q=await f.coordinator.quote(target);
      assert.equal(q.ethAmount,target/2n-target*rate/10000n);
      assert.equal(q.saleSupply%26n,0n);
      assert.equal(q.saleSupply+q.tokenAmount+q.lockedTokenRemainder+RESERVE,TOTAL);
      assert.deepEqual(fields(q),fields(await f.coordinator.quoteForFee(target,rate)));
      assert.equal(await f.coordinator.saleSupply(target),q.saleSupply);
      const numerator=q.saleSupply*10n*(1n<<192n),denominator=target*13n;
      assert.ok(q.sqrtPriceX96**2n*denominator<=numerator);
      assert.ok((q.sqrtPriceX96+1n)**2n*denominator>numerator);
     }
    }
    for(const invalid of [101n,1000n,4999n,5000n,10000n,(1n<<256n)-1n]){
     await assert.rejects(()=>f.coordinator.setMigrationFeeBps.staticCall(invalid),error=>error.revert?.name==='InvalidMigrationFee');
     await assert.rejects(()=>tx(f.coordinator.setMigrationFeeBps(invalid,{gasLimit:100000})));
     await assert.rejects(()=>f.coordinator.quoteForFee(eth('57'),invalid));
    }
    assert.equal(await f.coordinator.migrationFeeBps(),0n);
   }finally{await c.close();}
  });

  test('Timelock fee changes preserve funding and awaiting-migration snapshots while new projects use the new rate',async()=>{
   const c=await createLocalChain();
   try{
    const [owner,creator,alice,bob,validator]=c.signers;
    const manager=await c.deploy('PoolManager',[owner.address]);
    const s=await deployUpgradeableSuite({signer:owner,manager:manager.target,platform:owner.address,proposer:owner.address,validators:[validator.address]});
    assert.equal(await s.coordinator.migrationFeeAuthority(),s.timelock.target);
    assert.equal(await s.coordinator.migrationFeeBps(),100n);
    // A queued rate may increase the default again, provided it stays at or below 1%.
    const oldRateData=s.coordinator.interface.encodeFunctionData('setMigrationFeeBps',[100]);
    const oldRateArgs=[s.coordinator.target,0,oldRateData,ZeroHash,id('queued old migration rate')];
    await tx(s.timelock.schedule(...oldRateArgs,172800));
    const a=await c.createProject(s.factory),q100=await s.coordinator.quote(eth('57'));
    await tx(a.connect(alice).contribute(0,{value:eth('28.5'),gasLimit:600000}));
    const before=await a.contributions(alice.address),nextQuote=await a.quoteContribution(eth('14.25'));
    async function setFee(rate){
     await assert.rejects(()=>s.coordinator.setMigrationFeeBps.staticCall(rate));
     await assert.rejects(()=>s.coordinator.connect(creator).setMigrationFeeBps.staticCall(rate));
     const data=s.coordinator.interface.encodeFunctionData('setMigrationFeeBps',[rate]),salt=id('migration fee '+rate);
     const args=[s.coordinator.target,0,data,ZeroHash,salt];
     await tx(s.timelock.schedule(...args,172800));
     await assert.rejects(()=>s.timelock.execute.staticCall(...args));
     await c.mineAt(await c.timestamp()+172800);
     const receipt=await tx(s.timelock.execute(...args));
     const changed=receipt.logs.map(l=>{try{return s.coordinator.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='MigrationFeeChanged');
     assert.equal(changed.args.newBps,BigInt(rate));
    }
    await setFee(50);
    assert.equal(await a.migrationFeeBps(),100n);
    assert.equal(await a.SALE_SUPPLY(),q100.saleSupply);
    assert.deepEqual(Array.from(await a.contributions(alice.address)),Array.from(before));
    assert.deepEqual(Array.from(await a.quoteContribution(eth('14.25'))),Array.from(nextQuote));
    const b=await c.createProject(s.factory),q50=await s.coordinator.quote(eth('57'));
    assert.equal(await b.migrationFeeBps(),50n);
    assert.equal(await b.SALE_SUPPLY(),q50.saleSupply);
    assert.notEqual(q100.saleSupply,q50.saleSupply);
    await tx(s.timelock.execute(...oldRateArgs));
    assert.equal(await s.coordinator.migrationFeeBps(),100n);
    assert.equal(await b.migrationFeeBps(),50n);
    // Funding and migration are separate; fee changes must not change snapshots.
    await tx(a.connect(bob).contribute(0,{value:eth('28.5'),gasLimit:600000}));
    await tx(b.connect(alice).contribute(0,{value:eth('57'),gasLimit:600000}));
    assert.equal(await a.state(),1n);assert.equal(await b.state(),1n);
    await setFee(0);
    const zero=await c.createProject(s.factory),q0=await s.coordinator.quote(eth('57'));
    assert.equal(await zero.migrationFeeBps(),0n);
    let expectedFees=0n,expectedPoolETH=0n;
    for(const [p,rate,q] of [[a,100n,q100],[b,50n,q50],[zero,0n,q0]]){
     if(p===zero)await tx(p.connect(alice).contribute(0,{value:eth('57'),gasLimit:16000000}));
     await tx(p.connect(bob).migrate({gasLimit:16000000}));
     assert.equal(await p.state(),3n);assert.equal(await p.migrationFeeBps(),rate);
     const locker=new Contract(await p.liquidityLocker(),artifact('PermanentLiquidityLocker').abi,owner);
     assert.equal(await locker.migrationFeeBps(),rate);
     const finalQuote=await locker.initialQuote();
     assert.equal(finalQuote.saleSupply,q.saleSupply);
     assert.equal(finalQuote.sqrtPriceX96,q.sqrtPriceX96);
     assert.equal(finalQuote.ethAmount,q.ethAmount-await p.migrationGasRefund());
     assert.equal(await locker.positionLiquidity(),finalQuote.liquidity);
     const token=new Contract(await p.token(),artifact('ProjectToken').abi,owner);
     assert.equal(await token.balanceOf(manager.target),finalQuote.tokenAmount);
     assert.equal(await token.balanceOf(p.target),RESERVE);
     assert.equal(await token.totalSupply(),TOTAL-finalQuote.lockedTokenRemainder);
     const gov=new Contract(await p.governance(),artifact('ProjectGovernance').abi,owner);
     const vault=new Contract(await gov.devVault(),artifact('ProjectVault').abi,owner);
     assert.equal(await vault.availableFunds(),eth('28.5'));
     assert.equal(await c.balance(p.target),0n);
     expectedFees+=eth('57')*rate/10000n;expectedPoolETH+=finalQuote.ethAmount;
     assert.equal(await s.factory.accruedMigrationFees(),expectedFees);
     assert.equal(await s.factory.migrationFeeRecorded(p.target),true);
     assert.equal(await c.balance(manager.target),expectedPoolETH);
     for(const who of [alice,bob]){
      const entry=await p.contributions(who.address);
      if(entry.tokenUnits===0n)continue;
      assert.equal(await token.balanceOf(who.address),entry.tokenUnits);
     }
     assert.equal(await p.claimedTokenUnits(),q.saleSupply);
     assert.equal(await token.balanceOf(p.target),RESERVE);
    }
    assert.equal(await s.coordinator.migrationFeeBps(),0n);
    const restoreData=s.coordinator.interface.encodeFunctionData('setMigrationFeeBps',[1]);
    const restoreArgs=[s.coordinator.target,0,restoreData,ZeroHash,id('restore fee within 1 percent')];
    await tx(s.timelock.schedule(...restoreArgs,172800));
    await c.mineAt(await c.timestamp()+172800);
    await tx(s.timelock.execute(...restoreArgs));
    assert.equal(await s.coordinator.migrationFeeBps(),1n);
    assert.equal(await zero.migrationFeeBps(),0n);
    const invalidData=s.coordinator.interface.encodeFunctionData('setMigrationFeeBps',[101]);
    const invalidArgs=[s.coordinator.target,0,invalidData,ZeroHash,id('fee above hard 1 percent ceiling')];
    await tx(s.timelock.schedule(...invalidArgs,172800));
    await c.mineAt(await c.timestamp()+172800);
    await assert.rejects(()=>s.timelock.execute.staticCall(...invalidArgs));
    await assert.rejects(()=>tx(s.timelock.execute(...invalidArgs,{gasLimit:200000})));
    assert.equal(await s.coordinator.migrationFeeBps(),1n);
    await assert.rejects(()=>s.factory.depositMigrationFee.staticCall(zero.target));
    await assert.rejects(()=>s.coordinator.configureUpgradeServices.staticCall(s.rewardsDeployer.target,s.hook.target,s.feePolicy.target));
   }finally{await c.close();}
  });
});
