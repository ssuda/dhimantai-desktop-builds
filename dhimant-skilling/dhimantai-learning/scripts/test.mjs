// Some fixtures execute learner programs. Run the suite inside its course runtime on every desktop OS.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = fileURLToPath(new URL('..', import.meta.url));
const options = process.argv.slice(2);
const tests = readdirSync(resolve(extension, 'out/test'))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => 'out/test/' + name);

const selected = options.some(option => option.endsWith('.test.js')) ? options : [...options, ...tests];
const repo = resolve(extension, '../..');
const args = ['run', '--rm', '--network=none',
  '--volume', repo + ':/workspace:ro',
  '--volume', resolve(extension, 'media/course') + ':/opt/dhimantai:ro',
  '--workdir', '/workspace/dhimant-skilling/dhimantai-learning',
  process.env.DHIMANTAI_TEST_IMAGE || 'docker.io/library/node:22-bookworm',
  'node', '--test', ...selected];
const result = spawnSync('podman', args, { cwd: extension, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
