// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {V4ProjectFactory} from "./V4ProjectFactory.sol";
import {ProjectEscrow} from "./ProjectEscrow.sol";
import {IMigrationCoordinator} from "./interfaces/IMigrationCoordinator.sol";

/// @notice Founder deposits are separate from project principal and platform fees.
contract RefundableV4ProjectFactory is V4ProjectFactory {
    mapping(address => uint256) public creationDeposits;
    uint256 public outstandingCreationDeposits;
    error FundingOutcomePending();
    event CreationDepositRecorded(address indexed project, address indexed creator, uint256 amount);
    event CreationDepositClaimed(address indexed project, address indexed creator, address recipient, uint256 amount);

    constructor(address platform, IMigrationCoordinator coordinator_) V4ProjectFactory(platform, coordinator_) {}
    function CONTRACT_VERSION() external pure virtual override returns (uint256) { return 8; }
    function _recordCreationFee(address project) internal override {
        creationDeposits[project] = msg.value;
        outstandingCreationDeposits += msg.value;
        emit CreationDepositRecorded(project, msg.sender, msg.value);
    }
    function creationDepositClaimable(address project) public view returns (bool) {
        if (!isProject[project] || creationDeposits[project] == 0) return false;
        ProjectEscrow.State state = ProjectEscrow(payable(project)).state();
        return state == ProjectEscrow.State.Launched || state == ProjectEscrow.State.Refunding;
    }
    /// @notice Unlocks after migration or failure, including the 72-hour
    /// migration timeout. The current manager owns a launched project's deposit.
    function claimCreationDeposit(address project, address payable recipient) external nonReentrant {
        if (!isProject[project] || ProjectEscrow(payable(project)).creatorBeneficiary() != msg.sender) revert Unauthorized();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = creationDeposits[project];
        if (amount == 0) revert NothingToClaim();
        if (!creationDepositClaimable(project)) revert FundingOutcomePending();
        creationDeposits[project] = 0;
        outstandingCreationDeposits -= amount;
        emit CreationDepositClaimed(project, msg.sender, recipient, amount);
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert EtherTransferFailed();
    }
}
