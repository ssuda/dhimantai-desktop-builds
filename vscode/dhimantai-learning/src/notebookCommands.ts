import * as vscode from 'vscode';
import { ENVIRONMENTS, Environment, EnvironmentName } from './environments';

export const jupyterMetadata = (doc: vscode.NotebookDocument) => doc.metadata.metadata ?? doc.metadata.custom?.metadata ?? {};

export function contextFor(doc: vscode.NotebookDocument) {
  const meta = jupyterMetadata(doc);
  const link = meta.dhimantai_coach;
  if (link?.version !== 1 || !Object.hasOwn(ENVIRONMENTS, link.environment) ||
      typeof link.question !== 'string' || !link.question.trim() || [...link.question].length > 6000 ||
      typeof link.path !== 'string' || !/^(?:\/notebook-coach\/tutor|\/(?:practice-code|doubt-practice)\/[a-zA-Z0-9_-]{1,100}\/notebook-coach)$/.test(link.path) ||
      typeof meta.kernelspec?.language !== 'string') return;
  return { environment: link.environment as EnvironmentName, path: link.path as string, question: link.question as string,
    language: meta.kernelspec.language as string };
}

export const learnerCell = (cell: vscode.NotebookCell) => cell.kind === vscode.NotebookCellKind.Code &&
  !cell.metadata.metadata?.dhimantai_coach_helper && !/^#@title dhimantAI (?:Coach|Instructor)/.test(cell.document.getText());

/** Notebook execution and files stay in VS Code. Old commands fail locally,
 * before sign-in, transport or file reads, so old linked files cannot upload. */
export function registerNotebookSubmission(context: vscode.ExtensionContext, _testEnvironment?: Environment) {
  const view = vscode.window.createTreeView<never>('dhimantai.notebookSubmission', {
    treeDataProvider: { getChildren: () => [], getTreeItem: item => item },
  });
  const update = () => {
    const doc = vscode.window.activeNotebookEditor?.notebook;
    const linked = !!doc && !!jupyterMetadata(doc).dhimantai;
    view.description = linked ? 'Local notebook' : undefined;
    view.message = undefined;
    void vscode.commands.executeCommand('setContext', 'dhimantai.linkedNotebook', linked);
    void vscode.commands.executeCommand('setContext', 'dhimantai.sessionNotebook', false);
    void vscode.commands.executeCommand('setContext', 'dhimantai.notebookSubmitting', false);
  };
  const retired = () => vscode.window.showInformationMessage(
    'Code transfer and server submission are retired. Run and save this notebook in VS Code. Return to DhimantAI and attach your file for live feedback; it will not be stored or executed there.');
  context.subscriptions.push(view,
    vscode.window.onDidChangeActiveNotebookEditor(update),
    vscode.workspace.onDidChangeNotebookDocument(update),
    vscode.commands.registerCommand('dhimantai.sendNotebookToSession', retired),
    vscode.commands.registerCommand('dhimantai.submitNotebook', retired));
  update();
  return view;
}
