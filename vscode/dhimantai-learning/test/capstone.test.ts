import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloneCapstone } from '../src/capstoneRepo';

const root = resolve(__dirname, '../..');
const bundle = join(root, 'media/capstone/shelf.bundle');
const tools = spawnSync('git', ['--version']).status === 0 && spawnSync('python3', ['--version']).status === 0;
const refs = (path: string) => execFileSync('git', ['ls-remote', path], {encoding: 'utf8'}).trim();

test('the shipped capstone matches its build script and its judge fails a fresh clone', {skip: !tools && 'needs git and python3'}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'capstone-'));
  try {
    execFileSync('python3', [join(root, 'scripts/capstone/build_shelf.py'), join(folder, 'rebuilt.bundle')]);
    assert.equal(refs(join(folder, 'rebuilt.bundle')), refs(bundle), 'rebuild media/capstone/shelf.bundle after editing the script');
    const repo = join(folder, 'shelf');
    await cloneCapstone(bundle, repo);
    const tests = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'], {cwd: repo, encoding: 'utf8'});
    assert.equal(tests.status, 0, 'the teammate\'s tests pass: the bug is not covered');
    const judge = spawnSync('python3', ['check.py'], {cwd: repo, encoding: 'utf8'});
    assert.equal(judge.status, 1);
    assert.match(judge.stdout, /FAIL Issue #12: 'dune' finds Dune/);
    assert.match(judge.stdout, /2 of 10 checks passed/);
    await assert.rejects(cloneCapstone(bundle, repo), /Could not create the capstone repository/);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});
