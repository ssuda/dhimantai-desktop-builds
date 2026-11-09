import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { CoachRenderer, CoachSurface } from './coachSurface';
import { notebookRuntimeControls } from './notebookRuntime';

/**
 * The Instructor panel for a notebook that is not linked to a DhimantAI exercise: only its runtime
 * choices. Learning itself happens in the Instructor and Practice notebooks.
 */
export function standaloneNotebookView(media: vscode.Uri, surface: CoachSurface) {
  const render: CoachRenderer = webview => {
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('base64');
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'coach.css'))}"></head>
<body>${notebookRuntimeControls(webview, media, nonce)}
<p class="muted">To learn with Instructor or practise an exercise, open <strong>DhimantAI Practice</strong> in the Explorer.</p>
<script nonce="${nonce}">const api = acquireVsCodeApi(); window.installNotebookRuntime?.(api); api.postMessage({type: 'ready'});</script></body></html>`;
    return vscode.Disposable.from(surface.bindRuntime(webview));
  };
  return {
    render,
    show(preserveFocus = true) { surface.select(render); return surface.show(preserveFocus); },
  };
}
