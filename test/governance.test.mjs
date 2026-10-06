import {describe, afterEach, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {Contract, id, parseEther, ZeroAddress, ZeroHash, MaxUint256, Wallet, parseEther as eth} from 'ethers';
import {artifact, createLocalChain} from '../scripts/local-chain.mjs';
import {tx, withLocalChain} from './helpers.mjs';

describe("Base onchain voting", {concurrency: false}, () => {
  const HOUR = 3600, DAY = 86400, WEEK = 7 * DAY;
  const hash = id("project progress v1"), uri = "ipfs://project-progress-v1";
  const eth = parseEther;
  const S = { None: 0n, Voting: 1n, Rejected: 2n, Approved: 3n, Expired: 4n, Executed: 5n, Cancelled: 6n };
  let chain, platform, dev, alice, bob, carol, small, token, gov, treasury, insurance, anchor;

  beforeEach(async () => {
    chain = await createLocalChain();
    [platform, dev, alice, bob, carol, small] = chain.signers;
    // 60,000 indivisible test units; minimum proposal/objection weight is exactly 3.
    token = await chain.deploy("MockVotingToken", [
      [alice.address, bob.address, carol.address, small.address], [30000n, 20000n, 9997n, 3n],
    ]);
    gov = await chain.deploy("ProjectGovernance", [dev.address, token.target]);
    treasury = new Contract(await gov.devVault(), artifact("ProjectVault").abi, platform);
    insurance = new Contract(await gov.insuranceVault(), artifact("ProjectVault").abi, platform);
    anchor = Number(await gov.anchor()) + WEEK;
    await (await treasury.deposit({ value: eth("40") })).wait();
    await (await insurance.deposit({ value: eth("6") })).wait();
    await chain.rpc("evm_setNextBlockTimestamp", [anchor - WEEK]);
    await (await gov.connect(dev).claimInitialWithdrawal({gasLimit:500000})).wait();
    await (await treasury.deposit({ value: eth("10") })).wait();
  });
  afterEach(async () => { await chain?.close(); });

  async function expectError(contract, name, action) {
    const selector = contract.interface.getError(name).selector.toLowerCase();
    await assert.rejects(action, error => {
      const serialized = JSON.stringify(error, (_, value) => typeof value === "bigint" ? value.toString() : value);
      assert.ok(serialized.toLowerCase().includes(selector) || String(error).includes(name), String(error));
      return true;
    });
  }
  async function request(at) {
    if (at !== undefined) await chain.rpc("evm_setNextBlockTimestamp", [Number(at)]);
    await (await gov.connect(dev).requestWithdrawal(hash, uri, { gasLimit: 1_000_000 })).wait();
    return await gov.withdrawalCount();
  }
  async function atRequestEnd(requestId) { await chain.mineAt(Number((await gov.withdrawals(requestId)).endsAt)); }
  async function propose(signer = alice) {
    await (await gov.connect(signer).proposeTermination(hash, uri)).wait();
    return await gov.terminationCount();
  }
  async function vote(signer, proposal = 1n) { await (await gov.connect(signer).voteToTerminate(proposal)).wait(); }

  test("vaults have only governance authority and separately account funds", async () => {
    assert.notEqual(treasury.target, insurance.target);
    assert.equal(await treasury.controller(), gov.target);
    assert.equal(await insurance.controller(), gov.target);
    for (const signer of [platform, dev, alice]) {
      await expectError(treasury, "Unauthorized", () => treasury.connect(signer).release.staticCall(signer.address, 1n));
      await expectError(insurance, "Unauthorized", () => insurance.connect(signer).release.staticCall(signer.address, 1n));
      await expectError(insurance, "Unauthorized", () => insurance.connect(signer).seal.staticCall());
    }
    assert.equal(await treasury.availableFunds(), eth("40"));
    assert.equal(await insurance.availableFunds(), eth("6"));
    await assert.rejects(() => platform.sendTransaction({ to: gov.target, value: 1n }));
    await expectError(treasury, "InvalidAmount", () => treasury.deposit.staticCall({ value: 0n }));
  });

  test("weekly requests require the initial claim, developer authority and disclosure", async () => {
    await expectError(gov, "Unauthorized", () => gov.requestWithdrawal.staticCall(hash, uri));
    await expectError(gov, "TooEarly", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await chain.mineAt(anchor - 1);
    await expectError(gov, "TooEarly", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await expectError(gov, "InvalidDisclosure", () => gov.connect(dev).requestWithdrawal.staticCall(ZeroHash, uri));
    const r = await request(anchor);
    assert.equal((await gov.withdrawals(r)).endsAt, BigInt(anchor + 12 * HOUR));
    await atRequestEnd(r);
    await (await gov.executeWithdrawal(r)).wait();
    assert.equal(await treasury.availableFunds(), eth("30"));
    await expectError(gov, "NotExecutable", () => gov.connect(dev).claimInitialWithdrawal.staticCall());
    await expectError(gov, "CycleAlreadyPaid", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
  });

  test("withdrawal pays a quarter of execution-time balance including subsequent deposits", async () => {
    const r = await request(anchor);
    await (await treasury.deposit({ value: eth("8") })).wait();
    await atRequestEnd(r);
    const before = await chain.balance(dev.address);
    await (await gov.connect(bob).executeWithdrawal(r)).wait();
    assert.equal(await chain.balance(dev.address) - before, eth("12"));
    assert.equal(await treasury.availableFunds(), eth("36"));
    assert.equal(await treasury.totalDeposited(), eth("58"));
    assert.equal(await treasury.totalReleased(), eth("22"));
  });

  test("exactly half rejects; the only request is consumed even after cooldown", async () => {
    const r = await request(anchor);
    await (await gov.connect(alice).objectToWithdrawal(r)).wait();
    await expectError(gov, "AlreadyVoted", () => gov.connect(alice).objectToWithdrawal.staticCall(r));
    const end = Number((await gov.withdrawals(r)).endsAt);
    assert.equal(end, anchor + 12 * HOUR);
    await chain.mineAt(end);
    assert.equal(await gov.withdrawalState(r), S.Rejected);
    await expectError(gov, "NotExecutable", () => gov.executeWithdrawal.staticCall(r));
    await expectError(gov, "InvalidRequest", () => gov.connect(bob).objectToWithdrawal.staticCall(r));
    await chain.mineAt(end + DAY - 1);
    await expectError(gov, "CooldownActive", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await chain.mineAt(end + DAY);
    await expectError(gov, "AttemptsExhausted", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    assert.equal(await gov.cycleAttempts(1), 1n);
    assert.equal(await treasury.availableFunds(), eth("40"));
  });

  test("less than half allows withdrawal and nonvoters remain in denominator", async () => {
    const r = await request(anchor);
    await (await gov.connect(bob).objectToWithdrawal(r)).wait();
    await (await gov.connect(carol).objectToWithdrawal(r)).wait();
    assert.equal((await gov.withdrawals(r)).objections, 29997n);
    await atRequestEnd(r);
    await (await gov.executeWithdrawal(r)).wait();
    assert.equal(await gov.withdrawalState(r), S.Executed);
  });

  test("0.005% objections and 0.5% proposals are inclusive; small holders may support termination", async () => {
    assert.equal(await gov.minimumPower(), 3n);
    assert.equal(await gov.minimumTerminationPower(), 300n);
    const r = await request(anchor);
    await (await gov.connect(small).objectToWithdrawal(r)).wait();
    assert.equal((await gov.withdrawals(r)).objections, 3n);
    await expectError(gov, "InsufficientPower", () => gov.connect(small).proposeTermination.staticCall(hash, uri));
    await (await token.connect(alice).transfer(small.address, 297n)).wait();
    await propose(small);
    // New deployment isolates a new proposal snapshot after transfer.
    await (await token.connect(small).transfer(dev.address, 298n)).wait();
    const other = await chain.deploy("ProjectGovernance", [dev.address, token.target]);
    await expectError(other, "InsufficientPower", () => other.connect(small).proposeTermination.staticCall(hash, uri));
    await (await other.connect(alice).proposeTermination(hash, uri)).wait();
    await (await other.connect(small).voteToTerminate(1)).wait();
    assert.equal((await other.terminations(1)).yesPower, 2n);
    await prepareWeekly(other);
    await (await other.connect(dev).requestWithdrawal(hash, uri)).wait();
    await expectError(other, "InsufficientPower", () => other.connect(small).objectToWithdrawal.staticCall(1));
  });

  test("past balances stop transfer-based double voting and historical base survives burns", async () => {
    const r = await request(anchor);
    await propose();
    await (await gov.connect(bob).objectToWithdrawal(r)).wait();
    await vote(bob);
    await (await token.connect(bob).transfer(dev.address, 20000n)).wait();
    await expectError(gov, "InsufficientPower", () => gov.connect(dev).objectToWithdrawal.staticCall(r));
    await expectError(gov, "InsufficientPower", () => gov.connect(dev).voteToTerminate.staticCall(1));
    await (await token.connect(alice).burn(30000n)).wait();
    assert.equal(await token.totalSupply(), 30000n);
    assert.equal((await gov.withdrawals(r)).totalPower, 60000n);
    assert.equal((await gov.terminations(1)).totalPower, 60000n);
    await (await gov.connect(alice).objectToWithdrawal(r)).wait();
    assert.equal((await gov.withdrawals(r)).objections, 50000n);
  });

  test("a rejected weekly request retains the exact 24h cooldown across cycles", async () => {
    const cycleEnd = anchor + WEEK;
    const r = await request(cycleEnd - 13 * HOUR);
    await (await gov.connect(alice).objectToWithdrawal(r)).wait();
    const voteEnd = Number((await gov.withdrawals(r)).endsAt);
    await atRequestEnd(r);
    assert.equal(await gov.cycleAttempts(1), 1n);
    await chain.mineAt(cycleEnd);
    await expectError(gov, "CooldownActive", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await chain.mineAt(voteEnd + DAY - 1);
    await expectError(gov, "CooldownActive", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await request(voteEnd + DAY);
    assert.equal(await gov.cycleAttempts(2), 1n);
  });

  test("second request is rejected in the same week; a new week restores one request", async () => {
    assert.equal(await gov.MAX_ATTEMPTS(), 1n);
    assert.equal(await gov.VOTE_DURATION(), 12n * BigInt(HOUR));
    const r = await request(anchor);
    await (await gov.connect(alice).objectToWithdrawal(r)).wait();
    await chain.mineAt(Number((await gov.withdrawals(r)).endsAt) + DAY);
    await expectError(gov, "AttemptsExhausted", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await request(anchor + WEEK);
    assert.equal(await gov.cycleAttempts(1), 1n);
    assert.equal(await gov.cycleAttempts(2), 1n);
  });

  test("an impossible next-week execution window does not consume the only attempt", async () => {
    const r1 = await request(anchor + WEEK - 14 * HOUR);
    await atRequestEnd(r1);
    await (await gov.executeWithdrawal(r1)).wait();
    const last = Number(await gov.lastSuccessfulWithdrawal());
    await chain.mineAt(anchor + WEEK);
    await expectError(gov, "WindowClosed", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    assert.equal(await gov.cycleAttempts(2), 0n);
    const r3 = await request(last + WEEK - 12 * HOUR);
    await atRequestEnd(r3);
    await (await gov.executeWithdrawal(r3)).wait();
    assert.ok(await gov.lastSuccessfulWithdrawal() >= BigInt(last + WEEK));
    assert.equal(await treasury.availableFunds(), eth("22.5"));
  });

  test("one request per week can execute at the exact seven-day boundary with no objections", async () => {
    const r1 = await request(anchor);
    const end = Number((await gov.withdrawals(r1)).endsAt);
    await chain.rpc("evm_setNextBlockTimestamp", [end]);
    await (await gov.executeWithdrawal(r1, { gasLimit: 500000 })).wait();
    const r2 = await request(anchor + WEEK);
    await chain.mineAt(end + WEEK - 1);
    await expectError(gov, "NotExecutable", () => gov.executeWithdrawal.staticCall(r2));
    await chain.rpc("evm_setNextBlockTimestamp", [end + WEEK]);
    await (await gov.executeWithdrawal(r2, { gasLimit: 500000 })).wait();
    assert.equal(await gov.lastSuccessfulWithdrawal(), BigInt(end + WEEK));
    assert.equal(await treasury.availableFunds(), eth("22.5"));
  });

  test("approval expires at 24h or cycle end; exactly 12h before cycle end leaves no execution window", async () => {
    const r = await request(anchor);
    const info = await gov.withdrawals(r);
    assert.equal(info.expiresAt - info.endsAt, BigInt(DAY));
    await chain.mineAt(Number(info.expiresAt));
    assert.equal(await gov.withdrawalState(r), S.Expired);
    await expectError(gov, "NotExecutable", () => gov.executeWithdrawal.staticCall(r));
    await expectError(gov, "AttemptsExhausted", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    const r2 = await request(anchor + 2 * WEEK - 13 * HOUR);
    assert.equal((await gov.withdrawals(r2)).expiresAt, BigInt(anchor + 2 * WEEK));
    await chain.mineAt(anchor + 2 * WEEK);
    assert.equal(await gov.withdrawalState(r2), S.Expired);
    await chain.mineAt(anchor + 3 * WEEK - 12 * HOUR);
    await expectError(gov, "WindowClosed", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
  });

  test("cancellation consumes an attempt and starts 24h cooldown; disclosures are append-only", async () => {
    const r = await request(anchor);
    await (await gov.connect(dev).supplementWithdrawal(r, id("v2"), "ipfs://v2")).wait();
    assert.equal(await gov.withdrawalDisclosure(r), hash);
    assert.equal(await gov.disclosureVersions(r), 2n);
    await expectError(gov, "RequestPending", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await (await gov.connect(dev).cancelWithdrawal(r)).wait();
    assert.equal(await gov.withdrawalState(r), S.Cancelled);
    await expectError(gov, "CooldownActive", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await chain.mineAt(Number(await gov.cancellationCooldownUntil()));
    await expectError(gov, "AttemptsExhausted", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    assert.equal(await gov.cycleAttempts(1), 1n);
    await request(anchor + WEEK);
    assert.equal(await gov.cycleAttempts(2), 1n);
  });

  test("zero initial quarter does not consume the privilege; deposits allow retry", async () => {
    const other = await chain.deploy("ProjectGovernance", [dev.address, token.target]);
    const vault = new Contract(await other.devVault(), artifact("ProjectVault").abi, platform);
    await (await vault.deposit({ value: 3n })).wait();
    await chain.mineAt(Number(await other.anchor()));
    await expectError(other, "NothingToWithdraw", () => other.connect(dev).claimInitialWithdrawal.staticCall());
    assert.equal(await other.initialWithdrawalClaimed(), false);
    assert.equal(await other.cyclePaid(0), false);
    assert.equal(await other.lastSuccessfulWithdrawal(), 0n);
    await (await vault.deposit({ value: 1n })).wait();
    await (await other.connect(dev).claimInitialWithdrawal()).wait();
    assert.equal(await vault.availableFunds(), 3n);
  });

  test("half termination weight freezes immediately, two thirds terminates and seals both vaults", async () => {
    const r = await request(anchor);
    await atRequestEnd(r);
    await propose();
    assert.equal(await gov.withdrawalsFrozen(), false);
    await vote(alice);
    assert.equal(await gov.withdrawalsFrozen(), true);
    assert.equal(await gov.terminated(), false);
    await expectError(gov, "WithdrawalsFrozen", () => gov.executeWithdrawal.staticCall(r));
    await vote(carol);
    assert.equal((await gov.terminations(1)).yesPower, 39997n);
    assert.equal(await gov.terminated(), false);
    await vote(small);
    assert.equal((await gov.terminations(1)).yesPower, 40000n);
    assert.equal(await gov.terminated(), true);
    assert.equal(await treasury.sealedForSettlement(), true);
    assert.equal(await insurance.sealedForSettlement(), true);
    assert.equal(await treasury.availableFunds(), 0n);
    assert.equal(await insurance.availableFunds(), 0n);
    assert.equal(await chain.balance(await gov.settlement()), eth("46"));
    await expectError(gov, "ProjectTerminated", () => gov.executeWithdrawal.staticCall(r));
    await expectError(gov, "ProjectTerminated", () => gov.connect(dev).requestWithdrawal.staticCall(hash, uri));
    await expectError(gov, "ProjectTerminated", () => gov.connect(bob).proposeTermination.staticCall(hash, uri));
    await expectError(treasury, "VaultSealed", () => treasury.deposit.staticCall({ value: 1n }));
    await expectError(insurance, "VaultSealed", () => insurance.deposit.staticCall({ value: 1n }));
  });

  test("expired termination votes stop; freeze lifts without finalize but stale approvals stay expired", async () => {
    await chain.mineAt(anchor - 10);
    const p = await propose();
    await vote(alice);
    await expectError(gov, "AlreadyVoted", () => gov.connect(alice).voteToTerminate.staticCall(p));
    await expectError(gov, "CooldownActive", () => gov.connect(bob).proposeTermination.staticCall(hash, uri));
    const r = await request(anchor);
    const end = Number((await gov.terminations(p)).endsAt);
    await chain.mineAt(end - 1);
    assert.equal(await gov.withdrawalsFrozen(), true);
    await chain.mineAt(end);
    assert.equal(await gov.withdrawalsFrozen(), false);
    await expectError(gov, "InvalidRequest", () => gov.connect(carol).voteToTerminate.staticCall(p));
    assert.equal(await gov.withdrawalState(r), S.Expired);
    await expectError(gov, "NotExecutable", () => gov.executeWithdrawal.staticCall(r));
    await chain.mineAt(end + WEEK - 1);
    await expectError(gov, "CooldownActive", () => gov.connect(bob).proposeTermination.staticCall(hash, uri));
    await chain.rpc("evm_setNextBlockTimestamp", [end + WEEK]);
    await (await gov.connect(bob).proposeTermination(hash, uri, { gasLimit: 500000 })).wait();
    assert.equal(await gov.terminationCount(), 2n);
    assert.equal((await gov.terminations(2)).yesPower, 0n);
  });

  test("failed termination releases a still-valid approved withdrawal without backend finalization", async () => {
    await chain.mineAt(anchor - 60);
    await propose();
    await vote(alice);
    const end = Number((await gov.terminations(1)).endsAt);
    const r = await request(end - 13 * HOUR);
    await atRequestEnd(r);
    await expectError(gov, "WithdrawalsFrozen", () => gov.executeWithdrawal.staticCall(r));
    await chain.rpc("evm_setNextBlockTimestamp", [end]);
    await (await gov.executeWithdrawal(r, { gasLimit: 500000 })).wait();
    assert.equal(await gov.withdrawalState(r), S.Executed);
  });

  test("rejecting dev recipient rolls back all accounting, then dev can replace its recipient", async () => {
    const receiver = await chain.deploy("WithdrawalReceiver");
    await (await receiver.configure(gov.target, 1n, true, false)).wait();
    await (await gov.connect(dev).setDevRecipient(receiver.target)).wait();
    await expectError(gov, "Unauthorized", () => gov.connect(alice).setDevRecipient.staticCall(alice.address));
    for (const address of [ZeroAddress, gov.target, treasury.target, insurance.target]) {
      await expectError(gov, "InvalidRecipient", () => gov.connect(dev).setDevRecipient.staticCall(address));
    }
    const r = await request(anchor);
    await atRequestEnd(r);
    await assert.rejects(async () => (await gov.executeWithdrawal(r, { gasLimit: 500000 })).wait());
    assert.equal(await gov.withdrawalState(r), S.Approved);
    assert.equal(await gov.cyclePaid(1), false);
    assert.equal(await gov.lastSuccessfulWithdrawal(), BigInt(anchor - WEEK));
    assert.equal(await treasury.availableFunds(), eth("40"));
    await (await gov.connect(dev).setDevRecipient(dev.address)).wait();
    await (await gov.executeWithdrawal(r)).wait();
    assert.equal(await treasury.availableFunds(), eth("30"));
  });

  test("reentrant execution cannot withdraw twice and forced ETH cannot enlarge the approved quarter", async () => {
    const receiver = await chain.deploy("WithdrawalReceiver");
    await (await receiver.configure(gov.target, 1n, false, true)).wait();
    await (await gov.connect(dev).setDevRecipient(receiver.target)).wait();
    await chain.deploy("ForceEther", [treasury.target], platform, { value: eth("4") });
    const r = await request(anchor);
    await atRequestEnd(r);
    await (await gov.executeWithdrawal(r)).wait();
    assert.equal(await chain.balance(receiver.target), eth("10"));
    assert.equal(await receiver.reentryAttempts(), 1n);
    assert.equal(await receiver.reentrySucceeded(), false);
    assert.equal(await treasury.availableFunds(), eth("30"));
    assert.equal(await treasury.unaccountedSurplus(), eth("4"));
    assert.equal(await chain.balance(treasury.target), eth("34"));
  });

  test("zero base, zero supply, EOA policy and inconsistent weights fail closed", async () => {
    await assert.rejects(() => chain.deploy("ProjectGovernance", [dev.address, alice.address]));
    const zeroSupply = await chain.deploy("BadVotingPolicy", [0n, 1n, 1n]);
    await assert.rejects(() => chain.deploy("ProjectGovernance", [dev.address, zeroSupply.target]));
    await assert.rejects(() => chain.deploy("ProjectGovernance", [ZeroAddress, token.target]));
    for (const [total, power] of [[0n, 1n], [60000n, 60001n]]) {
      const bad = await chain.deploy("BadVotingPolicy", [60000n, total, power]);
      const other = await chain.deploy("ProjectGovernance", [dev.address, bad.target]);
      await expectError(other, "InvalidVotingPower", () => other.connect(alice).proposeTermination.staticCall(hash, uri));
      await prepareWeekly(other);
      if (total === 0n) {
        await expectError(other, "InvalidVotingPower", () => other.connect(dev).requestWithdrawal.staticCall(hash, uri));
      } else {
        await (await other.connect(dev).requestWithdrawal(hash, uri)).wait();
        await expectError(other, "InvalidVotingPower", () => other.connect(alice).objectToWithdrawal.staticCall(1));
      }
    }
  });

  test("rounding up protects half and two-thirds thresholds even at maximum uint256", async () => {
    const weight = (MaxUint256 * 2n + 2n) / 3n;
    const policy = await chain.deploy("BadVotingPolicy", [MaxUint256, MaxUint256, weight]);
    const other = await chain.deploy("ProjectGovernance", [dev.address, policy.target]);
    await (await other.connect(alice).proposeTermination(hash, uri)).wait();
    await (await other.connect(alice).voteToTerminate(1)).wait();
    assert.equal(await other.terminated(), true);
    assert.equal(await other.minimumPower(), (MaxUint256 + 19999n) / 20000n);
  });

  test("fractional thresholds round up: 2/5 cannot reject, 3/5 freezes, only 4/5 terminates", async () => {
    for (const weight of [2n, 3n, 4n]) {
      const policy = await chain.deploy("BadVotingPolicy", [5n, 5n, weight]);
      const other = await chain.deploy("ProjectGovernance", [dev.address, policy.target]);
      await prepareWeekly(other);
      await (await other.connect(dev).requestWithdrawal(hash, uri)).wait();
      await (await other.connect(alice).objectToWithdrawal(1)).wait();
      await (await other.connect(alice).proposeTermination(hash, uri)).wait();
      await (await other.connect(alice).voteToTerminate(1)).wait();
      assert.equal(await other.withdrawalsFrozen(), weight >= 3n);
      assert.equal(await other.terminated(), weight >= 4n);
      await chain.mineAt(Number((await other.withdrawals(1)).endsAt));
      assert.equal(await other.withdrawalState(1), weight >= 3n ? S.Rejected : S.Approved);
    }
  });

  async function prepareWeekly(other) {
    const vault = new Contract(await other.devVault(), artifact("ProjectVault").abi, platform);
    await (await vault.deposit({value:4n})).wait();
    await chain.mineAt(Number(await other.anchor()));
    await (await other.connect(dev).claimInitialWithdrawal()).wait();
    await chain.mineAt(Number(await other.anchor()) + WEEK + 2);
  }
});

describe("Signed community ballots", {concurrency: false}, () => {
  const DAY=86400,WEEK=7*DAY,eth=parseEther;
  let chain,owner,dev,alice,bob,carol,small,token,gov,validator,vault,anchor;
  beforeEach(async()=>{
   chain=await createLocalChain();[owner,dev,alice,bob,carol,small]=chain.signers;validator=Wallet.createRandom();
   token=await chain.deploy('ProjectToken',[owner.address,owner.address,ZeroAddress]);
   const verifier=await chain.deploy('AllocationVerifier',[[validator.address],1]);
   gov=await chain.deploy('CommunityGovernance',[dev.address,token.target,verifier.target]);
   const rewards=await chain.deploy('ProjectFeeRewards',[token.target,gov.target,token.target]);
   await(await token.configureFeeRewards(rewards.target)).wait();
   await(await token.registerLocker(dev.address)).wait();await(await token.launch()).wait();
   for(const [who,n] of [[alice,'30000'],[bob,'20000'],[carol,'10000'],[small,'4999']])await(await token.transfer(who.address,eth(n))).wait();
   vault=new Contract(await gov.devVault(),artifact('ProjectVault').abi,owner);await(await vault.deposit({value:eth('40')})).wait();
   anchor=Number(await gov.anchor());await chain.mineAt(anchor);await(await gov.connect(dev).claimInitialWithdrawal()).wait();
  });
  afterEach(async()=>await chain?.close());
  async function propose(){await(await gov.connect(alice).proposeWithdrawalVeto(1,id('community progress'),'ipfs://evidence')).wait();return gov.proposalCount()}
  async function ballot(who,proposalId,support){const p=await gov.proposals(proposalId);return who.signTypedData({name:'OriginCommunityGovernance',version:'1',chainId:31337,verifyingContract:gov.target},{Ballot:[{name:'proposalId',type:'uint256'},{name:'snapshotHash',type:'bytes32'},{name:'voter',type:'address'},{name:'support',type:'uint8'}]},{proposalId,snapshotHash:p.snapshotHash,voter:who.address,support})}
  async function result(proposalId,who,support,forVotes,againstVotes=0n){const p=await gov.proposals(proposalId);const r={proposalId,forVotes,againstVotes,abstainVotes:0n,archiveHash:id('canonical public ballot archive'),cid:'bafypublicvote12345678901234567890',uploader:who.address,deadline:p.uploadEndsAt};const signature=validator.signingKey.sign(await gov.resultDigest(r)).serialized;return [r,support,await ballot(who,proposalId,support),[validator.address],[signature]]}
  test('eligible denominator tracks complete balances across the minimum, self transfers and burns; past totals stay fixed',async()=>{
   assert.equal(await token.minimumVotingBalance(),eth('5000'));assert.equal(await token.eligiblePower(),eth('60000'));
   const block=await chain.rpc('eth_blockNumber',[]);await(await token.transfer(small.address,eth('1'))).wait();
   assert.equal(await token.eligiblePower(),eth('65000'));assert.equal(await token.getPastEligiblePower(BigInt(block)),eth('60000'));
   await(await token.connect(small).transfer(owner.address,eth('1'))).wait();assert.equal(await token.eligiblePower(),eth('60000'));
   await(await token.connect(alice).transfer(alice.address,eth('20000'))).wait();assert.equal(await token.eligiblePower(),eth('60000'));
   await(await token.connect(carol).burn(eth('6000'))).wait();assert.equal(await token.eligiblePower(),eth('50000'));
  });
  test('default weekly withdrawals need no proposal and pay one quarter at execution, without duplicate or catch-up claims',async()=>{
   assert.equal(await vault.availableFunds(),eth('30'));await chain.mineAt(anchor+WEEK+1);
   await(await gov.connect(dev).claimWeeklyWithdrawal()).wait();assert.equal(await vault.availableFunds(),eth('22.5'));
   await assert.rejects(()=>gov.connect(dev).claimWeeklyWithdrawal.staticCall());
   await assert.rejects(()=>gov.connect(alice).claimWeeklyWithdrawal.staticCall());
   await chain.mineAt(anchor+4*WEEK);await(await gov.connect(dev).claimWeeklyWithdrawal()).wait();assert.equal(await vault.availableFunds(),eth('16.875'));
  });
  test('veto creation requires strictly more than 24h and only one proposal for the next slot',async()=>{
   await propose();await assert.rejects(()=>gov.connect(bob).proposeWithdrawalVeto.staticCall(1,id('again'),'ipfs://again'));
   await assert.rejects(()=>gov.connect(small).proposeWithdrawalVeto.staticCall(2,id('small'),'ipfs://small'));
   await chain.mineAt(anchor+WEEK-DAY);await assert.rejects(()=>gov.connect(bob).proposeWithdrawalVeto.staticCall(1,id('boundary'),'ipfs://boundary'));
  });
  test('only valid signatures and snapshot balances qualify; ordinary ballots make no transactions',async()=>{
   const n=await propose();const before=await chain.rpc('eth_blockNumber',[]);const sig=await ballot(alice,n,1);
   assert.equal(await gov.validBallot(n,alice.address,1,sig),true);assert.equal(await gov.validBallot(n,alice.address,0,sig),false);assert.equal(await gov.validBallot(n,bob.address,1,sig),false);
   assert.equal(await gov.validBallot(n,small.address,1,await ballot(small,n,1)),false);assert.equal(await chain.rpc('eth_blockNumber',[]),before);
   await assert.rejects(()=>gov.connect(alice).objectToWithdrawal.staticCall(n));await assert.rejects(()=>gov.connect(alice).voteToTerminate.staticCall(n));
  });
  test('results cannot upload early, be tampered with or be submitted by another wallet; exactly half vetoes only one cycle',async()=>{
   const n=await propose(),args=await result(n,alice,0,0n,eth('30000'));const p=await gov.proposals(n);
   await chain.mineAt(Number(p.endsAt)-1);await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...args));
   await chain.mineAt(Number(p.endsAt));await assert.rejects(()=>gov.connect(bob).finalizeResult.staticCall(...args));
   await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall({...args[0],forVotes:eth('1')},...args.slice(1)));
   await(await gov.connect(alice).finalizeResult(...args)).wait();assert.equal(await gov.cycleBlocked(1),true);
   await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...args));await chain.mineAt(anchor+WEEK);await assert.rejects(()=>gov.connect(dev).claimWeeklyWithdrawal.staticCall());
   await chain.mineAt(anchor+2*WEEK);await(await gov.connect(dev).claimWeeklyWithdrawal()).wait();assert.equal(await vault.availableFunds(),eth('22.5'));
  });
  test('any attested participant may submit, including opponents; a defeated result permits withdrawal',async()=>{
   const n=await propose(),p=await gov.proposals(n);await chain.mineAt(Number(p.endsAt));
   await(await gov.connect(bob).finalizeResult(...await result(n,bob,0,eth('29999'),eth('20000')))).wait();
   assert.equal((await gov.proposals(n)).passed,false);assert.equal(await gov.cycleBlocked(1),false);await chain.mineAt(anchor+WEEK+1);await(await gov.connect(dev).claimWeeklyWithdrawal()).wait();
  });
  test('missing veto results expire exactly 24h after vote end and cannot block withdrawals or be replayed',async()=>{
   const n=await propose(),args=await result(n,alice,0,0n,eth('30000')),p=await gov.proposals(n);
   assert.equal(p.endsAt-p.startsAt,BigInt(DAY));assert.equal(p.uploadEndsAt-p.endsAt,BigInt(DAY));
   await chain.mineAt(Number(p.uploadEndsAt)-1);assert.equal(await gov.proposalState(n),2n);
   await gov.connect(alice).finalizeResult.staticCall(...args);
   await chain.mineAt(Number(p.uploadEndsAt));assert.equal(await gov.proposalState(n),5n);
   await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...args));
   await chain.mineAt(anchor+WEEK);await(await gov.connect(dev).claimWeeklyWithdrawal()).wait();
  });
  test('transfers during voting change neither eligibility nor denominator for the existing proposal',async()=>{
   const n=await propose(),p=await gov.proposals(n),sig=await ballot(alice,n,1);
   await(await token.connect(alice).transfer(small.address,eth('30000'))).wait();assert.equal(await gov.validBallot(n,alice.address,1,sig),true);
   assert.equal(await gov.validBallot(n,small.address,1,await ballot(small,n,1)),false);assert.equal((await gov.proposals(n)).totalPower,p.totalPower);
  });
  test('exactly two thirds terminates after three days; treasury enters fee rewards and insurance stays separate',async()=>{
   for(const [who,n] of [[alice,'470000'],[bob,'280000'],[carol,'90000']])await(await token.transfer(who.address,eth(n))).wait();
   await(await gov.connect(alice).proposeTermination(id('end'),'ipfs://termination')).wait();const n=await gov.proposalCount(),p=await gov.proposals(n);
   assert.equal(p.totalPower,eth('900000'));assert.equal(p.endsAt-p.startsAt,BigInt(3*DAY));await chain.mineAt(Number(p.endsAt));
   await(await gov.connect(carol).finalizeResult(...await result(n,carol,1,eth('600000')))).wait();assert.equal(await gov.terminated(),true);
   const settlement=new Contract(await gov.settlement(),artifact('ProjectSettlement').abi,owner);assert.equal(await settlement.totalPower(),eth('904999'));assert.equal(await settlement.totalDeposited(),0n);const rewards=new Contract(await token.feeRewards(),artifact('ProjectFeeRewards').abi,owner);assert.equal(await rewards.queuedFunds(),eth('30'));
   await assert.rejects(()=>gov.connect(dev).claimWeeklyWithdrawal.staticCall());
  });
  test('impossible vote totals and expired attestations are rejected without changing project state',async()=>{
   const n=await propose(),p=await gov.proposals(n);await chain.mineAt(Number(p.endsAt));
   await assert.rejects(async()=>gov.connect(alice).finalizeResult.staticCall(...await result(n,alice,1,eth('60001'))));assert.equal((await gov.proposals(n)).finalized,false);
   const args=await result(n,alice,0,0n,eth('30000'));args[0].deadline=p.endsAt-1n;args[4]=[validator.signingKey.sign(await gov.resultDigest(args[0])).serialized];
   await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...args));assert.equal((await gov.proposals(n)).finalized,false);
  });
  test('the exact 24h creation cutoff rejects a veto, and a shorter upload window ends at cycle opening',async()=>{
   await chain.mineAt(anchor+WEEK-DAY-3600);
   await(await gov.connect(alice).proposeWithdrawalVeto(1,id('boundary'),'ipfs://boundary')).wait();
   const p=await gov.proposals(1);assert.equal(p.uploadEndsAt,BigInt(anchor+WEEK));assert.ok(p.uploadEndsAt-p.endsAt<=3600n);
   await chain.mineAt(Number(p.endsAt));await gov.connect(alice).finalizeResult.staticCall(...await result(1,alice,1,eth('30000')));
   const args=await result(1,alice,1,eth('30000'));await chain.mineAt(anchor+WEEK);await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...args));
  });
  test('exactly 24h before the cycle cannot open a veto even without an existing proposal',async()=>{
   await chain.mineAt(anchor+WEEK-DAY);await assert.rejects(()=>gov.connect(alice).proposeWithdrawalVeto.staticCall(1,id('boundary'),'ipfs://boundary'));
  });
});

describe("Cooldowns, early termination and topics", {concurrency: false}, () => {
  const DAY=86400,WEEK=7*DAY;
  function fixture(run) {
    return withLocalChain(async c => {
    const [owner,founder,alice,bob]=c.signers,validator=Wallet.createRandom();
    const token=await c.deploy('ProjectToken',[owner.address,owner.address,ZeroAddress]);
    const verifier=await c.deploy('AllocationVerifier',[[validator.address],1]);
    const gov=(await c.deploy('CommunityGovernance',[founder.address,token.target,verifier.target])).connect(founder);
    const rewards=await c.deploy('ProjectFeeRewards',[token.target,gov.target,token.target]);
    await tx(token.configureFeeRewards(rewards.target));await tx(token.registerLocker(founder.address));await tx(token.launch());
    await tx(token.transfer(alice.address,eth('600000')));await tx(token.transfer(bob.address,eth('300000')));
    const vault=new Contract(await gov.devVault(),artifact('ProjectVault').abi,owner);await tx(vault.deposit({value:eth('4')}));
    const anchor=Number(await gov.anchor());
    async function result(n,who,support,fv,av=0n){
     const p=await gov.proposals(n),domain={name:'OriginCommunityGovernance',version:'1',chainId:31337,verifyingContract:gov.target};
     const signature=await who.signTypedData(domain,{Ballot:[{name:'proposalId',type:'uint256'},{name:'snapshotHash',type:'bytes32'},{name:'voter',type:'address'},{name:'support',type:'uint8'}]},{proposalId:n,snapshotHash:p.snapshotHash,voter:who.address,support});
     const r={proposalId:n,forVotes:fv,againstVotes:av,abstainVotes:0n,archiveHash:id('complete signed archive'),cid:'bafy-test-policy',uploader:who.address,deadline:p.uploadEndsAt};
     return [r,support,signature,[validator.address],[validator.signingKey.sign(await gov.resultDigest(r)).serialized]];
    }
    await run({c,owner,founder,alice,bob,token,gov,rewards,vault,anchor,result});

    });
  }
  test('first proposals require 24h; withdrawal and termination cooldowns are independent rolling weeks',async()=>fixture(async f=>{
   const {c,gov,alice,anchor,result}=f;
   await assert.rejects(()=>gov.connect(alice).proposeWithdrawalVeto.staticCall(1,id('withdraw'),'local://reason'));
   await assert.rejects(()=>gov.proposeTermination.staticCall(id('end'),'local://reason'));
   await assert.rejects(()=>gov.proposeTopic.staticCall(id('topic'),'local://topic'));
   await c.mineAt(anchor);await tx(gov.connect(alice).proposeWithdrawalVeto(1,id('withdraw'),'local://reason'));
   const w=await gov.proposals(1);assert.equal(w.kind,3n);
   await tx(gov.proposeTermination(id('end'),'local://reason'));const t=await gov.proposals(2);assert.equal(t.endsAt-t.startsAt,BigInt(3*DAY));
   await c.mineAt(Number(t.endsAt));await tx(gov.connect(alice).finalizeResult(...await result(2,alice,0,0n,eth('600000'))));
   await assert.rejects(()=>gov.proposeTermination.staticCall(id('again'),'local://reason'));
   await c.mineAt(Number(t.startsAt)+WEEK-1);await assert.rejects(()=>gov.proposeTermination.staticCall(id('again'),'local://reason'));
   await c.mineAt(Number(t.startsAt)+WEEK);await tx(gov.proposeTermination(id('again'),'local://reason'));
   assert.ok(Number(await gov.nextWithdrawalProposalAt())<=await c.timestamp());
   await tx(gov.connect(alice).proposeWithdrawalVeto(2,id('withdraw2'),'local://reason'));
  }));
  test('early termination rejects below two thirds, sums above denominator, forged attestations and replay',async()=>fixture(async f=>{
   const {c,gov,alice,bob,anchor,result,rewards,vault,owner}=f;await c.mineAt(anchor);
   await tx(gov.proposeTermination(id('end'),'local://reason'));const p=await gov.proposals(1);
   const short=await result(1,alice,1,eth('600000')-1n);await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...short));
   const tooMany=await result(1,alice,1,eth('600000'),eth('300000')+1n);await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...tooMany));
   const valid=await result(1,alice,1,eth('600000'));
   await assert.rejects(()=>gov.connect(bob).finalizeResult.staticCall(...valid));
   await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall({...valid[0],archiveHash:id('tampered')},...valid.slice(1)));
   await assert.rejects(()=>owner.sendTransaction({to:rewards.target,value:eth('1')}));
   await tx(gov.connect(alice).finalizeResult(...valid));assert.equal(await gov.terminated(),true);assert.ok(await c.timestamp()<Number(p.endsAt));
   assert.equal(await vault.availableFunds(),0n);assert.equal(await vault.sealedForSettlement(),true);assert.equal(await rewards.queuedFunds(),eth('4'));
   assert.equal(await rewards.accountedFunds(),await c.balance(rewards.target));
   await assert.rejects(()=>gov.connect(alice).finalizeResult.staticCall(...valid));
   await assert.rejects(()=>gov.claimInitialWithdrawal.staticCall());
   await c.mineAt(Math.max(await c.timestamp()+1,Number(await rewards.nextRoundAt())));await tx(rewards.process(1500000,{gasLimit:1800000}));
   assert.ok(await rewards.claimable(alice.address)>0n);assert.ok(await rewards.claimable(bob.address)>0n);
   assert.equal(await rewards.claimable(f.founder.address),0n);
   const owed=await rewards.claimable(alice.address),before=await c.balance(bob.address);await tx(rewards.connect(alice).claimTo(bob.address));
   assert.equal(await c.balance(bob.address)-before,owed);assert.equal(await rewards.claimable(alice.address),0n);
  }));
  test('current Founder alone proposes general topics; handover revokes old authority and preserves ordinary holder rights',async()=>fixture(async f=>{
   const {c,gov,founder,alice,bob,anchor,result,rewards}=f;await c.mineAt(anchor);
   await assert.rejects(()=>gov.connect(alice).proposeTopic.staticCall(id('unauthorized'),'local://topic'));
   await tx(gov.proposeTopic(id('community roadmap'),'local://topic'));const p=await gov.proposals(1);assert.equal(p.kind,2n);
   await assert.rejects(()=>gov.proposeTopic.staticCall(id('parallel'),'local://topic'));
   await assert.rejects(async()=>gov.connect(alice).finalizeResult.staticCall(...await result(1,alice,1,eth('600000'))));
   await tx(gov.proposeDeveloperTransfer(bob.address));await c.mineAt(Number(await gov.developerTransferReadyAt()));await tx(gov.connect(bob).acceptDeveloperTransfer());
   assert.equal(await gov.developer(),bob.address);assert.equal(await gov.devRecipient(),bob.address);
   await assert.rejects(()=>gov.claimInitialWithdrawal.staticCall());await assert.rejects(()=>gov.setDevRecipient.staticCall(founder.address));
   await assert.rejects(()=>rewards.deposit.staticCall({value:eth('1')}));await tx(rewards.connect(bob).deposit({value:eth('1')}));
   await c.mineAt(Number(p.endsAt));await tx(gov.connect(alice).finalizeResult(...await result(1,alice,1,eth('600000'))));
   assert.equal((await gov.proposals(1)).passed,true);assert.equal(await gov.terminated(),false);
   await assert.rejects(()=>gov.proposeTopic.staticCall(id('old'),'local://topic'));await tx(gov.connect(bob).proposeTopic(id('new'),'local://topic'));
  }));
});
