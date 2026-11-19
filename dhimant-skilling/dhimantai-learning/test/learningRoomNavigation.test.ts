import {authoredConfiguration} from './authoredConfiguration';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

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
Api.prototype.courseRuntime=async title=>({runtime:null,configuration:authoredConfiguration(title)});
const { TutorNotebookStore } = require('../src/tutorNotebookStore') as typeof import('../src/tutorNotebookStore');
Module._load = load;

test('Instructor and Doubt Solver switch in one tab, preserve separate drafts and explicitly hand off to Instructor', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'instructor-doubt-navigation-'));
  const grant = Api.prototype.learningRoom, catalog = Api.prototype.practiceCatalog;
  const execute = vscode.commands.executeCommand;
  const create = vscode.window.createWebviewPanel;
  const chapter = '10000000-0000-0000-0000-000000000001';
  const lesson = 'Chapter 1: Compile, Run, and Read Values';
  const session = {user:{id:'navigation-learner'}, access_token:'test-token'};
  const context: any = {extensionUri:{fsPath:resolve(__dirname, '../..')}, extensionPath:resolve(__dirname, '../..'),
    globalStorageUri:{fsPath:storage}, secrets:{onDidChange:() => disposable}, globalState:{get:() => undefined, update:async () => {}}};
  const auth: any = {session:async () => session, signIn:async () => session, accessToken:async () => 'test-token'};
  const requestedModes: string[] = [], errors: unknown[] = [], windows: JSDOM[] = [];
  const pending = new Set<Promise<void>>();
  const mounted = new Map<any, ReturnType<typeof mount>>();
  const originalPosts = new Map<any, (message: unknown) => Promise<boolean>>();
  let allowDoubt!: () => void;
  const doubtHandshake = new Promise<void>(resolve => { allowDoubt = resolve; });
  const settle = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 5000;
    while (!condition() && !errors.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(errors, [], 'host/webview messages must not fail');
    assert.ok(condition(), message);
  };
  const mount = (panel: any) => {
    // Exercise the generated product HTML and bundled client against the real host handler.
    const dom = new JSDOM(panel.webview.html, {runScripts:'outside-only', url:'https://webview.example', pretendToBeVisual:true});
    windows.push(dom);
    const w = dom.window, outbound: any[] = [], rooms: Room[] = [];
    const worker = {identity:'worker', isAgent:true, trackPublications:new Map()};
    class Room {
      listeners = new Map<string, Function>();
      remoteParticipants = new Map([['worker', worker]]);
      rpcs: any[] = [];
      chats: {text:string; topic:string; destinationIdentities:string[]}[] = [];
      disconnected = false;
      localParticipant = {
        registerRpcMethod() {},
        performRpc:async (rpc: any) => {
          this.rpcs.push(rpc);
          if (rpc.method === 'switch_mode' && JSON.parse(rpc.payload).mode === 'doubt_solver') await doubtHandshake;
          return 'ok';
        },
        sendText:async (text: string, options: any) => { this.chats.push({text, ...options}); },
      };
      constructor() { rooms.push(this); }
      on(event: string, listener: Function) { this.listeners.set(event, listener); }
      async connect() {} async disconnect() { this.disconnected = true; }
      registerTextStreamHandler() {}
      publish(data: object) { this.listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify(data)), worker); }
    }
    w.LivekitClient = {Room, RoomEvent:new Proxy({}, {get:(_target, event) => event})};
    w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
    w.HTMLElement.prototype.scrollIntoView = () => {};
    w.Range.prototype.getClientRects = () => [] as any;
    w.Range.prototype.getBoundingClientRect = () => ({left:0, right:0, top:0, bottom:0, width:0, height:0}) as any;
    const post = originalPosts.get(panel) ?? panel.webview.postMessage;
    originalPosts.set(panel, post);
    panel.webview.postMessage = async (message: unknown) => {
      await post(message);
      if (!w.document) return false;
      w.dispatchEvent(new w.MessageEvent('message', {data:message, origin:w.location.origin}));
      return true;
    };
    w.acquireVsCodeApi = () => ({postMessage:(message: unknown) => {
      outbound.push(message);
      const task = Promise.resolve().then(() => panel.send(message)).catch(error => { errors.push(error); });
      pending.add(task); void task.finally(() => pending.delete(task));
    }});
    w.eval(readFileSync(resolve(__dirname, '../../media/learning-room/room.js'), 'utf8'));
    const input = w.document.querySelector<HTMLTextAreaElement>('#message')!;
    const surface = {w, rooms, outbound, input, panel, html:panel.webview.html,
      send:w.document.querySelector<HTMLButtonElement>('#send')!,
      status:() => w.document.getElementById('status')!.textContent,
      type:(text: string) => { input.value = text; input.dispatchEvent(new w.Event('input')); },
      selectMode:(mode: string) => {
        const picker = w.document.querySelector<HTMLSelectElement>('#workspace-mode')!;
        picker.value = mode; picker.dispatchEvent(new w.Event('change'));
      },
      openInInstructor:() => { w.document.querySelector<HTMLDetailsElement>('.workspace-menu')!.open = true; w.document.getElementById('doubt_solver')!.click(); }};
    mounted.set(panel, surface);
    return surface;
  };
  const navigate = async (from: ReturnType<typeof mount>, mode: string, carryDraft = false) => {
    const before = panels.length, reveals = new Map(panels.map(panel => [panel, panel.revealed]));
    if (carryDraft) from.openInInstructor(); else from.selectMode(mode);
    await settle(() => panels.length > before || from.panel.webview.html !== from.html
      || panels.some(panel => panel.revealed > reveals.get(panel)), 'navigation initializes the requested mode through its host');
    const panel = panels.find(panel => panel.revealed > reveals.get(panel)) ?? panels.at(-1);
    assert.equal(panels.length, before, 'switching modes reuses the course tab');
    assert.equal(panel, from.panel);
    const change = from.outbound.filter(message => message.type === 'workspaceMode').at(-1);
    assert.equal(change.mode, mode);
    assert.equal(change.carryDraft, carryDraft);
    const retained = mounted.get(panel);
    const next = retained && retained.html === panel.webview.html ? retained : mount(panel);
    if (next !== from && panel === from.panel) {
      // Replacing webview HTML unloads the prior client. Its draft was flushed by navigation.
      from.w.close();
    }
    await settle(() => next.rooms[0]?.rpcs.some(rpc => rpc.method === 'switch_mode' && JSON.parse(rpc.payload).mode === mode) === true,
      'the destination obtains a grant and performs its mode handshake');
    return next;
  };
  try {
    // Run registered commands, unlike the recording-only mock used by the host unit tests.
    vscode.commands.executeCommand = async (id: string, ...args: any[]) => { executed.push(id); return commands.get(id)?.(...args); };
    vscode.window.createWebviewPanel = (...args: any[]) => {
      const panel = create(...args), handlers = new Set<(message: unknown) => Promise<void>>();
      // A workspace may replace its host on the same panel; disposal must remove the old receiver.
      panel.webview.onDidReceiveMessage = (handler: (message: unknown) => Promise<void>) => {
        handlers.add(handler); return {dispose:() => handlers.delete(handler)};
      };
      panel.send = async (message: unknown) => { for (const handler of [...handlers]) await handler(message); };
      return panel;
    };
    Api.prototype.practiceCatalog = (async () => ({courses:[{name:'C Programming', chapters:[
      {id:chapter, name:lesson}, {id:'10000000-0000-0000-0000-000000000002', name:'Conditions', locked:true},
    ]}]})) as any;
    Api.prototype.learningRoom = async mode => { requestedModes.push(mode); return {url:'wss://lk-prod.dhimant.ai', token:'test-grant'}; };
    registerLearningRoom(context, () => 'production', () => ({apiUrl:'https://api.example'}) as any, auth);
    await commands.get('dhimantai.openLearningRoom')!('C Programming', chapter);
    const instructorPanel = panels.at(-1), instructor = mount(instructorPanel);
    await settle(() => instructor.status() === 'Instructor connected', 'Instructor connects to the selected C chapter');
    instructor.rooms[0].publish({method:'tutor_session_summary', subject:'C Programming', chapter:lesson, topic:lesson,
      is_complete:true, partial_session:false, summary_scope:'full', big_idea:'Compile C before running it.'});
    assert.match(instructor.w.document.getElementById('feed')!.textContent!, /Lesson recap.*Compile C/s);
    instructor.type('Keep this Instructor draft');
    const instructorCards = instructor.w.document.getElementById('feed')!.textContent;
    const doubt = await navigate(instructor, 'doubt_solver');
    const switchMode = JSON.parse(doubt.rooms[0].rpcs.find(rpc => rpc.method === 'switch_mode').payload);
    assert.equal(switchMode.mode, 'doubt_solver');
    assert.equal(switchMode.chapter_id, chapter, 'the prior lesson supplies context without owning the Doubt Solver connection');
    assert.equal(switchMode.lesson_name, lesson);
    doubt.type('Why are we using C?');
    assert.equal(doubt.send.disabled, true, 'sending waits for the agent acknowledgement');
    assert.match(doubt.status()!, /Connecting to Doubt Solver/);
    allowDoubt();
    await settle(() => !doubt.send.disabled, 'Ask Doubt Solver enables after connection');
    assert.equal(doubt.status(), 'Doubt Solver connected');
    doubt.send.click();
    await settle(() => doubt.rooms[0].chats.length === 1, 'the workspace Doubt Solver receives the question');
    assert.equal(doubt.rooms[0].chats[0].text, 'Why are we using C?');
    assert.equal(doubt.rooms[0].chats[0].topic, 'lk.chat');
    assert.deepEqual([...doubt.rooms[0].chats[0].destinationIdentities], ['worker']);
    doubt.rooms[0].publish({method:'display_on_screen', content:'## Why we use C\n\nC gives direct control over memory.'});
    assert.match(doubt.w.document.getElementById('feed')!.textContent!, /Why we use C/);
    doubt.type('Keep this Doubt Solver draft');
    const returned = await navigate(doubt, 'tutor');
    await settle(() => returned.status() === 'Instructor connected', 'returning to Instructor connects');
    assert.equal(returned.w.document.getElementById('feed')!.textContent, instructorCards);
    assert.equal(returned.input.value, 'Keep this Instructor draft');
    const reopened = await navigate(returned, 'doubt_solver');
    await settle(() => !reopened.send.disabled, 'returning to Doubt Solver enables its saved question');
    assert.equal(reopened.input.value, 'Keep this Doubt Solver draft');
    assert.equal(reopened.send.disabled, false);
    // New Chat saves the current draft before replacing the document and reconnects with a new identity.
    const originalId=JSON.parse(reopened.rooms.at(-1)!.rpcs.find(r=>r.method==='switch_mode').payload).doubt_id;
    const oldRoom=reopened.rooms.at(-1)!;
    reopened.w.document.getElementById('new-doubt')!.click();
    await settle(()=>reopened.rooms.length===2 && reopened.status()==='Doubt Solver connected','New Chat connects independently');
    assert.equal(reopened.w.document.getElementById('feed')!.textContent,'');
    assert.equal(reopened.input.value,'');
    const freshPayload=JSON.parse(reopened.rooms.at(-1)!.rpcs.find(r=>r.method==='switch_mode').payload);
    assert.notEqual(freshPayload.doubt_id,originalId);assert.equal(freshPayload.recap,undefined);
    oldRoom.publish({method:'display_on_screen',content:'STALE answer for the first chat'});
    assert.doesNotMatch(reopened.w.document.getElementById('feed')!.textContent!,/STALE/);
    reopened.type('How does a pointer work?');reopened.send.click();
    await settle(()=>reopened.rooms.at(-1)!.chats.length===1,'second chat sends its own question');
    reopened.rooms.at(-1)!.publish({method:'display_on_screen',content:'A pointer stores an address.'});
    const history=reopened.w.document.getElementById('doubt-history') as HTMLDetailsElement;
    history.open=true;
    await settle(()=>reopened.w.document.querySelectorAll('#doubt-chat-list button').length===2,'history lists both chats');
    const prior=[...reopened.w.document.querySelectorAll<HTMLButtonElement>('#doubt-chat-list button')].find(item=>item.textContent!.includes('Why are we using C?'))!;
    assert.ok(prior);prior.click();
    await settle(()=>reopened.rooms.length===3 && reopened.status()==='Doubt Solver connected','saved chat reopens');
    assert.equal(reopened.input.value,'Keep this Doubt Solver draft');
    assert.match(reopened.w.document.getElementById('feed')!.textContent!,/Why we use C/);
    assert.doesNotMatch(reopened.w.document.getElementById('feed')!.textContent!,/pointer stores/);
    const resumed=JSON.parse(reopened.rooms.at(-1)!.rpcs.find(r=>r.method==='switch_mode').payload);
    assert.equal(resumed.doubt_id,originalId);assert.match(JSON.stringify(resumed.recap),/Why are we using C/);
    assert.doesNotMatch(JSON.stringify(resumed.recap),/pointer/);
    // A conflicting save leaves the current conversation and draft on screen.
    const {DoubtConversations}=require('../src/doubtConversations') as typeof import('../src/doubtConversations');
    const otherWindow=await new DoubtConversations(join(storage,'tutor-notebooks'),'production',session.user.id).open(originalId);
    await otherWindow.store.save({...otherWindow.book,textDraft:'Saved in another window'});
    const roomCount=reopened.rooms.length;
    reopened.w.document.getElementById('new-doubt')!.click();
    await settle(()=>/changed in another window/.test(reopened.status()??''),'save conflict is shown before switching');
    assert.equal(reopened.rooms.length,roomCount);assert.equal(reopened.input.value,'Keep this Doubt Solver draft');
    // Resolve through the existing explicit overwrite action to continue the handoff test.
    const keep=reopened.w.document.querySelector<HTMLButtonElement>('#notebook-conflict button:last-child')!;
    assert.ok(keep,'save-conflict resolution remains reachable');keep.click();
    await settle(()=>!reopened.w.document.getElementById('notebook-conflict'),'explicit keep saves this window');
    const handedOff = await navigate(reopened, 'tutor', true);
    await settle(() => handedOff.status() === 'Instructor connected', 'Open in Instructor connects with the carried draft');
    assert.equal(handedOff.input.value, 'Keep this Doubt Solver draft');
    assert.deepEqual([...handedOff.w.document.querySelectorAll<HTMLTextAreaElement>('#feed .note-cell textarea')].map(note => note.value),
      ['Keep this Instructor draft'], 'handoff preserves the previous Instructor draft as a private note');
    assert.equal([...handedOff.w.document.querySelectorAll('#feed > :not(.note-cell)')].map(card => card.textContent).join(''), instructorCards,
      'handoff preserves the completed lesson recap');
    assert.equal(handedOff.rooms[0].chats.length, 0, 'handoff does not send the carried draft');
    assert.deepEqual(requestedModes.slice(0, 2), ['tutor', 'doubt_solver']);
    assert.equal(instructor.outbound.some(message => message.type === 'join' && message.mode === 'doubt_solver'), false);
  } finally {
    allowDoubt();
    for (const dom of windows) if (dom.window.document) dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    while (pending.size) await Promise.all([...pending]);
    for (const dom of windows) dom.window.close();
    for (const panel of panels) if (!panel.disposed) panel.dispose();
    Api.prototype.learningRoom = grant; Api.prototype.practiceCatalog = catalog;
    vscode.commands.executeCommand = execute;
    vscode.window.createWebviewPanel = create;
    await rm(storage, {recursive:true, force:true});
  }
});

