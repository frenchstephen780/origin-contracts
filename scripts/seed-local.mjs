import fs from 'node:fs';
import { JsonRpcProvider, JsonRpcSigner, Contract, parseEther } from 'ethers';
import { artifact } from './local-chain.mjs';
const provider = new JsonRpcProvider('http://127.0.0.1:8545', undefined, {cacheTimeout:-1});
if ((await provider.getNetwork()).chainId !== 31337n) throw Error('Local chain only');
const migrationExecutor='0x8330F65fa8DEd47ED944f1981fAe9D9a7633E1d9';
await provider.send('hardhat_impersonateAccount',[migrationExecutor]);
await provider.send('hardhat_setBalance',[migrationExecutor,'0x21e19e0c9bab2400000']);
const migrationSigner=new JsonRpcSigner(provider,migrationExecutor);
const config = JSON.parse(fs.readFileSync(new URL('../deployments/local.json',import.meta.url)));
const factory = new Contract(config.factory,artifact('V4ProjectFactory').abi,await provider.getSigner(1));
const existingCount=await factory.projectCount();
const ideas=[
 {title:'OpenCanvas - Ideas without limits',category:'AI',cover:'forest',summary:'An open AI studio for independent creators, giving every idea a chance to become something real.',description:'OpenCanvas connects text, a shared canvas and composable models so independent creators can focus on their work.\nFunding supports an open-source prototype, inference costs and early user testing. We plan to share weekly progress and spending updates.\nThis is a local test-chain demonstration, not a real team or investment opportunity.',milestones:['Release the open-source canvas and first workflows','Invite 100 creators to test the product','Publish a self-hosted community edition'],target:'10',fund:'6.8'},
 {title:'Atlas - Open onchain maps',category:'Tools',cover:'ocean',summary:'Turn fragmented blockchain data into public knowledge that anyone can understand, verify and use.',description:'Atlas gives developers and everyday users a transparent view of onchain activity through open indexes and reusable visualizations.\nInitial funding supports indexing services, open-source components and community documentation, with regular development updates.\nThis is a local test-chain demonstration, not a real team or investment opportunity.',milestones:['Index public Ethereum data','Release reusable visualization components','Open community data collaboration'],target:'20',fund:'8.4'},
 {title:'Oasis - A place to belong',category:'Others',cover:'amber',summary:'Connect local rescuers and build a sustainable, traceable support network for animals in need.',description:'Oasis connects volunteers and shelters through shared rescue updates, expense records and adoption information.\nFunding supports rescue coordination and a pilot community platform. Onchain records cannot verify offline rescue activity; supporters should review the evidence provided.\nThis is a local test-chain demonstration, not a real team or investment opportunity.',milestones:['Create the first community rescue hub','Publish rescue progress and expense records','Launch volunteer and adoption matching'],target:'5',fund:'1.6'},
 {title:'Common Ground - Work together',category:'AI',cover:'violet',summary:'Help remote teams find their rhythm with a lightweight, quiet space for meaningful collaboration.',description:'Common Ground brings goals, progress and asynchronous conversation together so small teams spend less time switching tools.\nFunding supports a product prototype and user research. This local demo has completed fundraising and migrated to a real local Uniswap V4 pool.\nThis is a local test-chain demonstration, not a real team or investment opportunity.',milestones:['Build the shared workspace prototype','Run trials with small teams','Release the first public version'],target:'2',fund:'2'},
];
async function post(path,body){const r=await fetch('http://127.0.0.1:8080/api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(result.error);return result;}
if(existingCount>0n) console.log('Projects already exist; adding missing demo contributors only.');
for(const [i,idea] of ideas.entries()){
 if(existingCount>0n) break;
 const signer=await provider.getSigner(i+1);const {target,fund,...content}=idea;
 const document={version:1,author:await signer.getAddress(),...content,website:'',demo:true};
 const prepared=await post('/metadata/prepare',document);const signature=await signer.signMessage(prepared.message);
 const saved=await post('/metadata',{document:prepared.document,signature});
 const receipt=await(await factory.connect(signer).createProjectDays(parseEther(target),3,saved.hash,saved.uri,{value:parseEther('0.02')})).wait();
 const event=receipt.logs.map(l=>{try{return factory.interface.parseLog(l)}catch{return null}}).find(l=>l?.name==='ProjectCreated');
 const project=new Contract(event.args.project,artifact('ProjectEscrow').abi,await provider.getSigner(5));
 await(await project.contribute(0,{value:parseEther(fund),gasLimit:16_000_000})).wait();
 if(target===fund) await(await project.connect(migrationSigner).migrate({gasLimit:16_000_000})).wait();
 if(target===fund&&await project.state()!==3n)throw Error('V4 migration failed');
 console.log(`${idea.title}: ${project.target}, state ${await project.state()}`);
}
for(let i=0;i<3&&i<Number(await factory.projectCount());i++){
 const address=await factory.projects(i);
 const project=new Contract(address,artifact('ProjectEscrow').abi,provider);
 const expectedCreator=await (await provider.getSigner(i+1)).getAddress();
 if((await project.creator()).toLowerCase()!==expectedCreator.toLowerCase())continue;
 const uri=await project.metadataURI();
 if(!uri.startsWith('http://127.0.0.1:8080/api/metadata/'))continue;
 const metadata=await(await fetch(uri)).json();
 if(metadata.demo!==true||metadata.title!==ideas[i].title)continue;
 if(await project.state()!==0n)continue;
 for(const [walletIndex,amount] of [[6,'0.5'],[7,'0.25']]){
  const signer=await provider.getSigner(walletIndex);
  const contribution=await project.contributions(await signer.getAddress());
  if(contribution[0]===0n){
   await(await project.connect(signer).contribute(0,{value:parseEther(amount),gasLimit:11_000_000})).wait();
  }
 }
 console.log(`Demo supporter leaderboard ready: ${address}, ${await project.contributorCount()} wallets`);
}
provider.destroy();
