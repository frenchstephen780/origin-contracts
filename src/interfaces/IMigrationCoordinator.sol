// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IMigrationCoordinator {
    function poolManager() external view returns (address);
    function createToken() external returns (address);
    function saleSupply(uint256 target) external view returns (uint256);
    function migrationFeeBps() external view returns (uint256);
    function migrationGasRefundLimit() external view returns (uint256);
    function migrationExecutor() external view returns (address);
    function migrationReimbursementGasUnits() external view returns (uint256);
    function saleSupplyForFee(uint256 target, uint256 feeBps) external view returns (uint256);
    function migrate() external payable returns (address governance, address locker, bytes32 poolId);
}
