import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { activate } from '../../src/extension';
import { COLAB_EXTENSION, ensureColab, requireColabHost, useColabForNotebook } from '../../src/colab';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import { bindNotebookRuntime, newNotebook } from '../../src/notebookRuntime';
import { openNotebookKernelPicker } from '../../src/notebookKernelPicker';
import { EMAIL, PASSWORD } from './contractServer';

export async function run() {
  const ext = vscode.extensions.getExtension<NonNullable<Awaited<ReturnType<typeof activate>>>>('optficial.dhimantai-learning')!;
  const { auth, practice } = await ext.activate();
  const cfg = vscode.workspace.getConfiguration('dhimantai');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dhimantai-colab-host-')));
  const original = { get: vscode.extensions.getExtension, execute: vscode.commands.executeCommand,
    info: vscode.window.showInformationMessage, quick: vscode.window.showQuickPick, save: vscode.window.showSaveDialog,
    prepare: (CourseWorkspaces.prototype as any).prepare };
  const checks: {step: string; ok: boolean}[] = [];
  const check = async (step: string, action: () => Promise<void>) => {
    await action(); checks.push({step, ok: true});
  };
  let installed = false, consent = false, installs = 0, activations = 0, kernelPicks = 0;
  let activateProvider: (() => Promise<void>) | undefined;
  let kernelFailure = false;
  const commands: string[] = [];
  try {
    (vscode.extensions as any).getExtension = (id: string) => id === COLAB_EXTENSION
      ? installed ? { activate: async () => { activations++; await activateProvider?.(); } } : undefined
      : original.get(id);
    (vscode.commands as any).executeCommand = async (id: string, ...args: any[]) => {
      commands.push(id);
      if (id === 'workbench.extensions.installExtension') {
        assert.equal(args[0], COLAB_EXTENSION); installs++; installed = true; return;
      }
      if (id === 'dhimantai.newCourseNotebook') return;
      if (id === 'notebook.selectKernel') {
        kernelPicks++; assert.deepEqual(args, [{}]);
        if (kernelFailure) throw new TypeError("Cannot use 'in' operator to search for 'notebookEditorId' in null");
        return;
      }
      return original.execute(id, ...args);
    };
    (vscode.window as any).showInformationMessage = async (_message: string, ...items: any[]) =>
      consent && items.includes('Install Google Colab') ? 'Install Google Colab' : undefined;
    (vscode.window as any).showQuickPick = async (items: any[]) => items[0];
    (CourseWorkspaces.prototype as any).prepare = async () => { throw new Error('Colab must never start Podman'); };
    await cfg.update('exercisesFolder', root, vscode.ConfigurationTarget.Global);
    await auth.signInWithPassword(EMAIL, PASSWORD);
    const courses = await practice.getChildren();
    const llm = courses.find(node => node.kind === 'course' && node.course.name === 'Build an LLM from Scratch');
    assert.ok(llm && llm.kind === 'course');
    await check('older VS Code is rejected and declining installation creates no course files', async () => {
      assert.throws(() => requireColabHost('1.95.3'), /1.101/);
      await practice.openCourseColab(llm);
      assert.equal(installs, 0); assert.equal(kernelPicks, 0);
      assert.deepEqual(await readdir(root), []);
    });
    await check('Colab installs on request and opens eight scoped local notebooks without preparing a container', async () => {
      consent = true;
      assert.equal(practice.getTreeItem(llm).contextValue, 'dhimantaiCourseColab');
      await vscode.commands.executeCommand('dhimantai.openCourseColab', llm);
      const doc = vscode.window.activeNotebookEditor!.notebook;
      assert.match(doc.uri.fsPath, /\/colab\/00-colab-tpu\.ipynb$/);
      assert.equal((await readdir(dirname(doc.uri.fsPath))).length, 8);
      assert.deepEqual(await readdir(dirname(dirname(doc.uri.fsPath))), ['colab']);
      assert.equal(installs, 1); assert.equal(activations, 1); assert.equal(kernelPicks, 1);
      assert.equal(doc.cellAt(1).executionSummary?.success, undefined, 'opening a notebook must not execute code');
      assert.equal(doc.cellAt(1).executionSummary?.timing, undefined);
      assert.equal(doc.cellAt(1).outputs.length, 0);
      // Even a course with a stored Podman runtime must not prefer it for Colab copies.
      const courseRoot = dirname(dirname(doc.uri.fsPath));
      const courses = new CourseWorkspaces({ extensionPath: ext.extensionPath, globalState: {
        keys: () => ['dhimantai.courseRuntime.test'], get: () => ({ root: courseRoot })
      }} as any, auth, () => 'production', {} as any, true);
      assert.equal(courses.recordFor(doc.uri), undefined);
      assert.ok(courses.recordFor(vscode.Uri.file(join(courseRoot, 'notebooks', 'Start.ipynb'))));
    });
    await check('reopening preserves learner edits and existing Python notebooks use the public kernel picker', async () => {
      const doc = vscode.window.activeNotebookEditor!.notebook;
      const file = join(dirname(doc.uri.fsPath), '01-environment.ipynb');
      const notebook = JSON.parse(await readFile(file, 'utf8'));
      notebook.cells.push({id: 'learner', cell_type: 'markdown', source: 'My own notes', metadata: {}});
      const edited = JSON.stringify(notebook);
      await writeFile(file, edited);
      await practice.openCourseColab(llm);
      assert.equal(await readFile(file, 'utf8'), edited);
      const before = await readFile(doc.uri.fsPath, 'utf8');
      await vscode.commands.executeCommand('dhimantai.useColabKernel');
      assert.equal(await readFile(doc.uri.fsPath, 'utf8'), before);
      assert.equal(kernelPicks, 3);
      assert.ok(!commands.some(id => id.startsWith('colab.')), 'no private Colab allocation API');
    });
    await check('non-Python notebooks and changed accounts stop before connecting', async () => {
      const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'console.log(1)', 'javascript')]);
      const js = await vscode.workspace.openNotebookDocument('jupyter-notebook', data);
      await vscode.window.showNotebookDocument(js);
      await assert.rejects(useColabForNotebook(), /local Python|Python notebook/);
      activateProvider = async () => { await auth.signOut(); };
      await assert.rejects(practice.openCourseColab(llm), /account and service/);
      assert.equal(kernelPicks, 3);
      activateProvider = undefined;
      await assert.rejects(practice.openCourseColab(llm), /account or service changed/);
    });
    await check('provider activation failures remain actionable without opening a kernel', async () => {
      activateProvider = async () => { throw new Error('Colab activation failed'); };
      await assert.rejects(ensureColab(), /Colab activation failed/);
      assert.equal(kernelPicks, 3);
    });
    await check('new notebooks always route through course setup without invoking a host kernel', async () => {
      await newNotebook();
      assert.equal(commands.at(-1), 'dhimantai.newCourseNotebook');
      assert.equal(kernelPicks, 3);
      const uri = vscode.Uri.file(join(root, 'My notebook.ipynb'));
      await writeFile(uri.fsPath, JSON.stringify({nbformat:4, nbformat_minor:5,
        metadata:{kernelspec:{name:'python3',language:'python',display_name:'Python 3'}},
        cells:[{cell_type:'code',source:'',metadata:{},outputs:[],execution_count:null}]}));
    });
    await check('right-side runtime choices retain the notebook, reject stale clicks and preserve edits', async () => {
      activateProvider = undefined;
      const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(join(root, 'My notebook.ipynb')));
      await vscode.window.showNotebookDocument(doc);
      const source = doc.cellAt(0).document;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(source.uri, new vscode.Position(0, 0), 'answer = 42');
      assert.ok(await vscode.workspace.applyEdit(edit));
      let receive!: (message: any) => Promise<void>;
      const messages: any[] = [], containers: vscode.NotebookDocument[] = [];
      const binding = bindNotebookRuntime({
        postMessage: async (message: any) => { messages.push(message); return true; },
        onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return new vscode.Disposable(() => {}); },
      } as any, async target => { containers.push(target); });
      try {
        await receive({type: 'ready'});
        assert.equal(messages.at(-1).uri, doc.uri.toString());
        await receive({type: 'runtime', uri: 'file:///another.ipynb', runtime: 'colab'});
        await receive({type: 'runtime', uri: doc.uri.toString(), runtime: 'unknown'});
        assert.equal(kernelPicks, 3);
        await receive({type: 'runtime', uri: doc.uri.toString(), runtime: 'local'});
        await receive({type: 'runtime', uri: doc.uri.toString(), runtime: 'colab'});
        await receive({type: 'runtime', uri: doc.uri.toString(), runtime: 'podman'});
        assert.equal(kernelPicks, 4);
        assert.deepEqual(containers, [doc]);
        assert.equal(doc.cellAt(0).document.getText(), 'answer = 42');
        assert.equal(doc.isDirty, true, 'switching does not save or replace learner edits');
        assert.equal(doc.cellAt(0).outputs.length, 0);
        assert.equal(messages.at(-1).busy, false);
        assert.match(messages.at(-1).status, /run a cell to verify execution/, 'the picker never claims a connected runtime');

        const picksBefore = kernelPicks;
        await receive({type: 'runtime', uri: doc.uri.toString(), runtime: 'local'});
        assert.equal(kernelPicks, picksBefore, 'removed local runtime messages cannot open a host kernel');
        activateProvider = async () => { throw new Error('Colab activation failed'); };
        await receive({type: 'runtime', uri: doc.uri.toString(), runtime: 'colab'});
        assert.match(messages.at(-1).status, /Colab activation failed/);
        assert.equal(messages.at(-1).busy, false, 'failed connections can be retried');
        await doc.save();
      } finally { binding.dispose(); }
    });
    await check('real VS Code kernel picker opens and cancels without the null-context error', async () => {
      // This call crosses the real extension-host bridge, unlike the provider contract checks above.
      (vscode.commands as any).executeCommand = original.execute;
      const doc = vscode.window.activeNotebookEditor!.notebook;
      const dismiss = setInterval(() => { void original.execute('workbench.action.closeQuickOpen'); }, 250);
      let timeout: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([openNotebookKernelPicker(doc), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Kernel picker did not settle')), 10000);
        })]);
        assert.match(result, /No kernel was selected|Check the kernel shown/);
      } finally { clearInterval(dismiss); clearTimeout(timeout!); }
    });
  } finally {
    (vscode.extensions as any).getExtension = original.get;
    (vscode.commands as any).executeCommand = original.execute;
    (vscode.window as any).showInformationMessage = original.info;
    (vscode.window as any).showQuickPick = original.quick;
    (vscode.window as any).showSaveDialog = original.save;
    (CourseWorkspaces.prototype as any).prepare = original.prepare;
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(checks, null, 2));
    await rm(root, {recursive: true, force: true});
  }
}
