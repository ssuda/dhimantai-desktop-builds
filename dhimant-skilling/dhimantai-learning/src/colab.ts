import * as vscode from 'vscode';
import { externalRuntimeFor, jupyterMetadata } from './notebookCommands';
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
  const jupyter = vscode.extensions.getExtension<{createJupyterServerCollection?: unknown}>('ms-toolsai.jupyter');
  if (!jupyter) throw new Error('Enable Microsoft Jupyter and Google Colab in Extensions, reload the app, then choose Use Colab Kernel again.');
  try {
    const api = await jupyter.activate();
    if (typeof api?.createJupyterServerCollection !== 'function')
      throw new Error('Update Microsoft Jupyter to a version that supports Colab servers.');
    await extension.activate();
  } catch (error) {
    throw new Error(`Colab could not register its kernel source. Enable or update Microsoft Jupyter and Google Colab, reload the app, then choose Use Colab Kernel again. Check View → Output → Colab / Jupyter. ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

export async function chooseColabKernel(doc: vscode.NotebookDocument, accelerator: 'tpu' | 'gpu' | 'any' = 'tpu') {
  if (doc.isClosed) return;
  void vscode.window.showInformationMessage(
    `Choose New Colab Server, sign in with Google, choose ${accelerator === 'any' ? 'CPU, GPU or TPU' : accelerator.toUpperCase()}, then select Python 3 (ipykernel). If the notebook opens the full kernel picker, choose Select Another Kernel → Colab. If Colab is missing, enable or update Google Colab and Microsoft Jupyter in Extensions and reload the app. Availability and usage depend on your Colab account.`
  );
  return openNotebookKernelPicker(doc, 'colab');
}

export async function useColabForNotebook(doc = vscode.window.activeNotebookEditor?.notebook) {
  if (!doc || doc.isClosed || doc.notebookType !== 'jupyter-notebook' || doc.uri.scheme !== 'file')
    throw new Error('Save and open a local Python .ipynb notebook first.');
  const language = jupyterMetadata(doc).kernelspec?.language;
  if ((language && language !== 'python') || doc.getCells().some(
    cell => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId !== 'python'
  )) throw new Error('Use a Python notebook with Google Colab.');
  const accelerator = externalRuntimeFor(doc)?.accelerator;
  if (await ensureColab()) return chooseColabKernel(doc, accelerator === 'gpu' || accelerator === 'tpu' ? accelerator : 'any');
}
