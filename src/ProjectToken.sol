// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IProjectVotingPower} from "./interfaces/IProjectVotingPower.sol";
import {FundraisingCurve} from "./libraries/FundraisingCurve.sol";
import {HoldingWeight} from "./libraries/HoldingWeight.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ITransferRewards} from "./interfaces/ITransferRewards.sol";

interface IRewardRecoveryStatus { function isIdle() external view returns (bool); }
interface IDelayedRecoveryAuthority { function getMinDelay() external view returns (uint256); }

/// @notice Wallet-balance checkpoints. Unclaimed entitlements have no voting power.
/// Known protocol and burn addresses are excluded; contract wallets remain eligible.
contract ProjectToken is ERC20, IProjectVotingPower {
    using Checkpoints for Checkpoints.Trace208;
    address public immutable escrow;
    address public immutable coordinator;
    address public locker;
    bool public launched;
    uint256 public launchTime;
    uint256 public launchBlock;
    mapping(address => uint256) public subscriptionBalance;
    bool public metadataConfigured;
    string private tokenName = "Project Token";
    string private tokenSymbol = "PROJECT";
    uint256 public constant initialSupply = FundraisingCurve.TOTAL_SUPPLY;
    mapping(address => bool) public excluded;
    mapping(address => uint256) public unclaimed;
    mapping(address => Checkpoints.Trace208) private powers;
    Checkpoints.Trace208 private totalPowers;
    uint256 private accumulatedPublicPower;
    // Full balances of wallets meeting the voting minimum, including wallets
    // that abstain or never vote. Updated in O(1) at every balance change.
    uint256 private accumulatedEligiblePower;
    Checkpoints.Trace208 private eligiblePowers;
    uint256 public constant minimumVotingBalance = (initialSupply + 19_999) / 20_000;
    ITransferRewards public feeRewards;
    ITransferRewards public operatingRewards;
    uint256 public constant AUTO_REWARD_GAS = 350_000;
    struct WeightState { uint128 balance; uint48 updatedAt; uint48 blockNumber; uint256 decayBalance; }
    mapping(address => WeightState) public weights;
    mapping(address => WeightState) private previousWeights;
    // Append-only identities keep round cursors stable. No duplicate registration.
    address[] public holders;
    mapping(address => bool) private knownHolder;
    Checkpoints.Trace208 private rewardSupplies;
    address public rewardRecoveryAuthority;
    bool public rewardRecovery;
    uint256 public pruneCursor;
    event RewardRecoveryChanged(bool enabled);
    event HoldersPruned(uint256 removed, uint256 remaining);
    event RewardProcessingDeferred();
    event FeeRewardsConfigured(address indexed rewards);
    event OperatingRewardsConfigured(address indexed rewards);
    error Unauthorized();
    error Locked();
    error InvalidSnapshot();

    constructor(address escrow_, address coordinator_, address poolManager) ERC20("Project Token", "PROJECT") {
        require(escrow_ != address(0));
        escrow = escrow_;
        coordinator = coordinator_;
        excluded[escrow_] = true;
        excluded[poolManager] = true;
        excluded[coordinator_] = true;
        excluded[address(0)] = true;
        excluded[address(0xdead)] = true;
        _mint(escrow_, initialSupply);
    }

    function name() public view override returns (string memory) { return tokenName; }
    function symbol() public view override returns (string memory) { return tokenSymbol; }

    function configureMetadata(string calldata name_, string calldata symbol_) external {
        if (msg.sender != escrow || launched || metadataConfigured) revert Unauthorized();
        if (bytes(name_).length == 0 || bytes(name_).length > 64 ||
            bytes(symbol_).length == 0 || bytes(symbol_).length > 12) revert Unauthorized();
        metadataConfigured = true;
        tokenName = name_;
        tokenSymbol = symbol_;
    }

    function registerProtocolAddresses(address[] calldata accounts) external {
        if (msg.sender != coordinator || launched) revert Unauthorized();
        for (uint256 i; i < accounts.length; ++i) { if (accounts[i] != address(0)) _exclude(accounts[i]); }
    }

    function _exclude(address account) private {
        if (account == address(0) || account.code.length == 0 || balanceOf(account) != 0) revert Unauthorized();
        excluded[account] = true;
    }

    function burn(uint256 amount) external { _burn(msg.sender, amount); }

    function registerLocker(address locker_) external {
        if (msg.sender != coordinator || locker != address(0) || locker_ == address(0) || balanceOf(locker_) != 0) {
            revert Unauthorized();
        }
        locker = locker_;
        excluded[locker_] = true;
    }

    function creditEntitlement(address account, uint256 amount) external {
        if (msg.sender != escrow || launched || excluded[account]) revert Unauthorized();
        unclaimed[account] += amount;
    }

    /// @notice Deliver purchased tokens immediately; all wallet transfers remain locked.
    function issueSubscription(address account, uint256 amount) external {
        if (msg.sender != escrow || launched || excluded[account]) revert Unauthorized();
        subscriptionBalance[account] += amount;
        _transfer(escrow, account, amount);
    }

    /// @notice Only escrow can burn its exact locked allocation when refunding ETH.
    function burnSubscription(address account, uint256 amount) external {
        if (msg.sender != escrow || launched || amount == 0 || subscriptionBalance[account] != amount) revert Unauthorized();
        delete subscriptionBalance[account];
        _burn(account, amount);
    }

    function claim(address account, address recipient, uint256 amount) external {
        if (msg.sender != escrow || !launched || excluded[recipient]) revert Unauthorized();
        unclaimed[account] -= amount;
        _transfer(escrow, recipient, amount);
    }

    function launch() external {
        if (msg.sender != escrow || launched || locker == address(0)) revert Unauthorized();
        launched = true;
        launchTime = block.timestamp;
        launchBlock = block.number;
    }

    function configureFeeRewards(ITransferRewards rewards) external {
        if (msg.sender != coordinator || launched || address(feeRewards) != address(0) ||
            address(rewards).code.length == 0 || rewards.token() != address(this)) revert Unauthorized();
        feeRewards = rewards;
        excluded[address(rewards)] = true;
        emit FeeRewardsConfigured(address(rewards));
    }

    function configureOperatingRewards(ITransferRewards rewards) external {
        if (msg.sender != coordinator || launched || address(operatingRewards) != address(0) ||
            address(rewards).code.length == 0 || rewards.token() != address(this) ||
            address(rewards) == address(feeRewards)) revert Unauthorized();
        operatingRewards = rewards;
        excluded[address(rewards)] = true;
        emit OperatingRewardsConfigured(address(rewards));
    }

    function publicPower() external view returns (uint256) { return launched ? accumulatedPublicPower : 0; }
    function eligiblePower() external view returns (uint256) { return launched ? accumulatedEligiblePower : 0; }

    function holderCount() external view returns (uint256) { return holders.length; }

    function configureRecoveryAuthority(address authority) external {
        if (msg.sender != coordinator || launched || rewardRecoveryAuthority != address(0) ||
            authority.code.length == 0 || IDelayedRecoveryAuthority(authority).getMinDelay() < 2 days) revert Unauthorized();
        rewardRecoveryAuthority = authority;
    }

    /// @notice Delayed disaster recovery keeps transfers usable without pretending
    /// damaged snapshots are accurate. Both rounds must be aborted/finished before resuming.
    function setRewardRecovery(bool enabled) external {
        if (msg.sender != rewardRecoveryAuthority || msg.sender == address(0)) revert Unauthorized();
        if (!enabled && !_rewardsIdle()) revert Locked();
        rewardRecovery = enabled;
        emit RewardRecoveryChanged(enabled);
    }

    function _rewardsIdle() private view returns (bool) {
        return (address(feeRewards) == address(0) || IRewardRecoveryStatus(address(feeRewards)).isIdle()) &&
            (address(operatingRewards) == address(0) || IRewardRecoveryStatus(address(operatingRewards)).isIdle());
    }

    /// @notice Bounded registry maintenance between rounds; never moves scan cursors
    /// during either vault's processing. A same-block exit remains available to snapshots.
    function pruneHolders(uint256 checks) external {
        if (!_rewardsIdle()) revert Locked();
        if (checks > 200) checks = 200;
        uint256 removed;
        while (checks != 0 && holders.length != 0) {
            --checks;
            if (pruneCursor >= holders.length) pruneCursor = 0;
            address account = holders[pruneCursor];
            if (balanceOf(account) <= 1 ether && weights[account].blockNumber < block.number) {
                holders[pruneCursor] = holders[holders.length - 1];
                holders.pop(); knownHolder[account] = false; ++removed;
            } else ++pruneCursor;
        }
        emit HoldersPruned(removed, holders.length);
    }

    /// @notice Anyone can register a wallet newly eligible after a supply burn.
    function registerRewardHolder(address account) external {
        if (excluded[account] || balanceOf(account) <= 1 ether ||
            balanceOf(account) < Math.ceilDiv(totalSupply(), 20_000)) revert Unauthorized();
        if (!knownHolder[account]) { knownHolder[account] = true; holders.push(account); }
    }

    /// @notice Current raw age shares. Eligibility for payout is fixed per round.
    function currentShares(address account) external view returns (uint256) {
        if (!launched) return 0;
        WeightState storage w = weights[account];
        return HoldingWeight.shares(w.balance, w.decayBalance, block.timestamp - Math.max(w.updatedAt, launchTime));
    }

    /// @dev Only latest/previous states are kept; the distributor captures before
    /// subsequent changes overwrite them. This is NOT arbitrary historical lookup.
    function recentWeight(address account, uint256 snapshotBlock, uint256 weightTime)
        external view returns (uint256 balance, uint256 shares)
    {
        if (rewardRecovery || snapshotBlock >= block.number || weightTime > block.timestamp) revert InvalidSnapshot();
        if (!launched || snapshotBlock < launchBlock || weightTime < launchTime) return (0, 0);
        WeightState memory w = weights[account];
        if (w.blockNumber > snapshotBlock) w = previousWeights[account];
        if (w.blockNumber > snapshotBlock || w.updatedAt > weightTime) revert InvalidSnapshot();
        return (w.balance, HoldingWeight.shares(w.balance, w.decayBalance, weightTime - Math.max(w.updatedAt, launchTime)));
    }

    /// @notice Immutable accounting state for compatible upgraded distributors.
    /// D retains the original 23-day exponential basis; a new payout algorithm
    /// must interpret this aggregate state explicitly, not invent historical lots.
    function recentWeightState(address account, uint256 snapshotBlock, uint256 weightTime)
        external view returns (uint256 balance, uint256 decayBalance, uint256 elapsed) {
        if (rewardRecovery || snapshotBlock >= block.number || weightTime > block.timestamp) revert InvalidSnapshot();
        if (!launched || snapshotBlock < launchBlock || weightTime < launchTime) return (0, 0, 0);
        WeightState memory w = weights[account];
        if (w.blockNumber > snapshotBlock) w = previousWeights[account];
        if (w.blockNumber > snapshotBlock || w.updatedAt > weightTime) revert InvalidSnapshot();
        return (w.balance, w.decayBalance, weightTime - Math.max(w.updatedAt, launchTime));
    }

    /// @notice ERC20 totalSupply at the cutoff. Sending to dead does not reduce it.
    function getPastRewardSupply(uint256 snapshotBlock) external view returns (uint256) {
        if (snapshotBlock >= block.number) revert InvalidSnapshot();
        return rewardSupplies.upperLookupRecent(SafeCast.toUint48(snapshotBlock));
    }

    function getPastPower(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert InvalidSnapshot();
        if (!launched || blockNumber < launchBlock) return 0;
        return powers[account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function getPastTotalPower(uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert InvalidSnapshot();
        if (!launched || blockNumber < launchBlock) return 0;
        return totalPowers.upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function getPastEligiblePower(uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert InvalidSnapshot();
        if (!launched || blockNumber < launchBlock) return 0;
        return eligiblePowers.upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (!launched && from != address(0) && from != escrow && from != locker &&
            !(msg.sender == escrow && to == address(0) && subscriptionBalance[from] == 0)) revert Locked();
        bool changed = from != to && amount != 0;
        if (changed) {
            _changeWeight(from, amount, false);
            _changeWeight(to, amount, true);
        }
        super._update(from, to, amount);
        if (from != address(0) && !excluded[from]) _changePower(from, -int256(amount));
        if (to != address(0) && !excluded[to]) _changePower(to, int256(amount));
        if (from == address(0) || to == address(0)) {
            rewardSupplies.push(SafeCast.toUint48(block.number), SafeCast.toUint208(totalSupply()));
        }
        // Optional batching is isolated. Accurate holder accounting above is
        // mandatory; failed/underfunded processing never invalidates a transfer.
        if (changed && launched && !rewardRecovery && address(feeRewards) != address(0) && gasleft() > 100_000) {
            uint256 budget = Math.min(AUTO_REWARD_GAS, gasleft() - 60_000);
            try feeRewards.process{gas: budget}(budget > 20_000 ? budget - 20_000 : 0) {}
            catch { emit RewardProcessingDeferred(); }
        }
        if (changed && launched && !rewardRecovery && address(operatingRewards) != address(0) && gasleft() > 100_000) {
            uint256 budget = Math.min(AUTO_REWARD_GAS, gasleft() - 60_000);
            try operatingRewards.process{gas: budget}(budget > 20_000 ? budget - 20_000 : 0) {}
            catch { emit RewardProcessingDeferred(); }
        }
    }

    function _changeWeight(address account, uint256 amount, bool incoming) private {
        if (excluded[account]) return;
        if (launched && !rewardRecovery) {
            if (address(feeRewards) != address(0)) feeRewards.capture(account);
            if (address(operatingRewards) != address(0)) operatingRewards.capture(account);
        }
        WeightState storage w = weights[account];
        if (w.blockNumber != block.number) previousWeights[account] = w;
        uint256 oldBalance = balanceOf(account);
        uint256 nextBalance = incoming ? oldBalance + amount : oldBalance - amount;
        uint256 nextDecay;
        if (nextBalance > 1 ether) {
            if (oldBalance <= 1 ether) nextDecay = nextBalance * 1e18;
            else {
                nextDecay = HoldingWeight.decay(w.decayBalance, launched ? block.timestamp - Math.max(w.updatedAt, launchTime) : 0);
                if (incoming) nextDecay += amount * 1e18;
                else nextDecay = Math.mulDiv(nextDecay, nextBalance, oldBalance, Math.Rounding.Ceil);
            }
            if (!knownHolder[account]) { knownHolder[account] = true; holders.push(account); }
        }
        w.balance = SafeCast.toUint128(nextBalance);
        w.decayBalance = nextDecay;
        w.updatedAt = SafeCast.toUint48(block.timestamp);
        w.blockNumber = SafeCast.toUint48(block.number);
    }

    function _changePower(address account, int256 delta) private {
        uint256 previous = powers[account].latest();
        uint256 next;
        if (delta >= 0) {
            next = previous + uint256(delta);
            accumulatedPublicPower += uint256(delta);
        } else {
            next = previous - uint256(-delta);
            accumulatedPublicPower -= uint256(-delta);
        }
        uint48 clock = SafeCast.toUint48(block.number);
        if (previous >= minimumVotingBalance) accumulatedEligiblePower -= previous;
        if (next >= minimumVotingBalance) accumulatedEligiblePower += next;
        eligiblePowers.push(clock, SafeCast.toUint208(accumulatedEligiblePower));
        powers[account].push(clock, SafeCast.toUint208(next));
        totalPowers.push(clock, SafeCast.toUint208(accumulatedPublicPower));
    }
}
