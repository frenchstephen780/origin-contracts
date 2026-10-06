import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {projectRoot, publicFiles} from './public-files.mjs';

// Print locations and finding types only; never print a matched credential.
const rules = [
  ['Chinese text', /\p{Script=Han}/u],
  ['private-key literal', /(?:privateKey|(?:SIGNER|DEPLOYER|VALIDATOR)_PRIVATE_KEY)["']?\s*[:=]\s*["'](?:0x)?[\da-f]{64}["']/i],
  ['mnemonic literal', /(?:mnemonic|seedPhrase)["']?\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/i],
  ['RPC credential', /(?:alchemy\.com\/v2\/|infura\.io\/v3\/)[\w-]{12,}/i],
  ['URL credentials', /https?:\/\/[^\s/:"']+:[^\s/@"']+@/i],
  ['credential literal', /(?:api[_-]?key|secret|password|access[_-]?token)["']?\s*[:=]\s*["'][\w/+.-]{16,}["']/i],
  ['personal path', /(?:[a-z]:[\\/]Users[\\/]|[a-z]:[\\/]work\d*[\\/])/i],
  ['archived release reference', /(?:sepolia-v\d+|(?:current|source|deployed|suite)\s+v(?:[5-9]|1[0-4])\b|verification-20-walle[t]|twenty-wallet-sal[e])/i],
];

export function checkPublicFiles() {
  const files = publicFiles(), findings = [];
  if (fs.existsSync(path.join(projectRoot, '.git'))) {
    const tracked = spawnSync('git', ['-c', `safe.directory=${path.resolve(projectRoot).replaceAll('\\', '/')}`, 'ls-files', '-z'],
      {cwd: projectRoot, encoding: 'utf8'});
    if (tracked.status !== 0) throw Error('Cannot inspect tracked files for the public release');
    const allowed = new Set(files);
    for (const name of tracked.stdout.split('\0').filter(Boolean)) {
      if (!allowed.has(name)) findings.push({file: name, kind: 'tracked file outside public release'});
    }
  }
  for (const name of files) {
    if (/(?:^|\/)(?:\.env(?:\.|$)|.*\.private\.|.*\.(?:key|pem|log)$)/i.test(name)) {
      findings.push({file: name, kind: 'private filename'});
    }
    const content = fs.readFileSync(path.join(projectRoot, name), 'utf8');
    for (const [kind, regex] of rules) {
      if (regex.test(content)) findings.push({file: name, kind});
    }
    if (name.endsWith('.example.json')) {
      const example = JSON.parse(content);
      if (example.rpcUrl || example.privateKey || example.mnemonic) findings.push({file: name, kind: 'populated credential configuration'});
    }
  }
  if (findings.length) throw Error(JSON.stringify({publicFiles: files.length, findings}, null, 2));
  return {publicFiles: files.length, findings: 0};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkPublicFiles()));
}
