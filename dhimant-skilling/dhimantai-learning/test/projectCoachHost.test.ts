import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ApiError } from '../src/api';

const extension = resolve(__dirname, '../..');
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const step = (id: string) => ({id, title: id.toUpperCase(), goal: 'Goal ' + id, opening: '', task: 'Task ' + id, files: ['course_agent/tools.py'],
  check: 'checks.test_' + id, expected: '', hint: 'Hint ' + id, reflection: ''});

/** Loads the compiled host class with stubbed VS Code and project services. */
function harness(options: {session?: () => Promise<unknown>; snapshot?: () => Promise<unknown>; projectFiles?: () => Promise<string[]>;
    runCheck?: () => Promise<unknown>; inputBox?: () => Promise<string | undefined>; notebookCoach?: () => Promise<unknown>;
    saved?: unknown; root?: string} = {}) {
  const curriculum = {id: 'course-agent', version: 1, title: 'Agent', files: [], steps: [step('a'), step('b')]};
  const store = new Map<string, unknown>(), posted: any[] = [], calls = {projectFiles: 0, runCheck: 0, submitted: [] as unknown[][], warnings: [] as string[]};
  const disposable = {dispose() {}};
  const listener = () => disposable;
  const uri = (fsPath: string) => ({fsPath, scheme: 'file'});
  const webview = {postMessage: async (message: unknown) => { posted.push(message); return true; }};
  const vscode = {
    Uri: {file: uri, joinPath: (base: any, ...parts: string[]) => uri(join(base.fsPath, ...parts)), parse: () => ({fsPath: '', scheme: 'untitled'})},
    Disposable: {from: () => disposable},
    RelativePattern: class {},
    commands: {registerCommand: listener, executeCommand: async () => undefined},
    workspace: {isTrusted: true, textDocuments: [], workspaceFolders: [], onDidChangeConfiguration: listener, onDidChangeTextDocument: listener,
      onDidSaveTextDocument: listener, getConfiguration: () => ({get: (_key: string, value: unknown) => value}),
      createFileSystemWatcher: () => ({onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {}})},
    window: {activeTextEditor: undefined, onDidChangeTextEditorSelection: listener, onDidChangeActiveTextEditor: listener,
      showTextDocument: async () => undefined, showErrorMessage: () => undefined,
      showInputBox: options.inputBox ?? (async () => undefined),
      showWarningMessage: async (text: string) => { calls.warnings.push(text); return undefined; }},
  };
  const core = require('../src/projectCore');
  const snapshot = {digest: 'd1', files: [{path: 'course_agent/tools.py', text: 'def run(): pass', truncated: false, start_line: 1}],
    omitted: [], omitted_count: 0, structure: {files: ['course_agent/tools.py'], total_files: 1, truncated: false}};
  const modules: Record<string, unknown> = {
    vscode,
    './coachSurface': {CoachSurface: class { select() {} async show() {} async hide() {} webviewFor() { return webview; } dispose() {} }},
    './projectCore': {...core, projectIdentity: async () => 'course-agent', isProject: async () => true,
      loadProjectCurriculum: async () => curriculum, trackedProjectFiles: () => [],
      projectFiles: async () => { calls.projectFiles++; return options.projectFiles ? options.projectFiles() : ['course_agent/tools.py']; },
      projectSnapshot: options.snapshot ?? (async () => snapshot),
      runProjectCheck: async () => { calls.runCheck++; return options.runCheck ? options.runCheck()
        : {digest: 'd1', step: 'a', status: 'passed', command: '', output: '', truncated: false}; }},
    './projectResults': {...require('../src/projectResults'), submitProject: async (...args: unknown[]) => {
      calls.submitted.push(args); return {outcome: 'completed', runs: []}; }},
    './courseTerminal': {courseTerminalOptions: () => ({})},
    './projectLive': {runManagedProject: async () => ({output: '', passed: true})},
    './projectGitHub': {projectGitHub: async () => undefined},
    './api': {ApiError, Api: class { notebookCoach() { return options.notebookCoach!(); } }},
  };
  const sandbox = {exports: {}, Error, AbortController, Buffer, setTimeout, console,
    require: (name: string) => name in modules ? modules[name] : name.startsWith('./') ? require('../src/' + name.slice(2)) : require(name)};
  runInNewContext(readFileSync(join(extension, 'out/src/projectCoach.js'), 'utf8'), sandbox);
  const context = {extensionUri: uri(extension), workspaceState: {get: (key: string) => store.get(key) ?? options.saved,
    update: async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); }}};
  const auth = {onDidChange: listener, session: options.session ?? (async () => ({user: {id: 'learner'}}))};
  const results = {get: () => undefined, save: async () => {}};
  const courses = {forFile: async () => ({bin: 'podman', execArgs: () => []}), recordFor: () => undefined};
  const coach: any = new (sandbox.exports as any).ProjectCoach(context, auth, () => 'production', () => ({}), courses, results);
  const state = () => posted.filter(m => m.type === 'state').at(-1);
  const message = (type: string, data = {}) => ({type, scope: coach.key(), step: coach.step, conversationId: coach.conversationId, ...data});
  return {coach, open: () => coach.open(options.root ?? '/project'), posted, state, store, calls, message};
}

