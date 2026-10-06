// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProjectVotingPower} from "./interfaces/IProjectVotingPower.sol";
import {ProjectVault} from "./ProjectVault.sol";
import {ProjectSettlement} from "./ProjectSettlement.sol";
import {GovernanceCustodyFactory} from "./GovernanceCustodyFactory.sol";

/// @notice Base post-launch governance and custody. All tallies and custody checks
/// execute on-chain. Direct deployments have fixed logic; the separate UUPS
/// variant introduces a disclosed timelock upgrade authority.
/// @dev Deployment time is launchTime. V4MigrationCoordinator creates this
/// atomically with pool initialization and vault funding. The connected token
/// records eligible wallet balances; termination fixes the proposal snapshot.
contract ProjectGovernance is ReentrancyGuard {
    // Immutable implementation wiring adds no slots to an existing proxy.
    GovernanceCustodyFactory private immutable custodyFactory = new GovernanceCustodyFactory();
    enum WithdrawalState { None, Voting, Rejected, Approved, Expired, Executed, Cancelled }
    struct Withdrawal {
        uint256 cycle;
        uint256 snapshotBlock;
        uint256 totalPower;
        uint256 endsAt;
        uint256 expiresAt;
        uint256 objections;
        bool executed;
        bool cancelled;
    }
    struct Termination {
        uint256 snapshotBlock;
        uint256 totalPower;
        uint256 endsAt;
        uint256 yesPower;
        address proposer;
    }

    uint256 public constant VOTE_DURATION = 12 hours;
    uint256 public constant FIRST_UNLOCK_DELAY = 24 hours;
    uint256 public constant WITHDRAWAL_INTERVAL = 7 days;
    uint256 public constant RETRY_COOLDOWN = 24 hours;
    uint256 public constant APPROVAL_DURATION = 24 hours;
    uint256 public constant TERMINATION_DURATION = 7 days;
    uint256 public constant TERMINATION_COOLDOWN = 7 days;
    // Rejection, cancellation and expiry all consume the cycle's only request.
    uint256 public constant MAX_ATTEMPTS = 1;

    address public developer;
    address public pendingDeveloper;
    uint256 public developerTransferReadyAt;
    uint256 public constant DEVELOPER_TRANSFER_DELAY = 2 days;
    IProjectVotingPower public votingPower;
    ProjectVault public devVault;
    ProjectVault public insuranceVault;
    ProjectSettlement public settlement;
    uint256 public launchTime;
    uint256 public anchor;
    uint256 public minimumPower;
    uint256 public minimumTerminationPower;
    address payable public devRecipient;

    uint256 public withdrawalCount;
    uint256 public terminationCount;
    uint256 public lastSuccessfulWithdrawal;
    bool public initialWithdrawalClaimed;
    uint256 public cancellationCooldownUntil;
    bool public terminated;
    uint256 public terminatedAt;
    // Audit marker only, compensation uses the proposal snapshot.
    uint256 public terminationBlock;

    mapping(uint256 => Withdrawal) public withdrawals;
    mapping(uint256 => Termination) public terminations;
    mapping(uint256 => uint256) public cycleAttempts;
    mapping(uint256 => bool) public cyclePaid;
    mapping(uint256 => mapping(address => bool)) public hasObjected;
    mapping(uint256 => mapping(address => bool)) public hasVotedToTerminate;
    mapping(uint256 => bytes32) public withdrawalDisclosure;
    mapping(uint256 => uint256) public disclosureVersions;

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidDisclosure();
    error InvalidRecipient();
    error ProjectTerminated();
    error TooEarly();
    error RequestPending();
    error WindowClosed();
    error AttemptsExhausted();
    error CycleAlreadyPaid();
    error CooldownActive();
    error InvalidRequest();
    error InsufficientPower();
    error InvalidVotingPower();
    error AlreadyVoted();
    error NotExecutable();
    error WithdrawalsFrozen();
    error NothingToWithdraw();

    event WithdrawalRequested(uint256 indexed id, uint256 indexed cycle, uint256 snapshotBlock,
        uint256 totalPower, uint256 endsAt, uint256 expiresAt);
    event DisclosurePublished(uint256 indexed id, uint256 indexed version, bytes32 hash, string uri);
    event WithdrawalObjected(uint256 indexed id, address indexed voter, uint256 weight, uint256 objections);
    event WithdrawalCancelled(uint256 indexed id, uint256 cooldownUntil);
    event WithdrawalExecuted(uint256 indexed id, address indexed recipient, uint256 amount);
    event InitialWithdrawalExecuted(address indexed recipient, uint256 amount, uint256 cycle);
    event DevRecipientChanged(address indexed recipient);
    event DeveloperTransferStarted(address indexed currentDeveloper, address indexed nextDeveloper, uint256 readyAt);
    event DeveloperTransferred(address indexed previousDeveloper, address indexed nextDeveloper);
    event TerminationProposed(uint256 indexed id, address indexed proposer, uint256 snapshotBlock,
        uint256 totalPower, uint256 endsAt, bytes32 hash, string uri);
    event TerminationSupported(uint256 indexed id, address indexed voter, uint256 weight, uint256 yesPower);
    event ProjectEnded(uint256 indexed id, uint256 blockNumber, uint256 devFunds, uint256 insuranceFunds);

    constructor(address developer_, IProjectVotingPower votingPower_) {
        // Zero arguments are reserved for the locked UUPS implementation.
        if (developer_ != address(0) || address(votingPower_) != address(0)) _initializeGovernance(developer_, votingPower_);
    }

    function _initializeGovernance(address developer_, IProjectVotingPower votingPower_) internal {
        if (developer != address(0)) revert InvalidConfiguration();
        if (developer_ == address(0) || address(votingPower_).code.length == 0) revert InvalidConfiguration();
        uint256 supply = votingPower_.initialSupply();
        if (supply == 0) revert InvalidConfiguration();
        developer = developer_;
        devRecipient = payable(developer_);
        votingPower = votingPower_;
        minimumPower = Math.ceilDiv(supply, 20_000); // inclusive 0.005% of initial supply
        minimumTerminationPower = Math.ceilDiv(supply, 200); // inclusive 0.5%
        launchTime = block.timestamp;
        anchor = block.timestamp + FIRST_UNLOCK_DELAY;
        (devVault, insuranceVault, settlement) = custodyFactory.deploy(votingPower_);
    }

    modifier onlyDeveloper() {
        if (msg.sender != developer) revert Unauthorized();
        _;
    }

    modifier live() {
        if (terminated) revert ProjectTerminated();
        _;
    }

    function currentCycle() public view returns (uint256) {
        return block.timestamp < anchor ? 0 : (block.timestamp - anchor) / WITHDRAWAL_INTERVAL;
    }

    function withdrawalState(uint256 id) public view returns (WithdrawalState) {
        if (id == 0 || id > withdrawalCount) return WithdrawalState.None;
        Withdrawal storage request = withdrawals[id];
        if (request.executed) return WithdrawalState.Executed;
        if (request.cancelled) return WithdrawalState.Cancelled;
        if (block.timestamp < request.endsAt) return WithdrawalState.Voting;
        if (request.objections >= Math.ceilDiv(request.totalPower, 2)) return WithdrawalState.Rejected;
        if (block.timestamp >= request.expiresAt) return WithdrawalState.Expired;
        return WithdrawalState.Approved;
    }

    function requestWithdrawal(bytes32 hash, string calldata uri) external virtual onlyDeveloper live returns (uint256 id) {
        _validateDisclosure(hash, uri);
        if (!initialWithdrawalClaimed || block.timestamp < anchor + WITHDRAWAL_INTERVAL) revert TooEarly();
        WithdrawalState previous = withdrawalState(withdrawalCount);
        if (previous == WithdrawalState.Voting || previous == WithdrawalState.Approved) revert RequestPending();
        if (previous == WithdrawalState.Rejected &&
            block.timestamp < withdrawals[withdrawalCount].endsAt + RETRY_COOLDOWN) revert CooldownActive();
        if (block.timestamp < cancellationCooldownUntil) revert CooldownActive();
        uint256 cycle = currentCycle();
        if (cyclePaid[cycle]) revert CycleAlreadyPaid();
        if (cycleAttempts[cycle] >= MAX_ATTEMPTS) revert AttemptsExhausted();
        uint256 cycleEnd = anchor + (cycle + 1) * WITHDRAWAL_INTERVAL;
        uint256 endsAt = block.timestamp + VOTE_DURATION;
        // Equality leaves no execution interval before cycleEnd, so reject it.
        if (endsAt >= cycleEnd) revert WindowClosed();
        uint256 expiresAt = Math.min(endsAt + APPROVAL_DURATION, cycleEnd);
        uint256 executableAt = Math.max(endsAt, anchor);
        if (lastSuccessfulWithdrawal != 0) {
            executableAt = Math.max(executableAt, lastSuccessfulWithdrawal + WITHDRAWAL_INTERVAL);
        }
        // Never consume this cycle's only attempt for an approval that cannot execute.
        if (executableAt >= expiresAt) revert WindowClosed();
        (uint256 snapshot, uint256 total) = _snapshot();
        id = ++withdrawalCount;
        ++cycleAttempts[cycle];
        withdrawals[id] = Withdrawal(cycle, snapshot, total, endsAt,
            expiresAt, 0, false, false);
        emit WithdrawalRequested(id, cycle, snapshot, total, endsAt, withdrawals[id].expiresAt);
        _publish(id, hash, uri);
    }

    /// @notice One vote-free initial quarter after 24h. All subsequent payouts
    /// use weekly governance and remain at least seven days apart.
    function claimInitialWithdrawal() external onlyDeveloper nonReentrant live {
        if (initialWithdrawalClaimed) revert NotExecutable();
        if (block.timestamp < anchor) revert TooEarly();
        if (_initialWithdrawalsFrozen()) revert WithdrawalsFrozen();
        uint256 amount = _withdrawalAmount(devVault.availableFunds(), true);
        if (amount == 0) revert NothingToWithdraw();
        initialWithdrawalClaimed = true;
        uint256 cycle = currentCycle();
        cyclePaid[cycle] = true;
        lastSuccessfulWithdrawal = block.timestamp;
        emit InitialWithdrawalExecuted(devRecipient, amount, cycle);
        devVault.release(devRecipient, amount);
    }

    /// @notice Append-only event history; supplements cannot change the original
    /// disclosure, snapshot, voting deadline, or rejection cooldown.
    function supplementWithdrawal(uint256 id, bytes32 hash, string calldata uri) external onlyDeveloper live {
        if (id == 0 || id > withdrawalCount) revert InvalidRequest();
        _validateDisclosure(hash, uri);
        _publish(id, hash, uri);
    }

    function cancelWithdrawal(uint256 id) external onlyDeveloper live {
        WithdrawalState status = withdrawalState(id);
        if (id != withdrawalCount || (status != WithdrawalState.Voting && status != WithdrawalState.Approved)) {
            revert InvalidRequest();
        }
        withdrawals[id].cancelled = true;
        cancellationCooldownUntil = block.timestamp + RETRY_COOLDOWN;
        emit WithdrawalCancelled(id, cancellationCooldownUntil);
    }

    function objectToWithdrawal(uint256 id) external virtual live {
        if (withdrawalState(id) != WithdrawalState.Voting) revert InvalidRequest();
        if (hasObjected[id][msg.sender]) revert AlreadyVoted();
        Withdrawal storage request = withdrawals[id];
        uint256 weight = votingPower.getPastPower(msg.sender, request.snapshotBlock);
        if (weight < minimumPower) revert InsufficientPower();
        if (weight > request.totalPower - request.objections) revert InvalidVotingPower();
        hasObjected[id][msg.sender] = true;
        request.objections += weight;
        emit WithdrawalObjected(id, msg.sender, weight, request.objections);
    }

    function executeWithdrawal(uint256 id) external virtual nonReentrant live {
        if (withdrawalsFrozen()) revert WithdrawalsFrozen();
        if (withdrawalState(id) != WithdrawalState.Approved) revert NotExecutable();
        Withdrawal storage request = withdrawals[id];
        if (currentCycle() != request.cycle || cyclePaid[request.cycle]) revert NotExecutable();
        if (block.timestamp < anchor || (lastSuccessfulWithdrawal != 0 &&
            block.timestamp < lastSuccessfulWithdrawal + WITHDRAWAL_INTERVAL)) revert TooEarly();
        uint256 amount = devVault.availableFunds() / 4;
        if (amount == 0) revert NothingToWithdraw();
        request.executed = true;
        cyclePaid[request.cycle] = true;
        lastSuccessfulWithdrawal = block.timestamp;
        address payable recipient = devRecipient;
        emit WithdrawalExecuted(id, recipient, amount);
        devVault.release(recipient, amount);
    }

    function setDevRecipient(address payable recipient) external onlyDeveloper live {
        if (recipient == address(0) || recipient == address(this) || recipient == address(devVault) ||
            recipient == address(insuranceVault)) revert InvalidRecipient();
        devRecipient = recipient;
        emit DevRecipientChanged(recipient);
    }

    function proposeDeveloperTransfer(address nextDeveloper) external onlyDeveloper {
        if (nextDeveloper == address(0) || nextDeveloper == address(this) || nextDeveloper == developer ||
            nextDeveloper == address(devVault) || nextDeveloper == address(insuranceVault)) revert InvalidRecipient();
        WithdrawalState status = withdrawalState(withdrawalCount);
        if (!terminated && (status == WithdrawalState.Voting || status == WithdrawalState.Approved)) revert RequestPending();
        pendingDeveloper = nextDeveloper;
        developerTransferReadyAt = block.timestamp + DEVELOPER_TRANSFER_DELAY;
        emit DeveloperTransferStarted(developer, nextDeveloper, developerTransferReadyAt);
    }

    function cancelDeveloperTransfer() external onlyDeveloper {
        pendingDeveloper = address(0);
        developerTransferReadyAt = 0;
        emit DeveloperTransferStarted(developer, address(0), 0);
    }

    function acceptDeveloperTransfer() external {
        if (msg.sender != pendingDeveloper) revert Unauthorized();
        if (block.timestamp < developerTransferReadyAt) revert TooEarly();
        WithdrawalState status = withdrawalState(withdrawalCount);
        if (!terminated && (status == WithdrawalState.Voting || status == WithdrawalState.Approved)) revert RequestPending();
        address previous = developer;
        developer = msg.sender;
        devRecipient = payable(msg.sender);
        pendingDeveloper = address(0);
        developerTransferReadyAt = 0;
        emit DeveloperTransferred(previous, msg.sender);
        emit DevRecipientChanged(msg.sender);
    }

    function proposeTermination(bytes32 hash, string calldata uri) external virtual live returns (uint256 id) {
        _validateDisclosure(hash, uri);
        if (terminationCount != 0 &&
            block.timestamp < terminations[terminationCount].endsAt + TERMINATION_COOLDOWN) revert CooldownActive();
        (uint256 snapshot, uint256 total) = _snapshot();
        uint256 power = votingPower.getPastPower(msg.sender, snapshot);
        if (power < minimumTerminationPower) revert InsufficientPower();
        if (power > total) revert InvalidVotingPower();
        id = ++terminationCount;
        uint256 endsAt = block.timestamp + TERMINATION_DURATION;
        terminations[id] = Termination(snapshot, total, endsAt, 0, msg.sender);
        // Proposing is not itself a vote. The proposer may vote separately.
        emit TerminationProposed(id, msg.sender, snapshot, total, endsAt, hash, uri);
    }

    function voteToTerminate(uint256 id) external virtual nonReentrant live {
        if (id == 0 || id != terminationCount || block.timestamp >= terminations[id].endsAt) revert InvalidRequest();
        if (hasVotedToTerminate[id][msg.sender]) revert AlreadyVoted();
        Termination storage proposal = terminations[id];
        uint256 weight = votingPower.getPastPower(msg.sender, proposal.snapshotBlock);
        if (weight == 0) revert InsufficientPower(); // small holders may support termination
        if (weight > proposal.totalPower - proposal.yesPower) revert InvalidVotingPower();
        hasVotedToTerminate[id][msg.sender] = true;
        proposal.yesPower += weight;
        emit TerminationSupported(id, msg.sender, weight, proposal.yesPower);
        if (proposal.yesPower >= Math.mulDiv(proposal.totalPower, 2, 3, Math.Rounding.Ceil)) {
            terminated = true;
            terminatedAt = block.timestamp;
            terminationBlock = block.number;
            settlement.activate(proposal.proposer, proposal.snapshotBlock);
            uint256 devFunds = devVault.availableFunds();
            uint256 insuranceFunds = insuranceVault.availableFunds();
            devVault.seal();
            insuranceVault.seal();
            devVault.settleTo(payable(address(settlement)));
            insuranceVault.settleTo(payable(address(settlement)));
            emit ProjectEnded(id, block.number, devFunds, insuranceFunds);
        }
    }

    /// @notice Expired proposals unfreeze automatically without a finalize tx.
    function withdrawalsFrozen() public view virtual returns (bool) {
        if (terminated) return true;
        if (terminationCount == 0) return false;
        Termination storage proposal = terminations[terminationCount];
        return block.timestamp < proposal.endsAt && proposal.yesPower >= Math.ceilDiv(proposal.totalPower, 2);
    }

    function _initialWithdrawalsFrozen() internal view virtual returns (bool) { return withdrawalsFrozen(); }
    function _withdrawalAmount(uint256 available, bool) internal view virtual returns (uint256) { return available / 4; }

    function _snapshot() private view returns (uint256 snapshot, uint256 total) {
        // Voting and termination compensation use the preceding block.
        snapshot = block.number - 1;
        total = votingPower.getPastTotalPower(snapshot);
        if (total == 0) revert InvalidVotingPower();
    }

    function _publish(uint256 id, bytes32 hash, string calldata uri) private {
        uint256 version = ++disclosureVersions[id];
        if (version == 1) withdrawalDisclosure[id] = hash;
        emit DisclosurePublished(id, version, hash, uri);
    }

    function _validateDisclosure(bytes32 hash, string calldata uri) private pure {
        if (hash == bytes32(0) || bytes(uri).length == 0 || bytes(uri).length > 2048) revert InvalidDisclosure();
    }
}
