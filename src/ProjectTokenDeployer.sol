// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectToken} from "./ProjectToken.sol";

/// @notice Keeps token creation bytecode out of the escrow/factory runtime.
contract ProjectTokenDeployer {
    function deploy(address escrow, address coordinator, address poolManager) external returns (ProjectToken) {
        return new ProjectToken(escrow, coordinator, poolManager);
    }
}
