// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface ITransferRewards {
    function token() external view returns (address);
    function capture(address account) external;
    function process(uint256 gasBudget) external;
}
