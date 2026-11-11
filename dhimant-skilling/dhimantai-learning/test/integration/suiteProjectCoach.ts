/** Real right-panel checks, using controlled Coach replies; no live provider or deployment claims. */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const originalAvailability = Api.prototype.projectHandoffAvailability, originalSend = Api.prototype.sendProjectHandoff,
    originalDetail = Api.prototype.projectHandoffDetail, originalInfo = vscode.window.showInformationMessage, originalSave = vscode.window.showSaveDialog;
  const ui = (expression: string) => cdp.webview(`d => { if (!d.getElementById('checkpoint') || d.defaultView.frameElement?.id !== 'active-frame') return null; return (${expression})(d); }`);
  const visible = () => ui(`d => ({title:d.getElementById('title').textContent, step:d.getElementById('step').value,
    goal:d.getElementById('goal').textContent, check:d.getElementById('checkState').textContent, status:d.getElementById('status').textContent,
    messages:d.getElementById('conversation').textContent, saved:d.getElementById('saved').textContent,
    note:d.getElementById('note').value, askDisabled:d.getElementById('ask').disabled, checkDisabled:d.getElementById('check').disabled,
    progress:d.getElementById('progressText').textContent, milestoneStatus:d.getElementById('milestoneStatus').textContent,
    completed:d.getElementById('completed').checked, hint:d.getElementById('hint').textContent,
    handoff:d.getElementById('handoffStatus').textContent, finishDisabled:d.getElementById('finish').disabled,
    refreshDisabled:d.getElementById('refreshHandoff').disabled, handoffHidden:d.getElementById('handoff').hidden})`);
  const click = (id: string) => until(async () => ui(`d => {const button=d.getElementById('${id}');
    if (button.disabled) return false; button.scrollIntoView({block:'center'}); button.click(); return true;}`), Boolean, id + ' enabled');
  const ask = (text: string) => ui(`d => {d.getElementById('message').value=${JSON.stringify(text)}; d.getElementById('composer').requestSubmit(); return true;}`);
  const shot = async (name: string) => { await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise(resolve => setTimeout(resolve, 200));
    const image = await cdp.send('Page.captureScreenshot', {format:'png'}); writeFileSync(join(out,name+'.png'), Buffer.from(image.data,'base64')); };
  try {
    Api.prototype.notebookCoach = async (path, body: any) => {
      assert.equal(path, '/notebook-coach/project'); requests.push(body);
      return {guidance: body.project_context.project_id === 'rich-reading'
        ? 'You are in **Console.print**. Follow `_collect_renderables` to see how the inputs become renderables, then find `render_str` for the string path.'
        : 'Trace the **tool observation** from tools.py into the next model request.\n\n' +
          Array.from({length: 10}, (_, i) => `Observation ${i + 1}: Follow the returned data into the next request. Explain what changed before choosing the next action.`).join('\n\n'), prompt: '', line: null};
    };
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    // Activation also restores Coach asynchronously. Wait for its initial render/account refresh to settle.
    let previous = '', stable = 0;
    await until(visible, value => {
      const current = JSON.stringify(value);
      stable = value?.title === 'Course Research Agent' && !value.checkDisabled && current === previous ? stable + 1 : 0;
      previous = current; return stable >= 5;
    }, 'project right panel ready');
    await click('check');
    await until(visible, value => value?.check === 'Current files · passed', 'real Python setup checks');
    assert.match((await visible()).progress, /0\/10 marked complete/, 'passing checks do not claim completion');
    await shot('01-setup'); results.push({step:'setup', pass:true});
    for (const [index, file] of [[2, 'documents.py'], [3, 'tools.py']] as const) {
      await ui(`d => {const step=d.getElementById('step'); step.value='${index}'; step.dispatchEvent(new Event('change')); return true;}`);
      await until(visible, value => value?.step === String(index) && value.check === 'Not checked for this step.'
        && value.goal.includes(index === 2 ? 'actual evidence' : 'model proposal'), 'QA milestone ' + (index + 1));
      await click('check');
      await until(visible, value => value?.check.startsWith('Current files · failed'), 'QA starter failure');
      const failure = await ui(`d => ({cause:d.getElementById('checkCause').textContent,
        location:d.getElementById('checkLocation').textContent, hidden:d.getElementById('checkDiagnostic').hidden,
        open:d.getElementById('checkDetails').open, output:d.getElementById('output').textContent,
        fits:['checkCause','checkLocation'].every(id => {const el=d.getElementById(id);
          return el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= d.getElementById('projectContent').getBoundingClientRect().right;})})`);
      assert.match(failure.cause, /not implemented yet/);
      assert.ok(failure.location.startsWith('course_agent/' + file + ':'));
      assert.equal(failure.hidden, false); assert.equal(failure.open, false);
      assert.equal(failure.fits, true, 'the cause and location fit the narrow Coach panel');
      assert.match(failure.output, /NotImplementedError/);
      assert.match(failure.output, /FAILED/);
      assert.ok(failure.output.length <= 4000);
      if (index === 3) assert.match((await visible()).check, /output truncated/);
      await shot('qa-milestone-' + (index + 1));
      results.push({step:'qa-milestone-' + (index + 1) + '-failure-summary', pass:true});
    }
    await ui(`d => {const step=d.getElementById('step'); step.value='1'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible, value => value?.step === '1' && value.goal.includes('deterministic search'), 'search milestone');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'unfinished starter fails honestly');
    await ask('Help me understand how these files connect.');
    await until(visible, value => value?.messages.includes('tool observation') && !value.askDisabled, 'first Coach reply');
    assert.ok(requests[0].project_context.files.length > 1);
    assert.ok(requests[0].project_context.files.some((file: any) => file.path === 'README.md'));
    assert.ok(requests[0].project_context.structure.files.includes('data/documents.json'));
    assert.equal(requests[0].project_context.check.status, 'failed');
    await ask('What should I inspect next?');
    await until(async () => requests.length, value => value === 2, 'follow-up');
    assert.equal(requests[1].history.length, 2);
    await until(visible, value => !value?.askDisabled, 'follow-up finished');
    const scroll = await ui(`d => {const c=d.getElementById('projectContent'); c.scrollTop=150;
      d.defaultView.savedCoachRow=d.querySelector('#conversation article');
      return {height:c.clientHeight, content:c.scrollHeight, position:c.scrollTop, bottom:d.getElementById('composer').getBoundingClientRect().bottom, viewport:d.defaultView.innerHeight};}`);
    assert.ok(scroll.content > scroll.height && scroll.position > 0, 'long conversation scrolls inside its panel');
    assert.ok(scroll.bottom <= scroll.viewport + 1, 'composer remains visible');
    const active = vscode.window.activeTextEditor!;
    active.selection = new vscode.Selection(1, 0, 1, 0);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await ui(`d => d.getElementById('projectContent').scrollTop`), scroll.position, 'editor updates preserve reading position');
    assert.equal(await ui(`d => d.querySelector('#conversation article')===d.defaultView.savedCoachRow`), true, 'messages survive refresh');
    await shot('02-search-conversation'); results.push({step:'cross-file-conversation', pass:true});
    const terminal = courseTerminalOptions(new CourseEngine('podman','test-course',root), 'Project', join(root,'nested project'));
    assert.equal(terminal.cwd, join(root,'nested project'));
    assert.ok(Array.isArray(terminal.shellArgs) && terminal.shellArgs.includes('/course/nested project'));
    const doc = await vscode.workspace.openTextDocument(join(root,'course_agent/search.py'));
    await vscode.window.showTextDocument(doc, {preview:false});
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri,new vscode.Position(0,0),'# My investigation\n');
    assert.ok(await vscode.workspace.applyEdit(edit)); await doc.save();
    await until(visible, value => value?.check.startsWith('Earlier files'), 'stale check label');
    await ui(`d => {d.getElementById('note').value='Next: trace tied search scores.'; d.getElementById('externalHelp').value='reported'; d.getElementById('completed').checked=true; return true;}`);
    await click('checkpoint');
    await until(visible, value => value?.saved.includes('2 Coach help turns'), 'checkpoint assistance count');
    await vscode.commands.executeCommand('dhimantai.hideCoach');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    await until(visible, value => value?.step === '1' && value.note === 'Next: trace tied search scores.', 'resume checkpoint');
    assert.equal((await visible()).messages, '', 'chat does not persist across reopening');
    assert.match((await visible()).progress, /1\/10 marked complete/);
    assert.equal((await visible()).completed, true);
    await auth.signOut();
    await until(visible, value => value?.step === '0' && value.note === '' && value.progress.includes('0/10 marked complete'), 'signed-out progress is separate');
    await auth.signInWithPassword(EMAIL, PASSWORD);
    await until(visible, value => value?.step === '1' && value.note === 'Next: trace tied search scores.' && value.progress.includes('1/10 marked complete'), 'account progress restores after sign-in');
    await click('previous');
    await until(visible, value => value?.step === '0' && value.note === '', 'each milestone has separate evidence');
    assert.equal((await visible()).completed, false);
    await click('next');
    await until(visible, value => value?.step === '1' && value.note === 'Next: trace tied search scores.', 'next restores milestone evidence');
    const laterEdit = new vscode.WorkspaceEdit(); laterEdit.insert(doc.uri, new vscode.Position(0,0), '# Evidence changed after completion\n');
    assert.ok(await vscode.workspace.applyEdit(laterEdit)); await doc.save();
    await until(visible, value => value?.progress.includes('1 to review') && !value.completed, 'changed evidence needs review');
    assert.match((await visible()).progress, /0\/10 marked complete/);
    await vscode.workspace.getConfiguration('dhimantai').update('aiAssistance', false, vscode.ConfigurationTarget.Global);
    await until(visible, value => value?.askDisabled, 'AI off');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'checks work with AI off');
    const requestsBeforeHelp = requests.length;
    await click('hint');
    await until(visible, value => value?.hint === 'Try a smaller step', 'first local hint');
    await click('hint');
    await until(visible, value => value?.messages.includes('manually count distinct query-word matches') && value.hint === 'Review next step', 'smaller step with AI off');
    await click('hint');
    await until(visible, value => value?.status.includes('Turn on AI assistance'), 'offline follow-up explanation');
    assert.equal(requests.length, requestsBeforeHelp, 'local help does not send model requests');
    await shot('03-resumed-checkpoint'); results.push({step:'resume-stale-evidence-ai-off', pass:true});
    await vscode.workspace.getConfiguration('dhimantai').update('aiAssistance', true, vscode.ConfigurationTarget.Global);
    let delayed: ((reply: any) => void) | undefined;
    Api.prototype.notebookCoach = async (_path, body) => {
      requests.push(body); return new Promise(resolve => { delayed = resolve; });
    };
    await until(visible, value => !value?.askDisabled, 'AI on');
    await ask('This response should be cancelled by New chat.');
    await until(async () => !!delayed, Boolean, 'pending Coach request');
    await click('newChat');
    await until(visible, value => value?.messages === '' && !value.askDisabled, 'New chat clears while a request is pending');
    delayed!({guidance: 'Obsolete reply must not return', prompt: '', line: null});
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await visible()).messages, '');
    Api.prototype.notebookCoach = async (_path, body: any) => {
      requests.push(body); return {guidance: 'Fresh conversation', prompt: '', line: null};
    };
    await ask('Start from this question.');
    await until(visible, value => value?.messages.includes('Fresh conversation') && !value.askDisabled, 'fresh Coach reply');
    assert.deepEqual(requests.at(-1).history, [], 'New chat sends no previous conversation');
    results.push({step:'scroll-and-new-chat-race',pass:true});
    const submissions: {request: string; snapshot: any}[] = [];
    let savedReceipt = false;
    const receipt = {id: '00000000-0000-0000-0000-000000000001', status: 'open', created_at: '2026-11-09T00:00:00Z', version: 1};
    Api.prototype.projectHandoffAvailability = async () => ({mode: 'teacher', teachers: [{id: 'teacher', name: 'Assigned teacher'}],
      history: savedReceipt ? [{thread_id: receipt.id, source_hash: 'frozen', created_at: receipt.created_at}] : []});
    Api.prototype.sendProjectHandoff = async (request, snapshot) => {
      submissions.push({request, snapshot});
      if (submissions.length === 1) throw new Error('Controlled uncertain network result');
      savedReceipt = true; return {thread: receipt, source_hash: 'frozen'};
    };
    Api.prototype.projectHandoffDetail = async () => ({thread: {...receipt, status: 'answered', version: 2},
      messages: [{author_name: 'Assigned teacher', author_role: 'teacher', body: 'Explain the boundary case in your custom test.'}], has_more: false});
    (vscode.window as any).showInformationMessage = async (_text: string, options: any, choice: string) => options?.modal ? choice : undefined;
    await ui(`d => {const step=d.getElementById('step'); step.value='9'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible, value => value?.step === '9' && value.goal.includes('reproducible demonstration') && !value.refreshDisabled, 'final milestone');
    await click('refreshHandoff');
    await until(async () => ui(`d => d.getElementById('handoffStatus').textContent`), text => text?.includes('Assigned teacher'), 'teacher availability');
    await click('finish');
    await until(async () => ui(`d => d.getElementById('handoffStatus').textContent`), text => text?.includes('not confirmed'), 'uncertain submission');
    await click('finish');
    await until(async () => ui(`d => d.getElementById('handoffStatus').textContent`), text => text?.includes('Submitted for teacher review'), 'submission receipt');
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0].request, submissions[1].request, 'transport retry keeps its request ID');
    assert.deepEqual(submissions[0].snapshot, submissions[1].snapshot);
    assert.ok(submissions[1].snapshot.files.some((file: any) => file.path === 'EXPLANATION.md'));
    assert.equal(submissions[1].snapshot.assistance.other_help, 'reported');
    await click('refreshHandoff');
    await until(async () => ui(`d => d.getElementById('handoffStatus').textContent`), text => text?.includes('Explain the boundary case'), 'teacher feedback');
    const finalLayout = await ui(`d => {const form=d.getElementById('composer'), rect=form.getBoundingClientRect(); return {
      top:rect.top,bottom:rect.bottom,height:rect.height,viewport:d.defaultView.innerHeight,
      display:d.defaultView.getComputedStyle(form).display,visibility:d.defaultView.getComputedStyle(form).visibility};}`);
    assert.ok(finalLayout.height > 0 && finalLayout.bottom <= finalLayout.viewport + 1, JSON.stringify(finalLayout));
    assert.equal(finalLayout.visibility, 'visible');
    await new Promise(resolve => setTimeout(resolve, 200));
    await shot('04-final-submission');
    Api.prototype.projectHandoffAvailability = async () => ({mode: 'handoff', teachers: [], history: []});
    const exportPath = join(out, 'independent-handoff.json');
    (vscode.window as any).showSaveDialog = async () => vscode.Uri.file(exportPath);
    await click('finish');
    await until(async () => ui(`d => d.getElementById('handoffStatus').textContent`), text => text?.includes('Local handoff saved'), 'independent handoff');
    assert.equal(JSON.parse(readFileSync(exportPath, 'utf8')).project_id, 'course-agent');
    assert.equal(submissions.length, 2, 'independent export never sends a submission');
    results.push({step:'teacher-submission-retry-status-and-independent-handoff',pass:true});
    Api.prototype.notebookCoach = async (_path, body: any) => {
      requests.push(body); return {guidance: 'Follow Console.print and the supplied method.', prompt: '', line: null};
    };
    const richRoot = join(dirname(root),'rich-reading');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach',richRoot);
    await until(visible,value=>value?.title==='Read a codebase · Rich','Rich reading panel');
    assert.match((await visible()).progress, /0\/10 marked complete/, 'progress is isolated by project');
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
    await ask('Explain rich/_loop.py and its tests.');
    await until(async()=>requests.at(-1)?.project_context.selected_file,value=>value==='rich/_loop.py','question selects a non-curated source file');
    await until(visible,value=>!value?.askDisabled,'retrieved source reply complete');
    const retrieved = requests.at(-1).project_context;
    assert.ok(retrieved.files.some((file: any) => file.path === 'README.md'));
    assert.ok(retrieved.structure.files.includes('rich/_loop.py'));
    assert.ok(retrieved.structure.truncated && retrieved.omitted_count > retrieved.omitted.length);
    writeFileSync(join(out, 'context-request.json'), JSON.stringify(requests.at(-1)));
    results.push({step:'question-retrieval-and-public-project-map',pass:true});
    await vscode.commands.executeCommand('dhimantai.openProjectCoach',join(dirname(root),'shelf-reading'));
    await until(visible,value=>value?.title==='Read a codebase · shelf','shelf reading panel');
    assert.match((await visible()).progress, /0\/7 marked complete/);
    await ui(`d => {const step=d.getElementById('step'); step.value='3'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible,value=>value?.step==='3' && value.goal.includes('prediction'),'shelf search step');
    assert.equal(await ui(`d => d.getElementById('projectContent').scrollTop`),0,'new steps start at their goal');
    await click('check');
    await until(visible,value=>value?.check==='Current files · passed','shelf reading run');
    assert.match(await ui(`d => d.getElementById('output').textContent`),/No books found/);
    assert.match((await visible()).status,/not an assessment/);
    assert.equal((await visible()).messages,'','reading projects do not share chat');
    await shot('05-shelf-reading'); results.push({step:'shelf-reading-output-and-isolation',pass:true});
    const shelfRoot = join(dirname(root), 'shelf-capstone');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach', shelfRoot);
    await until(visible, value => value?.title === 'Shelf Capstone · fix a repository bug', 'Shelf capstone panel');
    assert.equal((await visible()).messages, '', 'capstone has its own conversation');
    assert.equal(await ui(`d => d.getElementById('step').options.length`), 7);
    await click('check');
    await until(visible, value => value?.check === 'Current files · passed', 'capstone baseline tests in container');
    const custom = join(shelfRoot, 'tests/test_regression.py');
    writeFileSync(custom, 'import unittest\nfrom shelf.models import Book\nfrom shelf.search import search\n\nclass RegressionTest(unittest.TestCase):\n    def test_user_report(self):\n        self.assertEqual(len(search([Book("Dune", "Frank Herbert", 1965)], "dune")), 1)\n');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(custom), {preview: false});
    await until(visible, value => value?.check.startsWith('Earlier files'), 'custom test invalidates evidence');
    await ui(`d => {const step=d.getElementById('step'); step.value='2'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible, value => value?.step === '2' && value.goal.includes('Capture the reported behavior'), 'capstone regression milestone');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'real regression test fails on buggy code');
    await ask('Why does my regression test fail, and how can Git help investigate?');
    await until(async () => requests.at(-1)?.project_context.project_id, value => value === 'shelf', 'capstone Coach request');
    const shelfContext = requests.at(-1).project_context;
    assert.equal(shelfContext.selected_file, 'tests/test_regression.py');
    assert.equal(shelfContext.check.status, 'failed');
    assert.equal(shelfContext.git.branch, 'main');
    assert.match(shelfContext.git.head, /^[a-f0-9]{40}$/);
    assert.ok(shelfContext.files.some((file: any) => file.path === 'shelf/search.py'));
    assert.deepEqual(requests.at(-1).history, []);
    await until(visible, value => !value?.askDisabled, 'capstone reply complete');
    execFileSync('git', ['switch', '-c', 'fix-search-case'], {cwd: shelfRoot});
    await ask('Which branch am I on now?');
    await until(async () => requests.at(-1)?.project_context.git?.branch, value => value === 'fix-search-case', 'fresh Git context');
    // A branch switch changes no files: this milestone's test result stays current. Only the capstone checker tracks Git state.
    assert.equal(requests.at(-1).project_context.check.state, 'current');
    await until(visible, value => !value?.askDisabled, 'Git reply complete');
    await ui(`d => {const step=d.getElementById('step'); step.value='6'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible, value => value?.step === '6' && value.goal.includes('Explain the cause'), 'capstone review milestone');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'capstone checker runs in container');
    assert.match(await ui(`d => d.getElementById('output').textContent`), /checks passed/);
    assert.equal((await visible()).handoffHidden, true, 'capstone does not use the agent teacher-handoff endpoint');
    await shot('06-shelf-capstone'); results.push({step:'shelf-capstone-context-git-regression-and-checker', pass:true});
  } catch (error) {
    results.push({step:'failure', error:String(error), visible:await visible(), output:await ui(`d => d.getElementById('output').textContent`)}); await shot('failure'); throw error;
  } finally {
    Api.prototype.notebookCoach = original;
    Api.prototype.projectHandoffAvailability = originalAvailability; Api.prototype.sendProjectHandoff = originalSend;
    Api.prototype.projectHandoffDetail = originalDetail;
    (vscode.window as any).showInformationMessage = originalInfo; (vscode.window as any).showSaveDialog = originalSave;
    CourseWorkspaces.prototype.forFile = originalEngine;
    CourseWorkspaces.prototype.recordFor = originalRecord;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({results, artifactDirectory:out},null,2));
    cdp.close();
  }
}
