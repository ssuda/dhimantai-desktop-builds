import * as vscode from 'vscode';
import { courseAllowsCopilot } from './courseCopilot';
import { jupyterMetadata } from './notebookCommands';

/** The custom desktop applies a temporary, per-window course setting. */
export class CopilotPolicy implements vscode.Disposable {
  private disposed = false;
  private pending = false;
  private running?: Promise<void>;
  private readonly panels = new Map<vscode.WebviewPanel, { course?: string; assistance: boolean }>();
  private readonly listeners: vscode.Disposable[];

  constructor(private readonly output: Pick<vscode.OutputChannel, 'appendLine'>,
      private readonly courseForFile: (uri: vscode.Uri) => string | undefined = () => undefined) {
    this.listeners = [
      vscode.window.tabGroups.onDidChangeTabs(() => { void this.enforce(); }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => { void this.enforce(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.enforce(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('dhimantai.environment')) void this.enforce();
      }),
    ];
  }

  bindPanel(panel: vscode.WebviewPanel, course?: string, assistance = true) {
    const state = { course, assistance };
    this.panels.set(panel, state);
    const visibility = panel.onDidChangeViewState(() => { void this.enforce(); });
    panel.onDidDispose(() => {
      visibility.dispose(); this.panels.delete(panel); void this.enforce();
    });
    void this.enforce();
    return (course?: string, assistance = true) => {
      state.course = course; state.assistance = assistance;
      return this.enforce();
    };
  }

  private enabled(): boolean {
    for (const [panel, state] of this.panels) {
      if (panel.active) return state.assistance && courseAllowsCopilot(state.course);
    }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook ? input.uri
      : input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff ? input.modified : undefined;
    if (uri) {
      const doc = vscode.workspace.notebookDocuments.find(doc => doc.uri.toString() === uri.toString());
      const practice = doc && jupyterMetadata(doc).dhimantai_practice;
      if (practice && practice.code_assistance_allowed !== true) return false;
      return courseAllowsCopilot(this.courseForFile(uri));
    }
    // Catalog, lesson chooser, unrelated files and unknown courses stay disabled.
    return false;
  }

  enforce(): Promise<void> {
    if (this.disposed || vscode.env.appName !== 'dhimantAI') return Promise.resolve();
    this.pending = true;
    return this.running ??= this.drain().finally(() => {
      this.running = undefined;
      if (this.pending && !this.disposed) void this.enforce();
    });
  }

  private async drain() {
    while (this.pending && !this.disposed) {
      this.pending = false;
      try {
        await vscode.commands.executeCommand('_dhimantai.setCourseCopilotEnabled', this.enabled());
      } catch (error) {
        this.output.appendLine(`Could not apply course Copilot setting: ${error instanceof Error ? error.message : String(error)}`);
        void vscode.window.showWarningMessage('Could not apply this course’s Copilot setting. Reload the dhimantAI desktop.');
      }
    }
  }

  dispose() {
    this.disposed = true; this.pending = false;
    this.listeners.forEach(listener => listener.dispose());
    this.panels.clear();
    if (vscode.env.appName === 'dhimantAI') void vscode.commands.executeCommand('_dhimantai.setCourseCopilotEnabled', false);
  }
}
