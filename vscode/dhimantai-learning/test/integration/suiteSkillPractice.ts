import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';
import { skillStages } from '../../src/skillPractice';

/** Real extension host, real local programs, and a contract-only Instructor service. */
export async function run() {
  const results: {step:string;ok:boolean;error?:string}[] = [];
  const check = async (step: string, body: () => Promise<void>) => {
    try { await body(); results.push({step,ok:true}); }
    catch (error) { results.push({step,ok:false,error:String(error instanceof Error ? error.stack : error)}); }
  };
  const {auth} = await vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!.activate();
  // These checks cover the Practice panel; suitePracticeNotebook covers the notebook flow.
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor', 'panel', vscode.ConfigurationTarget.Global);
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const create = vscode.window.createWebviewPanel, responses: any[] = [];
  let panel: vscode.WebviewPanel | undefined, receive: (message:any) => Promise<void>;
  (vscode.window as any).createWebviewPanel = (...args: any[]) => {
    const created = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] === 'dhimantai.learningRoom') {
      panel = created;
      (created.webview as any).onDidReceiveMessage = (handler:any) => { receive = handler; return new vscode.Disposable(() => {}); };
      (created.webview as any).postMessage = async (message:any) => { responses.push(message); return true; };
    }
    return created;
  };
  const state = async () => (await fetch(`${process.env.DHIMANTAI_TEST_SERVER}/__state`)).json() as Promise<any>;
  const cfg = vscode.workspace.getConfiguration('dhimantai');
  const snapshot = {snippet:'code-1',revision:0,language:'python',source:'print(int(input()) * 2)',stdin:'0\n',question:'My attempt'};
  const cases = [{kind:'regression',reason:'Zero must remain zero',stdin:'0\n',expected:'0\n'}];
  try {
    await vscode.commands.executeCommand('dhimantai.openExercise', QUESTION_ID);
    await receive!({type:'join',mode:'tutor',attempt:1});
    assert.equal(responses.at(-1).type,'practiceReady');
    const tool = async (value: unknown, source = snapshot.source) => {
      await receive!({type:'practiceTool',attempt:1,request:100 + responses.length,tool:'my_tests',snapshot:{...snapshot,source},cases:value});
      return responses.filter(m => m.type === 'practiceToolResult').at(-1);
    };
    await check('authored regression catches the bug, then matches the fixed program without an Instructor call', async () => {
      assert.equal((await tool(cases, 'print(int(input()) * 2 + 1)')).tests[0].verdict,'wrong_answer');
      const fixed = await tool(cases);
      assert.equal(fixed.error,undefined); assert.equal(fixed.tests[0].verdict,'passed');
      assert.equal(fixed.tests[0].expected,'0\n'); assert.equal(fixed.tests[0].actual,'0\n');
      assert.equal((await state()).coach.length,0);
    });
    await check('invalid cases fail validation and runtime failures cannot match expectations', async () => {
      assert.match((await tool(Array(7).fill(cases[0]))).error,/six test cases/);
      assert.match((await tool([{...cases[0],reason:''}])).error,/explain/);
      assert.equal((await tool(cases, 'print(0)\nraise ValueError("failed")')).tests[0].verdict,'runtime_error');
    });
    await check('debugging and test-design stages carry selected source and input without assessment', async () => {
      for (const stage of skillStages) {
        await receive!({type:'notebookTurn',attempt:1,request:200 + responses.length,snapshot,stage,
          message:'I expect zero for zero input.',prediction:'',submitted:false,history:[]});
        const reply = responses.filter(m => m.type === 'notebookReply').at(-1);
        assert.equal(reply.error,undefined); assert.equal(reply.submitted,false);
        const sent = (await state()).coach.at(-1);
        assert.equal(sent.stage,stage); assert.equal(sent.source,snapshot.source); assert.equal(sent.stdin,snapshot.stdin);
      }
      assert.equal((await state()).submissions.length,0);
    });
    await check('unverified debugger data cannot be sent to Instructor', async () => {
      const calls = (await state()).coach.length;
      await receive!({type:'notebookTurn',attempt:1,request:300,snapshot,stage:'debug',
        message:'Explain the pause.',prediction:'',submitted:false,history:[],debugger:{id:'invented',variables:[{name:'secret',value:'forged'}]}});
      assert.match(responses.filter(m => m.type === 'notebookReply').at(-1).error,/no longer current/);
      assert.equal((await state()).coach.length,calls);
    });
    await check('real unittest code executes and reports assertion failures without an Instructor call', async () => {
      const calls = (await state()).coach.length;
      const source = 'import unittest\ndef twice(n): return n * 2\nclass TestTwice(unittest.TestCase):\n    def test_zero(self): self.assertEqual(twice(0), 0)\nunittest.main()\n';
      const runTest = async (code:string) => {
        await receive!({type:'practiceTool',attempt:1,request:400 + responses.length,tool:'test_code',snapshot:{...snapshot,source:code}});
        const result = responses.filter(m => m.type === 'practiceToolResult').at(-1);
        assert.equal(result.error,undefined); return result.execution;
      };
      const failed = await runTest(source.replace('return n * 2','return n * 2 + 1'));
      assert.notEqual(failed.exit_code,0); assert.match(failed.stderr,/FAILED.*failures=1/s);
      const passed = await runTest(source);
      assert.equal(passed.exit_code,0); assert.match(passed.stderr,/Ran 1 test/); assert.match(passed.stderr,/OK/);
      assert.equal((await state()).coach.length,calls);
    });
    await check('learner tests still execute with AI assistance disabled', async () => {
      await cfg.update('aiAssistance',false,vscode.ConfigurationTarget.Global);
      const result = await tool(cases);
      assert.equal(result.error,undefined); assert.equal(result.tests[0].verdict,'passed');
    });
  } finally {
    (vscode.window as any).createWebviewPanel = create;
    panel?.dispose(); await cfg.update('aiAssistance',undefined,vscode.ConfigurationTarget.Global);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify(results,null,2));
  }
  if (results.some(r => !r.ok)) throw new Error('Debugging and testing integration checks failed');
}