test('a double click starts one check, and a pending live-run prompt blocks a check', async () => {
  const files = deferred<string[]>();
  const {coach, open, calls, message, state} = harness({projectFiles: () => files.promise});
  await open();
  const first = coach.handle(message('check')), second = coach.handle(message('check'));
  await settle();
  assert.equal(coach.busy, true, 'busy is claimed before the first await');
  files.resolve(['course_agent/tools.py']);
  await Promise.all([first, second]); await settle();
  assert.equal(calls.runCheck, 1);
  assert.equal(state().busy, false);

  const input = deferred<string | undefined>();
  const live = harness({inputBox: () => input.promise});
  await live.open();
  live.coach.step = 1;
  live.coach.curriculum = live.coach.curriculum.then((c: any) => ({...c, steps: [c.steps[0], {...c.steps[1], id: 'live'}]}));
  const running = live.coach.handle(live.message('runLive'));
  await settle();
  assert.equal(live.coach.busy, true, 'busy while the question prompt is open');
  await live.coach.handle(live.message('check'));
  assert.equal(live.calls.runCheck, 0, 'a check cannot overlap the live run');
  input.resolve(undefined);
  await running;
  assert.equal(live.coach.busy, false, 'cancelling the prompt releases busy');
});

test('an edit during the owner reload neither drops nor erases saved progress, and steps stay in range', async () => {
  const session = deferred<unknown>();
  const checkpoint = {step: 'b', note: 'Evidence', digest: 'd1', at: '2026-11-09T00:00:00Z', assistance: 1, externalHelp: 'unknown', completed: true};
  const {coach, open, store, message} = harness({session: () => session.promise,
    saved: {step: 7, progress: {visited: ['a', 'b'], checkpoints: {b: checkpoint}}, assistance: 3}});
  coach.step = 9;
  const opening = open();
  await settle();
  assert.ok(coach.step <= 1, 'a shorter curriculum never leaves the step out of range');
  coach.invalidate('Files changed.'); // A document change while the account is resolving.
  await coach.persist();
  assert.equal(store.size, 0, 'nothing is persisted before progress is loaded');
  session.resolve({user: {id: 'learner'}});
  await opening;
  assert.equal(coach.step, 1);
  assert.deepEqual(coach.progress.checkpoints.b, checkpoint);
  assert.equal(coach.assistance, 3);
  await coach.handle(message('hint'));
  const saved: any = [...store.values()].at(-1);
  assert.deepEqual(saved.progress.checkpoints.b, checkpoint, 'a later save keeps stored checkpoints');
});

test('Submit uses the note the learner typed, with the checkpoint length limit', async () => {
  const {coach, open, calls, message} = harness({saved: {step: 1, progress: {visited: ['b'], checkpoints: {
    b: {step: 'b', note: 'Old saved note', digest: 'd1', at: '2026-11-09T00:00:00Z', assistance: 0, externalHelp: 'unknown', completed: false}}}}});
  await open();
  await coach.handle(message('submitProject', {help: 'unknown', note: 'Typed but not saved'}));
  assert.equal(calls.submitted.length, 1);
  assert.equal(calls.submitted[0][3], 'Typed but not saved');
  await coach.handle(message('submitProject', {help: 'unknown', note: 'x'.repeat(1001)}));
  await coach.handle(message('submitProject', {help: 'unknown'}));
  assert.equal(calls.submitted.length, 1, 'an oversized or missing note is rejected');
});

test('a snapshot failure still sends a usable state that names the file and limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-coach-'));
  try {
    await writeFile(join(root, 'big.json'), 'x'.repeat(600000));
    const {open, state} = harness({root, projectFiles: async () => ['big.json'],
      snapshot: async () => { throw new Error('Project source files must be smaller than 512 KB.'); }});
    await open();
    const current = state();
    assert.ok(current, 'a state is posted, so the panel has a scope and controls');
    assert.equal(current.busy, false);
    assert.equal(current.scope.length > 0, true);
    assert.match(current.contextProblem, /big\.json is larger than 512 KB/);
    assert.match(current.status, /big\.json/);
    assert.equal(current.sharedFiles.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('ended course access explains how to restore Coach instead of a raw error', async () => {
  const {coach, open, message, calls} = harness({notebookCoach: async () => { throw new ApiError(403, 'Your course access has ended.'); }});
  await open();
  await assert.rejects(coach.handle(message('ask', {text: 'Why does this fail?'})),
    (error: Error) => /^Access ended — buy again from the course catalog/.test(error.message) && error.message.includes('Your course access has ended.'));
  assert.match(calls.warnings[0], /buy again from the course catalog/);
  assert.equal(coach.busy, false);
});
