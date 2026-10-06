// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Immutable attestation quorum. Signers cannot move funds or change budgets.
contract AllocationVerifier {
    mapping(address => bool) public isValidator;
    uint256 public immutable threshold;
    constructor(address[] memory validators, uint256 threshold_) {
        require(threshold_ > 0 && threshold_ <= validators.length && validators.length <= 16, "invalid quorum");
        for (uint256 i; i < validators.length; ++i) {
            require(validators[i] != address(0) && !isValidator[validators[i]], "invalid validator");
            isValidator[validators[i]] = true;
        }
        threshold = threshold_;
    }
    function verify(bytes32 digest, address[] calldata signers, bytes[] calldata signatures) external view returns (bool) {
        if (signers.length < threshold || signers.length > 16 || signers.length != signatures.length) return false;
        address previous;
        for (uint256 i; i < signers.length; ++i) {
            if (signers[i] <= previous || !isValidator[signers[i]] ||
                !SignatureChecker.isValidSignatureNow(signers[i], digest, signatures[i])) return false;
            previous = signers[i];
        }
        return true;
    }
}
