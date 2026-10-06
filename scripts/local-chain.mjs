import fs from "node:fs";
import { BrowserProvider, Contract, ContractFactory, id, parseEther } from "ethers";
import { network } from "hardhat";

export function artifact(name) {
  return JSON.parse(fs.readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8"));
}

export async function createLocalChain() {
  // Explicitly creates a new in-process simulated network, never a live RPC.
  const connection = await network.create("hardhat");
  // Optional evidence collection is explicitly enabled by the caller.
  const auditDirectory = process.env.ORIGIN_ENTRYPOINT_AUDIT;
  if (auditDirectory) {
    const {observeEntrypoints} = await import('./entrypoint-observer.mjs');
    observeEntrypoints(connection, auditDirectory);
  }
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  const signers = await Promise.all(Array.from({ length: 6 }, (_, index) => provider.getSigner(index)));
  const rpc = (method, params = []) => connection.provider.request({ method, params });
  const balance = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));
  const timestamp = async () => Number((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const mineAt = async (time) => {
    await rpc("evm_setNextBlockTimestamp", [Number(time)]);
    await rpc("evm_mine");
  };
  async function deploy(name, args = [], signer = signers[0], overrides = {}) {
    const compiled = artifact(name);
    const contract = await new ContractFactory(compiled.abi, compiled.bytecode, signer).deploy(...args, overrides);
    await contract.waitForDeployment();
    return contract;
  }
  async function createProject(factory, {
    target = parseEther("57"),
    deadline,
    creator = signers[1],
    hash = id("stage-one project disclosure"),
    uri = "ipfs://example-project-disclosure",
  } = {}) {
    deadline ??= (await timestamp()) + 3 * 86400;
    const receipt = await (await factory.connect(creator).createProject(target, deadline, hash, uri, {
      value: parseEther("0.02"),
    })).wait();
    const created = receipt.logs.map((log) => {
      try { return factory.interface.parseLog(log); } catch { return null; }
    }).find((log) => log?.name === "ProjectCreated");
    if (!created) throw new Error("ProjectCreated event missing");
    return new Contract(created.args.project, artifact("ProjectEscrow").abi, creator);
  }
  async function close() {
    provider.destroy();
    await connection.close();
  }
  return { connection, provider, signers, rpc, balance, timestamp, mineAt, deploy, createProject, close };
}
