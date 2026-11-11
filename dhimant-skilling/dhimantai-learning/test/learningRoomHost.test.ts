import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The learning room host runs against a recording VS Code API boundary.
const Module = require('node:module');
const commands = new Map<string, (...args: any[]) => unknown>(), executed: string[] = [];
const config: Record<string, unknown> = {aiAssistance: true};
const panels: any[] = [];
const disposable = {dispose() {}};
const stub: any = new Proxy(function () { return stub; }, {get: (_target, key) => key === 'then' ? undefined : key === 'dispose' ? () => {} : stub, apply: () => disposable, construct: () => stub});
const stubbed = (target: any): any => new Proxy(target, {get: (object, key) => key in object ? object[key] : stub});
const vscode: any = stubbed({
  Uri: {joinPath: (uri: {fsPath: string}, ...parts: string[]) => ({fsPath: join(uri.fsPath, ...parts)}), file: (fsPath: string) => ({fsPath})},
  ViewColumn: {One: 1},
  Disposable: Object.assign(class { dispose() {} }, {from: () => disposable}),
  TabInputWebview: class {},
  EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
  env: stubbed({appName: 'Visual Studio Code'}),
  workspace: stubbed({getConfiguration: () => ({get: (key: string, fallback: unknown) => key in config ? config[key] : fallback}),
    onDidChangeConfiguration: () => disposable, workspaceFolders: [], isTrusted: true}),
  window: stubbed({tabGroups: {all: []}, showInformationMessage: async () => undefined,
    createWebviewPanel: (_type: string, title: string) => {
      const handlers: ((message: unknown) => Promise<void>)[] = [], disposers: (() => void)[] = [];
      const panel = {title, visible: true, disposed: false, posted: [] as any[],
        webview: {cspSource: 'csp', html: '', asWebviewUri: (uri: unknown) => uri,
          onDidReceiveMessage: (handler: any) => { handlers.push(handler); return disposable; },
          postMessage: async (message: unknown) => { panel.posted.push(message); return true; }},
        revealed: 0, reveal() { panel.revealed++; }, onDidDispose: (fn: () => void) => { disposers.push(fn); return disposable; }, onDidChangeViewState: () => disposable,
        dispose() { panel.disposed = true; for (const fn of disposers) fn(); },
        send: async (message: unknown) => { for (const handler of handlers) await handler(message); }};
      panels.push(panel); return panel;
    }}),
  commands: stubbed({registerCommand: (id: string, fn: any) => { commands.set(id, fn); return disposable; },
    executeCommand: async (id: string) => { executed.push(id); }}),
});
const load = Module._load;
Module._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
const { registerLearningRoom } = require('../src/learningRoom') as typeof import('../src/learningRoom');
const { Api, ApiError } = require('../src/api') as typeof import('../src/api');
const { TutorNotebookStore } = require('../src/tutorNotebookStore') as typeof import('../src/tutorNotebookStore');
Module._load = load;

const snapshot = {snippet: 'code-1', revision: 0, language: 'python', source: 'print(1)', stdin: '', question: 'Why does this fail?'};
const reply = (panel: any, request: number) => panel.posted.find((m: any) => m.type === 'notebookReply' && m.request === request);

