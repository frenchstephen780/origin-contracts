import {JsonRpcProvider,isAddress,parseEther} from 'ethers';
const [address,amount='10']=process.argv.slice(2);
if(!address||!isAddress(address))throw Error('Usage: node scripts/fund-wallet.mjs <wallet address> [ETH amount, default 10]');
const value=parseEther(amount);if(value<=0n||value>parseEther('100'))throw Error('Local faucet amount must be > 0 and <= 100 ETH');
const provider=new JsonRpcProvider('http://127.0.0.1:8545');
if((await provider.getNetwork()).chainId!==31337n)throw Error('This helper only supports the local development chain 31337');
const receipt=await(await(await provider.getSigner(0)).sendTransaction({to:address,value})).wait();
console.log(`Sent ${amount} TEST ETH to ${address}. Transaction ${receipt.hash}`);provider.destroy();
