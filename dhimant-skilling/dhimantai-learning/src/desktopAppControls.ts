import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Auth } from './auth';
import { WEB_APP_ORIGINS } from './appLinks';
import type { EnvironmentName } from './environments';
import { DesktopUpdates, installedDesktop } from './desktopUpdates';
import { automaticUpdates, ExtensionUpdates } from './updates';
import { migrateDesktopAppBar } from './desktopConfiguration';

interface Choice extends vscode.QuickPickItem { action?: () => Promise<unknown> }

/** Avatar letters a person recognises: name parts of the email (sambasiva.rao → SR, learner → L), or a phone's last two digits. */
export function profileInitials(identity: string | undefined) {
  if (!identity) return '';
  if (!identity.includes('@')) return identity.replace(/\D/g, '').slice(-2);
  const parts = identity.split('@')[0].split(/[^\p{L}]+/u).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0]?.[0] ?? '').toUpperCase();
}
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/** One place for both update layers and the learner account, backed by existing auth. */
export class DesktopAppControls implements vscode.Disposable {
  private native?: DesktopUpdates;
  private nativeError = 'Reading desktop release information…';
  private identity?: string;
  private accountRequest = 0;
  private disposed = false;
  private lastCheck = 0;
  private nativeBar = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: Auth,
    private readonly environment: () => EnvironmentName, private readonly learning: ExtensionUpdates,
    private readonly checkLearning: () => Promise<void>, private readonly installLearning: () => Promise<void>,
    private readonly testing: boolean, private readonly legacyStatus?: vscode.StatusBarItem) {
    this.disposables.push(this.changed,
      vscode.commands.registerCommand('dhimantai.showUpdates', () => this.showUpdates()),
      vscode.commands.registerCommand('dhimantai.profile', () => this.showProfile()),
      auth.onDidChange(() => { void this.refreshProfile(); }),
      context.secrets.onDidChange(() => { void this.refreshProfile(); }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dhimantai.environment')) void this.refreshProfile();
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
      const target = await installedDesktop(vscode.env.appRoot);
      if (this.disposed) return;
      this.native = new DesktopUpdates(target, join(this.context.globalStorageUri.fsPath, 'desktop-updates'), () => this.refresh());
      this.refresh();
      if (!this.testing) await this.checkNative();
    } catch { this.nativeError = 'Desktop updates are unavailable for this installation.'; this.refresh(); }
  }
  private async refreshProfile() {
    const request = ++this.accountRequest, environment = this.environment();
    const session = await this.auth.session().catch(() => undefined);
    if (this.disposed || request !== this.accountRequest || environment !== this.environment()) return;
    this.identity = session ? session.user.email ?? session.user.phone ?? 'Your account' : undefined;
    this.refresh();
  }
  refresh() {
    if (this.disposed) return;
    this.changed.fire();
    const learning = this.learning.state, native = this.native?.state;
    const busy = learning.status === 'installing' || native?.status === 'downloading';
    const learningReady = learning.status === 'ready', desktopReady = native?.status === 'ready';
    const ready = learningReady || desktopReady;
    const available = learning.status === 'available' || native?.status === 'available';
    const checking = learning.status === 'checking' || native?.status === 'checking';
    const failed = learning.status === 'unavailable' || native?.status === 'unavailable' || (!native && this.nativeError.startsWith('Desktop updates'));
    const current = learning.status === 'current' && native?.status === 'current';
    const state = busy ? 'downloading' : ready ? 'ready' : available ? 'available' : checking ? 'checking' : failed ? 'unavailable' : current ? 'current' : 'unchecked';
    const message = busy ? (native?.status === 'downloading' ? native.message : `Learning extension: ${learning.message}`)
      : learningReady && desktopReady ? 'Learning extension and desktop app updates are ready'
        : learningReady ? 'Learning extension updated — reload when you are ready'
          : desktopReady ? 'Desktop update downloaded — open the installer when you are ready'
            : available ? 'Update available' : checking ? 'Checking for updates…'
        : failed ? 'Updates — check connection or retry' : current ? 'Updates — up to date' : 'Check for updates';
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
      initials: profileInitials(this.identity),
    }).then(undefined, () => {});
  }
  private async checkNative() {
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
  private updateChoices(): Choice[] {
    const learning = this.learning.state, native = this.native?.state;
    const choices: Choice[] = [
      { label: 'Learning extension', kind: vscode.QuickPickItemKind.Separator },
      { label: `Learning extension ${learning.installed}`, description: learning.status, detail: learning.message },
    ];
    if (learning.status === 'ready') choices.push({ label: '$(debug-restart) Reload to apply learning update',
      detail: 'Ends this window’s active lesson. You can also leave the update for your next normal restart.',
      action: async () => vscode.commands.executeCommand('workbench.action.reloadWindow') });
    if (learning.status === 'available') choices.push({ label: '$(cloud-download) Install learning update', action: this.installLearning });
    choices.push({ label: 'Desktop app', kind: vscode.QuickPickItemKind.Separator },
      { label: native ? `Desktop ${native.installed}` : 'Desktop update', description: native?.status, detail: native?.message ?? this.nativeError });
    if (native?.status === 'available') choices.push({ label: '$(cloud-download) Download desktop update', action: () => this.native!.download() });
    if (native?.status === 'ready') choices.push({ label: '$(desktop-download) Open desktop installer',
      detail: 'Finish your lesson first, then follow the installer to update the app. Your course files and profile are kept.',
      action: () => this.openInstaller() });
    choices.push({ label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(refresh) Check for updates', action: () => this.check() },
      { label: '$(settings-gear) Update settings', action: async () => vscode.commands.executeCommand('dhimantai.updateSettings') });
    return choices;
  }
  private showUpdates() {
    const picker = vscode.window.createQuickPick<Choice>();
    picker.title = 'dhimantAI updates'; picker.placeholder = 'Updates never restart an active lesson automatically';
    picker.matchOnDetail = true;
    const render = () => {
      picker.items = this.updateChoices();
      picker.busy = ['checking', 'installing'].includes(this.learning.state.status)
        || ['checking', 'downloading'].includes(this.native?.state.status ?? '');
    };
    const listener = this.changed.event(render);
    const accept = picker.onDidAccept(() => {
      const action = picker.selectedItems[0]?.action;
      if (!action) return;
      void action().catch(() => vscode.window.showErrorMessage('Could not complete the update action. Please try again.'));
      picker.hide();
    });
    picker.onDidHide(() => { listener.dispose(); accept.dispose(); picker.dispose(); });
    render(); picker.show();
    if (this.learning.state.status === 'unchecked' || this.native?.state.status === 'unchecked') void this.check();
  }
  private async showProfile() {
    await this.refreshProfile();
    const environment = this.environment(), identity = this.identity;
    const command = (id: string) => async () => vscode.commands.executeCommand(id);
    const separator = (label: string): Choice => ({ label, kind: vscode.QuickPickItemKind.Separator });
    // Learning first (what people open the menu for), account housekeeping next, Sign out last and apart.
    // The identity is the title, not a row: every row does something.
    const choices: Choice[] = identity ? [
      separator('Learning'),
      { label: '$(book) Continue with Instructor', detail: 'Pick up a lesson where you left off', action: command('dhimantai.openLearningRoom') },
      { label: '$(mortar-board) My courses', detail: 'Your courses, chapters and practice', action: command('dhimantai.browsePractice') },
      { label: '$(verified) My certificates', action: async () => vscode.commands.executeCommand('dhimantai.courseGrade', '__certificates__') },
      { label: '$(library) Course Catalog', action: command('dhimantai.courseCatalog') },
      separator('Account'),
      ...(WEB_APP_ORIGINS[environment] ? [{ label: '$(account) Manage profile', detail: 'Name, photo and account details on the web',
        action: async () => vscode.env.openExternal(vscode.Uri.parse(`${WEB_APP_ORIGINS[environment]}/#/profile`)) }] : []),
      { label: '$(settings-gear) Settings', action: command('workbench.action.openSettings') },
      separator(''),
      { label: '$(sign-out) Sign out', detail: 'Signs out on this computer only. Your course files stay here', action: command('dhimantai.signOut') },
    ] : [
      { label: '$(sign-in) Sign in', detail: 'Continue your courses and Instructor sessions', action: command('dhimantai.signIn') },
      { label: '$(add) Create account', detail: 'The first chapter of every course is free', action: command('dhimantai.signUp') },
      separator(''),
      { label: '$(library) Browse courses', detail: 'No account needed to look around', action: command('dhimantai.courseCatalog') },
      { label: '$(settings-gear) Settings', action: command('workbench.action.openSettings') },
    ];
    const service = environment === 'production' ? '' : ` · ${environment} service`;
    const choice = await vscode.window.showQuickPick(choices, { title: (identity ?? 'dhimantAI · not signed in') + service,
      placeHolder: identity ? 'Courses, profile and sign out' : 'Sign in to continue learning' });
    if (environment !== this.environment() || identity !== this.identity) return;
    try { await choice?.action?.(); }
    catch { void vscode.window.showErrorMessage('Could not open your profile action. Please try again.'); }
  }
  dispose() {
    this.disposed = true; ++this.accountRequest;
    this.native?.dispose(); this.disposables.forEach(item => item.dispose());
  }
}
