import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloneCapstone } from '../src/capstoneRepo';
import { createProject, createReadingProject, loadProjectCurriculum, projectSnapshot } from '../src/projectCore';
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
