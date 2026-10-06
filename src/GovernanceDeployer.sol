// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectGovernance} from "./ProjectGovernance.sol";
import {IProjectVotingPower} from "./interfaces/IProjectVotingPower.sol";
import {CommunityGovernanceDeployer} from "./CommunityGovernance.sol";
import {AllocationVerifier} from "./AllocationVerifier.sol";

/// @dev Separates creation bytecode to keep factory/coordinator below EIP-170.
contract GovernanceDeployer {
    CommunityGovernanceDeployer public immutable communityDeployer = new CommunityGovernanceDeployer();
    function deployCommunity(address developer, IProjectVotingPower policy, AllocationVerifier verifier) external returns (ProjectGovernance) {
        return communityDeployer.deploy(developer, policy, verifier);
    }
    function deploy(address developer, IProjectVotingPower policy) external returns (ProjectGovernance) {
        return new ProjectGovernance(developer, policy);
    }
}
