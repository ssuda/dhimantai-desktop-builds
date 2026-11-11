import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';

export async function run() {
  const results: { step: string; ok: boolean; error?: string }[] = [];
  const check = async (step: string, body: () => Promise<void>) => {
    try { await body(); results.push({ step, ok: true }); }
    catch (error) { results.push({ step, ok: false, error: String(error instanceof Error ? error.stack : error) }); }
  };
  const ext = vscode.extensions.getExtension<{ auth: Auth; notebookSubmissionView: vscode.TreeView<never> }>('optficial.dhimantai-learning')!;
  const { auth, notebookSubmissionView } = await ext.activate();
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const notices: string[] = [], errors: string[] = [];
  const info = vscode.window.showInformationMessage, error = vscode.window.showErrorMessage, warning = vscode.window.showWarningMessage;
  const progress = vscode.window.withProgress;
  (vscode.window as any).showInformationMessage = async (text: string) => { notices.push(text); };
  (vscode.window as any).showErrorMessage = async (text: string) => { errors.push(text); };
  (vscode.window as any).showWarningMessage = async () => undefined;
  const state = async () => (await fetch(`${process.env.DHIMANTAI_TEST_SERVER}/__state`)).json() as Promise<any>;
  const dir = mkdtempSync(join(tmpdir(), 'dhimantai-notebook-'));
  const notebook = async (name: string, metadata: any, code = 'print("saved")') => {
    const path = join(dir, `${name}.ipynb`);
    writeFileSync(path, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, ...metadata,
    }, cells: [{ cell_type: 'markdown', source: ['# Notes'], metadata: {} },
      { cell_type: 'code', source: [code], metadata: {}, outputs: [], execution_count: null }] }));
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path));
    await vscode.window.showNotebookDocument(doc);
    return doc;
  };
  const link = { protocol: 1, exercise_id: QUESTION_ID, export_id: '074dcfea-ea05-425f-a602-9a1d6a28e45a',
    account_id: 'learner-1', environment: 'production', workspace: 'practice', draft_version: 0, language: 'python' };
  let doc: vscode.NotebookDocument;
  try {
    await check('sidebar keeps the focused notebook target and submits unsaved cells in notebook order', async () => {
      doc = await notebook('renamed-by-learner', { dhimantai: link });
      assert.equal(doc.metadata.metadata.dhimantai.exercise_id, QUESTION_ID);
      const text = doc.cellAt(1).document;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(text.uri, new vscode.Range(text.positionAt(0), text.positionAt(text.getText().length)), 'a = 41');
      edit.set(doc.uri, [vscode.NotebookEdit.insertCells(2, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print(a + 1)', 'python')])]);
      assert.ok(await vscode.workspace.applyEdit(edit));
      for (let attempt = 0; attempt < 40 && !notebookSubmissionView.visible; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(notebookSubmissionView.visible, true, 'opening a linked notebook reveals its submit button');
      assert.equal(vscode.window.activeNotebookEditor?.notebook, doc, 'revealing the button preserves notebook focus');
      await vscode.commands.executeCommand('dhimantai.notebookSubmission.focus');
      assert.equal(notebookSubmissionView.description, 'renamed-by-learner.ipynb');
      assert.equal(notebookSubmissionView.message, undefined, 'welcome button is not hidden by a message');
      let sawProgress = false;
      (vscode.window as any).withProgress = (options: any, task: any) => {
        assert.equal(notebookSubmissionView.message, 'Submitting to Dhimantai…');
        sawProgress = true;
        return progress(options, task);
      };
      // Welcome buttons invoke commands without a document argument.
      const result: any = await vscode.commands.executeCommand('dhimantai.submitNotebook');
      (vscode.window as any).withProgress = progress;
      assert.equal(result?.version, 1, errors.join('\n'));
      assert.equal(sawProgress, true);
      assert.equal(notebookSubmissionView.message, undefined, 'button returns after submission');
      const s = await state();
      assert.deepEqual(s.draft.payload.notebook.cells.map((c: any) => c.source), ['# Notes', 'a = 41', 'print(a + 1)']);
      assert.equal(s.submissions.length, 1);
      assert.equal(s.submissions[0].kind, 'check');
      const disk = JSON.parse(readFileSync(doc.uri.fsPath, 'utf8'));
      assert.equal(disk.metadata.dhimantai.draft_version, 1);
      assert.ok(notices.some(n => n.includes('Submitted to DhimantAI v1')));
    });
    await check('repeated click reuses the saved version and server receipt', async () => {
      await vscode.commands.executeCommand('dhimantai.submitNotebook', doc.uri);
      const s = await state();
      assert.equal(s.draft.version, 1);
      assert.equal(s.submissions.length, 1);
    });
    await check('renaming a submitted notebook keeps the same evaluation receipt', async () => {
      const renamed = vscode.Uri.file(join(dir, 'renamed-after-submission.ipynb'));
      writeFileSync(renamed.fsPath, readFileSync(doc.uri.fsPath));
      const moved = await vscode.workspace.openNotebookDocument(renamed);
      await vscode.commands.executeCommand('dhimantai.submitNotebook', moved.uri);
      const s = await state();
      assert.equal(s.draft.version, 1);
      assert.equal(s.submissions.length, 1);
    });
    await check('old unlinked notebook never falls back to a filename or active exercise', async () => {
      const legacy = await notebook(QUESTION_ID, {});
      assert.equal(notebookSubmissionView.description, undefined);
      const before = (await state()).requests.length;
      await vscode.commands.executeCommand('dhimantai.submitNotebook', legacy.uri);
      assert.match(errors.at(-1)!, /no valid.*question link/);
      assert.equal((await state()).requests.length, before);
    });
    await check('different account cannot submit a shared notebook', async () => {
      const other = await notebook('other-account', { dhimantai: { ...link, account_id: 'learner-2' } });
      assert.equal(notebookSubmissionView.description, 'other-account.ipynb');
      const before = (await state()).requests.length;
      await vscode.commands.executeCommand('dhimantai.submitNotebook', other.uri);
      assert.equal((await state()).requests.length, before);
      assert.equal(notebookSubmissionView.message, undefined, 'cancelled sign-in restores the button');
    });
    await check('stale notebook keeps its source and cannot overwrite newer server work', async () => {
      const stale = await notebook('old-export', { dhimantai: { ...link, export_id: 'e615ccef-6c74-4667-a369-887def301430' } }, 'print("old export")');
      await vscode.commands.executeCommand('dhimantai.submitNotebook', stale.uri);
      assert.match(errors.at(-1)!, /different saved draft/);
      assert.equal(stale.cellAt(1).document.getText(), 'print("old export")');
      assert.equal((await state()).draft.version, 1);
      assert.equal(notebookSubmissionView.message, undefined, 'failed submission restores the button');
    });
    await check('Doubt Solver uses its private exercise route and prefixed question identity', async () => {
      const doubt = await notebook('doubt', { dhimantai: { ...link, workspace: 'doubt_practice', draft_version: 1,
        export_id: '03548f59-c5fa-43d1-a516-9fa0c37b59c6' } }, 'print("doubt answer")');
      const result: any = await vscode.commands.executeCommand('dhimantai.submitNotebook', doubt.uri);
      assert.equal(result?.version, 2, errors.join('\n'));
      const s = await state();
      assert.ok(s.requests.includes(`POST /doubt-practice/${QUESTION_ID}/save`));
      assert.ok(s.requests.includes(`POST /doubt-practice/${QUESTION_ID}/submit`));
    });
    await check('switching to a text editor does not submit the previously active notebook', async () => {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: 'notes' }));
      assert.equal(notebookSubmissionView.description, undefined);
      const before = (await state()).requests.length;
      await vscode.commands.executeCommand('dhimantai.submitNotebook');
      assert.match(errors.at(-1)!, /Open an exported DhimantAI notebook/);
      assert.equal((await state()).requests.length, before);
    });
  } finally {
    (vscode.window as any).showInformationMessage = info;
    (vscode.window as any).showErrorMessage = error;
    (vscode.window as any).showWarningMessage = warning;
    (vscode.window as any).withProgress = progress;
  }
  writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }, null, 2));
  if (results.some(r => !r.ok)) throw new Error('Notebook integration checks failed');
}
