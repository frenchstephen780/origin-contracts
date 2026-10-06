// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWeightedToken {
    function launched() external view returns (bool);
    function holderCount() external view returns (uint256);
    function holders(uint256 index) external view returns (address);
    function recentWeight(address account, uint256 snapshotBlock, uint256 weightTime)
        external view returns (uint256 balance, uint256 shares);
    function getPastRewardSupply(uint256 snapshotBlock) external view returns (uint256);
}
interface IFeeRewardGovernance {
    function terminated() external view returns (bool);
    function developer() external view returns (address);
    function devVault() external view returns (address);
}

/// @notice Per-project ETH rewards. Two bounded passes freeze an exact denominator
/// then credit claimable balances. Token transfers NEVER pay ETH to holders.
/// Latest/previous token states plus copy-before-write snapshots avoid storing
/// a complete transfer history. Only one round is processed at a time.
contract ProjectFeeRewards is ReentrancyGuard {
    uint256 public constant CONTRACT_VERSION = 1;
    uint256 public constant INTERVAL = 1 days;
    uint256 public constant MAX_PROCESS_GAS = 2_000_000;
    uint256 private constant ITEM_GAS_RESERVE = 110_000;
    IWeightedToken public token;
    IFeeRewardGovernance public governance;
    address public feeSource;
    uint256 public nextRoundAt;
    uint256 public queuedFunds;
    uint256 public totalClaimable;
    uint256 public roundCount;

    enum Phase { Idle, Summing, Crediting }
    struct Round {
        uint256 snapshotBlock;
        uint256 weightTime;
        uint256 threshold;
        uint256 holderLimit;
        uint256 amount;
        uint256 totalShares;
        uint256 credited;
        uint256 cursor;
        Phase phase;
    }
    struct FrozenWeight { uint256 roundId; uint256 shares; }
    Round public currentRound;
    mapping(address => FrozenWeight) public frozenWeights;
    mapping(address => uint256) public claimable;
    error Unauthorized(); error InvalidAmount(); error TransferFailed(); error InvalidRecipient();
    event Funded(address indexed sender, uint256 amount);
    event RoundStarted(uint256 indexed roundId, uint256 snapshotBlock, uint256 weightTime, uint256 threshold, uint256 amount, uint256 holders);
    event DenominatorFixed(uint256 indexed roundId, uint256 totalShares);
    event Credited(uint256 indexed roundId, address indexed account, uint256 amount);
    event RoundCompleted(uint256 indexed roundId, uint256 credited, uint256 carriedForward);
    event RoundAdvanced(uint256 indexed roundId, uint256 checks, bool automatic);
    event Claimed(address indexed account, address indexed recipient, uint256 amount);

    constructor(IWeightedToken token_, IFeeRewardGovernance governance_, address feeSource_) {
        if (address(token_) != address(0) || address(governance_) != address(0) || feeSource_ != address(0)) {
            _initializeRewards(token_, governance_, feeSource_);
        }
    }

    function _initializeRewards(IWeightedToken token_, IFeeRewardGovernance governance_, address feeSource_) internal {
        require(address(token) == address(0));
        require(address(token_).code.length != 0 && address(governance_).code.length != 0 && feeSource_.code.length != 0);
        token = token_; governance = governance_; feeSource = feeSource_;
        nextRoundAt = block.timestamp + INTERVAL;
    }

    /// @notice Authorized funding only. Raw/forced ETH cannot inflate liabilities.
    function deposit() external payable virtual {
        if (msg.sender != feeSource && msg.sender != governance.developer()) revert Unauthorized();
        if (governance.terminated() || msg.value == 0) revert InvalidAmount();
        _deposit();
    }

    /// @notice Swap fees continue funding holder rewards after termination.
    /// This exception is restricted to the immutable official hook, not dev.
    function depositFees() external payable {
        if (msg.sender != feeSource) revert Unauthorized();
        if (msg.value == 0) revert InvalidAmount();
        _deposit();
    }

    function _deposit() private {
        queuedFunds += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    /// @dev Mandatory token callback BEFORE overwriting a holder's weight state.
    function capture(address account) external virtual {
        if (msg.sender != address(token)) revert Unauthorized();
        if (currentRound.phase != Phase.Idle) _capture(account);
    }

    function _capture(address account) internal virtual returns (uint256 weight) {
        FrozenWeight storage f = frozenWeights[account];
        if (f.roundId == roundCount) return f.shares;
        Round storage r = currentRound;
        (uint256 balance, uint256 shares) = _snapshotShares(account, r.snapshotBlock, r.weightTime);
        weight = balance >= r.threshold ? shares : 0;
        f.roundId = roundCount; f.shares = weight;
    }

    function _snapshotShares(address account, uint256 snapshotBlock, uint256 weightTime)
        internal view virtual returns (uint256 balance, uint256 shares) {
        return token.recentWeight(account, snapshotBlock, weightTime);
    }

    /// @notice Anyone can advance a round, including when trading is quiet.
    /// gasBudget bounds internal work; the caller must also supply transaction gas.
    /// Token callbacks use their gas allowance without a fixed entry-count cap.
    /// Deposits made during processing stay queued for the next round.
    function process(uint256 gasBudget) external nonReentrant {
        (bool supportsRecovery, bytes memory status) = address(token).staticcall(abi.encodeWithSignature("rewardRecovery()"));
        if (supportsRecovery && status.length == 32 && abi.decode(status,(bool))) return;
        bool automatic = msg.sender == address(token);
        uint256 initialGas = gasleft();
        if (gasBudget > MAX_PROCESS_GAS) gasBudget = MAX_PROCESS_GAS;
        if (gasBudget < 200_000 || initialGas < 240_000 || !token.launched()) return;
        Round storage r = currentRound;
        if (r.phase == Phase.Idle) {
            if (block.timestamp < nextRoundAt || queuedFunds == 0) return;
            uint256 supply = token.getPastRewardSupply(block.number - 1);
            ++roundCount;
            r.snapshotBlock = block.number - 1;
            // Balances are from the completed previous block, aged to this fixed
            // timestamp for EVERY holder. Same-block loans/purchases are excluded.
            r.weightTime = block.timestamp;
            r.threshold = Math.ceilDiv(supply, 20_000); // >= 0.005%, no floor loophole.
            r.holderLimit = token.holderCount();
            r.amount = queuedFunds; queuedFunds = 0;
            r.totalShares = 0; r.credited = 0; r.cursor = 0; r.phase = Phase.Summing;
            nextRoundAt = block.timestamp + INTERVAL;
            emit RoundStarted(roundCount,r.snapshotBlock,r.weightTime,r.threshold,r.amount,r.holderLimit);
        }
        uint256 checks;
        while (gasleft() > ITEM_GAS_RESERVE && initialGas - gasleft() + ITEM_GAS_RESERVE < gasBudget) {
            if (r.cursor == r.holderLimit) {
                if (r.phase == Phase.Summing && r.totalShares != 0) {
                    r.phase = Phase.Crediting; r.cursor = 0;
                    emit DenominatorFixed(roundCount, r.totalShares);
                } else {
                    uint256 remainder = r.amount - r.credited;
                    queuedFunds += remainder;
                    r.phase = Phase.Idle;
                    emit RoundCompleted(roundCount, r.credited, remainder);
                    break;
                }
            } else {
                ++checks;
                address account = token.holders(r.cursor++);
                if (r.phase == Phase.Summing) r.totalShares += _capture(account);
                else {
                    uint256 amount = Math.mulDiv(r.amount, frozenWeights[account].shares, r.totalShares);
                    if (amount != 0) {
                        claimable[account] += amount; totalClaimable += amount; r.credited += amount;
                        emit Credited(roundCount, account, amount);
                    }
                }
            }
        }
        if (checks != 0) emit RoundAdvanced(roundCount, checks, automatic);
    }

    function claim() external nonReentrant { _claim(payable(msg.sender)); }
    function claimTo(address payable recipient) external nonReentrant { _claim(recipient); }
    function _claim(address payable recipient) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert InvalidAmount();
        claimable[msg.sender] = 0; totalClaimable -= amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, recipient, amount);
    }

    function accountedFunds() public view returns (uint256) {
        Round storage r = currentRound;
        return queuedFunds + totalClaimable + (r.phase == Phase.Idle ? 0 : r.amount - r.credited);
    }
    function isIdle() external view returns (bool) { return currentRound.phase == Phase.Idle; }
    function unaccountedSurplus() external view returns (uint256) { return address(this).balance - accountedFunds(); }
    /// @notice Atomic termination compensation enters the same weighted rounds.
    /// Only the project's sealed Founder vault can send termination principal.
    receive() external payable {
        if (!governance.terminated() || msg.sender != governance.devVault() || msg.value == 0) revert Unauthorized();
        _deposit();
    }
}
