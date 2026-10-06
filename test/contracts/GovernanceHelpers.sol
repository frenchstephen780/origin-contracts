// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IProjectVotingPower} from "../../src/interfaces/IProjectVotingPower.sol";
import {ProjectGovernance} from "../../src/ProjectGovernance.sol";

/// @dev TEST ONLY: all balances count, no pools or unclaimed allocations exist.
/// This is not the final circulation policy or project token implementation.
contract MockVotingToken is ERC20, IProjectVotingPower {
    using Checkpoints for Checkpoints.Trace208;
    mapping(address => Checkpoints.Trace208) private history;
    Checkpoints.Trace208 private totals;
    uint256 public immutable initialSupply;

    constructor(address[] memory accounts, uint256[] memory amounts) ERC20("Test votes", "TEST") {
        require(accounts.length == amounts.length);
        for (uint256 i; i < accounts.length; ++i) _mint(accounts[i], amounts[i]);
        initialSupply = totalSupply();
    }

    function burn(uint256 amount) external { _burn(msg.sender, amount); }

    function getPastPower(address account, uint256 blockNumber) external view returns (uint256) {
        require(blockNumber < block.number, "past blocks only");
        return history[account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function getPastTotalPower(uint256 blockNumber) external view returns (uint256) {
        require(blockNumber < block.number, "past blocks only");
        return totals.upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        uint48 clock = SafeCast.toUint48(block.number);
        if (from != address(0)) history[from].push(clock, SafeCast.toUint208(balanceOf(from)));
        if (to != address(0)) history[to].push(clock, SafeCast.toUint208(balanceOf(to)));
        if (from == address(0) || to == address(0)) totals.push(clock, SafeCast.toUint208(totalSupply()));
    }
}

/// @dev Intentionally inconsistent policy for zero, overflow and bad-weight tests.
contract BadVotingPolicy is IProjectVotingPower {
    uint256 public immutable initialSupply;
    uint256 private immutable total;
    uint256 private immutable weight;
    constructor(uint256 supply_, uint256 total_, uint256 weight_) {
        initialSupply = supply_;
        total = total_;
        weight = weight_;
    }
    function getPastTotalPower(uint256) external view returns (uint256) { return total; }
    function getPastPower(address, uint256) external view returns (uint256) { return weight; }
}

contract WithdrawalReceiver {
    bool public rejectEther;
    bool public attemptReentry;
    bool public reentrySucceeded;
    uint256 public reentryAttempts;
    ProjectGovernance public governance;
    uint256 public requestId;
    function configure(ProjectGovernance governance_, uint256 id, bool reject_, bool reenter_) external {
        governance = governance_;
        requestId = id;
        rejectEther = reject_;
        attemptReentry = reenter_;
    }
    receive() external payable {
        require(!rejectEther, "reject ETH");
        if (attemptReentry) {
            attemptReentry = false;
            ++reentryAttempts;
            (reentrySucceeded,) = address(governance).call(abi.encodeCall(governance.executeWithdrawal, (requestId)));
        }
    }
}

/// @dev Fault injection AFTER the actual V4 position has been created. Tests
/// must prove that rejecting the final vault deposit rolls the whole launch back.
contract RejectingVault {
    function deposit() external payable { revert("injected vault failure"); }
}
contract RejectingGovernance {
    RejectingVault public immutable devVault = new RejectingVault();
    RejectingVault public immutable insuranceVault = new RejectingVault();
    RejectingVault public immutable settlement = new RejectingVault();
    function terminated() external pure returns (bool) { return false; }
}
contract RejectingGovernanceDeployer {
    function deploy(address, IProjectVotingPower) external returns (ProjectGovernance) {
        return ProjectGovernance(address(new RejectingGovernance()));
    }
}
