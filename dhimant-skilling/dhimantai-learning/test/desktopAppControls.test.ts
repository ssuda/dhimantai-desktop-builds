import {test} from 'node:test';
import * as assert from 'node:assert/strict';

class Emitter<T> {
  listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => { this.listeners.add(listener); return {dispose: () => this.listeners.delete(listener)}; };
  fire(value: T) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const commands = new Map<string, (...args: any[]) => any>(), executed: any[][] = [];
const authChanged = new Emitter<void>(), configChanged = new Emitter<any>();
const messages: any[] = [], received = new Emitter<any>();
const tick = () => new Promise(resolve => setImmediate(resolve));
const panel: any = {visible:true, reveal() {}, dispose() {}, onDidDispose:new Emitter().event, onDidChangeViewState:new Emitter().event,
  webview:{onDidReceiveMessage:received.event, postMessage:async (message: any) => { messages.push(message); }}};
const view = () => messages.at(-1)?.view;
const click = async (action: string, id = view()?.id) => { received.fire({type:'desktopControlAction', id, action}); await tick(); };
const catalog = {activeControlPanel:panel, continueLearning:async () => { executed.push(['resumeCourse']); }};
let nativeInstance: any, checks = 0, installs = 0;
let nativeBar = true;
const store = new Map<string, unknown>();
const vscode = {
  EventEmitter: Emitter, ConfigurationTarget: {Global: 1}, QuickPickItemKind: {Separator: -1},
  env: {appRoot: '/desktop', appName: 'dhimantAI', openExternal: async (url: unknown) => { executed.push(['external', url]); }},
  Uri: {parse: (value: string) => value},
  commands: {
    registerCommand: (id: string, action: (...args: any[]) => any) => { commands.set(id, action); return {dispose: () => commands.delete(id)}; },
    getCommands: async (filterInternal: boolean) => filterInternal || !nativeBar ? [] : ['_dhimantai.setAppBarState'],
    executeCommand: async (...args: any[]) => { executed.push(args); },
  },
  workspace: {getConfiguration: () => ({inspect: () => ({globalValue: undefined}), get: () => false, update: async () => {}}),
    onDidChangeConfiguration: configChanged.event},
  window: {onDidChangeWindowState: () => ({dispose() {}}), showErrorMessage: async () => {},
    createWebviewPanel: () => panel},
  ViewColumn:{Active:-1},
};
const native = {installedDesktop: async () => ({version: '1.0.0', environment: 'staging'}), DesktopUpdates: class {
  state = {status: 'current', installed: '1.0.0', message: 'Up to date'};
  constructor() { nativeInstance = this; }
  check() { checks++; } dispose() {} download() {}
}};
const Module = require('node:module'), original = Module._load;
const apply = {
  applicationName: async () => 'dhimantai',
  prepareDesktopApply: async ({installer}: {installer:string}) => ({command:'test-installer', args:[installer]}),
  startDetached: async (plan: {command:string; args:string[]}) => { executed.push([plan.command, ...plan.args]); },
};
Module._load = function(request: string, ...args: unknown[]) {
  if (request === './desktopApply') return apply;
  return request === 'vscode' ? vscode : request === './desktopUpdates' ? native : original.call(this, request, ...args);
};
const {DesktopAppControls, profileInitials} = require('../src/desktopAppControls') as typeof import('../src/desktopAppControls');
Module._load = original;

test('desktop controls bridge only public account fields, update on auth changes, and expose both update layers without restarting', async () => {
  let session: any = {access_token: 'secret-access', refresh_token: 'secret-refresh', user: {id: 'learner', email: 'learner@example.test'}};
  const context: any = {globalStorageUri: {fsPath: '/test'}, secrets: {onDidChange: () => ({dispose() {}})},
    globalState: {get: (key: string) => store.get(key), update: async (key: string, value: unknown) => {store.set(key, value);}}};
  const auth: any = {session: async () => session, onDidChange: authChanged.event};
  const learning: any = {check:async () => {}, state: {status: 'ready', installed: '0.1.0', message: 'Installed; reload when ready'}};
  const controls = new DesktopAppControls(context, auth, () => 'staging', learning,
    async () => { checks++; }, async () => { installs++; }, true, undefined, catalog);
  try {
    await new Promise(resolve => setImmediate(resolve));
    const state = () => executed.filter(call => call[0] === '_dhimantai.setAppBarState').at(-1)?.[1];
    assert.equal(state().status, 'ready'); assert.match(state().profile, /learner@example.test/);
    assert.equal(state().message, 'Restart dhimantAI to apply the verified update');
    assert.ok(!JSON.stringify(executed).includes('secret-'));
    assert.ok(!executed.some(call => call[0] === 'workbench.action.reloadWindow'));
    assert.equal(checks, 0, 'test activation makes no background requests');
    assert.equal(store.get('desktopAppBarIntroduced'), true, 'internal command detection supports upgrade migration');
    learning.state = {...learning.state, status:'unavailable', message:'Offline'};
    await commands.get('dhimantai.showUpdates')!();
    assert.equal(view(), undefined, 'a failed sidebar check never opens a dialog');
    assert.equal(state().status, 'unavailable');
    assert.match(state().message, /Offline.*retry/);
    learning.state = {...learning.state, status:'installing', message:'Downloading learning update… 66%'};
    controls.refresh();
    assert.match(state().message, /66%/);
    learning.state = {...learning.state, status:'available', retry:true, message:'The download stopped receiving data.'};
    controls.refresh();
    assert.match(state().message, /stopped receiving data.*retry/);
    learning.state = {...learning.state, status:'ready', retry:false};
    nativeInstance.state = {status:'downloading', progress:42, installed:'1.0.0', available:'1.1.0', message:'Downloading'};
    controls.refresh();
    assert.equal(state().status, 'downloading');
    assert.match(state().message, /42%/);
    nativeInstance.state = {status:'available', retry:true, installed:'1.0.0', available:'1.1.0', message:'Download failed'};
    controls.refresh();
    assert.match(state().message, /Download failed.*retry/);
    let downloads = 0; nativeInstance.download = () => { downloads++; };
    learning.state.status = 'available';
    await commands.get('dhimantai.showUpdates')!();
    assert.equal(downloads, 1); assert.equal(installs, 1, 'one download fetches both the app and the learning update');
    learning.state.status = 'ready';
    assert.equal(view(), undefined);
    await commands.get('dhimantai.profile')!();
    const stale = view().id;
    session = undefined; authChanged.fire(); await tick();
    assert.equal(view(), undefined);
    await click('reload', stale);
    assert.ok(!executed.some(call => call[0] === 'workbench.action.reloadWindow'));
    assert.equal(state().initials, ''); assert.equal(state().profile, 'Sign in to dhimantAI');
    await commands.get('dhimantai.profile')!();
    assert.equal(view().contact, undefined);
    await click('signOut'); await click('signIn');
    assert.ok(executed.some(call => call[0] === 'dhimantai.signIn'));
    assert.ok(!executed.some(call => call[0] === 'dhimantai.signOut'));
    assert.ok(!JSON.stringify(messages).includes('secret-'));
    nativeInstance.state = {status:'unavailable', installed:'1.0.0', message:'Offline'}; learning.state.status = 'current'; controls.refresh();
    assert.equal(state().status, 'unavailable');
    assert.equal(installs, 1);
  } finally { controls.dispose(); }
  assert.equal(commands.size, 0);
});

test('one explicit restart applies the verified desktop installer and pending learning update', async () => {
  const context: any = {globalStorageUri:{fsPath:'/test'}, secrets:{onDidChange:() => ({dispose() {}})},
    globalState:{get:() => true, update:async () => {}}};
  const auth: any = {session:async () => undefined, onDidChange:authChanged.event};
  const learning: any = {check:async () => {}, state:{status:'ready', installed:'0.1.0', available:'0.2.0', message:'Ready'}};
  let finish!: () => void;
  const download = new Promise<void>(resolve => {finish = resolve;});
  const controls = new DesktopAppControls(context, auth, () => 'staging', learning, async () => {}, async () => {
    await download;
    learning.state.status = 'ready';
  }, true, undefined, catalog);
  try {
    await tick();
    assert.equal(controls.canReloadLearningAtStartup, true);
    nativeInstance.state = {status:'checking', installed:'1.0.0', message:'Checking'};
    assert.equal(controls.canReloadLearningAtStartup, false);
    await commands.get('dhimantai.showUpdates')!();
    assert.equal(view(), undefined);
    nativeInstance.state.status = 'unavailable'; controls.refresh();
    assert.equal(view(), undefined);
    nativeInstance.state = {status:'ready', installed:'1.0.0', available:'1.1.0', message:'Verified'};
    nativeInstance.installerPath = async () => '/cached/verified-installer';
    controls.refresh();
    assert.equal(view(), undefined);
    learning.state.status = 'available';
    const before = executed.length;
    const first = commands.get('dhimantai.showUpdates')!();
    assert.equal(commands.get('dhimantai.showUpdates')!(), first, 'repeated clicks join the same update');
    await tick();
    assert.equal(executed.slice(before).some(step => step[0] === 'workbench.action.quit'), false);
    finish();
    await first;
    assert.deepEqual(executed.slice(before).filter(step => step[0] !== '_dhimantai.setAppBarState'),
      [['test-installer', '/cached/verified-installer'], ['workbench.action.quit']]);
    assert.equal(controls.canReloadLearningAtStartup, false);
  } finally { controls.dispose(); }
});

test('older desktops surface the upgrade through the existing status item until the new rail is installed', async () => {
  nativeBar = false;
  const status: any = {};
  const context: any = {globalStorageUri: {fsPath: '/test'}, secrets: {onDidChange: () => ({dispose() {}})},
    globalState: {get: () => true, update: async () => {}}};
  const learning: any = {check:async () => {}, state: {status: 'ready', installed: '0.1.0', message: 'Ready'}};
  const controls = new DesktopAppControls(context, {session: async () => undefined, onDidChange: authChanged.event} as any,
    () => 'staging', learning, async () => {}, async () => {}, true, status);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(status.command, 'dhimantai.showUpdates'); assert.match(status.text, /Update ready/);
    learning.state.status = 'current'; controls.refresh();
    assert.equal(status.command, 'dhimantai.courseCatalog');
  } finally { controls.dispose(); nativeBar = true; }
});

