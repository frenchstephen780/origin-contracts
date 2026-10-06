// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

interface IUpgradeAuthority { function getMinDelay() external view returns (uint256); }
interface IUpgradeFamily { function upgradeFamily() external pure returns (bytes32); }

/// @notice Separate ERC-7201 storage avoids adding fields to inherited ledgers.
/// A timelock controls each UUPS proxy; there is no founder upgrade privilege.
abstract contract UpgradeControl is Initializable, UUPSUpgradeable {
    /// @custom:storage-location erc7201:origin.upgrade.control
    struct Control { address authority; }
    bytes32 private constant CONTROL_SLOT =
        keccak256(abi.encode(uint256(keccak256("origin.upgrade.control")) - 1)) & ~bytes32(uint256(0xff));
    error UnauthorizedUpgrade();
    error InvalidUpgrade();
    function _control() private pure returns (Control storage s) {
        bytes32 slot = CONTROL_SLOT;
        assembly { s.slot := slot }
    }
    function _initializeUpgrade(address authority) internal onlyInitializing {
        if (authority.code.length == 0 || IUpgradeAuthority(authority).getMinDelay() < 2 days) revert InvalidUpgrade();
        _control().authority = authority;
    }
    function upgradeAuthority() public view returns (address) { return _control().authority; }
    function implementationAddress() external view returns (address) { return ERC1967Utils.getImplementation(); }
    function upgradeFamily() public pure virtual returns (bytes32);
    function _authorizeUpgrade(address candidate) internal virtual override {
        if (msg.sender != upgradeAuthority()) revert UnauthorizedUpgrade();
        if (candidate.code.length == 0 || IUpgradeFamily(candidate).upgradeFamily() != upgradeFamily()) revert InvalidUpgrade();
    }
}
