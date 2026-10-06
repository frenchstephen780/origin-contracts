// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AllocationVerifier} from "./AllocationVerifier.sol";
import {IProjectVotingPower} from "./interfaces/IProjectVotingPower.sol";

interface IDividendFactory { function isProject(address) external view returns (bool); }
interface IDividendProject { function governance() external view returns (address); }
interface IDividendGovernance {
    function terminated() external view returns (bool);
    function developer() external view returns (address);
    function votingPower() external view returns (IProjectVotingPower);
    function minimumPower() external view returns (uint256);
}

/// @notice ETH custody with validator attestations and a public objection window.
/// Validators attest offchain history; they cannot withdraw or redirect funds.
contract ProjectDividends is ReentrancyGuard, EIP712 {
    uint256 public constant CONTRACT_VERSION = 4;
    uint256 public constant REVIEW_DURATION = 12 hours;
    uint256 public constant PUBLISH_TIMEOUT = 7 days;
    bytes32 public constant POLICY = keccak256("holding-age-v3-exponential-90d95pct");
    address public immutable factory;
    AllocationVerifier public immutable verifier;
    // Keep the existing tuple layout for reading older deployments.
    struct Round { uint256 amount; uint256 paid; bytes32 snapshotHash; bytes32 root; uint256 totalWeight; string cid; }
    struct Review {
        uint256 fundedAt;
        uint256 endsAt;
        uint256 snapshotBlock;
        uint256 revision;
        bytes32 objectionsHash;
        bool disputed;
    }
    mapping(address => uint256) public roundCount;
    mapping(address => mapping(uint256 => Round)) public rounds;
    mapping(address => mapping(uint256 => Review)) public reviews;
    mapping(address => mapping(uint256 => mapping(address => bool))) public claimed;
    mapping(address => mapping(uint256 => mapping(uint256 => mapping(address => bool)))) public hasChallenged;
    error Unauthorized(); error InvalidRound(); error InvalidProof(); error TransferFailed(); error ReviewPending();
    event Funded(address indexed project, uint256 indexed round, uint256 amount, bytes32 snapshotHash);
    event Published(address indexed project, uint256 indexed round, bytes32 root, uint256 totalWeight, string cid);
    event Challenged(address indexed project, uint256 indexed round, address indexed account, bytes32 evidence, bytes32 objectionsHash, string details);
    event Resolved(address indexed project, uint256 indexed round, bool accepted, bytes32 objectionsHash);
    event Claimed(address indexed project, uint256 indexed round, address indexed account, uint256 amount);

    constructor(address factory_, AllocationVerifier verifier_) EIP712("Origin Dividends", "4") {
        require(factory_.code.length != 0 && address(verifier_).code.length != 0);
        factory = factory_; verifier = verifier_;
    }
    function _governance(address project) private view returns (IDividendGovernance g) {
        if (!IDividendFactory(factory).isProject(project)) revert Unauthorized();
        address gov = IDividendProject(project).governance();
        if (gov == address(0)) revert Unauthorized();
        return IDividendGovernance(gov);
    }
    function fund(address project, bytes32 snapshotHash) external payable nonReentrant returns (uint256 id) {
        IDividendGovernance g = _governance(project);
        if (g.developer() != msg.sender || g.terminated()) revert Unauthorized();
        if (msg.value == 0 || snapshotHash == bytes32(0)) revert InvalidRound();
        id = ++roundCount[project];
        rounds[project][id].amount = msg.value;
        rounds[project][id].snapshotHash = snapshotHash;
        reviews[project][id].fundedAt = block.timestamp;
        emit Funded(project, id, msg.value, snapshotHash);
    }
    function allocationDigest(address project, uint256 id, bytes32 root, uint256 totalWeight, string calldata cid, uint256 deadline) public view returns (bytes32) {
        Round storage r = rounds[project][id];
        return _hashTypedDataV4(keccak256(abi.encode(
            keccak256("Allocation(address project,uint256 round,uint256 amount,bytes32 snapshotHash,bytes32 root,uint256 totalWeight,bytes32 cidHash,bytes32 policy,uint256 revision,uint256 deadline)"),
            project, id, r.amount, r.snapshotHash, root, totalWeight, keccak256(bytes(cid)), POLICY, reviews[project][id].revision, deadline
        )));
    }
    function publish(address project, uint256 id, bytes32 root, uint256 totalWeight, string calldata cid,
        uint256 deadline, address[] calldata signers, bytes[] calldata signatures) external nonReentrant {
        IDividendGovernance g = _governance(project);
        Round storage r = rounds[project][id]; Review storage v = reviews[project][id];
        // Existing funded rounds remain completable after termination or developer inactivity.
        if (g.developer() != msg.sender && block.timestamp < v.fundedAt + PUBLISH_TIMEOUT) revert Unauthorized();
        if (r.amount == 0 || r.root != bytes32(0) || root == bytes32(0) || totalWeight == 0 || bytes(cid).length == 0 || bytes(cid).length > 128) revert InvalidRound();
        if (block.timestamp > deadline || !verifier.verify(allocationDigest(project,id,root,totalWeight,cid,deadline),signers,signatures)) revert Unauthorized();
        r.root = root; r.totalWeight = totalWeight; r.cid = cid;
        v.endsAt = block.timestamp + REVIEW_DURATION; v.snapshotBlock = block.number - 1;
        v.disputed = false; v.objectionsHash = bytes32(0);
        emit Published(project,id,root,totalWeight,cid);
    }
    function challenge(address project, uint256 id, string calldata details) external {
        bytes32 evidence = keccak256(bytes(details));
        Review storage v = reviews[project][id]; Round storage r = rounds[project][id];
        if (r.root == bytes32(0) || block.timestamp >= v.endsAt || bytes(details).length == 0 || bytes(details).length > 2048 || hasChallenged[project][id][v.revision][msg.sender]) revert InvalidRound();
        IDividendGovernance g = _governance(project);
        if (g.votingPower().getPastPower(msg.sender,v.snapshotBlock) < g.minimumPower()) revert Unauthorized();
        hasChallenged[project][id][v.revision][msg.sender] = true;
        v.objectionsHash = keccak256(abi.encode(v.objectionsHash,msg.sender,evidence));
        v.disputed = true;
        emit Challenged(project,id,msg.sender,evidence,v.objectionsHash,details);
    }
    function resolutionDigest(address project,uint256 id,bool accepted,uint256 deadline) public view returns(bytes32) {
        Review storage v = reviews[project][id];
        return _hashTypedDataV4(keccak256(abi.encode(
            keccak256("Resolution(address project,uint256 round,bytes32 root,uint256 revision,bytes32 objectionsHash,bool accepted,uint256 deadline)"),
            project,id,rounds[project][id].root,v.revision,v.objectionsHash,accepted,deadline
        )));
    }
    // Anyone can relay a quorum-signed decision. All currently recorded objections are bound to it.
    function resolve(address project,uint256 id,bool accepted,uint256 deadline,address[] calldata signers,bytes[] calldata signatures) external nonReentrant {
        Review storage v = reviews[project][id]; Round storage r = rounds[project][id];
        if (!v.disputed || block.timestamp > deadline || !verifier.verify(resolutionDigest(project,id,accepted,deadline),signers,signatures)) revert Unauthorized();
        emit Resolved(project,id,accepted,v.objectionsHash);
        v.disputed = false;
        if (!accepted) {
            r.root = bytes32(0); r.totalWeight = 0; r.cid = "";
            v.endsAt = 0; v.objectionsHash = bytes32(0); ++v.revision;
        }
    }
    function leaf(address project,uint256 id,address account,uint256 weight) public view returns(bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid,address(this),project,id,account,weight))));
    }
    function claim(address project,uint256 id,uint256 weight,bytes32[] calldata proof) external nonReentrant {
        _claim(project,id,weight,proof,payable(msg.sender));
    }
    function claimTo(address project,uint256 id,uint256 weight,bytes32[] calldata proof,address payable recipient) external nonReentrant {
        _claim(project,id,weight,proof,recipient);
    }
    function _claim(address project,uint256 id,uint256 weight,bytes32[] calldata proof,address payable recipient) private {
        Round storage r = rounds[project][id]; Review storage v = reviews[project][id];
        if (v.disputed || v.endsAt == 0 || block.timestamp < v.endsAt) revert ReviewPending();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRound();
        if (r.root == bytes32(0) || weight == 0 || claimed[project][id][msg.sender] || !MerkleProof.verifyCalldata(proof,r.root,leaf(project,id,msg.sender,weight))) revert InvalidProof();
        uint256 amount = Math.mulDiv(r.amount,weight,r.totalWeight);
        if (amount == 0 || amount > r.amount-r.paid) revert InvalidRound();
        claimed[project][id][msg.sender] = true; r.paid += amount;
        (bool ok,) = recipient.call{value:amount}(""); if (!ok) revert TransferFailed();
        emit Claimed(project,id,msg.sender,amount);
    }
}
