import * as vscode from 'vscode';
import { jupyterMetadata } from './notebookCommands';
import { openNotebookKernelPicker } from './notebookKernelPicker';

export const COLAB_EXTENSION = 'google.colab';

export function requireColabHost(version = vscode.version) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 1 || (major === 1 && minor >= 101)))
    throw new Error('Google Colab requires VS Code 1.101 or newer. Update VS Code, then choose Open Course with Colab Runtime again.');
  if (vscode.env.remoteName || !vscode.workspace.isTrusted)
    throw new Error('Open a trusted, local VS Code window to connect these notebooks to Google Colab.');
}

// Google owns authentication, server allocation and the kernel. No Google token or
// private Colab API is handled by this extension.
export async function ensureColab() {
  requireColabHost();
  let extension = vscode.extensions.getExtension(COLAB_EXTENSION);
  if (!extension) {
    const install = 'Install Google Colab';
    if (await vscode.window.showInformationMessage(
      'Keep editing in VS Code and execute Python on a Colab runtime through Google’s extension. It also installs Microsoft Jupyter.', install
    ) !== install) return false;
    await vscode.commands.executeCommand('workbench.extensions.installExtension', COLAB_EXTENSION);
    extension = vscode.extensions.getExtension(COLAB_EXTENSION);
    if (!extension)
      throw new Error('Enable Google Colab in Extensions and reload VS Code if requested, then try again.');
  }
  await extension.activate();
  return true;
}

export async function chooseColabKernel(doc: vscode.NotebookDocument, tpu = true) {
  if (doc.isClosed) return;
  void vscode.window.showInformationMessage(
    `Select Another Kernel → Colab → New Colab Server, sign in with Google, then choose ${tpu ? 'TPU' : 'CPU, GPU or TPU'}. Availability and usage depend on your Colab account.`
  );
  // Use the supported VS Code picker; Colab does not expose a public command to
  // allocate a TPU. Never silently select Auto Connect (which may use a CPU).
  return openNotebookKernelPicker(doc);
}

export async function useColabForNotebook(doc = vscode.window.activeNotebookEditor?.notebook) {
  if (!doc || doc.isClosed || doc.notebookType !== 'jupyter-notebook' || doc.uri.scheme !== 'file')
    throw new Error('Save and open a local Python .ipynb notebook first.');
  const language = jupyterMetadata(doc).kernelspec?.language;
  if ((language && language !== 'python') || doc.getCells().some(
    cell => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId !== 'python'
  )) throw new Error('Use a Python notebook with Google Colab.');
  if (await ensureColab()) return chooseColabKernel(doc, false);
}
