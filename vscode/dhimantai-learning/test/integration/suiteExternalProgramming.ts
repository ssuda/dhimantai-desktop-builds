import * as assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import type { PracticeBrowser } from '../../src/practiceBrowser';
import { openTutorNotebook } from '../../src/tutorHandoff';
import { jupyterMetadata } from '../../src/notebookCommands';
import type { Auth } from '../../src/auth';
import { Api } from '../../src/api';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import * as podman from '../../src/podman';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';

export async function run(): Promise<void> {
  const results: { step: string; ok: boolean; error?: string }[] = [];
  const check = async (step: string, action: () => Promise<void>) => {
    try { await action(); results.push({ step, ok: true }); }
    catch (error) { results.push({ step, ok: false, error: String(error) }); throw error; }
  };
  const state = async () => (await fetch(`${process.env.DHIMANTAI_TEST_SERVER}/__state`)).json() as Promise<any>;
  const ext = vscode.extensions.getExtension<{ auth: Auth; practice: PracticeBrowser; uriHandler: vscode.UriHandler }>('optficial.dhimantai-learning')!;
  for (let i = 0; i < 120 && !ext.isActive; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(ext.isActive, 'DhimantAI must activate without an exercise, notebook or command');
  const { auth, practice } = ext.exports;
  // These checks cover the Practice panel; suitePracticeNotebook covers the notebook flow.
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor', 'panel', vscode.ConfigurationTarget.Global);
  const info = vscode.window.showInformationMessage;
  const exercises = mkdtempSync(join(tmpdir(), 'dhimantai-practice-'));
  const cfg = vscode.workspace.getConfiguration('dhimantai');
  const ensure = podman.ensurePodman;
  let setupAttempts = 0;
  (podman as any).ensurePodman = async () => { setupAttempts++; throw new Error('Podman is unavailable'); };
  (vscode.window as any).showInformationMessage = async () => undefined;
  try {
    await cfg.update('exercisesFolder', exercises, vscode.ConfigurationTarget.Global);
    await check('the notebook is the main surface: Instructor does not open by itself at startup', async () => {
      await new Promise(r => setTimeout(r, 1000));
      assert.equal(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'dhimantAI Instructor')), false);
    });
    await check('Explorer shows the signed-in Practice course, chapter and textbook coding exercise', async () => {
      const signedOut = (await practice.getChildren()).map(node => practice.getTreeItem(node).command?.command);
      assert.ok(signedOut.includes('dhimantai.signIn') && signedOut.includes('dhimantai.courseCatalog'));
      await auth.signInWithPassword(EMAIL, PASSWORD);
      const [course] = await practice.getChildren();
      assert.equal(practice.getTreeItem(course).label, 'Python');
      const [chapter] = await practice.getChildren(course);
      const [textbook, institution] = await practice.getChildren(chapter);
      assert.equal(practice.getTreeItem(textbook).label, 'Textbook Questions');
      assert.equal(practice.getTreeItem(institution).label, 'Institution Questions');
      const [topic] = await practice.getChildren(textbook);
      const [question] = await practice.getChildren(topic);
      const action = practice.getTreeItem(question).command!;
      assert.equal(action.command, 'dhimantai.openPracticeQuestion', 'Explorer exercises open in the Practice notebook');
      await vscode.commands.executeCommand(action.command, ...action.arguments!);
      for (let i = 0; i < 50 && !vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.label.startsWith('Practice notebook'))); i++)
        await new Promise(r => setTimeout(r, 100));
      assert.ok(vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.label === 'Practice notebook · ' + practice.getTreeItem(question).label)));
      assert.equal((await state()).editor, undefined);
    });
    await check('Instructor handoff opens the matching saved notebook with the selected question and code', async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'tutor-handoff-')), 'renamed.ipynb');
      const id = 'eb5611a1-771d-4e64-beda-27891e825ac2';
      const uri = vscode.Uri.parse('vscode://optficial.dhimantai-learning/open-notebook?id=' + id);
      writeFileSync(file, JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {dhimantai_tutor_export: id,
        kernelspec: {language:'python', name:'python3', display_name:'Python'}},
        cells: [{cell_type: 'markdown', metadata: {}, source: 'Predict fibonacci(4).'},
          {cell_type: 'code', metadata: {}, source: 'print(fibonacci(4))', outputs: [], execution_count: null}]}));
      const pick = vscode.window.showOpenDialog;
      try {
        (vscode.window as any).showOpenDialog = async () => [vscode.Uri.file(file)];
        await assert.rejects(openTutorNotebook(uri.with({query:'id=' + QUESTION_ID})), /different notebook/);
        await openTutorNotebook(uri);
        const doc = vscode.window.activeNotebookEditor!.notebook;
        assert.equal(doc.uri.fsPath, file);
        assert.equal(doc.cellAt(0).document.getText(), 'Predict fibonacci(4).');
        assert.equal(doc.cellAt(1).document.getText(), 'print(fibonacci(4))');
      } finally { (vscode.window as any).showOpenDialog = pick; }
    });
    await check('legacy notebook commands fail locally with no upload', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dhimantai-external-notebook-'));
      const file = join(dir, 'old.ipynb');
      writeFileSync(file, JSON.stringify({ nbformat: 4, nbformat_minor: 5,
        metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
          dhimantai: { protocol: 2, exercise_id: QUESTION_ID, transfer_id: 'old' } },
        cells: [{ cell_type: 'code', source: 'PRIVATE_NOTEBOOK', outputs: [], execution_count: null, metadata: {} }] }));
      const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
      await vscode.window.showNotebookDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
      const before = (await state()).requests.length;
      await vscode.commands.executeCommand('dhimantai.sendNotebookToSession');
      await vscode.commands.executeCommand('dhimantai.submitNotebook');
      assert.equal((await state()).requests.length, before);
    });
    // Visible inline help and run-context continuity are exercised by suiteNotebookCoachHistory.
    await check('generate a separate notebook from Explorer for its question', async () => {
      await cfg.update('courseContainers', false, vscode.ConfigurationTarget.Global);
      const [course] = await practice.getChildren();
      const [chapter] = await practice.getChildren(course);
      const nodes = await practice.getChildren(chapter);
      const action = practice.getTreeItem(nodes.find(n => n.kind === 'generate')!).command!;
      const pick = vscode.window.showQuickPick, input = vscode.window.showInputBox;
      try {
        (vscode.window as any).showQuickPick = async () => undefined;
        const before = (await state()).requests.length;
        await vscode.commands.executeCommand(action.command, ...action.arguments!);
        assert.equal((await state()).requests.length, before, 'cancel sends no generation request');
        (vscode.window as any).showQuickPick = async (items: any[]) => items[0];
        (vscode.window as any).showInputBox = async () => 'counting';
        await vscode.commands.executeCommand(action.command, ...action.arguments!);
      } finally { (vscode.window as any).showQuickPick = pick; (vscode.window as any).showInputBox = input; }
      assert.ok((await state()).requests.includes('POST /notebook-coach/exercises'), 'generation request reached service');
      // A generated exercise opens in the Practice notebook, like a published one.
      const practiceTab = () => vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.label === 'Practice notebook · Count red labels'));
      for (let i = 0; i < 80 && !practiceTab(); i++) await new Promise(r => setTimeout(r, 25));
      assert.ok(practiceTab(), 'the generated exercise opens in a Practice notebook');
      assert.ok(!vscode.workspace.notebookDocuments.some(doc => doc.isUntitled), 'no separate .ipynb is created');
    });
    await check('legacy API writes are blocked before authentication or network', async () => {
      const api = new Api({ accessToken: () => { throw new Error('Must not authenticate'); } } as any, () => ({} as any));
      await assert.rejects(api.save('q', 0, {} as any), /retired/);
      await assert.rejects(api.run('q', 0), /retired/);
      await assert.rejects(api.editor('q', 'open', 'old'), /retired/);
      await assert.rejects(api.learningEvents('q', []), /retired/);
      await assert.rejects(api.tutorHandoff('old'), /retired/);
      const requests = (await state()).requests as string[];
      assert.equal(requests.filter(r => /\/(save|submit|editor|learning-events|transfer)(\/|$)/.test(r)).length, 0);
    });
    await check('signing out invalidates visible chapters before opening or generating', async () => {
      const [course] = await practice.getChildren();
      const [chapter] = await practice.getChildren(course);
      assert.ok(chapter.kind === 'chapter');
      await auth.signOut();
      await assert.rejects(practice.generate(chapter), /account or service changed/);
      const rows = (await practice.getChildren()).map(row => practice.getTreeItem(row).command?.command);
      assert.ok(rows.includes('dhimantai.signIn'), 'signed out, the Explorer offers sign-in instead of chapters');
      assert.ok(!rows.includes('dhimantai.openPracticeQuestion'));
    });
  } finally {
    (podman as any).ensurePodman = ensure;
    rmSync(exercises, {recursive: true, force: true});
    (vscode.window as any).showInformationMessage = info;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
  }
}
