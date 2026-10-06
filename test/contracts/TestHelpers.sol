// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProjectEscrow} from "../../src/ProjectEscrow.sol";
import {ProjectFactory} from "../../src/ProjectFactory.sol";
import {FundraisingCurve} from "../../src/libraries/FundraisingCurve.sol";

contract CurveHarness {
    function tokensAt(uint256 raised, uint256 target) external pure returns (uint256) {
        return FundraisingCurve.tokensAt(raised, target);
    }
}

/// @dev Adversarial test-only wallet; intentionally has no access control.
contract TestWallet {
    bool public rejectEther;
    bool public attemptReentry;
    bool public reentrySucceeded;
    uint256 public reentryAttempts;
    ProjectEscrow public escrow;

    function configure(bool reject_, bool reenter_, ProjectEscrow escrow_) external {
        rejectEther = reject_;
        attemptReentry = reenter_;
        escrow = escrow_;
    }

    function buy(ProjectEscrow project, uint256 minimum) external payable {
        project.contribute{value: msg.value}(minimum);
    }

    function claimRefund(ProjectEscrow project, address payable recipient) external {
        project.refund(recipient);
    }

    function claimFactoryFees(ProjectFactory factory, address payable recipient) external {
        factory.claimCreationFees(recipient);
    }

    function migrate(ProjectEscrow project) external { project.migrate(); }

    function claimMigrationGas(ProjectEscrow project, address payable recipient) external {
        project.claimMigrationGasRefund(recipient);
    }

    receive() external payable {
        require(!rejectEther, "reject ETH");
        if (attemptReentry) {
            attemptReentry = false;
            ++reentryAttempts;
            (reentrySucceeded,) = address(escrow).call(abi.encodeCall(escrow.refund, (payable(address(this)))));
        }
    }
}

contract ForceEther {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}
