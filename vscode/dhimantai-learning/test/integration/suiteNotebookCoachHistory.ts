/** Visible Instructor history in a real VS Code webview, using controlled API replies.
 * Drives the production composer and checks rendered messages, not the host's chat array. */
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { Api } from '../../src/api';
import { PRACTICE_KERNEL } from '../../src/practiceKernel';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';

const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ready(value)) return value;
    await pause();
  }
  throw new Error('Timed out: ' + label);
}

export async function connect() {
  const pages = await (await fetch(`http://127.0.0.1:${process.env.DHIMANTAI_CDP_PORT ?? '9339'}/json`)).json() as any[];
  const page = pages.find(page => page.type === 'page' && /workbench/.test(page.url));
  assert.ok(page, 'real VS Code workbench is available');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  let id = 0;
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timeout: ' + method)); }, 10000);
    pending.set(requestId, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
    socket.send(JSON.stringify({id: requestId, method, params, sessionId}));
  });
  const evaluate = async (expression: string, sessionId?: string) => {
    const response = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const sessions = new Map<string, string>();
  const webview = async (expression: string) => {
    const targets = (await send('Target.getTargets')).targetInfos as any[];
    for (const target of targets.filter(target => ['iframe', 'page'].includes(target.type) && /vscode-webview/.test(target.url))) {
      try {
        let session = sessions.get(target.targetId);
        if (!session) {
          session = (await send('Target.attachToTarget', {targetId: target.targetId, flatten: true})).sessionId as string;
          sessions.set(target.targetId, session);
        }
        // The outer VS Code webview frame contains a same-origin active content frame.
        const wrapped = `(() => { const d = document.getElementById('active-frame')?.contentDocument || document;
          return (${expression})(d); })()`;
        const result = await evaluate(wrapped, session);
        if (result !== null && result !== undefined) return result;
      } catch (error) {
        if (!/No target|Session with given|Cannot find context|Inspected target navigated/.test(String(error))) throw error;
        sessions.delete(target.targetId);
      }
    }
    return null;
  };
  return {send, evaluate, webview, close: () => socket.close()};
}

