// Publishes no data and loads no credentials. Run after compile.mjs.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {checkPublicFiles} from './check-open-source.mjs';
import {resetOutput} from './public-files.mjs';
checkPublicFiles();
const root=fileURLToPath(new URL('../',import.meta.url));
const input=JSON.parse(fs.readFileSync(path.join(root,'artifacts/standard-input.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'artifacts/build-manifest.json'),'utf8'));
const destination=resetOutput('artifacts/routing-source');
const published={};
for(const [name,{content}] of Object.entries(input.sources)){
  if(name.startsWith('test/'))continue;
  if(path.isAbsolute(name)||name.split('/').includes('..')||!name.endsWith('.sol'))throw Error(`Unsafe source path: ${name}`);
  const target=path.join(destination,'sources',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
  published[name]=createHash('sha256').update(content).digest('hex');
}
fs.writeFileSync(path.join(destination,'source-manifest.json'),JSON.stringify({compilerVersion:manifest.compilerVersion,settings:manifest.settings,sourceHashes:published},null,2)+'\n');
fs.copyFileSync(path.join(root,'LICENSE'),path.join(destination,'LICENSE'));
const dependencyLicenses = {};
for (const name of ['@openzeppelin/contracts', '@uniswap/v4-core', '@uniswap/v4-core/lib/solmate']) {
  const directory = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  dependencyLicenses[name] = {version: pkg.version, declaredPackageLicense: pkg.license};
  for (const filename of fs.readdirSync(directory).filter(entry => /^licen[cs]e(?:\.|$)/i.test(entry))) {
    const target = path.join(destination, 'dependency-licenses', name.replaceAll('/', '_') + '-' + filename);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(directory, filename), target);
  }
}
fs.writeFileSync(path.join(destination, 'dependency-licenses.json'), JSON.stringify(dependencyLicenses, null, 2) + '\n');
fs.writeFileSync(path.join(destination,'README.md'),'# Origin contract source\n\nThis bundle contains project Solidity sources and their resolved dependencies. Compiler settings and SHA-256 source hashes are recorded in source-manifest.json. Dependency sources retain their original license identifiers; dependency-licenses.json records package license declarations, and available dependency license files are copied separately. The root MIT license applies to project code, not to third-party sources. Explorer verification requires the exact build and constructor arguments corresponding to the deployed address; generating this bundle does not publish or verify any deployment.\n');
console.log(`Prepared ${Object.keys(published).length} Solidity sources in ${destination}`);
