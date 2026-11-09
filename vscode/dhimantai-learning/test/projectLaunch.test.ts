import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { projectWorkspace } from '../src/projectWorkspace';
import { CATALOG_PROJECTS } from '../src/catalogProjects';

const extension = resolve(__dirname, '../..');

async function launch(options: {choice?: string; existing?: boolean; failure?: 'create' | 'open'; cancelSetup?: boolean; target?: string}) {
  const directory = await mkdtemp(join(tmpdir(), 'project-launch-'));
  const storage = join(directory, 'storage'), parent = join(directory, 'course');
  const id = options.target ?? 'course-agent';
  const destination = join(parent, id === 'course-agent' ? 'course-research-agent' : id === 'shelf' ? 'shelf-capstone' : id);
  const uri = (fsPath: string) => ({fsPath});
  const opened: {path: string; options: Record<string, boolean>}[] = [], errors: string[] = [], prompts: any[][] = [];
  let command: (target?: string) => Promise<void> = async () => {};
  let title = CATALOG_PROJECTS.find(p => p.id === id)?.title ?? '', creations = 0, restorations = 0, selections = 0;
  const prepare = async (_source: string, path: string) => {
    creations++;
    if (options.failure === 'create') throw new Error('Project creation failed');
    await mkdir(path, {recursive: true});
  };
  try {
    await mkdir(options.existing ? destination : parent, {recursive: true});
    const sentinel = join(destination, 'learner-work.txt');
    if (options.existing) await writeFile(sentinel, 'Keep my changes');
    const vscode = {
      Uri: {file: uri, joinPath: (base: any, ...parts: string[]) => uri(join(base.fsPath, ...parts))},
      commands: {
        registerCommand: (_name: string, callback: typeof command) => { command = callback; },
        executeCommand: async (name: string, target?: any, settings?: any) => {
          if (name === 'dhimantai.setupCourse') return options.cancelSetup ? undefined : uri(parent);
          assert.equal(name, 'vscode.openFolder');
          if (options.failure === 'open') throw new Error('Window could not open');
          opened.push({path: target.fsPath, options: settings});
        },
      },
      window: {
        showQuickPick: async (items: any[]) => { selections++; const item = items.find(p => p.id === id); title = item.label; return item; },
        showInformationMessage: async (...args: any[]) => { prompts.push(args); return options.choice; },
        showErrorMessage: (message: string) => { errors.push(message); },
      },
    };
    const sandbox = {exports: {}, Error, require: (name: string) => name === 'vscode' ? vscode
      : name === './projectCore' ? {createProject: prepare, createReadingProject: prepare}
      : name === './capstoneRepo' ? {cloneCapstone: prepare, restoreEmptyCapstone: async () => { restorations++; return true; }}
      : name === './projectSetup' ? {...require('../src/projectSetup'), validateProjectWorkspace: async () => {}}
      : name.startsWith('./') ? require('../src/' + name.slice(2)) : require(name)};
    runInNewContext(readFileSync(join(extension, 'out/src/capstone.js'), 'utf8'), sandbox);
    (sandbox.exports as any).registerCapstone({extensionUri: uri(extension), globalStorageUri: uri(storage)});
    await command(options.target);
    return {opened, errors, prompts, title, creations, restorations, selections, destination, storageExists: existsSync(storage),
      saved: existsSync(destination), preserved: options.existing ? await readFile(sentinel, 'utf8') : undefined,
      workspace: opened.length ? JSON.parse(await readFile(opened[0].path, 'utf8')) : undefined};
  } finally { await rm(directory, {recursive: true, force: true}); }
}

test('new and existing projects explain the destination and honour both explicit window choices', async () => {
  for (const existing of [false, true]) for (const choice of ['Open in New Window', 'Open in Current Window']) {
    const result = await launch({existing, choice});
    assert.deepEqual(result.errors, []);
    assert.equal(result.creations, existing ? 0 : 1);
    assert.equal(result.prompts.length, 1);
    const [message, options, ...actions] = result.prompts[0];
    assert.ok(message.includes(result.title));
    assert.match(message, existing ? /project ready/ : /project created/);
    assert.equal(options.modal, true);
    assert.ok(options.detail.includes(result.destination));
    assert.match(options.detail, /keep your current workspace open/);
    assert.match(options.detail, /replace this workspace/);
    assert.deepEqual(actions, ['Open in New Window', 'Open in Current Window']);
    assert.equal(result.opened.length, 1);
    assert.equal(JSON.stringify(result.opened[0].options), JSON.stringify(choice === 'Open in New Window'
      ? {forceNewWindow: true} : {forceReuseWindow: true}));
    assert.ok(result.opened[0].path.endsWith(`${result.title}.code-workspace`));
    assert.deepEqual(result.workspace.folders, [{name: result.title, path: result.destination}]);
    if (existing) assert.equal(result.preserved, 'Keep my changes');
  }
});

test('all catalog cards use the named launch choice, including recovered Rich projects', async () => {
  for (const project of CATALOG_PROJECTS) for (const existing of [false, true]) {
    const result = await launch({target: project.id, existing, choice: 'Open in Current Window'});
    assert.deepEqual(result.errors, []);
    assert.equal(result.selections, 0, 'direct card launch does not repeat project selection');
    assert.equal(result.prompts.length, 1);
    assert.ok(result.prompts[0][0].includes(project.title));
    assert.equal(result.restorations, project.id === 'rich-reading' && existing ? 1 : 0);
    assert.equal(result.workspace.folders[0].name, project.title);
    assert.equal(result.opened[0].options.forceReuseWindow, true);
  }
});

test('cancelling the launch keeps saved work and never switches windows', async () => {
  for (const existing of [false, true]) {
    const result = await launch({existing});
    assert.equal(result.opened.length, 0);
    assert.equal(result.storageExists, false);
    assert.equal(result.saved, true);
    if (existing) assert.equal(result.preserved, 'Keep my changes');
  }
  const setup = await launch({cancelSetup: true});
  assert.equal(setup.creations, 0);
  assert.equal(setup.prompts.length, 0);
  assert.equal(setup.opened.length, 0);
});

test('creation and window errors are reported without a successful transition', async () => {
  for (const failure of ['create', 'open'] as const) {
    const result = await launch({choice: 'Open in New Window', failure});
    assert.equal(result.opened.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], failure === 'create' ? /Project creation failed/ : /Your project is saved.*Window could not open/);
    assert.equal(result.prompts.length, failure === 'create' ? 0 : 1);
  }
});

test('named workspaces remain separate for different course folders and retain learner settings on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'project-workspace-'));
  try {
    const storage = join(directory, 'storage'), root = join(directory, 'first', 'project');
    const first = await projectWorkspace(storage, root, 'Read: Rich / Python');
    const second = await projectWorkspace(storage, join(directory, 'second', 'project'), 'Read: Rich / Python');
    assert.notEqual(first, second);
    assert.ok(first.endsWith('Read- Rich - Python.code-workspace'));
    const customized = JSON.parse(await readFile(first, 'utf8'));
    customized.settings = {'editor.fontSize': 18};
    await writeFile(first, JSON.stringify(customized));
    assert.equal(await projectWorkspace(storage, root, 'Read: Rich / Python'), first);
    assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), customized);
    assert.equal(existsSync(root), false, 'workspace metadata must not create or modify source files');
  } finally { await rm(directory, {recursive: true, force: true}); }
});
