// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ProjectEscrow} from "./ProjectEscrow.sol";
import {IMigrationCoordinator} from "./interfaces/IMigrationCoordinator.sol";

/// @notice Registers independent escrows. The platform can claim creation fees
/// only; it has no authority over project principal.
contract ProjectFactory is ReentrancyGuard {
    function CONTRACT_VERSION() external pure virtual returns (uint256) { return 7; }
    uint256 public constant CREATION_FEE = 0.02 ether;
    uint256 public constant DEFAULT_FUNDING_DAYS = 3;
    uint256 public constant MAX_FUNDING_DAYS = 15;
    address public immutable platformTreasury;
    uint256 public accruedCreationFees;
    uint256 public accruedMigrationFees;
    mapping(address => bool) public migrationFeeRecorded;
    address[] public projects;
    mapping(address => bool) public isProject;

    error InvalidTreasury();
    error IncorrectCreationFee();
    error Unauthorized();
    error InvalidRecipient();
    error NothingToClaim();
    error EtherTransferFailed();
    error DirectEtherNotAccepted();
    error InvalidDuration();

    event ProjectCreated(
        uint256 indexed projectId,
        address indexed project,
        address indexed creator,
        uint256 target,
        uint256 deadline,
        bytes32 metadataHash,
        string metadataURI
    );
    event CreationFeesClaimed(address indexed recipient, uint256 amount);
    event MigrationFeeRecorded(address indexed project, uint256 amount);
    event MigrationFeesClaimed(address indexed recipient, uint256 amount);

    constructor(address platformTreasury_) {
        if (platformTreasury_ == address(0)) revert InvalidTreasury();
        platformTreasury = platformTreasury_;
    }

    function createProject(uint256 target, uint256 deadline, bytes32 metadataHash, string calldata metadataURI)
        external payable nonReentrant returns (address project)
    {
        return _createProject(target, deadline, metadataHash, metadataURI);
    }

    function createProjectDays(uint256 target, uint256 durationDays, bytes32 metadataHash, string calldata metadataURI)
        external payable nonReentrant returns (address project)
    {
        if (durationDays == 0 || durationDays > MAX_FUNDING_DAYS) revert InvalidDuration();
        return _createProject(target, block.timestamp + durationDays * 1 days, metadataHash, metadataURI);
    }

    function _createProject(uint256 target, uint256 deadline, bytes32 metadataHash, string calldata metadataURI)
        private returns (address project)
    {
        if (msg.value != CREATION_FEE) revert IncorrectCreationFee();
        _validateMigrationTarget(target);
        project = address(new ProjectEscrow(msg.sender, target, deadline, metadataHash, metadataURI, _coordinator()));
        uint256 projectId = projects.length;
        projects.push(project);
        isProject[project] = true;
        _recordCreationFee(project);
        emit ProjectCreated(projectId, project, msg.sender, target, deadline, metadataHash, metadataURI);
    }

    function createNamedProjectDays(uint256 target, uint256 durationDays, bytes32 metadataHash,
        string calldata metadataURI, string calldata tokenName, string calldata tokenSymbol)
        external payable nonReentrant returns (address project)
    {
        if (durationDays == 0 || durationDays > MAX_FUNDING_DAYS) revert InvalidDuration();
        project = _createProject(target, block.timestamp + durationDays * 1 days, metadataHash, metadataURI);
        ProjectEscrow(payable(project)).configureTokenMetadata(tokenName, tokenSymbol);
    }

    function projectCount() external view returns (uint256) {
        return projects.length;
    }

    function _coordinator() internal view virtual returns (IMigrationCoordinator) {
        return IMigrationCoordinator(address(0));
    }

    function _validateMigrationTarget(uint256) internal pure virtual {}

    function _recordCreationFee(address) internal virtual { accruedCreationFees += msg.value; }

    function depositMigrationFee(address project) external payable {
        if (msg.sender != address(_coordinator()) || !isProject[project] || migrationFeeRecorded[project]) {
            revert Unauthorized();
        }
        migrationFeeRecorded[project] = true;
        accruedMigrationFees += msg.value;
        emit MigrationFeeRecorded(project, msg.value);
    }

    function claimMigrationFees(address payable recipient) external nonReentrant {
        if (msg.sender != platformTreasury) revert Unauthorized();
        _claimMigrationFees(recipient);
    }

    /// @notice Anyone may forward fees to the fixed platform beneficiary.
    /// No caller-supplied recipient and no access to refundable creation deposits.
    function collectMigrationFees() external nonReentrant {
        _claimMigrationFees(payable(platformTreasury));
    }

    function _claimMigrationFees(address payable recipient) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = accruedMigrationFees;
        if (amount == 0) revert NothingToClaim();
        accruedMigrationFees = 0;
        emit MigrationFeesClaimed(recipient, amount);
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert EtherTransferFailed();
    }

    /// @dev Pull-based collection so an unavailable treasury cannot block launches.
    function claimCreationFees(address payable recipient) external nonReentrant {
        if (msg.sender != platformTreasury) revert Unauthorized();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = accruedCreationFees;
        if (amount == 0) revert NothingToClaim();
        accruedCreationFees = 0;
        emit CreationFeesClaimed(recipient, amount);
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert EtherTransferFailed();
    }

    receive() external payable {
        revert DirectEtherNotAccepted();
    }
}
