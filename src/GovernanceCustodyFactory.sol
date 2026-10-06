// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectVault} from "./ProjectVault.sol";
import {ProjectSettlement} from "./ProjectSettlement.sol";
import {IProjectVotingPower} from "./interfaces/IProjectVotingPower.sol";

/// @notice Deployment only. Each account is controlled by the calling
/// governance, never by this factory. No upgrade or fund management authority.
contract GovernanceCustodyFactory {
    function deploy(IProjectVotingPower token) external returns (ProjectVault dev, ProjectVault insurance, ProjectSettlement settlement) {
        dev = new ProjectVault(msg.sender);
        insurance = new ProjectVault(msg.sender);
        settlement = new ProjectSettlement(token, msg.sender);
    }
}
