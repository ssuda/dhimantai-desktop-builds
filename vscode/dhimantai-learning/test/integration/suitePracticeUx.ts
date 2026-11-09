/** UX audit of the in-notebook Practice journey, measured in the real VS Code window (not a pass/fail suite).
 * Each step records a screenshot and layout facts read from the workbench through Chrome's debugging protocol. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';

const port = process.env.DHIMANTAI_CDP_PORT ?? '9339', out = process.env.DHIMANTAI_UX_OUT || '/tmp/ux';

async function workbench() {
  for (let i = 0; i < 50; i++) {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as {type: string; url: string; webSocketDebuggerUrl: string}[];
    const page = pages.find(p => p.type === 'page' && /workbench/.test(p.url));
    if (page) {
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      let id = 0;
      const pending = new Map<number, (value: any) => void>();
      socket.onmessage = event => { const m = JSON.parse(String(event.data)); pending.get(m.id)?.(m); pending.delete(m.id); };
      const send = (method: string, params: object = {}) => new Promise<any>(resolve => {
        pending.set(++id, resolve); socket.send(JSON.stringify({id, method, params}));
      });
      return {send, close: () => socket.close()};
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('No workbench page on the debugging port.');
}

// Facts about what the learner sees, read from the live DOM.
const PROBE = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const editor = document.querySelector('.notebookOverlay .monaco-list') || document.querySelector('.notebook-editor .monaco-list');
  const box = editor ? editor.getBoundingClientRect() : {top: 0, bottom: innerHeight};
  const rows = [...document.querySelectorAll('.notebookOverlay .monaco-list-row, .notebook-editor .monaco-list-row')].filter(visible).map(row => {
    const r = row.getBoundingClientRect();
    return {index: Number(row.getAttribute('data-index')), top: Math.round(r.top), bottom: Math.round(r.bottom),
      inView: r.bottom > box.top && r.top < box.bottom, text: row.innerText.replace(/\\s+/g, ' ').slice(0, 90)};
  });
  const toolbar = [...document.querySelectorAll('.notebook-toolbar-container .action-item, .notebook-toolbar-left .action-item, .notebook-toolbar-right .action-item')]
    .filter(visible).map(a => { const label = a.querySelector('[aria-label]'); return {label: (label && label.getAttribute('aria-label')) || a.getAttribute('title') || '', text: a.innerText.trim()}; });
  const quick = [...document.querySelectorAll('.quick-input-widget')].filter(visible).map(q => q.innerText.replace(/\\s+/g, ' ').slice(0, 160));
  const dialogs = [...document.querySelectorAll('.monaco-dialog-box, .notifications-toasts .notification-toast')].filter(visible).map(d => d.innerText.replace(/\\s+/g, ' ').slice(0, 160));
  const status = [...document.querySelectorAll('.cell-statusbar-container .cell-status-item')].filter(visible).map(s => s.innerText.trim()).filter(Boolean);
  return {viewport: {width: innerWidth, height: innerHeight, editorTop: Math.round(box.top), editorBottom: Math.round(box.bottom)}, rows, toolbar, quick, dialogs, status};
})()`;

export async function run() {
  mkdirSync(out, {recursive: true});
  const {auth} = await vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!.activate();
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const account = (await auth.session())!.user.id;
  const cdp = await workbench();
  const steps: any[] = [];
  const settle = (ms = 900) => new Promise(r => setTimeout(r, ms));
  const record = async (name: string, actions: string[]) => {
    await settle();
    const facts = (await cdp.send('Runtime.evaluate', {expression: PROBE, returnByValue: true})).result.result.value;
    const shot = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(out, `${String(steps.length + 1).padStart(2, '0')}-${name}.png`), Buffer.from(shot.result.data, 'base64'));
    steps.push({step: name, actions, ...facts});
  };
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', QUESTION_ID, account);
    await record('open-task', ['click the question in the Practice tree']);
    const editor = vscode.window.activeNotebookEditor!;
    const code = editor.notebook.getCells().find(c => c.kind === vscode.NotebookCellKind.Code)!;
    await vscode.commands.executeCommand('dhimantai.practice.predict');
    await record('predict', ['click Predict on the toolbar', 'type the expected output']);
    await vscode.commands.executeCommand('notebook.cell.quitEdit');
    editor.selections = [new vscode.NotebookRange(code.index, code.index + 1)];
    void vscode.commands.executeCommand('notebook.cell.execute', {ranges: [{start: code.index, end: code.index + 1}], document: editor.notebook.uri});
    await settle(4000);
    await record('first-run', ['click Run on the code cell']);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await vscode.commands.executeCommand('dhimantai.practice.stuck');
    await record('stuck-1', ['click Stuck? on the toolbar']);
    await vscode.commands.executeCommand('dhimantai.practice.stuck');
    await vscode.commands.executeCommand('dhimantai.practice.check');
    await record('check-samples', ['click Stuck? again', 'click Check sample tests']);
    // The QuickPick cannot be clicked from the extension host, so the stand-in chooses the item the learner would.
    const pick = vscode.window.showQuickPick;
    (vscode.window as any).showQuickPick = async (items: readonly vscode.QuickPickItem[]) => items.find(item => item.label === 'Review my code');
    try { await vscode.commands.executeCommand('dhimantai.practice.more'); }
    finally { (vscode.window as any).showQuickPick = pick; }
    await record('review', ['choose More, then Review my code']);
  } finally {
    cdp.close();
    writeFileSync(join(out, 'audit.json'), JSON.stringify(steps, null, 2));
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify([{step: 'ux audit recorded', ok: true}]));
    await auth.signOut();
  }
}
