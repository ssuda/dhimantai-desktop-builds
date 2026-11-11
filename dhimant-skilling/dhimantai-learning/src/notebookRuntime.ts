import * as vscode from 'vscode';
import { basename } from 'node:path';
import { useColabForNotebook } from './colab';
import { jupyterMetadata } from './notebookCommands';
import { openNotebookKernelPicker } from './notebookKernelPicker';

export function notebookRuntimeControls(webview: vscode.Webview, media: vscode.Uri, nonce: string) {
  return `<section class="notebook-runtime" aria-label="Notebook runtime">
<div class="runtime-row"><label for="runtime">Notebook runtime</label><select id="runtime" aria-describedby="runtime-target runtime-help runtime-status" disabled>
<option value="">Set up or change runtime…</option><option value="podman">Course container</option>
<option value="colab">Google Colab · remote Python</option>
<option value="jupyter">Your GPU / Jupyter server</option>
<option value="terminal">Open course terminal</option><option value="setup">Set up / rebuild course</option>
</select><button id="new-notebook" class="secondary">New notebook</button></div>
<p id="runtime-target" class="muted">Choose a course to prepare its workstation or open its terminal. Source files use Run code.</p>
<p class="muted">Course container setup takes several minutes and needs internet access. Choose Set up / rebuild course to prepare it. For GPU labs, select Colab or your Jupyter server and run the course preflight.</p>
<details><summary>How do I open the course terminal?</summary><p id="runtime-help">Course code and tests run in the course container. DhimantAI downloads and installs Podman, prepares course dependencies and checks execution. Follow any operating-system installation prompts. The Course Runtime terminal runs commands inside that container for every course language. Use the same container commands on Windows, macOS and Linux. Python notebooks can also connect to Google Colab or your own GPU through Jupyter. You write and save notebooks in VS Code; the selected kernel supplies execution. Select Another Kernel → Existing Jupyter Server connects your machine. Runtime selection alone does not verify a GPU.</p></details>
<p id="runtime-status" role="status">No notebook selected.</p>
</section><script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'notebookRuntime.js'))}"></script>`;
}

export async function newNotebook() {
  await vscode.commands.executeCommand('dhimantai.newCourseNotebook');
}

/** Keep the target while the learner focuses Instructor; never route a stale click to another notebook. */
export function bindNotebookRuntime(webview: vscode.Webview, podman: (doc: vscode.NotebookDocument) => Promise<void>) {
  let notebook = vscode.window.activeNotebookEditor?.notebook;
  let busy = false, status = '';
  let revision = 0;
  const post = async () => {
    const current = ++revision;
    const doc = notebook && !notebook.isClosed && notebook.notebookType === 'jupyter-notebook' ? notebook : undefined;
    const language = doc && jupyterMetadata(doc).kernelspec?.language;
    const python = !!doc && (!language || language === 'python') && doc.getCells().every(
      cell => cell.kind !== vscode.NotebookCellKind.Code || cell.document.languageId === 'python');
    let machines;
    try { machines = doc ? await vscode.commands.executeCommand('dhimantai.courseMachines',doc.uri) : undefined; }
    catch { machines = undefined; }
    if (current !== revision) return;
    void webview.postMessage({ type: 'runtimeState', uri: doc?.uri.toString(), name: doc && basename(doc.uri.fsPath),
      colab: python, podman: true, busy, status, machines });
  };
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveNotebookEditor(editor => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (!editor && tab instanceof vscode.TabInputWebview && tab.viewType.includes('dhimantai.coach')) return;
      if (notebook !== editor?.notebook) { notebook = editor?.notebook; status = ''; }
      post();
    }),
    vscode.workspace.onDidCloseNotebookDocument(doc => { if (doc === notebook) { notebook = undefined; post(); } }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai.courseContainers')) post(); }),
    webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready') { post(); return; }
      if (!['runtime', 'newNotebook'].includes(message?.type) || busy) return;
      const doc = notebook;
      if (message.type === 'runtime' && (!(typeof message.runtime === 'string' &&
          (['colab', 'jupyter', 'podman', 'terminal', 'setup'].includes(message.runtime) || /^machine:[a-z][a-z0-9-]{0,62}$/.test(message.runtime))) ||
          (doc ? doc.isClosed || message.uri !== doc.uri.toString() : message.uri || ['colab', 'jupyter'].includes(message.runtime)))) return;
      busy = true; status = message.type === 'newNotebook' ? 'Creating a notebook…' :
        message.runtime === 'colab' ? 'Opening Google Colab runtime setup…' :
        message.runtime === 'jupyter' ? 'Opening your Jupyter kernel selector…' : 'Preparing the course container…';
      post();
      try {
        status = '';
        if (message.runtime?.startsWith('machine:') && doc) {
          const target = message.runtime.slice(8);
          await vscode.commands.executeCommand('dhimantai.selectCourseMachine',doc.uri,target);
          status = 'Ready · ' + target + '. New cells and terminals use this machine.';
        }
        else if (message.runtime === 'setup' || message.runtime === 'terminal' || (message.runtime === 'podman' && !doc)) {
          const result = await vscode.commands.executeCommand(message.runtime === 'terminal' ? 'dhimantai.courseTerminal' : 'dhimantai.setupCourse', doc?.uri);
          status = result ? message.runtime === 'terminal' ? 'Course terminal opened.' : 'Course workstation ready. Code execution verified.' : 'Course setup was not completed. Choose the runtime again to retry.';
        }
        else if (message.type === 'newNotebook') await newNotebook();
        else if (message.runtime === 'colab') status = await useColabForNotebook(doc) ?? '';
        else if (message.runtime === 'jupyter') {
          void vscode.window.showInformationMessage('Choose Select Another Kernel → Existing Jupyter Server for your GPU machine, or select its local Python environment. Run the course GPU preflight to verify execution.');
          status = await openNotebookKernelPicker(doc!);
        }
        else if (message.runtime === 'podman') await podman(doc!);
        status ||= 'Setup returned. Check Select Kernel in the notebook toolbar, select a kernel if needed, then run a cell to verify execution.';
      } catch (error) {
        status = error instanceof Error ? error.message : 'Could not open this runtime.';
      } finally { busy = false; await post(); }
    }),
  );
}
