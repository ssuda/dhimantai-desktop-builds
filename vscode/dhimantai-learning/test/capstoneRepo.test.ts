import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { restoreEmptyCapstone } from '../src/capstoneRepo';

const extension = resolve(__dirname, '../..'), bundle = join(extension, 'media/projects/rich.bundle');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const oldClone = (root: string, destination: string) => git(root, '-c', 'init.defaultBranch=master', 'clone', '-q', '--origin', 'team', bundle, destination);

test('Rich checks out its source regardless of the machine default branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rich-default-branch-'));
  try {
    for (const branch of ['master', 'main', 'custom']) {
      const folder = join(root, branch);
      // Isolate Git configuration in a child process, without changing the user's settings.
      execFileSync(process.execPath, ['-e',
        'require(process.argv[1]).cloneCapstone(process.argv[2], process.argv[3]).catch(e => {console.error(e); process.exitCode=1;});',
        require.resolve('../src/capstoneRepo'), bundle, folder], {
        env: {...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'init.defaultBranch', GIT_CONFIG_VALUE_0: branch},
      });
      assert.equal(JSON.parse(await readFile(join(folder, '.dhimantai-project.json'), 'utf8')).id, 'rich-reading');
      assert.ok((await readFile(join(folder, 'rich/console.py'), 'utf8')).includes('class Console:'));
      assert.equal(git(folder, 'branch', '--show-current'), 'main');
      assert.equal(git(folder, 'status', '--porcelain'), '');
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('starting Rich again can recover the untouched empty clone left by an older extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rich-empty-recovery-')), folder = join(root, 'rich');
  try {
    oldClone(root, folder);
    assert.deepEqual(await readdir(folder), ['.git']);
    assert.equal(await restoreEmptyCapstone(bundle, folder), true);
    assert.equal(JSON.parse(await readFile(join(folder, '.dhimantai-project.json'), 'utf8')).id, 'rich-reading');
    assert.ok((await readFile(join(folder, 'rich/console.py'), 'utf8')).includes('class Console:'));
    assert.equal(git(folder, 'status', '--porcelain'), '');
    assert.equal(await restoreEmptyCapstone(bundle, folder), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('empty-clone recovery preserves added files, staged work and a different repository revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rich-preserve-')), folder = join(root, 'rich');
  try {
    oldClone(root, folder);
    const note = join(folder, 'my-notes.txt');
    await writeFile(note, 'My reading notes');
    assert.equal(await restoreEmptyCapstone(bundle, folder), false);
    assert.equal(await readFile(note, 'utf8'), 'My reading notes');
    git(folder, 'add', 'my-notes.txt');
    await rm(note);
    assert.equal(await restoreEmptyCapstone(bundle, folder), false);
    assert.equal(git(folder, 'show', ':my-notes.txt'), 'My reading notes');
    git(folder, 'update-index', '--force-remove', 'my-notes.txt');
    git(folder, 'update-ref', 'refs/remotes/team/main', 'refs/remotes/team/main~1');
    assert.equal(await restoreEmptyCapstone(bundle, folder), false);
    assert.deepEqual(await readdir(folder), ['.git']);
  } finally { await rm(root, {recursive: true, force: true}); }
});
