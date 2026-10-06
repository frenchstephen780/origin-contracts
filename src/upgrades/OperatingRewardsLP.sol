// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {UpgradeableProjectRewards} from "./UpgradeableProjectRewards.sol";
import {ProjectFeeRewards, IWeightedToken, IFeeRewardGovernance} from "../ProjectFeeRewards.sol";
import {LPRewardDistributor} from "../LPRewardDistributor.sol";
import {OriginProxy} from "./OriginProxy.sol";

interface ILPSource { function lpDistributor() external view returns (LPRewardDistributor); }
/// @notice Operating deposits: 80% holder custody, 20% V4 LP income, no platform cut.
/// Storage remains compatible with the original reward proxy; no age ledger added.
contract OperatingRewardsLP is UpgradeableProjectRewards {
    event OperatingDepositSplit(address indexed sender, uint256 holdersETH, uint256 lpETH);
    event LPDonationDeferred();
    function deposit() external payable override nonReentrant {
        if (msg.sender != governance.developer()) revert Unauthorized();
        if (governance.terminated() || msg.value == 0) revert InvalidAmount();
        LPRewardDistributor distributor = ILPSource(feeSource).lpDistributor();
        uint256 lpPart = Math.mulDiv(msg.value, 20, 100);
        uint256 holderPart = msg.value - lpPart;
        queuedFunds += holderPart;
        emit Funded(msg.sender, holderPart);
        if (lpPart != 0) {
            distributor.fund{value:lpPart}(address(token));
            try distributor.process{gas:200_000}(address(token)) {} catch { emit LPDonationDeferred(); }
        }
        emit OperatingDepositSplit(msg.sender, holderPart, lpPart);
    }
}
contract ProxyLPRewardsDeployer {
    address public immutable implementation;
    address public immutable operatingImplementation;
    address public immutable authority;
    constructor(address feeImpl, address operatingImpl, address authority_) {
        require(feeImpl.code.length != 0 && operatingImpl.code.length != 0 && authority_.code.length != 0);
        require(UpgradeableProjectRewards(payable(feeImpl)).upgradeFamily() == keccak256("origin.project.rewards.v1"));
        require(UpgradeableProjectRewards(payable(operatingImpl)).upgradeFamily() == keccak256("origin.project.rewards.v1"));
        implementation = feeImpl; operatingImplementation = operatingImpl; authority = authority_;
    }
    function deploy(IWeightedToken token, IFeeRewardGovernance governance, address source) external returns (ProjectFeeRewards) {
        return _deploy(implementation, token, governance, source);
    }
    function deployOperating(IWeightedToken token, IFeeRewardGovernance governance, address source) external returns (ProjectFeeRewards) {
        return _deploy(operatingImplementation, token, governance, source);
    }
    function _deploy(address impl, IWeightedToken token, IFeeRewardGovernance governance, address source) private returns (ProjectFeeRewards) {
        return ProjectFeeRewards(payable(new OriginProxy(impl,
            abi.encodeCall(UpgradeableProjectRewards.initialize, (token, governance, source, authority)))));
    }
}
