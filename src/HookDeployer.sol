// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {V4FeeHook} from "./V4FeeHook.sol";

/// @notice CREATE2 deployment for V4 hook address permission bits. Salt mining is
/// off-chain; the hook constructor verifies its actual deployed address flags.
contract HookDeployer {
    function deploy(bytes32 salt, IPoolManager manager, address coordinator, address platform) external returns (V4FeeHook) {
        return new V4FeeHook{salt: salt}(manager, coordinator, platform);
    }
}