export async function run() {
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor','notebook',vscode.ConfigurationTarget.Global);
  const out = process.env.DHIMANTAI_UX_OUT || mkdtempSync(join(tmpdir(), 'coach-history-ui-'));
  mkdirSync(out, {recursive: true});
  const ext = vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await ext.activate();
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const cdp = await connect();
  const results: object[] = [];
  const original = Api.prototype.notebookCoach;
  const artifactHashes = Object.fromEntries(['out/src/extension.js', 'out/src/practiceInNotebook.js', 'out/src/practiceIpynb.js', 'out/src/courseWorkspace.js', 'out/src/courseRecovery.js', 'out/src/practiceKernel.js', 'out/src/learningRoom.js', 'media/learning-room/room.js', 'media/learning-room/room.css'].map(file =>
    [file, createHash('sha256').update(readFileSync(join(ext.extensionPath, file))).digest('hex')]));
  const metadata = {startedAt: new Date().toISOString(), vscode: vscode.version, extension: ext.packageJSON.version,
    os: `${process.platform} ${release()} ${process.arch}`, extensionPath: ext.extensionPath, artifactHashes,
    interfaces: ['Practice Python .ipynb / Ask Instructor', 'ordinary Python .ipynb / Ask about This Notebook'],
    runtime: 'explicit local-Python fixture override; course container remains the product default',
    transport: 'local controlled fixture; not staging acceptance'};
  assert.equal(ext.packageJSON.contributes.viewsContainers?.secondarySidebar, undefined, 'no right-side assistant contribution');
  assert.equal(vscode.workspace.getConfiguration('dhimantai').get('courseContainers'), true, 'course container is the default');
  // This UI fixture explicitly opts into local Python. Course startup/repair has separate tests.
  await vscode.workspace.getConfiguration('dhimantai').update('courseContainers', false, vscode.ConfigurationTarget.Global);
  try {
    let nativeReply = 0;
    const requests: any[] = [];
    Api.prototype.notebookCoach = async (_path, body) => {
      requests.push(body);
      return {guidance: `Notebook Instructor reply ${++nativeReply}: list indexes start at zero.`, prompt: '', line: null};
    };
    await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', QUESTION_ID, (await auth.session())!.user.id);
    let practice = vscode.window.activeNotebookEditor!;
    const code = practice.notebook.cellAt(1);
    const change = new vscode.WorkspaceEdit();
    change.replace(code.document.uri, new vscode.Range(code.document.positionAt(0), code.document.positionAt(code.document.getText().length)), 'items = [10, 20, 30]\nprint(items[1])');
    change.set(practice.notebook.uri, [vscode.NotebookEdit.insertCells(2, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print("another cell")', 'python')])]);
    assert.ok(await vscode.workspace.applyEdit(change));
    practice.selection = new vscode.NotebookRange(1, 2);
    const panelHidden = async () => {
      const visible = await cdp.evaluate(`(() => { const bar = document.querySelector('.part.auxiliarybar');
        return !!bar && bar.getBoundingClientRect().width > 0 && bar.getBoundingClientRect().height > 0; })()`);
      assert.equal(visible, false, 'Practice keeps the right-side panel closed');
    };
    const askInNotebook = async (question: string, command = 'dhimantai.practice.ask') => {
      const request = vscode.commands.executeCommand(command);
      await until(async () => cdp.evaluate(`(() => { const input = document.querySelector('.quick-input-widget input');
        if (!input || !input.getBoundingClientRect().height) return false;
        input.focus(); input.value = ${JSON.stringify(question)}; input.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`), Boolean, 'Practice question input');
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
      await request;
    };
    const nativeRecord = async (step: string, texts: string[]) => {
      const visible: string[] = [];
      for (const text of texts) {
        const cell = practice.notebook.getCells().find(cell => cell.document.getText().includes(text));
        assert.ok(cell, 'saved notebook message: ' + text);
        practice.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1), vscode.NotebookEditorRevealType.InCenter);
        const seen = await until(async () => cdp.webview(`d => {
          const text = ${JSON.stringify(text)};
          const paragraphs = root => [...root.querySelectorAll('p'), ...[...root.querySelectorAll('*')].flatMap(e => e.shadowRoot ? paragraphs(e.shadowRoot) : [])];
          const element = paragraphs(d).find(p => p.textContent.trim() === text);
          if (!element) return null;
          const r = element.getBoundingClientRect();
          return {text: element.textContent.trim(), rendered: r.height > 0 && r.bottom > 0 && r.top < d.defaultView.innerHeight};
        }`), result => !!result?.rendered, 'visible notebook Markdown: ' + text);
        visible.push(seen.text);
      }
      await panelHidden();
      const shot = await cdp.send('Page.captureScreenshot', {format: 'png'});
      writeFileSync(join(out, `${results.length + 1}-${step}.png`), Buffer.from(shot.data, 'base64'));
      results.push({step, ok: true, visible, rightPanel: 'closed'});
    };
    practice.revealRange(new vscode.NotebookRange(1, 2), vscode.NotebookEditorRevealType.InCenter);
    const actions = await until(async () => cdp.evaluate(`(() => {
      const row = document.querySelector('.notebookOverlay .monaco-list-row[data-index="1"]');
      return [...(row?.querySelectorAll('.cell-statusbar-container .cell-status-item') || [])]
        .map(item => item.innerText.trim()).filter(Boolean);
    })()`), labels => labels.includes('More') && labels.includes('Ask Instructor'), 'simple code actions');
    assert.deepEqual(actions.filter((label: string) => label !== 'Python'), ['Check samples', 'Ask Instructor', 'More']);
    const more = vscode.commands.executeCommand('dhimantai.practice.more');
    const options = await until(async () => cdp.evaluate(`document.querySelector('.quick-input-widget')?.innerText || ''`),
      text => text.includes('Review my code') && text.includes('Predict the output'), 'optional actions menu');
    assert.ok(!options.includes('Submit'));
    await panelHidden();
    const menuShot = await cdp.send('Page.captureScreenshot', {format:'png'});
    writeFileSync(join(out, '0-more-actions.png'), Buffer.from(menuShot.data, 'base64'));
    await cdp.send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    await more;
    assert.equal(requests.length, 0, 'browsing optional actions makes no AI request or submission');
    results.push({step:'simple-actions-and-optional-review', ok:true, actions, rightPanel:'closed'});
    const longQuestion = 'Explain the list indexes and how to select the second element without changing the original list. Keep this complete question visible.';
    await askInNotebook(longQuestion);
    const nativeA = 'Notebook Instructor reply 1: list indexes start at zero.';
    await nativeRecord('practice-full-prompt', [longQuestion, nativeA]);
    const followup = 'Can you explain that first answer again?';
    // The old keyboard shortcut/command must use the notebook too, never reopen the side panel.
    await askInNotebook(followup, 'dhimantai.askCoach');
    const nativeB = 'Notebook Instructor reply 2: list indexes start at zero.';
    const nativeExpected = [longQuestion, nativeA, followup, nativeB];
    assert.deepEqual(requests.at(-1).history.map((m: any) => m.text), [longQuestion, nativeA]);
    await nativeRecord('practice-two-exchanges', nativeExpected);
    const turns = () => practice.notebook.getCells().filter(cell => ['learner', 'tutor', 'notice'].includes(cell.metadata.metadata?.dhimantai_practice_role));
    assert.deepEqual(turns().map(cell => cell.metadata.metadata.dhimantai_practice_role), ['learner', 'tutor', 'learner', 'tutor']);
    // Click a different code cell in the real workbench, rather than changing only host state.
    practice.revealRange(new vscode.NotebookRange(2, 3), vscode.NotebookEditorRevealType.InCenter);
    const point = await until(async () => cdp.evaluate(`(() => {
      const row = document.querySelector('.notebookOverlay .monaco-list-row[data-index="2"]');
      const editor = row?.querySelector('.monaco-editor'); if (!editor) return null;
      const r = editor.getBoundingClientRect(); return r.height ? {x: r.left + 70, y: r.top + 15} : null;
    })()`), Boolean, 'second code cell on screen');
    await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
    await until(async () => practice.selection.start, index => index === 2, 'clicked second code cell');
    await nativeRecord('practice-switch-cell', nativeExpected);
    practice.selection = new vscode.NotebookRange(1, 2);
    const edited = new vscode.WorkspaceEdit();
    edited.insert(code.document.uri, new vscode.Position(0, 0), '# changed after the conversation\n');
    assert.ok(await vscode.workspace.applyEdit(edited));
    await vscode.commands.executeCommand('notebook.selectKernel', {notebookEditor: practice, id: PRACTICE_KERNEL, extension: 'optficial.dhimantai-learning'});
    await vscode.commands.executeCommand('notebook.cell.execute', {ranges: [{start: 1, end: 2}], document: practice.notebook.uri});
    await until(async () => code.executionSummary?.success, value => value === true, 'actual Python cell run');
    const output = code.outputs.flatMap(o => o.items).map(i => Buffer.from(i.data).toString()).join('');
    assert.match(output, /20/);
    await nativeRecord('practice-edit-and-run', nativeExpected);
    await vscode.commands.executeCommand('dhimantai.hideCoach');
    Api.prototype.notebookCoach = async (_path, body) => { requests.push(body); throw new Error('Native controlled offline failure'); };
    await askInNotebook('Keep this failed notebook question.', 'dhimantai.askCoach');
    assert.match(requests.at(-1).source, /changed after the conversation/);
    assert.match(requests.at(-1).observed_run.output, /20/);
    assert.ok(requests.at(-1).history.every((message: any) => message.text.startsWith('[Earlier cell version')),
      'historical explanations are labelled while the new request uses current code and output');
    await nativeRecord('practice-failed-request', [...nativeExpected, 'Keep this failed notebook question.', 'Native controlled offline failure']);
    const otherPath = join(out, 'other-notebook.ipynb');
    writeFileSync(otherPath, JSON.stringify({nbformat:4, nbformat_minor:5,
      metadata:{kernelspec:{name:'python3', display_name:'Python', language:'python'}},
      cells:['print("another notebook")', 'PRIVATE_OTHER_CELL'].map(source => ({cell_type:'code',source,metadata:{},outputs:[],execution_count:null}))}));
    const other = await vscode.workspace.openNotebookDocument(vscode.Uri.file(otherPath));
    await vscode.window.showNotebookDocument(other, {viewColumn:vscode.ViewColumn.One,preview:false});
    Api.prototype.notebookCoach = async (_path, body: any) => {
      assert.equal(body.source, 'print("another notebook")');
      assert.equal(body.observed_run, undefined);
      assert.deepEqual(body.history, []);
      return {guidance:'A reply in the other notebook.',prompt:'',line:null};
    };
    await askInNotebook('A question in the other notebook.', 'dhimantai.askCoach');
    assert.ok(other.getCells().some(cell => cell.document.getText().includes('A reply in the other notebook.')));
    assert.ok(!other.getCells().some(cell => cell.document.getText().includes(longQuestion)));
    await panelHidden();
    await vscode.window.showNotebookDocument(practice.notebook, {viewColumn: vscode.ViewColumn.One, preview: false});
    await nativeRecord('practice-restore-notebook', nativeExpected);
    assert.ok(!practice.notebook.getCells().some(cell => cell.document.getText().includes('A question in the other notebook.')), 'different notebooks do not mix history');
    const saved = practice.notebook.uri;
    await practice.notebook.save();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    practice = await vscode.window.showNotebookDocument(await vscode.workspace.openNotebookDocument(saved), {viewColumn: vscode.ViewColumn.One, preview: false});
    await nativeRecord('practice-reopen-saved-notebook', nativeExpected);
    await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor', 'panel', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('dhimantai.openExercise', QUESTION_ID);
    const layout = await until(async () => cdp.webview(`d => {
      const editor = d.querySelector('.practice-code-editor'), more = editor?.querySelector('.practice-more');
      if (!more) return null;
      return {primary:[...editor.querySelectorAll('.practice-actions button')].filter(b => !b.hidden).map(b => b.textContent),
        more:more.querySelector('summary').textContent, open:more.open,
        review:more.querySelector('[data-action=submit]')?.textContent};
    }`), Boolean, 'Practice notebook optional actions');
    assert.deepEqual(layout.primary, ['Run', 'Run sample tests (2)']);
    assert.equal(layout.more, 'More'); assert.equal(layout.open, false); assert.equal(layout.review, 'Review my code');
    await panelHidden();
    await cdp.webview(`d => {
      const row = d.querySelector('.practice-code-editor .practice-actions');
      if (!row) return null; row.scrollIntoView({block:'center'}); return true;
    }`);
    await until(async () => cdp.webview(`d => {
      const row = d.querySelector('.practice-code-editor .practice-actions');
      if (!row) return null; const r = row.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= d.defaultView.innerHeight;
    }`), Boolean, 'visible Practice action row');
    await vscode.commands.executeCommand('notifications.clearAll');
    const practiceShot = await cdp.send('Page.captureScreenshot', {format:'png'});
    writeFileSync(join(out, 'practice-simple-controls.png'), Buffer.from(practiceShot.data, 'base64'));
    results.push({step:'practice-editor-simple-controls', ok:true, ...layout, rightPanel:'closed'});

  } catch (error) {
    results.push({step: 'failure', ok: false, error: String(error), notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString()});
    const shot = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(out, 'failure.png'), Buffer.from(shot.data, 'base64'));
    throw error;
  } finally {
    Api.prototype.notebookCoach = original;
    cdp.close();
    const receipt = {metadata, results, artifactDirectory: out};
    writeFileSync(join(out, 'results.json'), JSON.stringify(receipt, null, 2));
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(receipt, null, 2));
  }
}
