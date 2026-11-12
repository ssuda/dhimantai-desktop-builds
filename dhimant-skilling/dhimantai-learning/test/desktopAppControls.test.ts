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
let pickedItems: any[] = [], choice: string | undefined;
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
    showQuickPick: async (items: any[]) => { pickedItems = items; return items.find(item => item.label === choice); },
    createQuickPick: () => {
      const accepted = new Emitter<void>(), hidden = new Emitter<void>();
      return {items: [], selectedItems: [], onDidAccept: accepted.event, onDidHide: hidden.event,
        show() { pickedItems = this.items; }, hide() { hidden.fire(); }, dispose() {}};
    }},
};
const native = {installedDesktop: async () => ({version: '1.0.0', environment: 'staging'}), DesktopUpdates: class {
  state = {status: 'current', installed: '1.0.0', message: 'Up to date'};
  constructor() { nativeInstance = this; }
  check() { checks++; } dispose() {} download() {}
}};
const Module = require('node:module'), original = Module._load;
Module._load = function(request: string, ...args: unknown[]) {
  return request === 'vscode' ? vscode : request === './desktopUpdates' ? native : original.call(this, request, ...args);
};
const {DesktopAppControls, profileInitials} = require('../src/desktopAppControls') as typeof import('../src/desktopAppControls');
Module._load = original;

test('desktop controls bridge only public account fields, update on auth changes, and expose both update layers without restarting', async () => {
  let session: any = {access_token: 'secret-access', refresh_token: 'secret-refresh', user: {id: 'learner', email: 'learner@example.test'}};
  const context: any = {globalStorageUri: {fsPath: '/test'}, secrets: {onDidChange: () => ({dispose() {}})},
    globalState: {get: (key: string) => store.get(key), update: async (key: string, value: unknown) => {store.set(key, value);}}};
  const auth: any = {session: async () => session, onDidChange: authChanged.event};
  const learning: any = {state: {status: 'ready', installed: '0.1.0', message: 'Installed; reload when ready'}};
  const controls = new DesktopAppControls(context, auth, () => 'staging', learning,
    async () => { checks++; }, async () => { installs++; }, true);
  try {
    await new Promise(resolve => setImmediate(resolve));
    const state = () => executed.filter(call => call[0] === '_dhimantai.setAppBarState').at(-1)?.[1];
    assert.equal(state().status, 'ready'); assert.match(state().profile, /learner@example.test/);
    assert.equal(state().message, 'Learning extension updated — reload when you are ready');
    assert.ok(!JSON.stringify(executed).includes('secret-'));
    assert.ok(!executed.some(call => call[0] === 'workbench.action.reloadWindow'));
    assert.equal(checks, 0, 'test activation makes no background requests');
    assert.equal(store.get('desktopAppBarIntroduced'), true, 'internal command detection supports upgrade migration');
    await commands.get('dhimantai.showUpdates')!();
    assert.ok(pickedItems.some(item => /Reload to apply/.test(item.label)));
    assert.ok(pickedItems.some(item => item.label === 'Desktop 1.0.0'));
    assert.ok(pickedItems.some(item => item.label === 'Learning extension 0.1.0'));
    assert.ok(!pickedItems.some(item => /Download desktop|Open desktop installer/.test(item.label)),
      'an extension-only update never offers an app download or installer');
    session = undefined; authChanged.fire(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(state().initials, ''); assert.equal(state().profile, 'Sign in to dhimantAI');
    choice = '$(sign-in) Sign in'; await commands.get('dhimantai.profile')!();
    assert.ok(executed.some(call => call[0] === 'dhimantai.signIn'));
    assert.ok(!pickedItems.some(item => /Sign out/.test(item.label)));
    nativeInstance.state.status = 'unavailable'; learning.state.status = 'current'; controls.refresh();
    assert.equal(state().status, 'unavailable');
    assert.equal(installs, 0);
  } finally { controls.dispose(); }
  assert.equal(commands.size, 0);
});

test('older desktops surface the upgrade through the existing status item until the new rail is installed', async () => {
  nativeBar = false;
  const status: any = {};
  const context: any = {globalStorageUri: {fsPath: '/test'}, secrets: {onDidChange: () => ({dispose() {}})},
    globalState: {get: () => true, update: async () => {}}};
  const learning: any = {state: {status: 'ready', installed: '0.1.0', message: 'Ready'}};
  const controls = new DesktopAppControls(context, {session: async () => undefined, onDidChange: authChanged.event} as any,
    () => 'staging', learning, async () => {}, async () => {}, true, status);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(status.command, 'dhimantai.showUpdates'); assert.match(status.text, /Learning update ready/);
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
  const auth: any = {session: async () => ({access_token: 'secret', user: {id: 'learner', email: 'asha.k@example.test'}}), onDidChange: authChanged.event};
  const learning: any = {state: {status: 'current', installed: '0.1.0', message: 'Up to date'}};
  const controls = new DesktopAppControls(context, auth, () => 'staging', learning, async () => {}, async () => {}, true);
  try {
    await new Promise(resolve => setImmediate(resolve));
    const state = executed.filter(call => call[0] === '_dhimantai.setAppBarState').at(-1)?.[1];
    assert.equal(state.initials, 'AK');
    choice = '$(mortar-board) My courses'; await commands.get('dhimantai.profile')!();
    const rows = pickedItems.filter(item => item.kind !== -1).map(item => item.label);
    assert.deepEqual(rows.slice(0, 4), ['$(book) Continue with Instructor', '$(mortar-board) My courses', '$(verified) My certificates', '$(library) Course Catalog']);
    assert.equal(rows.at(-1), '$(sign-out) Sign out');
    assert.ok(!rows.includes('asha.k@example.test'), 'the identity is the title, not a row that does nothing');
    assert.deepEqual(executed.at(-1), ['dhimantai.browsePractice']);
  } finally { controls.dispose(); }
});
