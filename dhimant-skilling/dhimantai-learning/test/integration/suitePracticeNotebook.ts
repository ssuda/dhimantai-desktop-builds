/** Practice as one real Jupyter notebook: task, code, prediction, help, sample tests and Instructor replies are cells. */
import * as assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { mirrorFolder } from '../../src/cellMirror';
import { cellCompletions } from '../../src/cellCompletion';
import { jupyterMetadata } from '../../src/notebookCommands';
import { openPracticeFile } from '../../src/practiceInNotebook';
import { inputMarkdown, practiceLink } from '../../src/practiceIpynb';
import { PRACTICE_KERNEL } from '../../src/practiceKernel';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';

export async function run() {
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor','notebook',vscode.ConfigurationTarget.Global);
  const results: {step: string; ok: boolean; error?: string}[] = [];
  const check = async (step: string, body: () => Promise<void>) => {
    try { await body(); results.push({step, ok: true}); }
    catch (error) { results.push({step, ok: false, error: String(error instanceof Error ? error.stack : error)}); }
  };
  const state = async () => (await fetch(`${process.env.DHIMANTAI_TEST_SERVER}/__state`)).json() as Promise<any>;
  const {auth} = await vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!.activate();
  await auth.signInWithPassword(EMAIL, PASSWORD);
  await vscode.workspace.getConfiguration('dhimantai').update('courseContainers', false, vscode.ConfigurationTarget.Global);
  const account = (await auth.session())!.user.id;
  const role = (cell: vscode.NotebookCell) => cell.metadata?.metadata?.dhimantai_practice_role;
  const until = async (test: () => boolean, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (test()) return;
    assert.fail('Timed out waiting for the notebook to update.');
  };
  let notebook: vscode.NotebookDocument;
  try {
    await check('opening a Practice task opens one real notebook with the task, code and prediction cells', async () => {
      await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', QUESTION_ID, account);
      notebook = vscode.window.activeNotebookEditor!.notebook;
      assert.equal(notebook.notebookType, 'jupyter-notebook');
      assert.equal(notebook.uri.scheme, 'file');
      const link = practiceLink(jupyterMetadata(notebook), ['production', 'staging', 'development']);
      assert.equal(link?.questionId, QUESTION_ID);assert.equal(link?.account, account);
      const cells = notebook.getCells();
      assert.deepEqual(cells.map(c => c.kind), [vscode.NotebookCellKind.Markup, vscode.NotebookCellKind.Code, vscode.NotebookCellKind.Markup, vscode.NotebookCellKind.Markup]);
      assert.equal(cells[1].document.languageId, 'python');
      // The Word Count examples take arguments, so the notebook starts with the first example's.
      assert.equal(role(cells[2]), 'input');assert.match(cells[2].document.getText(), /```args\n--count words\.txt/);
      assert.equal(role(cells[3]), 'prediction');
      assert.match(cells[3].document.getText(), /I expect it to print/);
    });
    await check('reopening keeps the learner\'s code; the file is never replaced', async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(notebook.cellAt(1).document.uri, new vscode.Position(0, 0), '# my work\n');
      await vscode.workspace.applyEdit(edit);await notebook.save();
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', QUESTION_ID, account);
      notebook = vscode.window.activeNotebookEditor!.notebook;
      assert.match(notebook.cellAt(1).document.getText(), /^# my work/);
    });
    await check('Stuck? starts with a guiding question and writes the reply as a notebook cell', async () => {
      const before = (await state()).coach.length;
      await vscode.commands.executeCommand('dhimantai.practice.stuck');
      const sent = (await state()).coach.slice(before);
      assert.equal(sent.length, 1);assert.equal(sent[0].help_level, 1);assert.equal(sent[0].stage, 'guide');
      assert.match(sent[0].source, /# my work/);
      const reply = notebook.getCells().find(c => role(c) === 'tutor');
      assert.ok(reply);assert.match(reply!.document.getText(), /Instructor · Step 1 of 4/);
      assert.match(reply!.document.getText(), /Check which name this line reads/);
      // Without a run since that help, the next request stays at a question.
      await vscode.commands.executeCommand('dhimantai.practice.stuck');
      assert.equal((await state()).coach.at(-1).help_level, 1);
    });
    await check('More names the next help step and offers the optional code review in the same conversation', async () => {
      const pick = vscode.window.showQuickPick;
      let labels: string[] = [];
      (vscode.window as any).showQuickPick = async (items: readonly vscode.QuickPickItem[]) => {
        labels = items.map(item => item.label);
        return items.find(item => item.label === 'Review my code');
      };
      try { await vscode.commands.executeCommand('dhimantai.practice.more'); }
      finally { (vscode.window as any).showQuickPick = pick; }
      assert.equal(labels[0], 'Ask me a guiding question');
      assert.equal((await state()).coach.at(-1).stage, 'review');
      const prediction = notebook.getCells().find(c => role(c) === 'prediction')!;
      assert.equal(prediction.index, 3);
      const turns = notebook.getCells().filter(c => ['learner', 'tutor'].includes(role(c)));
      assert.deepEqual(turns.map(role), ['learner', 'tutor', 'learner', 'tutor', 'learner', 'tutor']);
      assert.match(turns.at(-2)!.document.getText(), /Review my code against the task/);
      assert.match(turns.at(-1)!.document.getText(), /Code review/);
    });
    await check('Ask Instructor takes a photo through the paperclip and sends it with the question', async () => {
      const photo = vscode.Uri.joinPath(notebook.uri, '..', 'error.png');
      await vscode.workspace.fs.writeFile(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      const window = vscode.window as any, original = {box: window.createInputBox, open: window.showOpenDialog};
      window.showOpenDialog = async () => [photo];
      // A stand-in input box: the learner clicks the paperclip, then types a question and presses Enter.
      window.createInputBox = () => {
        const on: Record<string, (...args: any[]) => any> = {}, listen = (name: string) => (f: any) => { on[name] = f; return {dispose() {}}; };
        let shown = false;
        const box: any = {value: '', buttons: [], dispose() {}, hide() { on.hide?.(); },
          onDidChangeValue: listen('change'), onDidTriggerButton: listen('button'), onDidAccept: listen('accept'), onDidHide: listen('hide'),
          show() {
            if (shown) return; shown = true;
            setTimeout(async () => { await on.button(box.buttons[0]); box.value = 'Why does it say this?'; on.accept(); });
          }};
        return box;
      };
      try {
        const before = (await state()).coach.length;
        await vscode.commands.executeCommand('dhimantai.practice.ask');
        const sent = (await state()).coach.slice(before);
        assert.equal(sent.length, 1);assert.equal(sent[0].message, 'Why does it say this?');
        assert.deepEqual(sent[0].attachments.map((a: any) => [a.name, a.type]), [['error.png', 'image/png']]);
        assert.ok(notebook.getCells().some(c => role(c) === 'tutor' && /Attached: error\.png/.test(c.document.getText())));
      } finally { window.createInputBox = original.box; window.showOpenDialog = original.open; }
    });
    await check('sample tests run against the code cells and their results replace one results cell', async () => {
      await vscode.commands.executeCommand('dhimantai.practice.check');
      await vscode.commands.executeCommand('dhimantai.practice.check');
      const samples = notebook.getCells().filter(c => role(c) === 'samples');
      assert.equal(samples.length, 1);
      assert.match(samples[0].document.getText(), /Sample tests · \d+ of \d+ passed/);
    });
    await check('Run passes the Run with arguments, typed input and sample files to the program', async () => {
      const folder = vscode.Uri.file(mkdtempSync(join(tmpdir(), 'dhimantai-run-')));
      const doc = await openPracticeFile({id: '22222222-3333-4444-8555-666666666666', language: 'python', title: 'Echo',
        question: 'Echo it.', starter: 'import sys\nprint(sys.argv[1:])\nprint(input())\nprint(open("data.txt").read())',
        assistance: true, path: '/practice-code/22222222-3333-4444-8555-666666666666/notebook-coach', account,
        tests: [{id: 't1', kind: 'cli', argv: ['--name', 'Asha'], stdin: 'hello\n', files: [{name: 'data.txt', content: 'from the sample file'}], expected: ''}]},
        'production', folder, PRACTICE_KERNEL);
      const output = async () => {
        const code = doc.cellAt(1);
        await vscode.commands.executeCommand('notebook.cell.execute', {ranges: [{start: 1, end: 2}], document: doc.uri});
        await until(() => code.outputs.length > 0 && code.executionSummary?.success !== undefined, 20000);
        return code.outputs.flatMap(o => o.items).map(i => Buffer.from(i.data).toString()).join('');
      };
      const first = await output();
      assert.match(first, /\['--name', 'Asha'\]/);assert.match(first, /hello/);assert.match(first, /from the sample file/);
      const runWith = doc.getCells().find(c => role(c) === 'input')!;
      const edit = new vscode.WorkspaceEdit();
      edit.set(doc.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(runWith.index, runWith.index + 1),
        [Object.assign(new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, inputMarkdown(['two words', '3'], 'bye\n'), 'markdown'),
          {metadata: {metadata: {dhimantai_practice_role: 'input'}}})])]);
      await vscode.workspace.applyEdit(edit);
      const second = await output();
      assert.match(second, /\['two words', '3'\]/);assert.match(second, /bye/);
    });
    await check('non-Python code is mirrored so file-based language extensions reach the cells', async () => {
      const folder = vscode.Uri.file(mkdtempSync(join(tmpdir(), 'dhimantai-practice-')));
      const go = await openPracticeFile({id: '11111111-2222-4333-8444-555555555555', language: 'go', title: 'Sum two numbers',
        question: 'Print the sum.', starter: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(1 + 2)\n}',
        assistance: true, path: '/practice-code/11111111-2222-4333-8444-555555555555/notebook-coach', account, tests: []}, 'production', folder);
      const cell = go.cellAt(1);
      assert.equal(cell.document.languageId, 'go');
      const mirror = vscode.Uri.joinPath(mirrorFolder(go.uri), 'main.go');
      // Stand in for gopls: a file-only provider and a diagnostic on the mirror.
      const provider = vscode.languages.registerCompletionItemProvider({scheme: 'file', language: 'go'}, {
        provideCompletionItems: (doc, position) => doc.uri.toString() === mirror.toString()
          ? [Object.assign(new vscode.CompletionItem('FromFileServer'), {detail: `line ${position.line}`})] : []});
      const diagnostics = vscode.languages.createDiagnosticCollection('fake-gopls');
      try {
        await until(() => vscode.workspace.textDocuments.some(d => d.uri.toString() === mirror.toString()));
        const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', cell.document.uri, new vscode.Position(5, 1));
        const item = list.items.find(i => i.label === 'FromFileServer');
        assert.ok(item, 'completion from the file server reaches the cell');assert.equal(item!.detail, 'line 5');
        diagnostics.set(mirror, [new vscode.Diagnostic(new vscode.Range(5, 1, 5, 12), 'undefined: fmtx', vscode.DiagnosticSeverity.Error)]);
        await until(() => vscode.languages.getDiagnostics(cell.document.uri).some(d => d.message === 'undefined: fmtx'));
        const mapped = vscode.languages.getDiagnostics(cell.document.uri).find(d => d.message === 'undefined: fmtx')!;
        assert.equal(mapped.range.start.line, 5);
        assert.deepEqual(new Set((await vscode.workspace.fs.readDirectory(mirrorFolder(go.uri))).map(([name]) => name)), new Set(['.gitignore', 'go.mod', 'main.go']));
      } finally { provider.dispose();diagnostics.dispose(); }
    });
    await check('shell extensions complete native and embedded Bash/Zsh cells in a mixed notebook',async()=>{
      const provider=vscode.languages.registerCompletionItemProvider({scheme:'file',language:'shellscript'},{
        provideCompletionItems:(text,position)=>{
          assert.equal(text.getText().trimEnd(),'pg_d');assert.equal(position.line,0);
          return [Object.assign(new vscode.CompletionItem('pg_dump'),{insertText:'pg_dump',range:new vscode.Range(0,0,0,4)})];
        }
      });
      try{
        // Save before mirroring: hidden source files belong beside a real notebook.
        const folder=vscode.Uri.file(mkdtempSync(join(tmpdir(),'dhimantai-shell-cells-')));
        const uri=vscode.Uri.joinPath(folder,'mixed.ipynb');
        await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3',display_name:'Python 3',language:'python'}},cells:[
          {cell_type:'code',source:['answer = 42'],metadata:{vscode:{languageId:'python'}},outputs:[],execution_count:null},
          {cell_type:'code',source:['pg_d'],metadata:{vscode:{languageId:'shellscript'}},outputs:[],execution_count:null},
        ]})));
        const saved=await vscode.workspace.openNotebookDocument(uri);
        const list=await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',saved.cellAt(1).document.uri,new vscode.Position(0,4));
        assert.ok(list.items.some(item=>item.label==='pg_dump'));
        const items=await cellCompletions(folder.fsPath,'zsh','pg_d',4);
        assert.ok(items.some(item=>item.label==='pg_dump' && item.apply==='pg_dump' && item.from===0 && item.to===4));
      }finally{provider.dispose();}
    });
    if(vscode.extensions.getExtension('mads-hartmann.bash-ide-vscode'))await check('installed Bash IDE completes shell variables in embedded cells',async()=>{
      const folder=mkdtempSync(join(tmpdir(),'dhimantai-bash-ide-'));
      const source='GREETING=hello\nprintf "%s" "$GRE';
      let items:Awaited<ReturnType<typeof cellCompletions>>=[];
      for(let n=0;n<20;n++){
        items=await cellCompletions(folder,'bash',source,source.length);
        if(items.some(item=>item.label.includes('GREETING')))break;
        await new Promise(r=>setTimeout(r,500));
      }
      assert.ok(items.some(item=>item.label.includes('GREETING')),JSON.stringify(items));
    });
  } finally {
    await auth.signOut();
    require('node:fs').writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
  }
  assert.ok(results.every(r => r.ok), JSON.stringify(results.filter(r => !r.ok), null, 2));
}
