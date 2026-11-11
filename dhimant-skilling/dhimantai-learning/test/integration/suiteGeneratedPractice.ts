/** Real Practice webviews and local storage; exercise generation uses controlled API replies. */
import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Api, GeneratedExercise } from '../../src/api';
import type { Auth } from '../../src/auth';
import type { PracticeBrowser } from '../../src/practiceBrowser';
import { EMAIL, PASSWORD } from './contractServer';
import { connect } from './suiteNotebookCoachHistory';

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

export async function run() {
  const out = process.env.DHIMANTAI_UX_OUT || mkdtempSync(join(tmpdir(), 'generated-practice-ui-'));
  mkdirSync(out, {recursive:true});
  const {auth, practice} = await vscode.extensions.getExtension<{auth:Auth; practice:PracticeBrowser}>('optficial.dhimantai-learning')!.activate();
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor', 'panel', vscode.ConfigurationTarget.Global);
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const cdp = await connect();
  let visibleSession: string | undefined;
  // Retained background webviews can be frozen. Evaluate only the visible iframe, as a learner would.
  const sessions = new Map<string, string>();
  const webview = async (expression: string) => {
    const url = await cdp.evaluate(`(() => {
      const frame = [...document.querySelectorAll('iframe')].find(frame =>
        frame.src.startsWith('vscode-webview:') && frame.checkVisibility({visibilityProperty:true}));
      return frame?.src;
    })()`);
    if (!url) return null;
    const targets = (await cdp.send('Target.getTargets')).targetInfos as any[];
    const target = targets.find(target => ['iframe', 'page'].includes(target.type)
      && target.url.startsWith('vscode-webview://') && new URL(target.url).host === new URL(url).host
      && new URL(target.url).searchParams.get('id') === new URL(url).searchParams.get('id'));
    if (!target) return null;
    let session = sessions.get(target.targetId);
    if (!session) {
      session = (await cdp.send('Target.attachToTarget', {targetId:target.targetId, flatten:true})).sessionId as string;
      sessions.set(target.targetId, session);
    }
    visibleSession = session;
    return cdp.evaluate(`(() => { const d = document.getElementById('active-frame')?.contentDocument || document;
      return (${expression})(d); })()`, session);
  };
  const create = vscode.window.createWebviewPanel, pick = vscode.window.showQuickPick, input = vscode.window.showInputBox;
  const generate = Api.prototype.generateExercise;
  const panels: vscode.WebviewPanel[] = [], closed = new Set<vscode.WebviewPanel>(), documents: any[] = [];
  const restored = new Map<vscode.WebviewPanel, any>(), saved = new Map<vscode.WebviewPanel, number>();
  const edited = new Map<vscode.WebviewPanel, any>();
  const results: object[] = [];
  (vscode.window as any).createWebviewPanel = (...args:any[]) => {
    const panel = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] === 'dhimantai.learningRoom') {
      panels.push(panel);
      panel.onDidDispose(() => closed.add(panel));
      panel.webview.onDidReceiveMessage(message => {
        if (message.type === 'notebookChanged') edited.set(panel, message.notebook);
      });
      const post = panel.webview.postMessage.bind(panel.webview);
      panel.webview.postMessage = message => {
        if (message.type === 'restoreNotebook') restored.set(panel, message.notebook);
        if (message.type === 'notebookSaved') saved.set(panel, (saved.get(panel) ?? 0) + 1);
        return post(message);
      };
    }
    return panel;
  };
  const facts = (title: string, draft: string) => webview(`d => {
    if (d.querySelector('.workspace-title h1')?.textContent !== ${JSON.stringify(title)} || d.querySelector('#message')?.value !== ${JSON.stringify(draft)}) return null;
    return {heading:d.querySelector('h1').textContent, mode:d.querySelector('#notebook-mode')?.textContent,
      status:d.querySelector('#status')?.textContent, question:d.querySelector('#feed h3')?.textContent};
  }`);
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const course = (await practice.getChildren()).find(node => node.kind === 'course');
    assert.ok(course, 'course fixture is available');
    const [chapter] = await practice.getChildren(course);
    assert.equal(chapter.kind, 'chapter');
    if (chapter.kind !== 'chapter') throw new Error('Missing chapter fixture');
    const titles = ['Token-ID Embedding Lookup with Padding Boundary', 'Token-ID Embedding Lookup with Padding Boundary', 'Count tokens <without padding>'];
    for (const [index, title] of titles.entries()) {
      const exercise: GeneratedExercise = {exercise:{title, task:'Print twelve.', example_input:'', expected_output:'12'},
        course:'Python', chapter:'Variables', language:'python', kernel:'python3', difficulty:'easy',
        validation:'reference_execution', tests:[{id:'example', kind:'stdio', stdin:'', expected:'12\n'}]};
      (vscode.window as any).showQuickPick = async (items:any[]) => items[0];
      (vscode.window as any).showInputBox = async () => '';
      Api.prototype.generateExercise = async () => exercise;
      await practice.generate(chapter);
      const panel = panels.at(-1)!;
      assert.equal(closed.size, 0, 'generation leaves every earlier notebook open');
      assert.equal(panels.length, index + 1);
      assert.equal(panel.title, 'Practice notebook · ' + title);
      const shown = await until(() => facts(title, ''), value => value?.status === 'Practice is ready. Ask questions and get feedback here.', 'exercise heading and ready state');
      assert.equal(shown.mode, 'DHIMANTAI · PRACTICE NOTEBOOK');
      assert.equal(shown.question, title);
      const source = 'print(' + (index + 1) + ')';
      await webview(`d => { d.querySelector('.cm-content').focus(); return true; }`);
      await cdp.send('Input.insertText', {text:source}, visibleSession);
      const draft = 'My unsent answer for exercise ' + (index + 1);
      await webview(`d => {
        const field = d.querySelector('#message');
        if (d.querySelector('h1')?.textContent !== ${JSON.stringify(title)} || !field || field.value) return null;
        field.value = ${JSON.stringify(draft)}; field.dispatchEvent(new d.defaultView.Event('input', {bubbles:true})); return true;
      }`);
      await until(async () => edited.get(panel), notebook => (saved.get(panel) ?? 0) > 0
        && notebook?.textDraft === draft && notebook.drafts.some((cell:any) => cell.source === source), 'autosaved exercise code and draft');
      documents.push(edited.get(panel));
      results.push({step:'Generated independent notebook ' + (index + 1), ...shown});
    }
    assert.equal(new Set(documents.map(document => document.exerciseId)).size, 3);
    const shot = await cdp.send('Page.captureScreenshot', {format:'png'});
    writeFileSync(join(out, 'independent-exercise-tabs.png'), Buffer.from(shot.data, 'base64'));
    for (const [index, notebook] of documents.entries()) {
      (vscode.window as any).showQuickPick = async (choices:any[]) => choices.find(c => c.practice.id === notebook.exerciseId);
      await vscode.commands.executeCommand('dhimantai.practiceHistory');
      assert.equal(panels.length, 3, 'history reveals an existing exercise tab');
      await until(async () => panels[index].active, Boolean, 'history reveals the selected tab');
      assert.ok(await facts(notebook.title, notebook.textDraft));
    }
    for (const panel of panels) panel.dispose();
    for (const notebook of documents) {
      (vscode.window as any).showQuickPick = async (choices:any[]) => choices.find(c => c.practice.id === notebook.exerciseId);
      await vscode.commands.executeCommand('dhimantai.practiceHistory');
      const panel = panels.at(-1)!;
      await until(() => facts(notebook.title, notebook.textDraft), value => value?.status === 'Practice is ready. Ask questions and get feedback here.', 'saved notebook restored');
      assert.deepEqual(restored.get(panel), notebook);
      results.push({step:'Reopened saved exercise', title:notebook.title, draft:notebook.textDraft});
      panel.dispose();
    }
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({passed:true, vscode:vscode.version, out, results}, null, 2));
  } finally {
    (vscode.window as any).createWebviewPanel = create;
    (vscode.window as any).showQuickPick = pick;
    (vscode.window as any).showInputBox = input;
    Api.prototype.generateExercise = generate;
    for (const panel of panels) panel.dispose();
    cdp.close();
  }
}
