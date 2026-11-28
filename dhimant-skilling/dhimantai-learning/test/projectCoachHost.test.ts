import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { loadProjectCurriculum, ProjectCurriculum } from '../src/projectCore';
import { ACCESS_ENDED, ApiError } from '../src/api';

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
    runCheck?: () => Promise<unknown>; inputBox?: () => Promise<string | undefined>; notebookCoach?: (path: string, body: any) => Promise<unknown>;
    workspace?: {course: string; account: string; environment: string};
    saved?: unknown; root?: string; curriculum?: ProjectCurriculum} = {}) {
  const curriculum = options.curriculum ?? {id: 'course-agent', version: 1, title: 'Agent', files: [], steps: [step('a'), step('b')]};
  const store = new Map<string, unknown>(), posted: any[] = [], calls = {engines:0, projectFiles: 0, runCheck: 0, submitted: [] as unknown[][], warnings: [] as string[]};
  const disposable = {dispose() {}};
  const listener = () => disposable;
  const uri = (fsPath: string) => ({fsPath, scheme: 'file'});
  const webview = {postMessage: async (message: unknown) => { posted.push(message); return true; }};
  const vscode = {
    env: {appName:'dhimantAI'}, TabInputWebview: class {},
    Uri: {file: uri, joinPath: (base: any, ...parts: string[]) => uri(join(base.fsPath, ...parts)), parse: () => ({fsPath: '', scheme: 'untitled'})},
    Disposable: {from: () => disposable},
    EventEmitter: class { event = listener; fire() {} dispose() {} },
    RelativePattern: class {},
    commands: {registerCommand: listener, executeCommand: async () => undefined},
    workspace: {isTrusted: true, textDocuments: [], workspaceFolders: [], onDidChangeConfiguration: listener, onDidChangeTextDocument: listener,
      onDidSaveTextDocument: listener, getConfiguration: () => ({get: (_key: string, value: unknown) => value}),
      createFileSystemWatcher: () => ({onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {}})},
    window: {activeTextEditor: undefined, onDidChangeTextEditorSelection: listener,
      tabGroups:{activeTabGroup:{}, onDidChangeTabs:listener, onDidChangeTabGroups:listener},
      showTextDocument: async () => undefined, showErrorMessage: () => undefined,
      showInputBox: options.inputBox ?? (async () => undefined),
      showWarningMessage: async (text: string) => { calls.warnings.push(text); return undefined; }},
  };
  const core = require('../src/projectCore');
  const snapshot = {digest: 'd1', files: [{path: 'course_agent/tools.py', text: 'def run(): pass', truncated: false, start_line: 1}],
    omitted: [], omitted_count: 0, structure: {files: ['course_agent/tools.py'], total_files: 1, truncated: false}};
  const modules: Record<string, unknown> = {
    vscode,
    './coachAudio': {},
    './skillingMenu': {courseAction: () => vscode.commands.executeCommand},
    './coachSurface': {CoachSurface: class { select() {} async show() {} async hide() {} release() {} webviewFor() { return webview; } dispose() {} }},
    './projectCore': {...core, projectIdentity: async () => 'course-agent', isEnabledProject: async () => true,
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
    './api': {ApiError, Api: class { notebookCoach(path: string, body: any) { return options.notebookCoach!(path, body); } }},
  };
  const sandbox = {exports: {}, Error, AbortController, Buffer, URLSearchParams, setTimeout, clearTimeout, console,
    require: (name: string) => name in modules ? modules[name] : name.startsWith('./') ? require('../src/' + name.slice(2)) : require(name)};
  runInNewContext(readFileSync(join(extension, 'out/src/projectCoach.js'), 'utf8'), sandbox);
  const context = {extensionUri: uri(extension), globalState: {get: () => undefined}, workspaceState: {get: (key: string) => store.get(key) ?? (key === "projectCoach:production:learner:" + (options.root ?? "/project") ? options.saved : undefined),
    update: async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); }}};
  const auth = {onDidChange: listener, session: options.session ?? (async () => ({user: {id: 'learner'}}))};
  const results = {get: () => undefined, save: async () => {}};
  const courses = {forProject: async () => { calls.engines++; return {bin:'podman', execArgs:() => []}; }, recordFor: () => options.workspace};
  const coach: any = new (sandbox.exports as any).ProjectCoach(context, auth, () => 'production', () => ({}), courses, new (modules['./coachSurface'] as any).CoachSurface(), results);
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

