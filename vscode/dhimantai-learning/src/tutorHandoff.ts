import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { jupyterMetadata } from './notebookCommands';
import { Api } from './api';
import { Auth } from './auth';
import { ENVIRONMENTS, Environment, EnvironmentName } from './environments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRIES: Record<string, string> = { python: 'main.py', javascript: 'main.js', typescript: 'main.ts',
  java: 'Main.java', c: 'main.c', cpp: 'main.cpp', go: 'main.go', rust: 'main.rs' };

/** Open the locally exported notebook. A URI can only identify an Instructor export, never supply a file path. */
export async function openTutorNotebook(uri: vscode.Uri) {
  const params = new URLSearchParams(uri.query);
  const id = params.get('id') ?? '';
  if (!UUID.test(id) || [...params.keys()].length !== 1) throw new Error('Download the notebook again from Instructor.');
  const downloads = vscode.Uri.file(join(homedir(), 'Downloads'));
  const file = vscode.Uri.joinPath(downloads, `dhimantai-tutor-${id}.ipynb`);
  const openMatching = async (path: vscode.Uri) => {
    const doc = await vscode.workspace.openNotebookDocument(path);
    if (jupyterMetadata(doc).dhimantai_tutor_export === id) return doc;
  };
  let doc = await openMatching(file).catch(() => undefined);
  if (!doc) {
    const files = await vscode.window.showOpenDialog({title: 'Select the notebook you just downloaded from Instructor',
      defaultUri: downloads, filters: {'Jupyter notebooks': ['ipynb']}, canSelectMany: false});
    if (!files?.length) {
      void vscode.window.showInformationMessage('Open cancelled. Your Instructor notebook is still available from the app.');
      return;
    }
    doc = await openMatching(files[0]);
    if (!doc) throw new Error('This is a different notebook. Choose Open in VS Code again and select the file you just saved.');
  }
  await vscode.window.showNotebookDocument(doc, {viewColumn: vscode.ViewColumn.One, preview: false});
  void vscode.window.showInformationMessage(`Instructor notebook opened · ${basename(doc.uri.fsPath)}. For Podman, choose Open Copy in Course.`);
}

export function tutorLink(uri: vscode.Uri) {
  const p = new URLSearchParams(uri.query);
  const id = p.get('handoff') ?? '', account = p.get('account') ?? '', env = p.get('env') ?? '';
  if (uri.path !== '/tutor' || !UUID.test(id) || !/^[a-zA-Z0-9-]{1,100}$/.test(account) ||
      !Object.hasOwn(ENVIRONMENTS, env) || [...p.keys()].length !== 3) {
    throw new Error('This Instructor link is invalid. Choose Open in VS Code again in the app.');
  }
  return { id, account, env: env as EnvironmentName };
}

