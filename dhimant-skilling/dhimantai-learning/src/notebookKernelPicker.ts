import * as vscode from 'vscode';

/** Focus the requested notebook and pass a real options object across the command bridge. */
export async function openNotebookKernelPicker(doc: vscode.NotebookDocument, provider: 'jupyter' | 'colab' = 'jupyter') {
  if (doc.isClosed || doc.notebookType !== 'jupyter-notebook') throw new Error('Open a notebook first.');
  const editor = await vscode.window.showNotebookDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  const jupyter = vscode.extensions.getExtension('ms-toolsai.jupyter');
  if (!jupyter) throw new Error('Enable Microsoft Jupyter to connect a remote kernel.');
  await jupyter.activate();
  // Jupyter's remote source action returns the controller ID for the chosen server.
  const collection = provider === 'colab' ? ['google.colab', 'colab'] : ['ms-toolsai.jupyter', '_builtin.jupyterServerUrlProvider'];
  const id = await vscode.commands.executeCommand<string>('jupyter.kernel.selectJupyterServerKernel', ...collection, doc);
  if (typeof id !== 'string' || !id.trim()) return 'No kernel was selected. Choose the remote runtime again to retry.';
  const selected = await vscode.commands.executeCommand<boolean>('notebook.selectKernel', {notebookEditor: editor, id, extension: 'ms-toolsai.jupyter'});
  if (selected !== true) throw new Error('The remote kernel could not be selected. Choose the runtime again.');
  return 'Remote kernel selected. Use Run Cell to execute on the selected server.';
}
