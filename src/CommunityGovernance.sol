// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ProjectGovernance} from "./ProjectGovernance.sol";
import {AllocationVerifier} from "./AllocationVerifier.sol";
import {IProjectVotingPower} from "./interfaces/IProjectVotingPower.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

interface IEligibleVotingPower {
    function getPastEligiblePower(uint256 blockNumber) external view returns (uint256);
    function minimumVotingBalance() external view returns (uint256);
    function feeRewards() external view returns (address);
}

/// @notice Offchain signed ballots, public IPFS archive and one attested result
/// transaction. The verifier authenticates the offchain tally; it is a trust
/// dependency and cannot be represented as an onchain proof of that tally.
contract CommunityGovernance is ProjectGovernance, EIP712 {
    uint256 public constant COMMUNITY_VERSION = 2;
    uint256 public constant COMMUNITY_TERMINATION_DURATION = 3 days;
    uint256 public constant TOPIC_DURATION = 3 days;
    uint256 public constant OBJECTION_DURATION = 24 hours;
    uint256 public constant VETO_UPLOAD_DURATION = 24 hours;
    uint256 public constant TERMINATION_UPLOAD_DURATION = 24 hours;
    bytes32 public constant BALLOT_TYPEHASH = keccak256("Ballot(uint256 proposalId,bytes32 snapshotHash,address voter,uint8 support)");
    bytes32 public constant RESULT_TYPEHASH = keccak256("VoteResult(uint256 proposalId,uint256 snapshotBlock,bytes32 snapshotHash,uint256 totalPower,uint256 forVotes,uint256 againstVotes,uint256 abstainVotes,bytes32 archiveHash,bytes32 cidHash,address uploader,uint256 deadline)");
    // Never reinterpret archived ballots: 0 is the legacy veto encoding.
    enum Kind { WithdrawalVeto, Termination, Topic, Withdrawal }
    enum State { None, Active, AwaitingResult, Passed, Defeated, Expired }
    struct Proposal {
        Kind kind;
        address proposer;
        uint256 cycle;
        uint256 snapshotBlock;
        bytes32 snapshotHash;
        uint256 totalPower;
        uint256 startsAt;
        uint256 endsAt;
        uint256 uploadEndsAt;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        bool finalized;
        bool passed;
        bytes32 disclosureHash;
        string disclosureURI;
        bytes32 archiveHash;
        string cid;
    }
    struct Result {
        uint256 proposalId;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        bytes32 archiveHash;
        string cid;
        address uploader;
        uint256 deadline;
    }
    AllocationVerifier public resultVerifier;
    uint256 public proposalCount;
    uint256 public latestTerminationProposal;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => uint256) public cycleProposal;
    mapping(uint256 => bool) public cycleBlocked;
    mapping(uint256 => uint256) private terminationIds;
    // New state is namespaced to preserve the deployed proxy/child layout.
    /// @custom:storage-location erc7201:origin.governance.community.policy
    struct Policy { uint256 lastWithdrawalAt; uint256 latestTopic; mapping(uint256 => bool) earlyTermination; }
    bytes32 private constant POLICY_SLOT = keccak256(abi.encode(uint256(keccak256("origin.governance.community.policy")) - 1)) & ~bytes32(uint256(255));
    function _policy() private pure returns (Policy storage p) {
        bytes32 slot = POLICY_SLOT;
        assembly { p.slot := slot }
    }
    function latestTopicProposal() public view returns (uint256) { return _policy().latestTopic; }
    function nextWithdrawalProposalAt() public view returns (uint256) {
        // An upgrade must also respect proposals created with the previous code.
        uint256 last = _policy().lastWithdrawalAt;
        uint256 cycle = nextWithdrawalCycle();
        uint256 prior = cycleProposal[cycle];
        if (prior == 0 && cycle > 0) prior = cycleProposal[cycle - 1];
        if (prior != 0) last = Math.max(last, proposals[prior].startsAt);
        return last == 0 ? anchor : Math.max(anchor, last + WITHDRAWAL_INTERVAL);
    }
    function nextTerminationProposalAt() public view returns (uint256) {
        return latestTerminationProposal == 0 ? anchor : Math.max(anchor,
            proposals[latestTerminationProposal].startsAt + TERMINATION_COOLDOWN);
    }
    function supportsEarlyTermination(uint256 id) public view returns (bool) { return _policy().earlyTermination[id]; }
    error InvalidResult();
    error InvalidSignature();
    error LegacyVotingDisabled();
    event CommunityProposalCreated(uint256 indexed id, Kind kind, address indexed proposer,
        uint256 cycle, uint256 snapshotBlock, uint256 totalPower, uint256 endsAt, uint256 uploadEndsAt);
    event CommunityResultFinalized(uint256 indexed id, address indexed uploader, bool passed,
        uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, bytes32 archiveHash, string cid);

    constructor(address dev, IProjectVotingPower token, AllocationVerifier verifier)
        ProjectGovernance(dev, token) EIP712("OriginCommunityGovernance", "1") {
        if (dev != address(0)) _initializeVerifier(verifier);
    }

    function _initializeVerifier(AllocationVerifier verifier) internal {
        if (address(resultVerifier) != address(0) || address(verifier).code.length == 0) revert InvalidConfiguration();
        resultVerifier = verifier;
    }

    function cycleUnlockAt(uint256 cycle) public view returns (uint256) {
        return anchor + cycle * WITHDRAWAL_INTERVAL;
    }

    /// @notice Eligibility and denominator use the SAME fixed token ledger.
    function votingMinimum() public view returns (uint256) {
        return IEligibleVotingPower(address(votingPower)).minimumVotingBalance();
    }

    function _beforeProposal() internal view virtual {}

    function nextWithdrawalCycle() public view returns (uint256) {
        return currentCycle() + 1;
    }

    function proposalState(uint256 id) public view returns (State) {
        if (id == 0 || id > proposalCount) return State.None;
        Proposal storage p = proposals[id];
        if (p.finalized) return p.passed ? State.Passed : State.Defeated;
        if (block.timestamp < p.endsAt) return State.Active;
        if (block.timestamp < p.uploadEndsAt) return State.AwaitingResult;
        return State.Expired;
    }

    function proposeWithdrawalVeto(uint256 cycle, bytes32 hash, string calldata uri)
        external live returns (uint256 id) {
        if (block.timestamp < nextWithdrawalProposalAt()) revert TooEarly();
        // Only the upcoming weekly slot can be voted on. First claim remains vote-free.
        if (cycle == 0 || cycle != nextWithdrawalCycle() || cycleProposal[cycle] != 0) revert InvalidRequest();
        uint256 unlock = cycleUnlockAt(cycle);
        uint256 end = block.timestamp + OBJECTION_DURATION;
        if (unlock <= end) revert WindowClosed();
        uint256 uploadEnd = Math.min(end + VETO_UPLOAD_DURATION, unlock);
        id = _create(Kind.Withdrawal, cycle, end, uploadEnd, hash, uri, votingMinimum());
        cycleProposal[cycle] = id;
        _policy().lastWithdrawalAt = block.timestamp;
    }

    function proposeTermination(bytes32 hash, string calldata uri) external override live returns (uint256 id) {
        if (block.timestamp < anchor) revert TooEarly();
        if (block.timestamp < nextTerminationProposalAt()) revert CooldownActive();
        if (_terminationPending()) revert RequestPending();
        uint256 end = block.timestamp + COMMUNITY_TERMINATION_DURATION;
        id = _create(Kind.Termination, 0, end, end + TERMINATION_UPLOAD_DURATION, hash, uri,
            msg.sender == developer ? 0 : minimumTerminationPower);
        latestTerminationProposal = id;
        _policy().earlyTermination[id] = true;
        uint256 legacyId = ++terminationCount;
        terminationIds[id] = legacyId;
        Proposal storage p = proposals[id];
        // Settlement's compensation denominator remains ALL eligible raw wallet
        // balances, including small wallets; it is distinct from voting quorum.
        terminations[legacyId] = Termination(p.snapshotBlock, votingPower.getPastTotalPower(p.snapshotBlock), end, 0, msg.sender);
        emit TerminationProposed(legacyId, msg.sender, p.snapshotBlock, p.totalPower, end, hash, uri);
    }

    /// @notice Community direction only: no arbitrary calls or treasury execution.
    function proposeTopic(bytes32 hash, string calldata uri) external onlyDeveloper live returns (uint256 id) {
        if (block.timestamp < anchor) revert TooEarly();
        uint256 latest = latestTopicProposal();
        if (proposalState(latest) == State.Active || proposalState(latest) == State.AwaitingResult) revert RequestPending();
        uint256 end = block.timestamp + TOPIC_DURATION;
        id = _create(Kind.Topic, 0, end, end + VETO_UPLOAD_DURATION, hash, uri, 0);
        _policy().latestTopic = id;
    }

    function _create(Kind kind, uint256 cycle, uint256 end, uint256 uploadEnd,
        bytes32 hash, string calldata uri, uint256 proposerMinimum) private returns (uint256 id) {
        _beforeProposal();
        if (hash == bytes32(0) || bytes(uri).length == 0 || bytes(uri).length > 2048) revert InvalidDisclosure();
        uint256 snapshot = block.number - 1;
        uint256 total = IEligibleVotingPower(address(votingPower)).getPastEligiblePower(snapshot);
        if (total == 0) revert InvalidVotingPower();
        if (votingPower.getPastPower(msg.sender, snapshot) < proposerMinimum) revert InsufficientPower();
        id = ++proposalCount;
        Proposal storage p = proposals[id];
        p.kind = kind; p.proposer = msg.sender; p.cycle = cycle; p.snapshotBlock = snapshot;
        p.snapshotHash = blockhash(snapshot);
        p.totalPower = total; p.startsAt = block.timestamp; p.endsAt = end; p.uploadEndsAt = uploadEnd;
        p.disclosureHash = hash; p.disclosureURI = uri;
        emit CommunityProposalCreated(id, kind, msg.sender, cycle, snapshot, total, end, uploadEnd);
    }

    function ballotDigest(uint256 proposalId, address voter, uint8 support) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BALLOT_TYPEHASH, proposalId, proposals[proposalId].snapshotHash, voter, support)));
    }

    function validBallot(uint256 id, address voter, uint8 support, bytes calldata signature) external view returns (bool) {
        return id != 0 && id <= proposalCount && support <= 2 &&
            votingPower.getPastPower(voter, proposals[id].snapshotBlock) >= votingMinimum() &&
            SignatureChecker.isValidSignatureNow(voter, ballotDigest(id, voter, support), signature);
    }

    function resultDigest(Result calldata r) public view returns (bytes32) {
        Proposal storage p = proposals[r.proposalId];
        return _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, r.proposalId, p.snapshotBlock,
            p.snapshotHash, p.totalPower, r.forVotes, r.againstVotes, r.abstainVotes, r.archiveHash,
            keccak256(bytes(r.cid)), r.uploader, r.deadline)));
    }

    function finalizeResult(Result calldata r, uint8 uploaderSupport, bytes calldata uploaderBallot,
        address[] calldata signers, bytes[] calldata signatures) external nonReentrant live {
        Proposal storage p = proposals[r.proposalId];
        State state = proposalState(r.proposalId);
        bool early = state == State.Active && p.kind == Kind.Termination && supportsEarlyTermination(r.proposalId) &&
            r.forVotes >= Math.mulDiv(p.totalPower, 2, 3, Math.Rounding.Ceil);
        if ((!early && state != State.AwaitingResult) || r.uploader != msg.sender ||
            block.timestamp > r.deadline || r.deadline > p.uploadEndsAt ||
            r.archiveHash == bytes32(0) || bytes(r.cid).length == 0 || bytes(r.cid).length > 128) revert InvalidResult();
        // Attestation binds this uploader, and they also prove an eligible ballot.
        // Inclusion in the archived accepted-vote set is checked by the verifier.
        if (uploaderSupport > 2 || votingPower.getPastPower(msg.sender, p.snapshotBlock) < votingMinimum() ||
            !SignatureChecker.isValidSignatureNow(msg.sender, ballotDigest(r.proposalId, msg.sender, uploaderSupport), uploaderBallot) ||
            !resultVerifier.verify(resultDigest(r), signers, signatures)) revert InvalidSignature();
        if (r.forVotes > p.totalPower || r.againstVotes > p.totalPower - r.forVotes ||
            r.abstainVotes > p.totalPower - r.forVotes - r.againstVotes) revert InvalidVotingPower();
        p.forVotes = r.forVotes; p.againstVotes = r.againstVotes; p.abstainVotes = r.abstainVotes;
        p.archiveHash = r.archiveHash; p.cid = r.cid; p.finalized = true;
        uint256 threshold = p.kind == Kind.WithdrawalVeto || p.kind == Kind.Withdrawal || p.kind == Kind.Topic ? Math.ceilDiv(p.totalPower, 2) :
            Math.mulDiv(p.totalPower, 2, 3, Math.Rounding.Ceil);
        p.passed = r.forVotes >= threshold;
        emit CommunityResultFinalized(r.proposalId, msg.sender, p.passed, r.forVotes, r.againstVotes,
            r.abstainVotes, r.archiveHash, r.cid);
        if (p.passed && p.kind == Kind.WithdrawalVeto) cycleBlocked[p.cycle] = true;
        // Direct meaning: For permits withdrawal, Against blocks withdrawal.
        if (p.kind == Kind.Withdrawal && r.againstVotes >= threshold) cycleBlocked[p.cycle] = true;
        if (p.passed && p.kind == Kind.Termination) _terminate(p, terminationIds[r.proposalId]);
    }

    function claimWeeklyWithdrawal() external onlyDeveloper nonReentrant live {
        if (withdrawalsFrozen()) revert WithdrawalsFrozen();
        uint256 cycle = currentCycle();
        if (!initialWithdrawalClaimed || cycle == 0 || cyclePaid[cycle] || cycleBlocked[cycle]) revert NotExecutable();
        if (block.timestamp < lastSuccessfulWithdrawal + WITHDRAWAL_INTERVAL) revert TooEarly();
        uint256 amount = _withdrawalAmount(devVault.availableFunds(), false);
        if (amount == 0) revert NothingToWithdraw();
        cyclePaid[cycle] = true; lastSuccessfulWithdrawal = block.timestamp;
        emit WithdrawalExecuted(cycle, devRecipient, amount);
        devVault.release(devRecipient, amount);
    }

    function _terminate(Proposal storage p, uint256 id) private {
        terminated = true; terminatedAt = block.timestamp; terminationBlock = block.number;
        settlement.activate(p.proposer, p.snapshotBlock);
        uint256 devFunds = devVault.availableFunds(); uint256 insuranceFunds = insuranceVault.availableFunds();
        devVault.seal(); insuranceVault.seal();
        address rewards = IEligibleVotingPower(address(votingPower)).feeRewards();
        if (rewards.code.length == 0) revert InvalidConfiguration();
        devVault.settleTo(payable(rewards)); insuranceVault.settleTo(payable(address(settlement)));
        emit ProjectEnded(id, block.number, devFunds, insuranceFunds);
    }

    // A public onchain termination proposal freezes withdrawals until resolved/expired.
    // Offchain intermediate tallies cannot terminate a project.
    function _terminationPending() internal view returns (bool) {
        State s = proposalState(latestTerminationProposal);
        return s == State.Active || s == State.AwaitingResult;
    }
    function withdrawalsFrozen() public view override returns (bool) {
        return terminated || cycleBlocked[currentCycle()] || _terminationPending();
    }
    // A delayed first claim is still vote-free, even if a weekly cycle was vetoed.
    function _initialWithdrawalsFrozen() internal view override returns (bool) { return terminated || _terminationPending(); }
    function requestWithdrawal(bytes32, string calldata) external pure override returns (uint256) { revert LegacyVotingDisabled(); }
    function objectToWithdrawal(uint256) external pure override { revert LegacyVotingDisabled(); }
    function executeWithdrawal(uint256) external pure override { revert LegacyVotingDisabled(); }
    function voteToTerminate(uint256) external pure override { revert LegacyVotingDisabled(); }
}

/// @notice Fixed clones have no upgrade authority. Initialization is bound
/// to their deploying factory and happens atomically with creation.
contract FixedCommunityGovernance is CommunityGovernance {
    address private immutable deployer = msg.sender;
    constructor() CommunityGovernance(address(0), IProjectVotingPower(address(0)), AllocationVerifier(address(0))) {}
    function initializeFixed(address dev, IProjectVotingPower token, AllocationVerifier verifier) external {
        if (msg.sender != deployer) revert Unauthorized();
        _initializeGovernance(dev, token); _initializeVerifier(verifier);
    }
}
contract CommunityGovernanceDeployer {
    address private immutable implementation = address(new FixedCommunityGovernance());
    function deploy(address developer, IProjectVotingPower policy, AllocationVerifier verifier) external returns (ProjectGovernance) {
        FixedCommunityGovernance clone = FixedCommunityGovernance(Clones.clone(implementation));
        clone.initializeFixed(developer, policy, verifier);
        return clone;
    }
}
