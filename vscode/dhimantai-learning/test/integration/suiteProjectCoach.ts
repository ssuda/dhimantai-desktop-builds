/** Real right-panel checks, using controlled Coach replies; no live provider or deployment claims. */
import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { Api } from '../../src/api';
import { CourseEngine } from '../../src/courseEngine';
import { CourseWorkspaces } from '../../src/courseWorkspace';
import { courseTerminalOptions } from '../../src/courseTerminal';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD } from './contractServer';
import { connect } from './suiteNotebookCoachHistory';

const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(read: () => Promise<any>, ready: (value: any) => boolean, label: string) {
  for (let i = 0; i < 400; i++) { const value = await read(); if (ready(value)) return value; await pause(); }
  throw new Error('Timed out: ' + label);
}

export async function run() {
  const results: object[] = [], requests: any[] = [];
  const out = process.env.DHIMANTAI_UX_OUT || mkdtempSync(join(tmpdir(), 'project-coach-ui-'));
  mkdirSync(out, {recursive: true});
  const ext = vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await ext.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const originalEngine = CourseWorkspaces.prototype.forFile, originalRecord = CourseWorkspaces.prototype.recordFor;
  const courseEngine = new CourseEngine(process.env.DHIMANTAI_PROJECT_PODMAN!,process.env.DHIMANTAI_PROJECT_CONTAINER!,dirname(root));
  CourseWorkspaces.prototype.forFile = async () => courseEngine;
  CourseWorkspaces.prototype.recordFor = () => ({root,course:'Project test',key:'project-test',account:'test',environment:'staging'});
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const cdp = await connect(), original = Api.prototype.notebookCoach;
  const ui = (expression: string) => cdp.webview(`d => { if (!d.getElementById('checkpoint')) return null; return (${expression})(d); }`);
  const visible = () => ui(`d => ({title:d.getElementById('title').textContent, step:d.getElementById('step').value,
    goal:d.getElementById('goal').textContent, check:d.getElementById('checkState').textContent, status:d.getElementById('status').textContent,
    messages:d.getElementById('conversation').textContent, saved:d.getElementById('saved').textContent,
    note:d.getElementById('note').value, askDisabled:d.getElementById('ask').disabled})`);
  const click = (id: string) => ui(`d => {d.getElementById('${id}').click(); return true;}`);
  const ask = (text: string) => ui(`d => {d.getElementById('message').value=${JSON.stringify(text)}; d.getElementById('composer').requestSubmit(); return true;}`);
  const shot = async (name: string) => { await vscode.commands.executeCommand('notifications.clearAll');
    const image = await cdp.send('Page.captureScreenshot', {format:'png'}); writeFileSync(join(out,name+'.png'), Buffer.from(image.data,'base64')); };
  try {
    Api.prototype.notebookCoach = async (path, body: any) => {
      assert.equal(path, '/notebook-coach/project'); requests.push(body);
      return {guidance: body.project_context.project_id === 'rich-reading'
        ? 'You are in **Console.print**. Follow `_collect_renderables` to see how the inputs become renderables, then find `render_str` for the string path.'
        : 'Trace the **tool observation** from tools.py into the next model request.', prompt: '', line: null};
    };
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    await until(visible, value => value?.title === 'Course Research Agent', 'project right panel');
    await click('check');
    await until(visible, value => value?.check === 'Current files · passed', 'real Python setup checks');
    await shot('01-setup'); results.push({step:'setup', pass:true});
    await ui(`d => {const step=d.getElementById('step'); step.value='1'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible, value => value?.step === '1' && value.goal.includes('deterministic search'), 'search milestone');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'unfinished starter fails honestly');
    await ask('Help me understand how these files connect.');
    await until(visible, value => value?.messages.includes('tool observation') && !value.askDisabled, 'first Coach reply');
    assert.ok(requests[0].project_context.files.length > 1);
    assert.equal(requests[0].project_context.check.status, 'failed');
    await ask('What should I inspect next?');
    await until(async () => requests.length, value => value === 2, 'follow-up');
    assert.equal(requests[1].history.length, 2);
    await until(visible, value => !value?.askDisabled, 'follow-up finished');
    await shot('02-search-conversation'); results.push({step:'cross-file-conversation', pass:true});
    const terminal = courseTerminalOptions(new CourseEngine('podman','test-course',root), 'Project', join(root,'nested project'));
    assert.equal(terminal.cwd, join(root,'nested project'));
    assert.ok(Array.isArray(terminal.shellArgs) && terminal.shellArgs.includes('/course/nested project'));
    const doc = await vscode.workspace.openTextDocument(join(root,'course_agent/search.py'));
    await vscode.window.showTextDocument(doc, {preview:false});
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri,new vscode.Position(0,0),'# My investigation\n');
    assert.ok(await vscode.workspace.applyEdit(edit)); await doc.save();
    await until(visible, value => value?.check.startsWith('Earlier files'), 'stale check label');
    await ui(`d => {d.getElementById('note').value='Next: trace tied search scores.'; d.getElementById('externalHelp').value='reported'; return true;}`);
    await click('checkpoint');
    await until(visible, value => value?.saved.includes('2 Coach help turns'), 'checkpoint assistance count');
    await vscode.commands.executeCommand('dhimantai.hideCoach');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    await until(visible, value => value?.step === '1' && value.note === 'Next: trace tied search scores.', 'resume checkpoint');
    assert.equal((await visible()).messages, '', 'chat does not persist across reopening');
    await vscode.workspace.getConfiguration('dhimantai').update('aiAssistance', false, vscode.ConfigurationTarget.Global);
    await until(visible, value => value?.askDisabled, 'AI off');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'checks work with AI off');
    await shot('03-resumed-checkpoint'); results.push({step:'resume-stale-evidence-ai-off', pass:true});
    await vscode.workspace.getConfiguration('dhimantai').update('aiAssistance', true, vscode.ConfigurationTarget.Global);
    const richRoot = join(dirname(root),'rich-reading');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach',richRoot);
    await until(visible,value=>value?.title==='Read a codebase · Rich','Rich reading panel');
    const runtimeValues = await ui(`d => [...d.getElementById('runtime').options].map(o=>o.value)`);
    assert.deepEqual(runtimeValues,['course','setup','terminal']);
    await click('check');
    await until(visible,value=>value?.check==='Current files · passed','Rich dependency setup in container');
    await ui(`d => {const step=d.getElementById('step'); step.value='2'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible,value=>value?.step==='2' && value.goal.includes('long file'),'Rich navigation step');
    await ui(`d => { [...d.querySelectorAll('#files button')].find(b=>b.textContent==='rich/console.py').click(); return true;}`);
    await until(async()=>vscode.window.activeTextEditor?.selection.active.line,value=>value>1500,'Console.print anchor');
    await ask('How do I follow this method into its next function?');
    await until(async()=>requests.at(-1)?.project_context.project_id,value=>value==='rich-reading','Rich Coach context');
    const richContext = requests.at(-1).project_context;
    assert.equal(richContext.selected_file,'rich/console.py');
    assert.ok(richContext.files[0].start_line>1500 && richContext.files[0].text.includes('    def print('));
    await until(visible,value=>!value?.askDisabled,'Rich reply complete');
    await click('check');
    await until(visible,value=>value?.check==='Current files · passed','Rich plain text run');
    await shot('04-rich-navigation'); results.push({step:'rich-container-navigation-and-line-context',pass:true});
    await vscode.commands.executeCommand('dhimantai.openProjectCoach',join(dirname(root),'shelf-reading'));
    await until(visible,value=>value?.title==='Read a codebase · shelf','shelf reading panel');
    await ui(`d => {const step=d.getElementById('step'); step.value='3'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible,value=>value?.step==='3' && value.goal.includes('prediction'),'shelf search step');
    assert.equal(await ui(`d => d.getElementById('projectContent').scrollTop`),0,'new steps start at their goal');
    await click('check');
    await until(visible,value=>value?.check==='Current files · passed','shelf reading run');
    assert.match(await ui(`d => d.getElementById('output').textContent`),/No books found/);
    assert.match((await visible()).status,/not an assessment/);
    assert.equal((await visible()).messages,'','reading projects do not share chat');
    await shot('05-shelf-reading'); results.push({step:'shelf-reading-output-and-isolation',pass:true});
  } catch (error) {
    results.push({step:'failure', error:String(error), visible:await visible()}); await shot('failure'); throw error;
  } finally {
    Api.prototype.notebookCoach = original;
    CourseWorkspaces.prototype.forFile = originalEngine;
    CourseWorkspaces.prototype.recordFor = originalRecord;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({results, artifactDirectory:out},null,2));
    cdp.close();
  }
}
