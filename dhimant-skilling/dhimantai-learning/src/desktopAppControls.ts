import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CourseCatalog } from './courseCatalog';
import { type Auth, learnerDisplayName } from './auth';
import { type ControlKind, type ControlView, standaloneControls, updateCard } from './desktopControlView';
import { WEB_APP_ORIGINS } from './appLinks';
import type { EnvironmentName } from './environments';
import { DesktopUpdates, installedDesktop } from './desktopUpdates';
import { automaticUpdates, ExtensionUpdates } from './updates';
import { migrateDesktopAppBar } from './desktopConfiguration';

interface OpenControl {
  id: string;
  kind: ControlKind;
  panel: vscode.WebviewPanel;
  standalone: boolean;
  account?: string;
  environment: EnvironmentName;
  listeners: vscode.Disposable[];
}

export function profileInitials(identity: string | undefined, name?: string) {
  const words = (name || identity?.split('@')[0] || '').match(/[\p{L}][\p{L}\p{M}]*/gu) ?? [];
  const graphemes = new Intl.Segmenter();
  return words.slice(0, 2).map(word => graphemes.segment(word).containing(0)!.segment).join('').toLocaleUpperCase()
    || identity?.replace(/\D/g, '').slice(-2) || '';
}
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/** One place for both update layers and the learner account, backed by existing auth. */
export class DesktopAppControls implements vscode.Disposable {
  private native?: DesktopUpdates;
  private nativeError?: string;
  private loadingNative?: Promise<void>;
  private openControl?: OpenControl;
  private account?: string;
  private displayName?: string;
  private opening = 0;
  private identity?: string;
  private accountRequest = 0;
  private disposed = false;
  private lastCheck = 0;
  private nativeBar = false;
  private readonly disposables: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: Auth,
    private readonly environment: () => EnvironmentName, private readonly learning: ExtensionUpdates,
    private readonly checkLearning: () => Promise<void>, private readonly installLearning: () => Promise<void>,
    private readonly testing: boolean, private readonly legacyStatus?: vscode.StatusBarItem,
    private readonly catalog?: Pick<CourseCatalog, 'activeControlPanel' | 'continueLearning'>) {
    this.disposables.push(
      vscode.commands.registerCommand('dhimantai.showUpdates', () => this.show('updates')),
      vscode.commands.registerCommand('dhimantai.profile', () => this.show('profile')),
      auth.onDidChange(() => { void this.refreshProfile(); }),
      context.secrets.onDidChange(() => { void this.refreshProfile(); }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dhimantai.environment')) { this.close(); void this.refreshProfile(); }
        if (e.affectsConfiguration('dhimantai.autoUpdate') && !testing) void this.checkNative();
      }),
      vscode.window.onDidChangeWindowState(e => {
        if (e.focused && !testing && Date.now() - this.lastCheck >= CHECK_INTERVAL) void this.check();
      }));
    if (!testing) {
      const timer = setInterval(() => { void this.check(); }, CHECK_INTERVAL);
      this.disposables.push({ dispose: () => clearInterval(timer) });
    }
    void this.refreshProfile();
    void this.initialize();
  }
  private async initialize() {
    try {
      this.nativeBar = (await vscode.commands.getCommands()).includes('_dhimantai.setAppBarState');
      if (this.disposed) return;
      if (this.nativeBar) {
        const settings = vscode.workspace.getConfiguration();
        await migrateDesktopAppBar(this.context.globalState, { inspect: key => settings.inspect(key),
          update: (key, value) => settings.update(key, value, vscode.ConfigurationTarget.Global) });
      }
    } catch { /* The existing status bar remains available on older shells. */ }
    await this.loadNative();
    if (!this.testing && this.native) await this.checkNative();
  }
  private loadNative() {
    if (this.native || this.disposed) return;
    return this.loadingNative ??= this.readNative().finally(() => { this.loadingNative = undefined; });
  }
  private async readNative() {
    this.nativeError = undefined;
    this.render();
    try {
      const target = await installedDesktop(vscode.env.appRoot);
      if (this.disposed) return;
      this.native = new DesktopUpdates(target, join(this.context.globalStorageUri.fsPath, 'desktop-updates'), () => this.refresh());
    } catch {
      this.nativeError = 'Could not read the desktop installation details. Check that you are using a supported dhimantAI desktop build.';
    }
    this.refresh();
  }
  private async refreshProfile() {
    const request = ++this.accountRequest, environment = this.environment();
    const session = await this.auth.session().catch(() => undefined);
    if (this.disposed || request !== this.accountRequest || environment !== this.environment()) return;
    if (this.openControl && (this.openControl.account !== session?.user.id || this.openControl.environment !== environment)) this.close();
    this.account = session?.user.id;
    this.displayName = session && learnerDisplayName(session);
    this.identity = session ? session.user.email ?? session.user.phone ?? 'Your account' : undefined;
    this.refresh();
  }
  refresh() {
    if (this.disposed) return;
    this.render();
    const learning = this.learning.state, native = this.native?.state;
    const busy = learning.status === 'installing' || native?.status === 'downloading';
    const learningReady = learning.status === 'ready', desktopReady = native?.status === 'ready';
    const ready = learningReady || desktopReady;
    const available = learning.status === 'available' || native?.status === 'available';
    const checking = learning.status === 'checking' || native?.status === 'checking';
    const incompatible = learning.status === 'incompatible' || native?.status === 'incompatible';
    const failed = incompatible || learning.retry || native?.retry || learning.status === 'unavailable' || native?.status === 'unavailable' || this.nativeError;
    const current = learning.status === 'current' && native?.status === 'current';
    const state = busy ? 'downloading' : ready ? 'ready' : failed ? 'unavailable' : available ? 'available' : checking ? 'checking' : current ? 'current' : 'unchecked';
    const message = busy ? (native?.status === 'downloading' ? native.message : `Learning extension: ${learning.message}`)
      : learningReady && desktopReady ? 'Learning extension and desktop app updates are ready'
        : learningReady ? 'Learning extension updated — reload when you are ready'
          : desktopReady ? 'Desktop update downloaded — open the installer when you are ready'
            : incompatible ? 'Updates — review compatibility warning' : failed ? 'Updates — check details or retry'
            : available ? 'Update available' : checking ? 'Checking for updates…' : current ? 'Updates — up to date' : 'Check for updates';
    if (this.legacyStatus) {
      const attention = !this.nativeBar && (busy || ready || available);
      const readyLabel = learningReady && desktopReady ? 'Updates ready' : learningReady ? 'Learning update ready' : 'App update ready';
      this.legacyStatus.text = attention ? `$(cloud-download) dhimantAI · ${ready ? readyLabel : busy ? 'Updating…' : 'Update available'}` : '$(mortar-board) dhimantAI';
      this.legacyStatus.tooltip = attention ? message : 'Open Course Catalog, Instructor, and Doubt Solver.';
      this.legacyStatus.command = attention ? 'dhimantai.showUpdates' : 'dhimantai.courseCatalog';
    }
    // Older desktops keep working until the learner installs the new native shell.
    void vscode.commands.executeCommand('_dhimantai.setAppBarState', {
      status: state, message, profile: this.identity ? `${this.identity} — courses, profile and sign out` : 'Sign in to dhimantAI',
      initials: profileInitials(this.identity, this.displayName),
    }).then(undefined, () => {});
  }
  private async checkNative() {
    await this.loadNative();
    if (!this.native || this.disposed) return;
    await this.native.check();
    const config = vscode.workspace.getConfiguration('dhimantai');
    if (!automaticUpdates(vscode.env.appName, config.inspect<boolean>('autoUpdate')?.globalValue, config.get('autoUpdate', false))) return;
    const state = this.native.state;
    if (state.status !== 'available' || !state.available) return;
    const key = `desktopDownloadAttempt:${state.installed}:${state.available}`;
    if (this.context.globalState.get(key)) return;
    await this.context.globalState.update(key, true);
    if (!this.disposed) await this.native.download();
  }
  private async check() {
    this.lastCheck = Date.now();
    await Promise.all([this.checkLearning(), this.checkNative()]);
  }
  private async openInstaller() {
    const path = await this.native?.installerPath();
    if (!path) return;
    // Explicit learner action opens the verified installer. Never terminate the app,
    // launch a silent installer, or replace files belonging to a running process.
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [path], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  private view(open: OpenControl): ControlView {
    const native = this.native?.state ?? {status: this.nativeError ? 'unavailable' : 'checking', installed: '',
      message: this.nativeError ?? 'Reading desktop installation details…'};
    const env = this.environment();
    return {kind: open.kind, id: open.id, name: this.displayName, contact: this.identity,
      initials: profileInitials(this.identity, this.displayName), service: env[0].toUpperCase() + env.slice(1) + ' service',
      manageProfile: !!this.account && !!WEB_APP_ORIGINS[env],
      extension: updateCard('extension', this.learning.state), desktop: updateCard('desktop', native)};
  }
  get isOpen() { return !!this.openControl; }
  private render() {
    const open = this.openControl;
    if (open) void open.panel.webview.postMessage({type:'desktopControlView', view:this.view(open)});
  }
  private close(disposed = false) {
    const open = this.openControl;
    this.openControl = undefined;
    if (!open) return;
    open.listeners.forEach(listener => listener.dispose());
    if (disposed) return;
    if (open.standalone) open.panel.dispose();
    else void open.panel.webview.postMessage({type:'desktopControlView'});
  }
  private async show(kind: ControlKind) {
    const opening = ++this.opening;
    await this.refreshProfile();
    if (this.disposed || opening !== this.opening) return;
    this.close();
    const catalog = this.catalog?.activeControlPanel;
    const panel = catalog ?? vscode.window.createWebviewPanel('dhimantai.desktopControls',
      kind === 'updates' ? 'dhimantAI Updates' : 'Your profile', vscode.ViewColumn.Active,
      { enableScripts:true, localResourceRoots:[] });
    const open: OpenControl = {kind, id:randomUUID(), panel, standalone:!catalog,
      environment:this.environment(), account:this.account, listeners:[]};
    this.openControl = open;
    open.listeners.push(panel.onDidDispose(() => this.close(true)),
      panel.onDidChangeViewState(() => { if (!panel.visible) this.close(); }),
      panel.webview.onDidReceiveMessage(message => {
        if (this.openControl !== open) return;
        if (message?.type === 'desktopControlReady') this.render();
        if (message?.type === 'desktopControlAction' && message.id === open.id)
          void this.act(open, message.action).catch(() => vscode.window.showErrorMessage('Could not complete that action. Please try again.'));
      }));
    if (catalog) {
      panel.reveal(panel.viewColumn);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      if (this.openControl !== open) return;
      this.render();
    }
    else panel.webview.html = standaloneControls(randomUUID());
    if (kind === 'updates' && (this.learning.state.status === 'unchecked' || this.native?.state.status === 'unchecked')) void this.check();
  }
  private async act(open: OpenControl, action: string) {
    if (action === 'close') { this.close(); return; }
    const session = await this.auth.session();
    if (open !== this.openControl || open.environment !== this.environment() || open.account !== session?.user.id) return;
    const command = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);
    if (open.kind === 'profile') {
      const origin = WEB_APP_ORIGINS[open.environment];
      const actions = new Map<string, () => Thenable<unknown>>([
        ['settings', () => command('workbench.action.openSettings')], ['catalog', () => command('dhimantai.courseCatalog')],
      ]);
      if (session) {
        actions.set('continue', () => this.catalog ? this.catalog.continueLearning(session.user.id) : command('dhimantai.openLearningRoom'));
        actions.set('courses', () => command('dhimantai.browsePractice'));
        actions.set('certificates', () => command('dhimantai.courseGrade', '__certificates__'));
        actions.set('signOut', () => command('dhimantai.signOut'));
        if (origin) actions.set('manage', () => vscode.env.openExternal(vscode.Uri.parse(`${origin}/#/profile${session.user.email ? '?signin=email' : ''}`)));
      } else {
        actions.set('signIn', () => command('dhimantai.signIn'));
        actions.set('signUp', () => command('dhimantai.signUp'));
      }
      const run = actions.get(action);
      if (run) { this.close(); await run(); }
      return;
    }
    const {extension, desktop} = this.view(open);
    if (action === 'check' && !extension.busy && !desktop.busy) return this.check();
    if (action === 'updateSettings') { this.close(); return command('dhimantai.updateSettings'); }
    if (action === 'extensionNotes') {
      this.close();
      return command('markdown.showPreview', vscode.Uri.joinPath(this.context.extensionUri, 'changelog.md'));
    }
    if (action === 'desktopNotes') {
      const version = desktop.available;
      const releases = 'https://github.com/ssuda/dhimantai-downloads/releases';
      return vscode.env.openExternal(vscode.Uri.parse(version ? releases + '/tag/v' + encodeURIComponent(version) : releases));
    }
    if (action !== extension.action && action !== desktop.action) return;
    switch (action) {
      case 'checkExtension': return this.checkLearning();
      case 'checkDesktop': return this.checkNative();
      case 'install': return this.installLearning();
      case 'download': return this.native?.download();
      case 'openInstaller': return this.openInstaller();
      case 'reload': return command('workbench.action.reloadWindow');
    }
  }
  dispose() {
    this.disposed = true; ++this.accountRequest; this.close();
    this.native?.dispose(); this.disposables.forEach(item => item.dispose());
  }
}