test('a failed checkpoint write preserves the previously saved evidence and completion', async () => {
  const {coach, open, message} = harness({snapshot: async () => ({digest: 'd1', steps: {a: 'a1'},
    files: [], omitted: [], omitted_count: 0, structure: {files: [], total_files: 0, truncated: false}})});
  await open();
  await coach.handle(message('checkpoint', {completed: false, note: 'My draft', help: 'unknown'}));
  coach.context.workspaceState.update = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(coach.handle(message('checkpoint', {completed: true, note: 'Help lists search.', help: 'unknown'})), /Storage unavailable/);
  assert.equal(coach.checkpoint.note, 'My draft');
  assert.equal(coach.progress.checkpoints.a.completed, false);
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

test('a failure location only opens from the matching current run and public file list', async () => {
  const {coach, open, message, calls} = harness({projectFiles: async () => []});
  await open();
  const diagnostic = {file:'tests/test_regression.py', line:7, cause:'Assertion failed'};
  coach.run = {digest:'d1', step:'a', status:'failed', diagnostic};
  const click = (path: string, line: number) => coach.handle(message('checkLocation', {path, line, revision:coach.revision}));
  await click('README.md', 7);
  await click(diagnostic.file, 1);
  assert.equal(calls.projectFiles, 0);
  coach.run.digest = 'earlier';
  await click(diagnostic.file, 7);
  assert.equal(calls.projectFiles, 0, 'a stale run cannot offer a current source location');
  coach.run.digest = 'd1';
  await click(diagnostic.file, 7);
  assert.equal(calls.projectFiles, 1, 'even a matching traceback must refer to a public project file');
});

test('ended course access explains how to restore Coach instead of a raw error', async () => {
  const {coach, open, message, calls} = harness({notebookCoach: async () => { throw new ApiError(403, ACCESS_ENDED, 'access_ended'); }});
  await open();
  await assert.rejects(coach.handle(message('ask', {text: 'Why does this fail?'})),
    (error: Error) => error.message.startsWith(ACCESS_ENDED));
  assert.deepEqual(calls.warnings, [ACCESS_ENDED]);
  assert.equal(coach.busy, false);
});

test('reopened Coach checks its workspace course and preserves unrelated service refusal reasons', async () => {
  const workspace = {course: 'Build AI Agents with Python', account: 'learner', environment: 'production'};
  const paths: string[] = [];
  const notebookCoach = async (path: string) => { paths.push(path); throw new ApiError(403, 'Your learner profile is unavailable.'); };
  const current = harness({workspace, notebookCoach});
  await current.open();
  await assert.rejects(current.coach.handle(current.message('ask', {text:'Why?'})), /Your learner profile is unavailable/);
  assert.deepEqual(paths, ['/notebook-coach/project?course=Build%20AI%20Agents%20with%20Python']);
  assert.deepEqual(current.calls.warnings, []);
  const other = harness({workspace: {...workspace, account: 'other'}, notebookCoach});
  await other.open();
  await assert.rejects(other.coach.handle(other.message('ask', {text:'Why?'})), /learning account and service/);
  assert.equal(paths.length, 1);
});

test('only the current milestone reply becomes playable, including after cancelling a pending answer', async () => {
  const pending = deferred<unknown>();
  let turns = 0;
  const {coach, open, state, message} = harness({workspace: {course: 'Build AI Agents with Python', account: 'learner', environment: 'production'},
    notebookCoach: async () => ++turns === 1 ? {guidance: 'Look at the test.', prompt: 'What did it print?'} : pending.promise});
  await open();
  await coach.handle(message('ask', {text: 'What should I check?'})); await settle();
  assert.equal(state().voiceAvailable, true);
  assert.equal(state().audioId, coach.spoken.id);
  assert.equal(coach.spoken.text, state().messages.at(-1).text);
  assert.equal(new URLSearchParams(coach.spoken.query).get('course'), 'Build AI Agents with Python');
  const original = state().conversationId;
  const followup = coach.handle(message('ask', {text: 'Where is it?'})); await settle();
  await coach.handle(message('step', {index: 1}));
  pending.resolve({guidance: 'Old answer', prompt: ''});
  await followup; await settle();
  assert.notEqual(state().conversationId, original);
  assert.equal(state().audioId, null);
  assert.equal(state().messages.length, 0);
});

test('a milestone discussion survives navigation and reopen, and chat never starts a container', async () => {
  const app = harness({workspace:{course:'C Programming', account:'learner', environment:'production'},
    notebookCoach:async () => ({guidance:'Compare the baseline tests.', prompt:'What changed?'})});
  await app.open();
  await app.coach.handle(app.message('ask', {text:'How should I read this baseline?'}));
  await app.coach.handle(app.message('step',{index:1}));
  assert.equal(app.coach.messages.length,0);
  await app.coach.handle(app.message('step',{index:0}));
  assert.match(app.coach.messages[0].text,/baseline/);
  await app.open();
  assert.equal(app.coach.messages.length,2);
  assert.equal(app.calls.engines,0);
  await app.coach.handle(app.message('newChat'));
  await app.open();
  assert.equal(app.coach.messages.length,0);
});

test('opening a Shelf workspace upgrades only verifiable older checkpoints and exposes one voice prompt per transition', async () => {
  const curriculum = await loadProjectCurriculum(join(extension, 'media'), 'shelf-reading');
  const checkpoint = {step: 'map', at: '2026-11-19T09:00:00Z', digest: 'old', stepDigest: 'map-original', note: 'The search command finds books.',
    completed: true, assistance: 1, externalHelp: 'unknown'};
  const sections = {'Repository map and question': ['shelf/', 'tests/', 'books.json']};
  const snapshot = {digest: 'edited', steps: {map: 'map-original', entry: 'entry-new'}, files: [], omitted: [], omitted_count: 0,
    structure: {files: [], total_files: 0, truncated: false}, reading: {sections, savedSections: sections,
      sources: Object.fromEntries(curriculum.steps.map(s => [s.id, s.id])), commandDigest: 'commands'}};
  const {coach, open, state, message, store} = harness({curriculum, snapshot: async () => snapshot,
    saved: {progress: {visited: [], checkpoints: {map: checkpoint, entry: {...checkpoint, step: 'entry', stepDigest: 'entry-old'}}}},
    workspace: {course: 'Build AI Agents with Python', account: 'learner', environment: 'production'}});
  await open(); await settle();
  const saved: any = [...store.values()].at(-1);
  assert.equal(saved.progress.checkpoints.map.noteLines['Repository map and question'], 3);
  assert.equal(saved.progress.checkpoints.map.at, checkpoint.at);
  assert.equal(saved.progress.checkpoints.entry.noteLines, undefined, 'already-changed legacy evidence keeps its original baseline');
  assert.equal(state().milestones[0].status, 'complete');
  assert.equal(state().milestones[1].status, 'review');
  const completedVoice = state().audioId;
  await coach.refresh();
  assert.equal(state().audioId, completedVoice);
  await coach.handle(message('step', {index: 1}));
  assert.notEqual(state().audioId, completedVoice);
  assert.equal(coach.spoken.text, state().guide);
  assert.match(coach.spoken.text, /reviewing/);
  assert.equal(new URLSearchParams(coach.spoken.query).get('course'), 'Build AI Agents with Python');
  assert.equal(coach.assistance, 0);
  assert.equal(state().messages.length, 0);
});

test('automatic feedback uses evidence once, keeps questions available and omits silent observations', async () => {
  const bodies: any[] = [];
  const pending = deferred<any>();
  const app = harness({notebookCoach:async (_path, body) => {
    bodies.push(body);
    return bodies.length === 1 ? pending.promise : {guidance:'',prompt:'',line:null};
  }});
  await app.open();
  app.coach.surface.visible = true;
  const review = app.coach.review({event:'saved', path:'course_agent/tools.py'});
  await settle();
  assert.equal(app.coach.busy, false);
  assert.equal(bodies[0].message, '');
  assert.equal(bodies[0].project_context.observation, 'saved');
  assert.equal(app.posted.some(m => m.type === 'questionAccepted'), false);
  pending.resolve({guidance:'Trace the dependency in course_agent/tools.py:1.',prompt:'What belongs at that boundary?',line:1});
  await review;
  assert.deepEqual(Array.from(app.coach.messages, (m:any) => m.role), ['tutor']);
  await app.coach.review({event:'saved', path:'course_agent/tools.py'});
  await app.coach.review({event:'saved', path:'.env'});
  assert.equal(bodies.length, 1);
  app.coach.run = {digest:'d1',step:'a',status:'failed',command:'check',output:'Different outcome',truncated:false};
  await app.coach.review({event:'check'});
  assert.equal(bodies[1].project_context.check.status, 'failed');
  assert.equal(app.coach.messages.length, 1);
  app.coach.dispose();
});

test('the mentor uses a current debugger stop and discards a reply after the learner continues', async () => {
  const pending = deferred<any>(), requests: any[] = [];
  const app = harness({notebookCoach: async (_path, body) => { requests.push(body); return pending.promise; }});
  try {
    await app.open();
    app.coach.surface.visible = true;
    let paused = true;
    const stop = {event:'debug_pause',path:'course_agent/tools.py',line:1,current:()=>paused};
    const review = app.coach.review(stop);
    await settle();
    assert.equal(requests[0].project_context.selected_file,stop.path);
    assert.equal(requests[0].project_context.observation_line,1);
    assert.equal(requests[0].project_context.observation,'debug_pause');
    paused = false;
    pending.resolve({guidance:'Inspect the value at this breakpoint.',prompt:'',line:1});
    await review;
    assert.equal(app.coach.messages.length,0);
    await app.coach.review(stop);
    assert.equal(requests.length,1);
  } finally { app.coach.dispose(); }
});

test('a learner question supersedes an automatic review in flight', async () => {
  const pending = deferred<any>();
  const app = harness({notebookCoach:async (_path, body) => body.project_context.observation ? pending.promise :
    {guidance:'Here is the answer to your question.',prompt:'',line:null}});
  await app.open();
  app.coach.surface.visible = true;
  const review = app.coach.review({event:'saved', path:'course_agent/tools.py'});
  await settle();
  await app.coach.handle(app.message('ask', {text:'Which part reads the data?'}));
  pending.resolve({guidance:'This obsolete review should be discarded.',prompt:'',line:null});
  await review;
  assert.equal(app.coach.messages.length, 2);
  assert.match(app.coach.messages.at(-1).text, /answer to your question/);
  app.coach.dispose();
});


test('Project Mentor uses the latest spoken language for guidance and playback in the same chat', async () => {
  const bodies: any[] = [];
  const app = harness({notebookCoach:async (_path, body) => {
    bodies.push(body); return {guidance:'Inspect the change.', prompt:''};
  }});
  await app.open();
  for (const [language, text] of [['en-IN','What changed?'],['te-IN','ఇప్పుడు ఏమి చేయాలి?'],['en-IN','What is next?']]) {
    await app.coach.handle(app.message('ask', {text, spokenLanguage:language}));
    assert.equal(bodies.at(-1).coaching_language, language);
    assert.equal(new URLSearchParams(app.coach.spoken.query).get('language'), language);
  }
  await app.coach.handle(app.message('voiceLanguage', {value:'te-IN'}));
  await app.coach.handle(app.message('ask', {text:'What is next?', spokenLanguage:'kn-IN'}));
  assert.equal(bodies.at(-1).coaching_language, 'te-IN');
  await app.coach.handle(app.message('newChat'));
  await app.coach.handle(app.message('ask', {text:'What now?'}));
  assert.equal(bodies.at(-1).coaching_language, undefined);
});
