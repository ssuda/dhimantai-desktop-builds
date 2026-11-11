import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloneCapstone } from '../src/capstoneRepo';
import { createProject, createReadingProject, createShelfProject, loadProjectCurriculum, projectFolderMissing, projectSnapshot, stageProject } from '../src/projectCore';
import { projectSetupError, validateProjectWorkspace } from '../src/projectSetup';

const media = resolve(__dirname, '../../media');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: 'pipe'}).trim();

test('all project workspaces validate; local editor files are ignored while learner work stays visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-setup-'));
  try {
    for (const id of ['course-agent', 'shelf-reading', 'rich-reading', 'shelf'] as const) {
      const folder = join(root, id);
      if (id === 'course-agent') await createProject(join(media, 'projects/course-agent'), folder);
      else if (id === 'shelf') await cloneCapstone(join(media, 'capstone/shelf.bundle'), folder);
      else await createReadingProject(media, id, folder);
      // Simulate editor files left behind by an earlier version before reopening.
      for (const editor of ['.vscode', '.idea']) {
        await mkdir(join(folder, editor));
        await writeFile(join(folder, editor, 'settings.json'), '{}');
      }
      const before = git(folder, 'rev-parse', 'HEAD');
      await validateProjectWorkspace(media, id, folder);
      assert.equal(git(folder, 'status', '--porcelain'), '');
      const exclusions = await readFile(join(folder, '.git/info/exclude'), 'utf8');
      await validateProjectWorkspace(media, id, folder);
      assert.equal(await readFile(join(folder, '.git/info/exclude'), 'utf8'), exclusions, 'reopening is idempotent');
      git(folder, 'switch', '-c', 'my-work');
      await writeFile(join(folder, 'README.md'), '# My work\n');
      await writeFile(join(folder, 'my-notes.md'), 'My notes\n');
      await validateProjectWorkspace(media, id, folder);
      assert.match(git(folder, 'status', '--porcelain'), /M README.md/);
      assert.match(git(folder, 'status', '--porcelain'), /\?\? my-notes.md/);
      assert.equal(await readFile(join(folder, 'README.md'), 'utf8'), '# My work\n');
      assert.equal(git(folder, 'branch', '--show-current'), 'my-work');
      assert.equal(git(folder, 'rev-parse', 'HEAD'), before);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('Shelf guidance opens and hashes the root fixture; incomplete or mismatched projects are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-files-')), folder = join(root, 'shelf');
  try {
    await createReadingProject(media, 'shelf-reading', folder);
    await validateProjectWorkspace(media, 'shelf-reading', folder);
    const plan = await loadProjectCurriculum(media, 'shelf-reading');
    assert.ok(!JSON.stringify(plan).includes('data/books.json'));
    const step = plan.steps.find(step => step.id === 'data')!;
    const snapshot = await projectSnapshot(folder, plan, step.files);
    assert.equal(snapshot.files[0].path, 'books.json');
    assert.match(snapshot.files[0].text, /Dune/);
    const changed = await projectSnapshot(folder, plan, [], new Map([['books.json', '[]']]));
    assert.notEqual(changed.digest, snapshot.digest, 'fixture changes invalidate run evidence');
    await assert.rejects(validateProjectWorkspace(media, 'rich-reading', folder), /different project/);
    await rm(join(folder, 'books.json'));
    await assert.rejects(validateProjectWorkspace(media, 'shelf-reading', folder), /Required project files.*books.json/);
    await writeFile(join(root, 'elsewhere.json'), '[]');
    await symlink(join(root, 'elsewhere.json'), join(folder, 'books.json'));
    await assert.rejects(validateProjectWorkspace(media, 'shelf-reading', folder), /Required project files.*books.json/);
    await rm(join(folder, '.dhimantai-project.json'));
    await assert.rejects(validateProjectWorkspace(media, 'shelf-reading', folder), /project guide is missing/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('empty, un-checked-out and nested folders cannot be opened as valid project repositories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-empty-'));
  try {
    const empty = join(root, 'empty');
    await mkdir(empty);
    await assert.rejects(validateProjectWorkspace(media, 'rich-reading', empty), /not initialized and checked out/);
    git(empty, 'init', '-b', 'main');
    await assert.rejects(validateProjectWorkspace(media, 'rich-reading', empty), /not initialized and checked out/);
    const unchecked = join(root, 'unchecked');
    git(root, 'clone', '--no-checkout', join(media, 'projects/rich.bundle'), unchecked);
    await assert.rejects(validateProjectWorkspace(media, 'rich-reading', unchecked), /not initialized and checked out/);
    const project = join(root, 'project');
    await createProject(join(media, 'projects/course-agent'), project);
    await assert.rejects(validateProjectWorkspace(media, 'course-agent', join(project, 'course_agent')), /not initialized and checked out/);
    assert.match(projectSetupError(empty, new Error('Missing books.json')), /Missing books.json.*workspace was not opened.*files were kept/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a moved or deleted project folder is reported as missing, not as a missing Git installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-missing-')), gone = join(root, 'course-research-agent');
  try {
    for (const id of ['course-agent', 'shelf']) {
      const error = await validateProjectWorkspace(media, id, gone).then(() => undefined, e => e);
      assert.match(error.message, /Project folder not found/); assert.doesNotMatch(error.message, /Install Git/);
      assert.equal(projectFolderMissing(error), true);
    }
    await assert.rejects(projectSnapshot(gone, await loadProjectCurriculum(media, 'course-agent'), []), /Project folder not found/);
    await writeFile(gone, 'a file, not a folder');
    await assert.rejects(validateProjectWorkspace(media, 'course-agent', gone), /Project folder not found/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('setup builds in a private folder: failures leave nothing behind and learner hooks never run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-staging-')), template = join(root, 'template');
  const previous = process.env.GIT_TEMPLATE_DIR;
  try {
    // A failed build leaves no destination and no staging folder; an existing destination is never replaced.
    await assert.rejects(createProject(join(root, 'no-such-template'), join(root, 'agent')));
    await assert.rejects(stageProject(join(root, 'agent'), async folder => { await mkdir(folder); throw new Error('interrupted'); }), /interrupted/);
    assert.deepEqual((await readdir(root)).sort(), []);
    await mkdir(join(root, 'existing'));
    await assert.rejects(createProject(join(media, 'projects/course-agent'), join(root, 'existing')), /already exists/);
    assert.deepEqual(await readdir(join(root, 'existing')), []);
    // Hooks installed by a Git template (or core.hooksPath) would otherwise block the starter commit and clone.
    await mkdir(join(template, 'hooks'), {recursive: true});
    for (const hook of ['pre-commit', 'commit-msg', 'post-checkout'])
      await writeFile(join(template, 'hooks', hook), '#!/bin/sh\nexit 1\n', {mode: 0o755});
    process.env.GIT_TEMPLATE_DIR = template;
    await createProject(join(media, 'projects/course-agent'), join(root, 'agent'));
    assert.equal(git(join(root, 'agent'), 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git(join(root, 'agent'), 'status', '--porcelain'), '');
    await createReadingProject(media, 'shelf-reading', join(root, 'shelf-reading'));
    await createShelfProject(media, join(root, 'shelf-capstone'));
    await validateProjectWorkspace(media, 'shelf-reading', join(root, 'shelf-reading'));
    await validateProjectWorkspace(media, 'shelf', join(root, 'shelf-capstone'));
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.')), [], 'no staging folders remain');
  } finally {
    if (previous === undefined) delete process.env.GIT_TEMPLATE_DIR; else process.env.GIT_TEMPLATE_DIR = previous;
    await rm(root, {recursive: true, force: true});
  }
});
