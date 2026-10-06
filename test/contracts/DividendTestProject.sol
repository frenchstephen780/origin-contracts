// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract DividendTestProject {
 address public creator;
 bool public terminated;
 constructor(address dev) {creator=dev;}
 function developer() external view returns(address){return creator;}
 function isProject(address p) external view returns(bool){return p==address(this);}
 function governance() external view returns(address){return address(this);}
 function votingPower() external view returns(address){return address(this);}
 function minimumPower() external pure returns(uint256){return 1;}
 function getPastPower(address,uint256) external pure returns(uint256){return 1;}
 function end() external {terminated=true;}
}
