// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {CommunityGovernance} from "../CommunityGovernance.sol";
import {ProjectGovernance} from "../ProjectGovernance.sol";
import {IProjectVotingPower} from "../interfaces/IProjectVotingPower.sol";
import {AllocationVerifier} from "../AllocationVerifier.sol";
import {UpgradeControl} from "./UpgradeControl.sol";
import {OriginProxy} from "./OriginProxy.sol";

contract UpgradeableCommunityGovernance is CommunityGovernance, UpgradeControl {
    event ResultVerifierChanged(address previousVerifier, address nextVerifier);
    event NewProposalsPaused(uint256 until);
    /// @custom:storage-location erc7201:origin.governance.maintenance
    struct Maintenance { uint256 until; }
    bytes32 private constant MAINTENANCE_SLOT =
        keccak256(abi.encode(uint256(keccak256("origin.governance.maintenance")) - 1)) & ~bytes32(uint256(0xff));
    function _maintenance() private pure returns (Maintenance storage s) {
        bytes32 slot = MAINTENANCE_SLOT;
        assembly { s.slot := slot }
    }
    function proposalsPausedUntil() external view returns (uint256) { return _maintenance().until; }
    /// @notice Delayed maintenance stops new proposal spam while existing votes finish.
    /// No existing result, payout, or voting deadline is modified. Pause expires automatically.
    function pauseNewProposals() external {
        if (msg.sender != upgradeAuthority()) revert UnauthorizedUpgrade();
        _maintenance().until = block.timestamp + 10 days;
        emit NewProposalsPaused(_maintenance().until);
    }
    function _beforeProposal() internal view override {
        if (block.timestamp < _maintenance().until) revert RequestPending();
    }
    constructor() CommunityGovernance(address(0), IProjectVotingPower(address(0)), AllocationVerifier(address(0))) {
        _disableInitializers();
    }
    function initialize(address founder, IProjectVotingPower token, AllocationVerifier verifier, address authority)
        external initializer {
        _initializeUpgrade(authority);
        _initializeGovernance(founder, token);
        _initializeVerifier(verifier);
    }
    function upgradeFamily() public pure override returns (bytes32) { return keccak256("origin.community.governance.v1"); }
    function _pending(uint256 id) private view returns (bool) {
        State s = proposalState(id);
        return s == State.Active || s == State.AwaitingResult;
    }
    function _requireIdleGovernance() private view {
        if (terminated || _pending(latestTerminationProposal) || _pending(latestTopicProposal()) ||
            _pending(cycleProposal[nextWithdrawalCycle()]) || _pending(cycleProposal[currentCycle()])) revert InvalidUpgrade();
    }
    /// @notice Rotate lost/compromised attestors through the same delay, never
    /// while a proposal is accepting ballots or waiting for its signed result.
    function setResultVerifier(AllocationVerifier next) external {
        if (msg.sender != upgradeAuthority()) revert UnauthorizedUpgrade();
        _requireIdleGovernance();
        if (address(next).code.length == 0 || next.threshold() == 0 || next.threshold() > 16) revert InvalidUpgrade();
        emit ResultVerifierChanged(address(resultVerifier), address(next));
        resultVerifier = next;
    }
    function _authorizeUpgrade(address candidate) internal override {
        super._authorizeUpgrade(candidate);
        // No reinterpretation of an ongoing vote, and no resurrection of a
        // terminated project. Fixes must preserve the existing storage layout.
        _requireIdleGovernance();
    }
}

contract ProxyGovernanceDeployer {
    address public immutable implementation;
    address public immutable authority;
    constructor(address implementation_, address authority_) {
        require(implementation_.code.length != 0 && authority_.code.length != 0);
        require(UpgradeableCommunityGovernance(implementation_).upgradeFamily() == keccak256("origin.community.governance.v1"));
        implementation = implementation_; authority = authority_;
    }
    function deployCommunity(address founder, IProjectVotingPower token, AllocationVerifier verifier)
        external returns (ProjectGovernance) {
        return ProjectGovernance(address(new OriginProxy(implementation,
            abi.encodeCall(UpgradeableCommunityGovernance.initialize, (founder, token, verifier, authority)))));
    }
    function deploy(address, IProjectVotingPower) external pure returns (ProjectGovernance) {
        revert("community verifier required");
    }
}
