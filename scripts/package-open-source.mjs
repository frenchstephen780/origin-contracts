import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkPublicFiles} from './check-open-source.mjs';
import {projectRoot, publicFiles, resetOutput} from './public-files.mjs';

checkPublicFiles();
const destination = resetOutput('artifacts/open-source');
const hashes = {};
for (const name of publicFiles().filter(name => name !== 'release-manifest.json')) {
  const content = fs.readFileSync(path.join(projectRoot, name));
  const target = path.join(destination, name);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content);
  hashes[name] = createHash('sha256').update(content).digest('hex');
}
fs.writeFileSync(path.join(destination, 'release-manifest.json'), JSON.stringify({sourceHashes: hashes}, null, 2) + '\n');
console.log(`Prepared ${Object.keys(hashes).length} public files in ${destination}`);
