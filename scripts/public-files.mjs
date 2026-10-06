import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = ['.gitattributes', '.gitignore', '.npmrc', 'LICENSE', 'README.md',
  'hardhat.config.ts', 'package.json', 'package-lock.json'];
const directories = ['.github', 'src', 'scripts', 'test', 'docs'];

function walk(directory) {
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Public directories must not be symlinks');
  return fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Public files must not contain symlinks: ${absolute}`);
      return entry.isDirectory() ? walk(absolute) : [path.relative(projectRoot, absolute).replaceAll('\\', '/')];
    });
}

export function publicFiles() {
  const optional = fs.existsSync(path.join(projectRoot, 'release-manifest.json')) ? ['release-manifest.json'] : [];
  const examples = fs.readdirSync(path.join(projectRoot, 'deployments'))
    .filter(name => name.endsWith('.example.json'))
    .map(name => `deployments/${name}`);
  const files = [...rootFiles, ...optional, ...directories.flatMap(name => walk(path.join(projectRoot, name))), ...examples];
  for (const name of files) {
    if (!fs.lstatSync(path.join(projectRoot, name)).isFile()) throw Error(`Not a regular public file: ${name}`);
  }
  return files.sort();
}

export function resetOutput(relative) {
  const output = path.resolve(projectRoot, relative);
  const artifacts = path.join(projectRoot, 'artifacts') + path.sep;
  if (!output.startsWith(artifacts)) throw Error('Release output must stay inside artifacts');
  if (fs.existsSync(path.join(projectRoot, 'artifacts')) && fs.lstatSync(path.join(projectRoot, 'artifacts')).isSymbolicLink()) throw Error('Artifact directory must not be a symlink');
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw Error('Release output must not be a symlink');
  fs.rmSync(output, {recursive: true, force: true});
  fs.mkdirSync(output, {recursive: true});
  return output;
}