test('generated exercises keep independent tabs and saved work even when titles match, and reopen after reload', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'practice-notebooks-'));
  const pick = vscode.window.showQuickPick;
  const opened: any[] = [], documents: any[] = [];
  const context: any = {extensionUri: {fsPath: resolve(__dirname, '../..')}, extensionPath: resolve(__dirname, '../..'),
    globalStorageUri: {fsPath: storage}, secrets: {onDidChange: () => disposable}, globalState: {get: () => undefined, update: async () => {}}};
  const session = {user: {id: 'learner'}, access_token: 'token'};
  const auth: any = {session: async () => session, signIn: async () => session, accessToken: async () => 'token'};
  const register = () => registerLearningRoom(context, () => 'production', () => ({apiUrl:'https://api.example'}) as any, auth);
  try {
    register();
    for (const title of ['Token-ID Embedding Lookup', 'Token-ID Embedding Lookup', 'Count words']) {
      await commands.get('dhimantai.openPracticeNotebook')!('', 'learner', 'Python', {
        exercise:{title, task:'Print twelve.', example_input:'', expected_output:'12'},
        course:'Python', chapter:'Variables', language:'python', kernel:'python3', difficulty:'easy',
        validation:'reference_execution', tests:[{id:'example', kind:'stdio', stdin:'', expected:'12\n'}],
      });
      const panel = panels.at(-1);
      const imagePolicy = panel.webview.html.match(/img-src ([^;]+);/)?.[1].split(/\s+/);
      assert.ok(imagePolicy?.includes('https:'), 'textbook storage images can load in the actual notebook webview');
      assert.ok(!imagePolicy?.includes('http:') && !imagePolicy?.includes('*'));
      opened.push(panel);
      assert.ok(opened.every(p => !p.disposed), 'generating another exercise must keep every previous tab open');
      assert.equal(panel.title, 'Practice notebook · ' + title);
      await panel.send({type:'join', mode:'tutor', attempt:1});
      const document = panel.posted.find((m: any) => m.type === 'restoreNotebook');
      assert.ok(document);
      const notebook = {...document.notebook, textDraft:'Unsent answer ' + opened.length,
        cells:[...document.notebook.cells, {id:'my-note', kind:'note', text:'Reasoning ' + opened.length}],
        drafts:[{key:'practice-question:0', snippet:'code-1', language:'python', source:'print(' + opened.length + ')',
          stdin:'', prediction:'', explanation:'', helped:false}]};
      await panel.send({type:'notebookChanged', documentKey:document.documentKey, sequence:1, notebook});
      documents.push(notebook);
    }
    assert.equal(new Set(documents.map(n => n.exerciseId)).size, 3, 'identical titles still have separate document IDs');
    // Background tabs remain writable after opening another exercise.
    const first = opened[0], firstKey = first.posted.find((m: any) => m.type === 'restoreNotebook').documentKey;
    documents[0].textDraft = 'Revised while another exercise is open';
    await first.send({type:'notebookChanged', documentKey:firstKey, sequence:2, notebook:documents[0]});
    const history = () => TutorNotebookStore.practiceHistory(join(storage, 'tutor-notebooks'), 'production', 'learner');
    assert.equal((await history()).length, 3);
    for (const notebook of documents) {
      assert.deepEqual((await history()).find(item => item.notebook.exerciseId === notebook.exerciseId)!.notebook, notebook);
      vscode.window.showQuickPick = async (choices: any[]) => choices.find(c => c.practice.id === notebook.exerciseId);
      const count = panels.length;
      await commands.get('dhimantai.practiceHistory')!();
      assert.equal(panels.length, count, 'reopening an already open exercise reveals its tab');
      assert.equal(opened[documents.indexOf(notebook)].revealed, 1);
    }
    for (const panel of opened) panel.dispose();
    register(); // A fresh registration has no retained panels, like restarting the extension.
    for (const notebook of documents) {
      vscode.window.showQuickPick = async (choices: any[]) => choices.find(c => c.practice.id === notebook.exerciseId);
      await commands.get('dhimantai.practiceHistory')!();
      const panel = panels.at(-1);
      assert.equal(panel.title, 'Practice notebook · ' + notebook.title);
      await panel.send({type:'join', mode:'tutor', attempt:1});
      assert.deepEqual(panel.posted.find((m: any) => m.type === 'restoreNotebook').notebook, notebook);
      panel.dispose();
    }
  } finally {
    vscode.window.showQuickPick = pick;
    for (const panel of panels) panel.dispose();
    await rm(storage, {recursive:true, force:true});
  }
});

