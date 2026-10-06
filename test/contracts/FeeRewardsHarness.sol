// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectToken} from "../../src/ProjectToken.sol";
import {ProjectFeeRewards, IWeightedToken, IFeeRewardGovernance} from "../../src/ProjectFeeRewards.sol";
import {ITransferRewards} from "../../src/interfaces/ITransferRewards.sol";

contract FeeRewardsHarness {
    ProjectToken public token;
    ProjectFeeRewards public rewards;
    ProjectFeeRewards public operating;
    address public developer;
    bool public terminated;
    constructor() { developer = msg.sender; }
    function initialize(ProjectToken token_) external {
        _initialize(token_, false);
    }
    function initializeBoth(ProjectToken token_) external {
        _initialize(token_, true);
    }
    function _initialize(ProjectToken token_, bool both) private {
        require(address(token) == address(0));
        require(token_.escrow() == address(this) && token_.coordinator() == address(this));
        token = token_;
        rewards = new ProjectFeeRewards(IWeightedToken(address(token)), IFeeRewardGovernance(address(this)), address(this));
        token.configureFeeRewards(ITransferRewards(address(rewards)));
        if (both) {
            operating = new ProjectFeeRewards(IWeightedToken(address(token)), IFeeRewardGovernance(address(this)), address(this));
            token.configureOperatingRewards(ITransferRewards(address(operating)));
        }
        token.registerLocker(address(rewards));
        token.launch();
    }
    function give(address account, uint256 amount) external { token.transfer(account, amount); }
    function fund() external payable { rewards.deposit{value:msg.value}(); }
    function fundOperating() external payable { operating.deposit{value:msg.value}(); }
    function end() external { terminated = true; }
    // Same-block balance mutation before and after round creation.
    function roundTrip(address account, uint256 amount) external {
        token.transfer(account, amount);
        rewards.process(1_000_000);
        token.transferFrom(account, address(this), amount);
    }
    function changeTwice(address account, uint256 amount) external {
        token.transfer(account,amount);
        token.transferFrom(account,address(this),amount);
    }
    function giveMany(address account, uint256 amount, uint256 count) external {
        for (uint256 i; i < count; ++i) token.transfer(account, amount);
    }
}

contract RejectFeeRewardRecipient {
    function collect(ProjectFeeRewards rewards) external { rewards.claim(); }
    function collectTo(ProjectFeeRewards rewards, address payable recipient) external { rewards.claimTo(recipient); }
    receive() external payable { revert(); }
}
