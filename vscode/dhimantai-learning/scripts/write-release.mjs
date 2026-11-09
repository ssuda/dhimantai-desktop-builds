import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const output = resolve(process.argv[2]);
const vsix = await readFile(resolve(root, `dhimantai-learning-${pkg.version}.vsix`));
// Validate the same bytes we publish; a hash alone can bless a corrupt archive.
execFileSync('python3', [resolve(root, 'scripts/validate-vsix.py'), JSON.stringify(pkg)], { input: vsix });
await mkdir(output, { recursive: true });
const temporary = resolve(output, `.dhimantai-learning-${process.pid}.vsix`);
await writeFile(temporary, vsix);
await rename(temporary, resolve(output, 'dhimantai-learning.vsix'));
await writeFile(resolve(output, 'dhimantai-learning.json'), JSON.stringify({
  extension: `${pkg.publisher}.${pkg.name}`, version: pkg.version, file: 'dhimantai-learning.vsix',
  sha256: createHash('sha256').update(vsix).digest('hex'),
}, null, 2) + '\n');
