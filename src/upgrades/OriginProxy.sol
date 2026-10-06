// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract OriginProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory initializer) ERC1967Proxy(implementation, initializer) {
        // Never expose an uninitialized, externally claimable proxy.
        require(initializer.length >= 4, "initializer required");
    }
}

contract OriginTimelock is TimelockController {
    constructor(uint256 delay, address[] memory proposers, address[] memory executors)
        TimelockController(delay, proposers, executors, address(0)) {
        require(delay >= 2 days && proposers.length > 0 && executors.length > 0, "invalid timelock");
        for (uint256 i; i < proposers.length; ++i) require(proposers[i] != address(0), "zero proposer");
    }
    // Even a self-governed configuration change cannot silently remove the delay.
    function updateDelay(uint256 newDelay) public override {
        require(newDelay >= 2 days, "minimum 48 hours");
        super.updateDelay(newDelay);
    }
}
