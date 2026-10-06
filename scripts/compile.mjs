import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import solc from "solc";
import solcV4 from "solc-v4";

export const root = fileURLToPath(new URL("../", import.meta.url));
const sources = {};
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolute);
    else if (entry.name.endsWith(".sol")) {
      sources[path.relative(root, absolute).replaceAll("\\", "/")] = {
        content: fs.readFileSync(absolute, "utf8"),
      };
    }
  }
}
collect(path.join(root, "src"));
collect(path.join(root, "test", "contracts"));

const settings = {
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
  evmVersion: "cancun",
  outputSelection: { "*": { "*": ["abi", "storageLayout", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } },
};
const imports = {};
function resolveImport(importPath) {
    if ((!importPath.startsWith("@openzeppelin/contracts/") && !importPath.startsWith("@uniswap/v4-core/") &&
        !importPath.startsWith("solmate/")) || importPath.includes("..")) {
      return { error: `Unsupported dependency import: ${importPath}` };
    }
    try {
      const dependencyPath = importPath.startsWith("solmate/") ? `@uniswap/v4-core/lib/${importPath}` : importPath;
      const contents = fs.readFileSync(path.join(root, "node_modules", dependencyPath), "utf8");
      imports[importPath] = contents;
      return { contents };
    } catch (error) {
      return { error: error.message };
    }
}
// Resolve the complete dependency graph without generating deployment bytecode.
// The same import whitelist is used here and for the separate upstream build.
const dependencyOutput = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources,
  settings: {...settings, outputSelection: {"*": {"*": ["abi"]}}},
}), { import: resolveImport }));
for (const diagnostic of dependencyOutput.errors ?? []) {
  if (diagnostic.severity === "error") console.error(diagnostic.formattedMessage);
}
if ((dependencyOutput.errors ?? []).some(item => item.severity === "error")) process.exit(1);
const resolvedSources = {...sources, ...Object.fromEntries(Object.entries(imports).map(([name, content]) => [name, {content}]))};
const canonicalSources = Object.fromEntries(Object.keys(resolvedSources).sort().map(name => [name, resolvedSources[name]]));
const standardInput = `${JSON.stringify({language: "Solidity", sources: canonicalSources, settings}, null, 2)}\n`;
// Only this self-contained input produces project artifacts. No import callback
// is used, so explorer compilation receives exactly the input used by this build.
const output = JSON.parse(solc.compile(standardInput));
for (const diagnostic of output.errors ?? []) {
  // selfdestruct is used only by the forced-ETH test constructor.
  if (diagnostic.errorCode === "5159" && diagnostic.sourceLocation?.file.startsWith("test/")) continue;
  console.error(diagnostic.formattedMessage);
}
if ((output.errors ?? []).some((item) => item.severity === "error")) process.exit(1);

const artifactDir = path.join(root, "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
// Archive the exact serialized input supplied to the artifact-producing compiler.
fs.writeFileSync(path.join(artifactDir, "standard-input.json"), standardInput);
const emitted = new Set();
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  if (!sourceName.startsWith("src/") && !sourceName.startsWith("test/")) continue;
  for (const [contractName, result] of Object.entries(contracts)) {
    if (emitted.has(contractName)) throw new Error(`Duplicate artifact name: ${contractName}`);
    emitted.add(contractName);
    const runtimeBytes = result.evm.deployedBytecode.object.length / 2;
    if (runtimeBytes > 24_576) throw new Error(`${contractName} exceeds the EIP-170 runtime size limit`);
    if (result.evm.bytecode.object.length / 2 > 49_152) throw new Error(`${contractName} exceeds the EIP-3860 initcode limit before constructor arguments`);
    const artifact = {
      contractName, sourceName, compilerVersion: solc.version(),
      abi: result.abi,
      bytecode: `0x${result.evm.bytecode.object}`,
      deployedBytecode: `0x${result.evm.deployedBytecode.object}`,
      storageLayout: result.storageLayout,
      immutableReferences: result.evm.deployedBytecode.immutableReferences,
    };
    fs.writeFileSync(path.join(artifactDir, `${contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`${contractName}: ${runtimeBytes} runtime bytes`);
  }
}
// Compile the real pinned PoolManager with its exact upstream compiler pragma.
// No source edits, mocks or patched manager bytecode are involved.
const coreName = "@uniswap/v4-core/src/PoolManager.sol";
const coreContent = resolveImport(coreName).contents;
const coreOutput = JSON.parse(solcV4.compile(JSON.stringify({ language: "Solidity",
  sources: { [coreName]: { content: coreContent } }, settings,
}), { import: resolveImport }));
for (const diagnostic of coreOutput.errors ?? []) {
  if (diagnostic.severity === "error") console.error(diagnostic.formattedMessage);
}
if ((coreOutput.errors ?? []).some(item => item.severity === "error")) process.exit(1);
const manager = coreOutput.contracts[coreName].PoolManager;
const managerBytes = manager.evm.deployedBytecode.object.length / 2;
if (managerBytes > 24576) throw new Error("PoolManager exceeds EIP-170");
fs.writeFileSync(path.join(artifactDir, "PoolManager.json"), `${JSON.stringify({
  contractName: "PoolManager", sourceName: coreName, compilerVersion: solcV4.version(),
  abi: manager.abi, bytecode: `0x${manager.evm.bytecode.object}`,
  deployedBytecode: `0x${manager.evm.deployedBytecode.object}`,
}, null, 2)}\n`);
console.log(`PoolManager (upstream 1.0.2): ${managerBytes} runtime bytes; compiler ${solcV4.version()}`);
const sourceHashes = Object.fromEntries([
  ...Object.entries(sources).map(([name, { content }]) => [name, content]),
  ...Object.entries(imports),
].map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")]));
const artifactHashes = Object.fromEntries([...emitted, "PoolManager"].sort().map(name => {
  const filename = `${name}.json`;
  return [filename, createHash("sha256").update(fs.readFileSync(path.join(artifactDir, filename))).digest("hex")];
}));
fs.writeFileSync(path.join(artifactDir, "build-manifest.json"), `${JSON.stringify({
  compilerVersion: solc.version(), v4CompilerVersion: solcV4.version(), settings, sourceHashes,
  standardInputSHA256: createHash("sha256").update(standardInput).digest("hex"), artifactHashes,
}, null, 2)}\n`);
console.log(`Compiled with ${solc.version()} for ${settings.evmVersion}.`);
