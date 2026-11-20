import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Api } from './api';
import { bindDictation, microphoneControl } from './dictation';
import { messageComposer } from './learningComposer';
import { PracticeAttachment, practiceAttachments } from './practiceAttachments';

/** A native .ipynb has no HTML footer. Its Ask command opens the same form for the selected cell. */
export function notebookPrompt(media: vscode.Uri, cell: vscode.NotebookCell, assistant: 'Instructor' | 'Doubt Solver',
    column: vscode.ViewColumn | undefined, api: Api) {
  const panel = vscode.window.createWebviewPanel('dhimantai.notebookPrompt',
    `Ask ${assistant} · ${basename(cell.notebook.uri.fsPath)} · Cell ${cell.index + 1}`, column ?? vscode.ViewColumn.Active,
    {enableScripts:true, retainContextWhenHidden:true, localResourceRoots:[media]});
  const view = panel.webview, nonce = randomUUID();
  const asset = (name: string) => view.asWebviewUri(vscode.Uri.joinPath(media, name));
  const current = () => panel.visible && !cell.notebook.isClosed && !cell.document.isClosed;
  const dictation = bindDictation(view, () => current() && vscode.workspace.getConfiguration('dhimantai').get('aiAssistance',true)
    ? {key:'notebook', api} : undefined);
  const closed = vscode.workspace.onDidCloseNotebookDocument(doc => { if (doc === cell.notebook) panel.dispose(); });
  const visibility = panel.onDidChangeViewState(() => { void view.postMessage({type:'visibility', visible:panel.visible}); });
  const result = new Promise<{text:string; attachments:PracticeAttachment[]} | undefined>(resolve => {
    const listener = view.onDidReceiveMessage(message => {
      if (message?.type !== 'ask' || typeof message.text !== 'string' || message.text.length > 600 || !current()) return;
      try {
        const attachments = practiceAttachments(message.attachments);
        if (message.text.trim() || attachments.length) {
          resolve({text:message.text.trim(), attachments}); panel.dispose();
        }
      } catch (error) {
        void view.postMessage({type:'attachmentError', text:error instanceof Error ? error.message : 'Could not read the files.'});
      }
    });
    panel.onDidDispose(() => { dictation.dispose(); closed.dispose(); visibility.dispose(); listener.dispose(); resolve(undefined); });
  });
  view.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; media-src blob:; style-src ${view.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${asset('coach.css')}"><link rel="stylesheet" href="${asset('audioControls.css')}"><link rel="stylesheet" href="${asset('learning-room/composer.css')}"></head>
<body><main id="notebook-prompt"><h2>Ask ${assistant} about cell ${cell.index + 1}</h2>
${messageComposer({assistant, maxlength:600, audio:microphoneControl, camera:vscode.env.appName === 'dhimantAI'})}</main>
<script nonce="${nonce}" src="${asset('dictation.js')}"></script><script nonce="${nonce}" src="${asset('learning-room/composer.js')}"></script>
<script nonce="${nonce}" src="${asset('notebookPrompt.js')}"></script></body></html>`;
  return {panel, cell, result};
}
