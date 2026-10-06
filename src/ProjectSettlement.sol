// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProjectVotingPower} from "./interfaces/IProjectVotingPower.sol";

/// @notice Pull settlement whose individual weights and denominator are checked onchain.
/// A manifest cannot invent balances or permanently censor a holder. Later deposits
/// increase cumulative entitlements against the same immutable snapshot.
contract ProjectSettlement is ReentrancyGuard {
    address public immutable controller;
    IProjectVotingPower public immutable token;
    uint256 public constant MANIFEST_TIMEOUT = 7 days;
    address public proposer;
    uint256 public activatedAt;
    uint256 public snapshotBlock;
    uint256 public totalPower;
    uint256 public totalDeposited;
    uint256 public totalPaid;
    bytes32 public root;
    bytes32 public snapshotHash;
    string public cid;
    mapping(address => uint256) public claimedAmount;

    error Unauthorized();
    error InvalidSnapshot();
    error InvalidClaim();
    error TooEarly();
    error TransferFailed();
    event Activated(address indexed proposer, uint256 snapshotBlock, uint256 totalPower);
    event ManifestPublished(bytes32 root, bytes32 snapshotHash, string cid);
    event Deposited(address indexed sender, uint256 amount);
    event Claimed(address indexed account, address indexed recipient, uint256 amount);

    constructor(IProjectVotingPower token_, address controller_) { require(controller_ != address(0)); controller = controller_; token = token_; }

    function activate(address proposer_, uint256 snapshot) external {
        if (msg.sender != controller || activatedAt != 0) revert Unauthorized();
        uint256 total = token.getPastTotalPower(snapshot);
        if (proposer_ == address(0) || total == 0) revert InvalidSnapshot();
        proposer = proposer_;
        snapshotBlock = snapshot;
        totalPower = total;
        activatedAt = block.timestamp;
        emit Activated(proposer_, snapshot, total);
    }

    function publish(bytes32 root_, bytes32 hash_, string calldata cid_) external {
        if (activatedAt == 0 || msg.sender != proposer || root != bytes32(0)) revert Unauthorized();
        if (root_ == bytes32(0) || hash_ == bytes32(0) || bytes(cid_).length == 0 || bytes(cid_).length > 128) revert InvalidSnapshot();
        root = root_;
        snapshotHash = hash_;
        cid = cid_;
        emit ManifestPublished(root_, hash_, cid_);
    }

    function deposit() public payable {
        if (activatedAt == 0 || msg.value == 0) revert InvalidSnapshot();
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function leaf(address account, uint256 weight) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), snapshotBlock, account, weight))));
    }

    function claim(uint256 weight, bytes32[] calldata proof, address payable recipient) external nonReentrant {
        if (root == bytes32(0) || !MerkleProof.verifyCalldata(proof, root, leaf(msg.sender, weight))) revert InvalidClaim();
        if (token.getPastPower(msg.sender, snapshotBlock) != weight) revert InvalidClaim();
        _claim(weight, recipient);
    }

    function claimDirect(address payable recipient) external nonReentrant {
        if (activatedAt == 0 || block.timestamp < activatedAt + MANIFEST_TIMEOUT) revert TooEarly();
        _claim(token.getPastPower(msg.sender, snapshotBlock), recipient);
    }

    function claimable(address account) public view returns (uint256) {
        if (activatedAt == 0) return 0;
        uint256 weight = token.getPastPower(account, snapshotBlock);
        if (weight > totalPower) return 0;
        return Math.mulDiv(totalDeposited, weight, totalPower) - claimedAmount[account];
    }

    function _claim(uint256 weight, address payable recipient) private {
        if (recipient == address(0) || recipient == address(this) || recipient == controller || weight == 0 || weight > totalPower) revert InvalidClaim();
        uint256 cumulative = Math.mulDiv(totalDeposited, weight, totalPower);
        uint256 amount = cumulative - claimedAmount[msg.sender];
        if (amount == 0 || amount > totalDeposited - totalPaid) revert InvalidClaim();
        claimedAmount[msg.sender] = cumulative;
        totalPaid += amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, recipient, amount);
    }

    receive() external payable { deposit(); }
}