export function tutorFiles(row: any, id: string): { entry: string; files: Record<string, string> } {
  const p = row?.payload;
  if (row?.id !== id || !p || !Object.hasOwn(ENTRIES, p.language) || typeof p.code !== 'string' ||
      p.code.length > 64_000 || typeof p.stdin !== 'string' || p.stdin.length > 32_000 ||
      !['program', 'python_repl'].includes(p.mode) || (p.mode === 'python_repl' && p.language !== 'python') ||
      !Array.isArray(p.lesson) || p.lesson.length !== 3 || p.lesson.some((s: any) => typeof s !== 'string' || s.length > 300) ||
      !Array.isArray(p.packages) || p.packages.length > 20 || p.packages.some((s: any) =>
        typeof s !== 'string' || s.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._\[\],<>=!~+*() \t-]*$/.test(s))) {
    throw new Error('The Instructor transfer is invalid. Open it again from the app.');
  }
  const entry = ENTRIES[p.language];
  const files: Record<string, string> = { [entry]: p.code, 'stdin.txt': p.stdin,
    'tutor-context.json': JSON.stringify({ lesson: p.lesson, language: p.language, mode: p.mode }, null, 2) + '\n',
    'README.txt': 'Instructor workspace\n\nThis is a local copy of your Instructor code. Edits here do not sync back to the app.\n' +
      'Return to Instructor to continue the lesson or paste your changes into its code editor.\n\n' +
      'Use the VS Code language extension and a local toolchain to run or debug this file.\n' +
      'Nothing runs or installs automatically. Practice grading and coaching do not apply to this copy.\n' +
      'stdin.txt contains your input; tutor-context.json records the lesson and execution mode.\n' +
      (p.mode === 'python_repl' ? 'This code came from Python shell mode. Run its expressions in a Python REPL to display their values.\n' : '') +
      (p.language === 'python' ? '\nFor Python packages, open a terminal in this folder and create a virtual environment:\n' +
        '  Windows: py -m venv .venv\n  macOS/Linux: python3 -m venv .venv\n' +
        'Activate it (Windows Command Prompt: .venv\\Scripts\\activate; macOS/Linux: source .venv/bin/activate).\n' +
        'Then run: python -m pip install -r requirements.txt\nSelect that interpreter in the VS Code Python extension.\n' : '') };
  if (p.language === 'python') files['requirements.txt'] = p.packages.join('\n') + (p.packages.length ? '\n' : '');
  return { entry, files };
}

/** One-way import: capture service/account, preserve existing edits, acknowledge only after opening. */
export async function openTutorHandoff(uri: vscode.Uri, deps: {
  auth: Auth; envName: () => EnvironmentName; env: () => Environment; storage: vscode.Uri;
  closeExercise: () => Promise<void>;
}) {
  const link = tutorLink(uri);
  if (link.env !== deps.envName()) {
    await vscode.workspace.getConfiguration('dhimantai').update('environment', link.env, vscode.ConfigurationTarget.Global);
  }
  if (link.env !== deps.envName()) throw new Error('Choose the same dhimantAI service as the app in VS Code settings, then reopen the Instructor link.');
  let session = await deps.auth.session() ?? await deps.auth.signIn();
  if (!session) return;
  if (session.user.id !== link.account) {
    const choice = await vscode.window.showWarningMessage('This Instructor code belongs to a different dhimantAI account.',
      { modal: true, detail: 'Sign in with the account you use in Instructor to open its code.' }, 'Switch account');
    if (!choice) return;
    await deps.auth.signOut();
    session = await deps.auth.signIn();
    if (!session) return;
    if (session.user.id !== link.account) throw new Error('Sign in with the same account as Instructor, then reopen the link.');
  }
  const environment = deps.env();
  const check = async () => {
    if (deps.envName() !== link.env || (await deps.auth.session())?.user.id !== link.account) {
      throw new Error('Your service or account changed. Reopen the Instructor link from the app.');
    }
  };
  const api = new Api(deps.auth, () => {
    if (deps.envName() !== link.env) throw new Error('Your service changed. Reopen the Instructor link.');
    return environment;
  }, link.account);
  await check();
  const { handoff } = await api.tutorHandoff(link.id);
  const { entry, files } = tutorFiles(handoff, link.id);
  await check();
  await deps.closeExercise();
  const account = createHash('sha256').update(link.account).digest('hex').slice(0, 24);
  const dir = join(deps.storage.fsPath, 'tutor', link.env, account, link.id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await check();
    // Reopening a link must never overwrite a learner's saved or unsaved work.
    await writeFile(join(dir, name), content, { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  for (const name of ['README.txt', ...(files['requirements.txt'] !== undefined ? ['requirements.txt'] : []), 'stdin.txt', entry]) {
    await check();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(join(dir, name))), { preview: false });
  }
  await check();
  await api.tutorOpened(link.id);
  void vscode.window.showInformationMessage('Instructor code opened. This is a local copy; return to Instructor to continue your lesson.', 'Open folder in new window').then(choice => {
    if (choice) void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), true);
  });
}