test('the profile avatar uses recognisable initials and the menu leads with learning, ending with sign out', async () => {
  assert.equal(profileInitials('sambasiva.rao@example.test'), 'SR');
  assert.equal(profileInitials('learner42@example.test'), 'L');
  assert.equal(profileInitials('+91 98765 43210'), '10');
  assert.equal(profileInitials(undefined), '');
  nativeBar = true;
  const context: any = {globalStorageUri: {fsPath: '/test'}, secrets: {onDidChange: () => ({dispose() {}})},
    globalState: {get: () => true, update: async () => {}}};
  const auth: any = {session: async () => ({access_token: 'secret', user: {id: 'learner', email: 'asha.k@example.test', displayName:'Asha Kumar'}}), onDidChange: authChanged.event};
  const learning: any = {check:async () => {}, state: {status: 'current', installed: '0.1.0', message: 'Up to date'}};
  const controls = new DesktopAppControls(context, auth, () => 'staging', learning, async () => {}, async () => {}, true, undefined, catalog);
  try {
    await new Promise(resolve => setImmediate(resolve));
    const state = executed.filter(call => call[0] === '_dhimantai.setAppBarState').at(-1)?.[1];
    assert.equal(state.initials, 'AK');
    await commands.get('dhimantai.profile')!();
    assert.equal(view().name, 'Asha Kumar'); assert.equal(view().service, 'Staging service');
    assert.equal(view().contact, 'asha.k@example.test');
    await click('continue'); assert.deepEqual(executed.at(-1), ['resumeCourse']);
    await commands.get('dhimantai.profile')!(); await click('courses');
    assert.deepEqual(executed.at(-1), ['dhimantai.myCourses']);
    await commands.get('dhimantai.profile')!(); await click('manage');
    assert.deepEqual(executed.at(-1), ['external', 'https://app-staging.dhimant.ai/#/profile?signin=email']);
    assert.ok(!JSON.stringify(executed.at(-1)).includes('asha.k'), 'profile URLs do not carry identity or session tokens');
  } finally { controls.dispose(); }
});
