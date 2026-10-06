// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectEscrow} from "../../src/ProjectEscrow.sol";

/// @dev Test-only receiver probes reimbursement reentrancy within the payout limit.
contract MigrationGasWallet {
    ProjectEscrow public project;
    uint256 public reentryResult;
    function migrate(ProjectEscrow project_) external {
        project = project_;
        project_.migrate();
    }
    receive() external payable {
        (bool succeeded,) = address(project).call(
            abi.encodeCall(project.claimMigrationGasRefund, (payable(address(this))))
        );
        reentryResult = succeeded ? 2 : 1;
    }
}
