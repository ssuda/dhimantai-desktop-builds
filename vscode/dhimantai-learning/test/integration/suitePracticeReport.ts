/** Real VS Code host regressions for the 7 Nov 2026, 36-screenshot report.
 * The service is a contract fixture; Python execution and local notebook storage are real.
 */
import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { Api, GeneratedExercise } from '../../src/api';
import type { Auth } from '../../src/auth';
import type { PracticeBrowser } from '../../src/practiceBrowser';
import { EMAIL, PASSWORD } from './contractServer';

export async function run() {
  const results: {step:string; ok:boolean; error?:string}[] = [];
  const check = async (step:string, body:() => Promise<void>) => {
    try { await body(); results.push({step,ok:true}); }
    catch (error) { results.push({step,ok:false,error:String(error instanceof Error ? error.stack : error)}); }
  };
  const extension = vscode.extensions.getExtension<{auth:Auth; practice:PracticeBrowser}>('optficial.dhimantai-learning')!;
  const {auth,practice} = await extension.activate();
  // These checks cover the Practice panel; suitePracticeNotebook covers the notebook flow.
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor', 'panel', vscode.ConfigurationTarget.Global);
  await auth.signInWithPassword(EMAIL,PASSWORD);
  const create = vscode.window.createWebviewPanel, pick = vscode.window.showQuickPick, input = vscode.window.showInputBox;
  const generate = Api.prototype.generateExercise, catalog = Api.prototype.practiceCatalog;
  const messages:any[] = [], saved:any[] = [];
  let panel:vscode.WebviewPanel | undefined, receive:(message:any) => Promise<void>;
  (vscode.window as any).createWebviewPanel = (...args:any[]) => {
    const host = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] === 'dhimantai.learningRoom') {
      panel = host;
      (host.webview as any).onDidReceiveMessage = (handler:any) => { receive = handler; return new vscode.Disposable(() => {}); };
      (host.webview as any).postMessage = async (message:any) => { messages.push(message); return true; };
    }
    return host;
  };
  try {
    const [course] = await practice.getChildren();
    const [chapter] = await practice.getChildren(course);
    if (chapter.kind !== 'chapter') throw new Error('Missing chapter fixture');
    for (const difficulty of ['Easy','Medium','Hard']) {
      await check(`1–6, 26, 29, 33: ${difficulty} selection reaches generation and creates its own saved notebook`, async () => {
        const title = `${difficulty} variable practice`;
        const exercise:GeneratedExercise = {exercise:{title,task:'Print the sum of 7 and 5.',example_input:'',expected_output:'12'},
          course:'Python',chapter:'Variables',language:'python',kernel:'python3',difficulty:difficulty.toLowerCase(),
          validation:'reference_execution',tests:[{id:'example',kind:'stdio',stdin:'',expected:'12\n'}]};
        (vscode.window as any).showQuickPick = async (items:any[], options:any) => {
          if (options.placeHolder === 'Choose the programming language') {
            assert.equal(items[0].id,'python'); return items[0];
          }
          assert.deepEqual(items,['Easy','Medium','Hard']); return difficulty;
        };
        (vscode.window as any).showInputBox = async (options:any) => {
          assert.match(options.prompt,/Optional focus/);
          assert.ok(options.validateInput('x'.repeat(201)));
          return '  variables  ';
        };
        Api.prototype.generateExercise = async (id,language,selected,focus) => {
          assert.equal(id,chapter.chapter.id); assert.equal(language,'python');
          assert.equal(selected,difficulty.toLowerCase()); assert.equal(focus,'variables');
          return exercise;
        };
        messages.length = 0;
        await practice.generate(chapter);
        assert.equal(panel!.title,'Practice notebook · '+title);
        await receive!({type:'join',mode:'tutor',attempt:1});
        assert.equal(messages.at(-1).practice.tools.tests,1);
        const document = messages.find(m => m.type === 'restoreNotebook');
        const notebook = {...document.notebook,textDraft:'Unsent '+title,
          cells:[...document.notebook.cells,{id:'learner',kind:'message',text:'Why twelve?'},
            {id:'tutor',kind:'board',text:'Seven plus five is twelve.'}],
          drafts:[{key:'practice-question:0',snippet:'code-1',language:'python',source:'a = 7\nb = 5\nprint(a + b)',
            stdin:'',prediction:'12',explanation:title,helped:true}]};
        await receive!({type:'notebookChanged',documentKey:document.documentKey,sequence:1,notebook});
        saved.push(notebook);
        panel!.dispose();
      });
    }
    await check('21–25: offline catalog retains saved history; exact selected title restores only its own work', async () => {
      assert.equal(saved.length,3);
      assert.equal(new Set(saved.map(n => n.exerciseId)).size,3);
      Api.prototype.practiceCatalog = async () => { throw new Error('Service unavailable'); };
      const nodes = await practice.getChildren();
      assert.ok(nodes.some(n => n.kind === 'notice' && n.command === 'dhimantai.practiceHistory'));
      for (const notebook of saved) {
        (vscode.window as any).showQuickPick = async (choices:any[],options:any) => {
          assert.equal(options.title,'Saved Practice notebooks');
          const matches = choices.filter(c => c.label === notebook.title);
          assert.equal(matches.length,1); return matches[0];
        };
        messages.length = 0;
        await vscode.commands.executeCommand('dhimantai.practiceHistory');
        assert.equal(panel!.title,'Practice notebook · '+notebook.title);
        await receive!({type:'join',mode:'tutor',attempt:1});
        const restored = messages.find(m => m.type === 'restoreNotebook').notebook;
        assert.deepEqual(restored,notebook);
        assert.equal(messages.at(-1).practice.tools.tests,1);
        panel!.dispose();
      }
    });
    await check('10, 15, 17: recovered generated sample runs real Python, reports mismatch, success and runtime failure', async () => {
      messages.length = 0;
      await vscode.commands.executeCommand('dhimantai.practiceHistory');
      await receive!({type:'join',mode:'tutor',attempt:1});
      const run = async (source:string) => {
        await receive!({type:'practiceTool',tool:'tests',attempt:1,request:messages.length+1,
          snapshot:{snippet:'code-1',revision:0,language:'python',source,stdin:'',question:'Print the sum of 7 and 5.'}});
        return messages.filter(m => m.type === 'practiceToolResult').at(-1);
      };
      const mismatch = await run('print(15)');
      assert.equal(mismatch.error,undefined); assert.notEqual(mismatch.tests[0].verdict,'passed');
      assert.equal(mismatch.tests[0].actual,'15\n'); assert.equal(mismatch.tests[0].expected,'12\n');
      const passed = await run('a = 7\nb = 5\nprint(a + b)');
      assert.equal(passed.tests[0].verdict,'passed'); assert.equal(passed.tests[0].actual,'12\n');
      const crashed = await run('a = 7\nb = 0\nprint(a / b)');
      assert.notEqual(crashed.tests[0].verdict,'passed'); assert.match(crashed.tests[0].stderr,/ZeroDivisionError/);
    });
  } finally {
    (vscode.window as any).createWebviewPanel = create;
    (vscode.window as any).showQuickPick = pick;
    (vscode.window as any).showInputBox = input;
    Api.prototype.generateExercise = generate; Api.prototype.practiceCatalog = catalog;
    panel?.dispose();
  }
  writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:results.filter(r=>r.ok).length,
    failed:results.filter(r=>!r.ok).length,results},null,2));
  if (results.some(r=>!r.ok)) throw new Error('Practice screenshot report checks failed');
}
