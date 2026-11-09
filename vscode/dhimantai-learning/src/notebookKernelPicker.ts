import * as vscode from 'vscode';

/** Focus the requested notebook and pass a real options object across the command bridge. */
export async function openNotebookKernelPicker(doc: vscode.NotebookDocument) {
  if (doc.isClosed || doc.notebookType !== 'jupyter-notebook') throw new Error('Open a notebook first.');
  await vscode.window.showNotebookDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  try {
    // VS Code 1.106 converts an omitted argument to null; its picker then tests
    // `notebookEditorId in context`. An empty object keeps the public picker safe.
    const selected = await vscode.commands.executeCommand<boolean>('notebook.selectKernel', {});
    return selected === false ? 'No kernel was selected. Use Select Kernel above the notebook to try again.'
      : 'Check the kernel shown above the notebook, then use Run Cell. Choosing a runtime alone does not run code.';
  } catch {
    throw new Error('Could not open the kernel picker. Use Select Kernel above the notebook. For local Python, enable the Python and Jupyter extensions and choose an environment with ipykernel.');
  }
}
