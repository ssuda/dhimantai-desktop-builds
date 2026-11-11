import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { tutorFiles } from '../../src/tutorHandoff';
import { EMAIL, PASSWORD, TUTOR_ID, TUTOR_PAYLOAD } from './contractServer';

export async function run() {
  const results: { step: string; ok: boolean; error?: string }[] = [];
  const check = async (step: string, body: () => Promise<void>) => {
    try { await body(); results.push({ step, ok: true }); }
    catch (error) { results.push({ step, ok: false, error: String(error instanceof Error ? error.stack : error) }); }
  };
  const ext = vscode.extensions.getExtension<{ auth: Auth; uriHandler: vscode.UriHandler }>('optficial.dhimantai-learning')!;
  const { auth, uriHandler } = await ext.activate();
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const errors: string[] = [];
  const info = vscode.window.showInformationMessage, error = vscode.window.showErrorMessage, warning = vscode.window.showWarningMessage;
  (vscode.window as any).showInformationMessage = async () => undefined;
  (vscode.window as any).showErrorMessage = async (text: string) => { errors.push(text); };
  (vscode.window as any).showWarningMessage = async () => undefined;
  const state = async () => (await fetch(`${process.env.DHIMANTAI_TEST_SERVER}/__state`)).json() as Promise<any>;
  const uri = (id = TUTOR_ID, account = 'learner-1', env = 'production') =>
    vscode.Uri.parse(`vscode://optficial.dhimantai-learning/tutor?handoff=${id}&account=${account}&env=${env}`);
  let doc: vscode.TextDocument;
  try {
    await check('Instructor handoff opens exact code, input and packages, then confirms', async () => {
      const show = vscode.window.showTextDocument;
      let openedBeforeAck = false;
      (vscode.window as any).showTextDocument = async (...args: any[]) => {
        if (args[0]?.fileName?.endsWith('/main.py')) {
          assert.ok(!(await state()).requests.includes(`POST /tutor-code/vscode/${TUTOR_ID}/opened`));
          openedBeforeAck = true;
        }
        return (show as any)(...args);
      };
      try { await uriHandler.handleUri(uri()); }
      finally { (vscode.window as any).showTextDocument = show; }
      assert.deepEqual(errors, []);
      assert.equal(openedBeforeAck, true);
      doc = vscode.window.activeTextEditor!.document;
      assert.equal(doc.getText(), TUTOR_PAYLOAD.code);
      const folder = dirname(doc.uri.fsPath);
      assert.equal(readFileSync(join(folder, 'stdin.txt'), 'utf8'), TUTOR_PAYLOAD.stdin);
      assert.equal(readFileSync(join(folder, 'requirements.txt'), 'utf8'), TUTOR_PAYLOAD.packages.join('\n') + '\n');
      assert.deepEqual(JSON.parse(readFileSync(join(folder, 'tutor-context.json'), 'utf8')).lesson, TUTOR_PAYLOAD.lesson);
      const s = await state();
      assert.ok(s.requests.includes(`POST /tutor-code/vscode/${TUTOR_ID}/opened`));
      assert.equal(s.submissions.length, 0);
      assert.equal(s.assistance.length, 0);
    });
    await check('reopening preserves unsaved and saved local edits', async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), 'print("my local edit")\n');
      await vscode.workspace.applyEdit(edit);
      await uriHandler.handleUri(uri());
      assert.equal(doc.getText(), 'print("my local edit")\n');
      await doc.save();
      await uriHandler.handleUri(uri());
      assert.equal(readFileSync(doc.uri.fsPath, 'utf8'), 'print("my local edit")\n');
    });
    await check('wrong account and malformed links never fetch a snapshot', async () => {
      const before = (await state()).requests.length;
      await uriHandler.handleUri(uri(TUTOR_ID, 'learner-2'));
      await uriHandler.handleUri(uri('../secrets'));
      await uriHandler.handleUri(uri(TUTOR_ID, 'learner-1', 'toString'));
      assert.equal((await state()).requests.length, before);
      assert.match(errors.at(-1)!, /invalid/);
    });
    await check('expired link preserves local edits and never acknowledges', async () => {
      const before = (await state()).requests.length;
      await uriHandler.handleUri(uri('00000000-0000-4000-8000-000000000001'));
      assert.match(errors.at(-1)!, /expired/);
      assert.equal(doc.getText(), 'print("my local edit")\n');
      assert.deepEqual((await state()).requests.slice(before), ['GET /tutor-code/vscode/00000000-0000-4000-8000-000000000001']);
    });
    await check('failed file open never sends opened confirmation', async () => {
      const show = vscode.window.showTextDocument;
      const before = (await state()).requests.length;
      (vscode.window as any).showTextDocument = async () => { throw new Error('File open failed'); };
      try { await uriHandler.handleUri(uri()); }
      finally { (vscode.window as any).showTextDocument = show; }
      assert.match(errors.at(-1)!, /File open failed/);
      assert.deepEqual((await state()).requests.slice(before), [`GET /tutor-code/vscode/${TUTOR_ID}`]);
    });
    await check('response validation fixes filenames, rejects unsafe requirements and preserves REPL mode', async () => {
      assert.throws(() => tutorFiles({ id: TUTOR_ID, payload: { ...TUTOR_PAYLOAD, language: '../../evil' } }, TUTOR_ID));
      assert.throws(() => tutorFiles({ id: TUTOR_ID, payload: { ...TUTOR_PAYLOAD, packages: ['x\n--index-url=https://evil.test'] } }, TUTOR_ID));
      const files = tutorFiles({ id: TUTOR_ID, payload: { ...TUTOR_PAYLOAD, mode: 'python_repl', code: '2 + 2', packages: ['transformers==4.*'] } }, TUTOR_ID);
      assert.equal(files.files['main.py'], '2 + 2');
      assert.match(files.files['README.txt'], /Python REPL/);
    });
  } finally {
    (vscode.window as any).showInformationMessage = info;
    (vscode.window as any).showErrorMessage = error;
    (vscode.window as any).showWarningMessage = warning;
  }
  writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }, null, 2));
  if (results.some(r => !r.ok)) throw new Error('Instructor integration checks failed');
}
