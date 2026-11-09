import * as vscode from 'vscode';
import { bindNotebookRuntime } from './notebookRuntime';

/** The renderer owns its message listener only while its content is displayed. */
export type CoachRenderer = (webview: vscode.Webview) => vscode.Disposable;

export class CoachSurface implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private tab?: vscode.WebviewPanel;
  private renderer?: CoachRenderer;
  private listener?: vscode.Disposable;
  private readonly registration?: vscode.Disposable;
  private readonly ready: Thenable<unknown>;

  constructor(private readonly media: vscode.Uri, private readonly usePodman: (doc: vscode.NotebookDocument) => Promise<void>) {
    // VS Code 1.106 introduced secondarySidebar. Keep the adjacent editor on older hosts.
    const [major, minor] = vscode.version.split('.').map(Number);
    this.native = major > 1 || (major === 1 && minor >= 106);
    this.ready = vscode.commands.executeCommand('setContext', 'dhimantai.nativeCoach', this.native);
    void vscode.commands.executeCommand('setContext', 'dhimantai.legacyCoachOpen', false);
    if (this.native) {
      this.registration = vscode.window.registerWebviewViewProvider('dhimantai.coachView', this,
        { webviewOptions: { retainContextWhenHidden: true } });
    }
  }

  readonly native: boolean;
  bindRuntime(webview: vscode.Webview) { return bindNotebookRuntime(webview, this.usePodman); }
  get visible() { return !!(this.view ?? this.tab)?.visible; }

  webviewFor(renderer: CoachRenderer) {
    return this.renderer === renderer ? (this.view ?? this.tab)?.webview : undefined;
  }

  select(renderer: CoachRenderer) {
    if (this.renderer === renderer) return;
    this.renderer = renderer;
    this.render();
  }

  private render() {
    this.listener?.dispose();
    const host = this.view ?? this.tab;
    this.listener = host && this.renderer ? this.renderer(host.webview) : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.onDidChangeVisibility(() => {
      if (!view.visible) void view.webview.postMessage({type: 'audioOff'});
    });
    view.onDidDispose(() => { this.view = undefined; this.render(); });
    this.render();
  }

  async show(preserveFocus: boolean) {
    await this.ready;
    // Instructor owns the full learning interaction inside its notebook.
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (active instanceof vscode.TabInputWebview && active.viewType.includes('dhimantai.learningRoom')) return;
    await vscode.commands.executeCommand('setContext', 'dhimantai.legacyCoachOpen', true);
    if (preserveFocus && this.visible) return;
    if (this.view) return this.view.show(preserveFocus);
    if (this.native) {
      await vscode.commands.executeCommand('dhimantai.coachView.focus', { preserveFocus });
      return;
    }
    if (this.tab) return this.tab.reveal(this.tab.viewColumn, preserveFocus);
    this.tab = vscode.window.createWebviewPanel('dhimantai.coach', 'dhimantAI Coach',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus },
      { enableScripts: true, localResourceRoots: [this.media], retainContextWhenHidden: true });
    this.tab.onDidChangeViewState(({webviewPanel}) => {
      if (!webviewPanel.visible) void webviewPanel.webview.postMessage({type: 'audioOff'});
    });
    this.tab.iconPath = vscode.Uri.joinPath(this.media, 'icon.svg');
    this.tab.onDidDispose(() => { this.tab = undefined; this.render(); });
    this.render();
  }

  async hide() {
    // Remove only the Coach view; closing the whole secondary sidebar would hide other extensions' views.
    if (this.view?.visible) await vscode.commands.executeCommand('dhimantai.coachView.removeView').then(undefined, () => {});
    this.tab?.dispose();
    await vscode.commands.executeCommand('setContext', 'dhimantai.legacyCoachOpen', false);
  }

  dispose() {
    this.listener?.dispose();
    this.tab?.dispose();
    this.registration?.dispose();
  }
}
