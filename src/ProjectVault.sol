// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice ETH custody controlled exclusively by its deploying governance.
/// No arbitrary calls, delegatecall, upgrade or surplus sweep exists in this
/// vault. With proxy governance, its controller's code can change via timelock.
/// @dev Sealing is irreversible; governance then transfers the accounted balance
/// to the fixed settlement module in the same termination transaction.
contract ProjectVault is ReentrancyGuard {
    address public immutable controller;
    uint256 public availableFunds;
    uint256 public totalDeposited;
    uint256 public totalReleased;
    bool public sealedForSettlement;

    error Unauthorized();
    error VaultSealed();
    error InvalidAmount();
    error InvalidRecipient();
    error EtherTransferFailed();

    event Deposited(address indexed sender, uint256 amount);
    event Released(address indexed recipient, uint256 amount);
    event Sealed(uint256 funds);
    event Settled(address indexed settlement, uint256 amount);

    constructor(address controller_) { require(controller_ != address(0)); controller = controller_; }

    function deposit() public payable {
        if (sealedForSettlement) revert VaultSealed();
        if (msg.value == 0) revert InvalidAmount();
        availableFunds += msg.value;
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function release(address payable recipient, uint256 amount) external nonReentrant {
        if (msg.sender != controller) revert Unauthorized();
        if (sealedForSettlement) revert VaultSealed();
        if (recipient == address(0) || recipient == address(this) || recipient == controller) revert InvalidRecipient();
        if (amount == 0 || amount > availableFunds) revert InvalidAmount();
        availableFunds -= amount;
        totalReleased += amount;
        emit Released(recipient, amount);
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert EtherTransferFailed();
    }

    function seal() external {
        if (msg.sender != controller) revert Unauthorized();
        if (sealedForSettlement) revert VaultSealed();
        sealedForSettlement = true;
        emit Sealed(availableFunds);
    }

    function settleTo(address payable settlement) external nonReentrant {
        if (msg.sender != controller) revert Unauthorized();
        if (!sealedForSettlement || settlement.code.length == 0 || settlement == controller || settlement == address(this)) revert InvalidRecipient();
        uint256 amount = availableFunds;
        if (amount == 0) return;
        availableFunds = 0;
        totalReleased += amount;
        (bool ok,) = settlement.call{value: amount}("");
        if (!ok) revert EtherTransferFailed();
        emit Settled(settlement, amount);
    }

    /// @notice Forced ETH is isolated, never silently counted as fees/principal.
    function unaccountedSurplus() external view returns (uint256) {
        return address(this).balance - availableFunds;
    }

    receive() external payable { deposit(); }
}
