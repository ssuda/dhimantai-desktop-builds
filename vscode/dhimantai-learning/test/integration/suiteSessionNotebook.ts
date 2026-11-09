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
  const errors: string[] = [];
  const info = vscode.window.showInformationMessage, error = vscode.window.showErrorMessage;
  (vscode.window as any).showInformationMessage = async () => undefined;
  (vscode.window as any).showErrorMessage = async (message: string) => { errors.push(message); };
  const state = async () => (await fetch(`${process.env.DHIMANTAI_TEST_SERVER}/__state`)).json() as Promise<any>;
  const dir = mkdtempSync(join(tmpdir(), 'dhimantai-live-notebook-'));
  const link = { protocol: 2, exercise_id: QUESTION_ID, export_id: '074dcfea-ea05-425f-a602-9a1d6a28e45a',
    account_id: 'learner-1', environment: 'production', workspace: 'practice', draft_version: 0, language: 'python',
    base_revision: 0, transfer_id: 'f594f2bf-81b9-4869-a4d0-bef64dc4160e' };
  const open = async (name: string, metadata = link) => {
    const path = join(dir, `${name}.ipynb`);
    writeFileSync(path, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, dhimantai: metadata,
    }, cells: [{ cell_type: 'code', source: ['print("disk")'], metadata: {}, outputs: [], execution_count: null }] }));
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path));
    await vscode.window.showNotebookDocument(doc);
    return doc;
  };
  let doc: vscode.NotebookDocument;
  try {
    await check('native notebook button sends unsaved multi-cell code only to the live relay', async () => {
      doc = await open('live');
      const cell = doc.cellAt(0).document;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(cell.uri, new vscode.Range(cell.positionAt(0), cell.positionAt(cell.getText().length)), 'answer = 42');
      edit.set(doc.uri, [vscode.NotebookEdit.insertCells(1, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print(answer)', 'python')])]);
      assert.ok(await vscode.workspace.applyEdit(edit));
      await vscode.commands.executeCommand('dhimantai.notebookSubmission.focus');
      const receipt: any = await vscode.commands.executeCommand('dhimantai.sendNotebookToSession');
      assert.equal(receipt?.status, 'applied', errors.join('\n'));
      const s = await state();
      assert.deepEqual(s.liveTransfers[0].notebook.cells.map((c: any) => c.source), ['answer = 42', 'print(answer)']);
      assert.equal(s.draft.version, 0);
      assert.equal(s.submissions.length, 0);
      assert.equal(JSON.parse(readFileSync(doc.uri.fsPath, 'utf8')).cells[0].source[0], 'print("disk")', 'transfer must not silently save the notebook');
      assert.equal(notebookSubmissionView.message, undefined);
      assert.match(notebookSubmissionView.description!, /Last send: received/);
    });
    await check('receipt persists, later edits are unsent, and switching notebooks isolates feedback', async () => {
      const cell = doc.cellAt(0).document;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(cell.uri, new vscode.Range(cell.positionAt(0), cell.positionAt(cell.getText().length)), 'answer = 43');
      assert.ok(await vscode.workspace.applyEdit(edit));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.match(notebookSubmissionView.description!, /Edits not sent/);
      await open('not-yet-sent');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.doesNotMatch(notebookSubmissionView.description!, /Last send|Edits not sent/);
      await vscode.window.showNotebookDocument(doc);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.match(notebookSubmissionView.description!, /Edits not sent/);
      const undo = new vscode.WorkspaceEdit();
      undo.replace(cell.uri, new vscode.Range(cell.positionAt(0), cell.positionAt(cell.getText().length)), 'answer = 42');
      assert.ok(await vscode.workspace.applyEdit(undo));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.match(notebookSubmissionView.description!, /Last send: received/);
      const metadata = doc.metadata;
      const relink = new vscode.WorkspaceEdit();
      relink.set(doc.uri, [vscode.NotebookEdit.updateNotebookMetadata({ ...metadata,
        metadata: { ...metadata.metadata, dhimantai: { ...link, export_id: 'e615ccef-6c74-4667-a369-887def301430' } } })]);
      assert.ok(await vscode.workspace.applyEdit(relink));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.doesNotMatch(notebookSubmissionView.description!, /Last send: received/);
      const restore = new vscode.WorkspaceEdit();
      restore.set(doc.uri, [vscode.NotebookEdit.updateNotebookMetadata(metadata)]);
      assert.ok(await vscode.workspace.applyEdit(restore));
    });
    await check('repeating a send after moving the notebook uses the same live receipt', async () => {
      await doc.save();
      const path = join(dir, 'moved.ipynb');
      writeFileSync(path, readFileSync(doc.uri.fsPath));
      const renamed = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path));
      await vscode.commands.executeCommand('dhimantai.sendNotebookToSession', renamed.uri);
      assert.equal((await state()).liveTransfers.length, 1);
    });
    await check('another account and legacy submit cannot send session source', async () => {
      const other = await open('other', { ...link, account_id: 'learner-2' });
      const before = (await state()).requests.length;
      await vscode.commands.executeCommand('dhimantai.sendNotebookToSession', other.uri);
      assert.match(errors.at(-1)!, /same DhimantAI account/);
      await vscode.commands.executeCommand('dhimantai.submitNotebook', doc.uri);
      assert.match(errors.at(-1)!, /no valid/);
      assert.equal((await state()).requests.length, before);
    });
    await check('ended sessions do not fall back to saving or evaluating', async () => {
      const ended = await open('ended', { ...link, transfer_id: '00000000-0000-4000-8000-000000000000' });
      await vscode.commands.executeCommand('dhimantai.sendNotebookToSession', ended.uri);
      assert.match(errors.at(-1)!, /live link ended/);
      assert.match(notebookSubmissionView.description!, /Transfer not confirmed/);
      assert.equal((await state()).draft.version, 0);
      assert.equal((await state()).submissions.length, 0);
    });
    await check('Doubt Practice uses the correct live route', async () => {
      const doubt = await open('doubt', { ...link, workspace: 'doubt_practice', export_id: 'e615ccef-6c74-4667-a369-887def301430' });
      const receipt: any = await vscode.commands.executeCommand('dhimantai.sendNotebookToSession', doubt.uri);
      assert.equal(receipt?.status, 'applied', errors.join('\n'));
      assert.ok((await state()).requests.includes(`POST /doubt-practice/${QUESTION_ID}/transfer/${link.transfer_id}/send`));
    });
  } finally {
    (vscode.window as any).showInformationMessage = info;
    (vscode.window as any).showErrorMessage = error;
  }
  writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({ passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length, results }, null, 2));
  if (results.some(r => !r.ok)) throw new Error('Live notebook integration checks failed');
}