test('learning room host: other mode opens its own tab, mismatched joins fail, and every help request gets a reply', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'learning-room-host-'));
  const grant = Api.prototype.learningRoom, coach = Api.prototype.notebookCoach;
  try {
    const context: any = {extensionUri: {fsPath: resolve(__dirname, '../..')}, extensionPath: resolve(__dirname, '../..'),
      globalStorageUri: {fsPath: storage}, secrets: {onDidChange: () => disposable}, globalState: {get: () => undefined, update: async () => {}}};
    const session = {user: {id: 'alice'}, access_token: 'token'};
    const auth: any = {session: async () => session, signIn: async () => session, accessToken: async () => 'token'};
    registerLearningRoom(context, () => 'production', () => ({apiUrl: 'https://api.example'}) as any, auth);

    await commands.get('dhimantai.openLearningRoom')!();
    const tutor = panels.at(-1);
    await tutor.send({type: 'openOtherMode'});
    assert.equal(executed.filter(id => id !== 'setContext').at(-1), 'dhimantai.openDoubtSolver');
    assert.equal(tutor.disposed, false, 'this lesson tab stays open');
    await tutor.send({type: 'join', mode: 'doubt_solver', attempt: 4});
    assert.match(tutor.posted.find((m: any) => m.type === 'failed' && m.attempt === 4)?.message, /This tab is for Instructor/);
    await tutor.send({type: 'notebookTurn', attempt: 9, request: 1, snapshot, message: 'Help'});
    assert.match(reply(tutor, 1).error, /session changed/i, 'no session still answers instead of leaving a 60 second wait');

    Api.prototype.learningRoom = async () => ({url: 'wss://lk-prod.dhimant.ai', token: 'grant'});
    await commands.get('dhimantai.openDoubtSolver')!();
    const doubt = panels.at(-1);
    await doubt.send({type: 'join', mode: 'doubt_solver', attempt: 1});
    assert.ok(doubt.posted.some((m: any) => m.type === 'grant' && m.attempt === 1));
    await doubt.send({type: 'openOtherMode'});
    assert.equal(executed.filter(id => id !== 'setContext').at(-1), 'dhimantai.openLearningRoom');

    config.aiAssistance = false;
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 2, snapshot, message: 'Help', prediction: ''});
    assert.match(reply(doubt, 2).error, /AI assistance is off/);
    config.aiAssistance = true;

    const calls: {path: string; body: any}[] = [];
    let finish!: () => void;
    Api.prototype.notebookCoach = (async function (path: string, body: any) {
      calls.push({path, body});
      if (calls.length === 1) await new Promise<void>(done => { finish = done; });
      if (calls.length === 2) throw new ApiError(403, 'Your course access has ended.');
      return {guidance: 'Look at the index.', prompt: 'Your turn: print the last valid index.', line: null};
    }) as any;
    const doubtId = '3b241101-e2bb-4255-8caf-4136c566a962';
    const first = doubt.send({type: 'notebookTurn', attempt: 1, request: 3, snapshot, message: 'Help', prediction: '', doubtId, helpLevel: 2,
      history: [{role: 'learner', text: 'Why index 3?'}]});
    await new Promise(r => setTimeout(r, 10));
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 4, snapshot, message: 'Again', prediction: ''});
    assert.match(reply(doubt, 4).error, /still answering/, 'a busy request is refused with a reply');
    finish(); await first;
    assert.equal(calls[0].path, '/notebook-coach/doubt');
    assert.equal(calls[0].body.doubt_id, doubtId);
    assert.equal(calls[0].body.help_level, 2, 'Doubt Solver help climbs the ladder');
    assert.equal(calls[0].body.chapter_id, undefined);
    assert.match(reply(doubt, 3).content, /Your turn: print the last valid index/);
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 5, snapshot, message: 'Help', prediction: '', doubtId});
    assert.equal(reply(doubt, 5).accessEnded, true, 'ended access is marked so the notebook offers the catalog');
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 6, snapshot, message: 'Help', prediction: '', attachments: 'broken'});
    assert.match(reply(doubt, 6).error, /attachments could not be read/, 'a bad attachment is explained, never silently dropped');
  } finally {
    Api.prototype.learningRoom = grant; Api.prototype.notebookCoach = coach;
    for (const panel of panels) panel.dispose();
    await rm(storage, {recursive: true, force: true});
  }
});

test('learning room host: a notebook without course data says so, and a data question before it is ready still gets a reply', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'learning-room-data-'));
  const grant = Api.prototype.learningRoom;
  try {
    const context: any = {extensionUri: {fsPath: resolve(__dirname, '../..')}, extensionPath: resolve(__dirname, '../..'),
      globalStorageUri: {fsPath: storage}, secrets: {onDidChange: () => disposable}, globalState: {get: () => undefined, update: async () => {}}};
    const session = {user: {id: 'bob'}, access_token: 'token'};
    const auth: any = {session: async () => session, signIn: async () => session, accessToken: async () => 'token'};
    registerLearningRoom(context, () => 'production', () => ({apiUrl: 'https://api.example'}) as any, auth);
    Api.prototype.learningRoom = async () => ({url: 'wss://lk-prod.dhimant.ai', token: 'grant'});
    await commands.get('dhimantai.openDoubtSolver')!();
    const doubt = panels.at(-1);
    await doubt.send({type: 'join', mode: 'doubt_solver', attempt: 1});
    await new Promise(r => setTimeout(r, 10));
    assert.ok(doubt.posted.some((m: any) => m.type === 'courseData' && m.state === 'none'), 'no course data outside AI at Work');
    await doubt.send({type: 'dataAsk', attempt: 1, request: 7, question: 'Which branch sold the most?'});
    assert.match(doubt.posted.find((m: any) => m.type === 'dataReply' && m.request === 7).error, /not ready/);
    await doubt.send({type: 'dataAsk', attempt: 2, request: 8, question: 'x'});
    assert.match(doubt.posted.find((m: any) => m.type === 'dataReply' && m.request === 8).error, /session changed/i);
  } finally {
    Api.prototype.learningRoom = grant;
    for (const panel of panels) panel.dispose();
    await rm(storage, {recursive: true, force: true});
  }
});
