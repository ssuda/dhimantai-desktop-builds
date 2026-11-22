/** Real right-panel checks, using controlled Coach replies; no live provider or deployment claims. */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { CODE_READING_PROJECTS_ENABLED } from '../../src/desktopFeatures';
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
  const originalEngine = CourseWorkspaces.prototype.forProject, originalRecord = CourseWorkspaces.prototype.recordFor;
  const courseEngine = new CourseEngine(process.env.DHIMANTAI_PROJECT_PODMAN!,process.env.DHIMANTAI_PROJECT_CONTAINER!,dirname(root));
  CourseWorkspaces.prototype.forProject = async () => courseEngine;
  const session = await auth.signInWithPassword(EMAIL, PASSWORD);
  CourseWorkspaces.prototype.recordFor = () => ({root,course:'Build AI Agents with Python',key:'project-test',account:session.user.id,
    environment:vscode.workspace.getConfiguration('dhimantai').get('environment', 'production')});
  const cdp = await connect(), original = Api.prototype.notebookCoach;
  const originalDictate = Api.prototype.dictate, originalGrant = Api.prototype.audioGrant;
  const originalAvailability = Api.prototype.projectHandoffAvailability, originalSend = Api.prototype.sendProjectHandoff,
    originalDetail = Api.prototype.projectHandoffDetail, originalInfo = vscode.window.showInformationMessage, originalSave = vscode.window.showSaveDialog;
  const ui = (expression: string) => cdp.webview(`d => { if (!d.getElementById('checkpoint') || d.defaultView.frameElement?.id !== 'active-frame') return null; return (${expression})(d); }`);
  const visible = () => ui(`d => ({title:d.getElementById('title').textContent, step:d.getElementById('step').value,
    goal:d.getElementById('goal').textContent, check:d.getElementById('checkState').textContent, status:d.getElementById('status').textContent,
    messages:d.getElementById('conversation').textContent, saved:d.getElementById('saved').textContent,
    voiceStatus:d.getElementById('dictation-status')?.textContent, draft:d.getElementById('message').value,
    note:d.getElementById('note').value, composerDisabled:d.getElementById('attach-images').disabled, checkDisabled:d.getElementById('check').disabled,
    progress:d.getElementById('progressText').textContent, guide:d.getElementById('guide').textContent,
    review:d.getElementById('reviewList').hidden ? '' : d.getElementById('reviewTitle').textContent, milestoneStatus:d.getElementById('milestoneStatus').textContent,
    completed:d.getElementById('saveDraft').textContent === 'Mark in progress', hint:d.getElementById('hint').textContent,
    handoff:d.getElementById('handoffStatus').textContent, finishDisabled:d.getElementById('finish').disabled,
    refreshDisabled:d.getElementById('refreshHandoff').disabled, handoffHidden:d.getElementById('handoff').hidden})`);
  const click = (id: string) => until(async () => ui(`d => {const button=d.getElementById('${id}');
    if (button.disabled) return false; button.scrollIntoView({block:'center'}); button.click(); return true;}`), Boolean, id + ' enabled');
  const ask = (text: string) => ui(`d => {const field=d.getElementById('message'); field.value=${JSON.stringify(text)}; field.dispatchEvent(new Event('input', {bubbles:true})); d.getElementById('composer').requestSubmit(); return true;}`);
  const shot = async (name: string) => { await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise(resolve => setTimeout(resolve, 200));
    const image = await cdp.send('Page.captureScreenshot', {format:'png'}); writeFileSync(join(out,name+'.png'), Buffer.from(image.data,'base64')); };
  try {
    await vscode.commands.executeCommand('dhimantai.openLearningRoom');
    await until(() => cdp.webview(`async d => {
      const picker = d.getElementById('coaching-language');
      if (!picker || !picker.onchange) return null;
      const saved = new Promise(resolve => {
        const ack = e => {
          if (e.data?.type === 'coachingLanguage' && e.data.language === 'te-IN') {
            d.defaultView.removeEventListener('message', ack); resolve(true);
          }
        };
        d.defaultView.addEventListener('message', ack);
        d.defaultView.setTimeout(() => { d.defaultView.removeEventListener('message', ack); resolve(false); }, 1000);
      });
      picker.value = 'te-IN'; picker.dispatchEvent(new d.defaultView.Event('change')); return saved;
    }`), Boolean, 'Telugu coaching preference saved');
    Api.prototype.notebookCoach = async (path, body: any) => {
      if (body.project_context.observation) return {guidance:'', prompt:'', line:null};
      assert.equal(path, '/notebook-coach/project?course=Build%20AI%20Agents%20with%20Python'); requests.push(body);
      return {guidance: body.project_context.project_id === 'rich-reading'
        ? 'You are in **Console.print**. Follow `_collect_renderables` to see how the inputs become renderables, then find `render_str` for the string path.'
        : 'Trace the **tool observation** from tools.py into the next model request.\n\n' +
          Array.from({length: 10}, (_, i) => `Observation ${i + 1}: Follow the returned data into the next request. Explain what changed before choosing the next action.`).join('\n\n'), prompt: '', line: body.project_context.files[0].start_line};
    };
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    // Activation also restores Coach asynchronously. Wait for its initial render/account refresh to settle.
    let previous = '', stable = 0;
    await until(visible, value => {
      const current = JSON.stringify(value);
      stable = value?.title === 'Course Research Agent' && !value.checkDisabled && current === previous ? stable + 1 : 0;
      previous = current; return stable >= 5;
    }, 'project right panel ready');
    const firstTask = await ui(`d => ({file:d.querySelector('#task button')?.textContent,
      visible:d.getElementById('task').checkVisibility(), checkpoint:d.getElementById('checkpointDetails').open,
      brief:d.getElementById('fullTask').open})`);
    assert.deepEqual(firstTask, {file:'README.md',visible:true,checkpoint:false,brief:false});
    await ui(`d => { const link = [...d.querySelectorAll('#task button')].find(b => b.textContent === 'data/documents.json'); link.click(); return true; }`);
    await until(async () => vscode.window.activeTextEditor?.document.fileName, name => name?.endsWith('data/documents.json'), 'task link opens the fixture');
    await shot('00-project-instructor');
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
      await click('checkLocation');
      await until(async () => vscode.window.activeTextEditor, editor => editor &&
        failure.location === 'course_agent/' + file + ':' + (editor.selection.active.line + 1) &&
        editor.document.fileName.endsWith('/course_agent/' + file), 'failure opens at its reported line');
      await shot('qa-milestone-' + (index + 1));
      results.push({step:'qa-milestone-' + (index + 1) + '-failure-summary', pass:true});
    }
    await ui(`d => {const step=d.getElementById('step'); step.value='1'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible, value => value?.step === '1' && value.goal.includes('deterministic search'), 'search milestone');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'unfinished starter fails honestly');
    const searchFile = vscode.Uri.file(join(root, 'course_agent/search.py'));
    const searchEditor = await vscode.window.showTextDocument(searchFile);
    searchEditor.selection = new vscode.Selection(4, 0, 6, 0);
    await vscode.commands.executeCommand('dhimantai.discussProjectSelection');
    await until(() => ui(`d => ({selected:d.getElementById('selectionContext').textContent, focus:d.activeElement.id})`),
      v => v?.selected.includes('course_agent/search.py:5–6') && v.focus === 'message', 'discuss selected lines in the existing composer');
    await ask('Help me understand how these files connect.');
    await until(visible, value => value?.messages.includes('tool observation') && !value.composerDisabled, 'first Coach reply');
    assert.equal(requests[0].coaching_language, 'te-IN');
    assert.equal(requests[0].source, [searchEditor.document.lineAt(4).text, searchEditor.document.lineAt(5).text].join('\n'));
    assert.match(requests[0].question, /Selected lines: course_agent\/search.py:5–6/);
    const beforeDiscussion = searchEditor.document.getText();
    await ui(`d => { d.querySelector('.instructor-sources button').click(); return true; }`);
    await until(async () => vscode.window.activeTextEditor, e => e?.document.uri.fsPath === searchFile.fsPath &&
      e.selection.isEmpty && e.selection.active.line === 4, 'Instructor citation opens the discussed line');
    assert.equal(searchEditor.document.getText(), beforeDiscussion, 'discussing and following references does not edit the source');
    assert.ok(requests[0].project_context.files.length > 1);
    assert.ok(requests[0].project_context.files.some((file: any) => file.path === 'README.md'));
    assert.ok(requests[0].project_context.structure.files.includes('data/documents.json'));
    assert.equal(requests[0].project_context.check.status, 'failed');
    // Exercise the real Chromium recorder and PCM conversion without opening a hardware microphone.
    const question = 'What should I inspect next?';
    Api.prototype.dictate = async (pcm, language) => {
      assert.equal(language, undefined, 'Project Coach requests spoken-language detection');
      const bytes = Buffer.from(pcm, 'base64');
      assert.ok(bytes.length > 0 && bytes.length <= 960000 && bytes.some(byte => byte !== 0));
      return {text: question};
    };
    const speech: string[] = [];
    Api.prototype.audioGrant = async (path, text, query) => {
      assert.equal(path, '/notebook-coach/project');
      assert.equal(new URLSearchParams(query).get('course'), 'Build AI Agents with Python');
      assert.equal(new URLSearchParams(query).get('language'), 'te-IN');
      speech.push(text);
      throw new Error('Test playback service unavailable');
    };
    await ui(`d => {
      const w = d.defaultView;
      w.navigator.mediaDevices.getUserMedia = async () => {
        const track = new w.MediaStreamTrackGenerator({kind:'audio'}), writer = track.writable.getWriter();
        w.testMicTrack = track;
        const samples = Float32Array.from({length:1600}, (_, i) => 0.2 * Math.sin(2 * Math.PI * i / 32));
        let timestamp = 0;
        w.feedTestMic = async () => {
          const frame = new w.AudioData({data:samples, format:'f32', sampleRate:16000, numberOfFrames:samples.length, numberOfChannels:1, timestamp});
          timestamp += 100000;
          try { await writer.write(frame); } finally { frame.close(); }
          return true;
        };
        return new w.MediaStream([track]);
      };
      return true;
    }`);
    await click('audio-microphone');
    await until(() => ui(`d => d.getElementById('audio-microphone').getAttribute('aria-pressed')`), v => v === 'true', 'microphone recording');
    // Background Electron windows throttle DOM timers. Drive the synthetic input from the extension host clock.
    for (let i = 0; i < 12; i++) {
      await ui(`d => d.defaultView.feedTestMic()`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await click('audio-microphone');
    await until(() => ui(`d => d.getElementById('message').value`), v => v === question, 'editable voice transcript');
    assert.equal(await ui(`d => d.defaultView.testMicTrack.readyState`), 'ended');
    assert.equal(requests.length, 1, 'dictation waits for Send');
    await click('ask');
    await until(async () => requests.length, value => value === 2, 'follow-up');
    assert.equal(requests[1].history.length, 2);
    assert.equal(requests[1].message, question);
    assert.equal(requests[1].project_context.milestone, requests[0].project_context.milestone);
    await until(async () => speech.length, v => v === 1, 'automatic spoken reply');
    assert.ok(speech[0].includes('tool observation') && (await visible()).messages.includes('tool observation'),
      'the spoken answer stays in the conversation after a playback failure');
    results.push({step:'dictated-follow-up-with-project-history-and-speech', pass:true});
    await until(visible, value => !value?.composerDisabled, 'follow-up finished');
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
    await ui(`d => {d.getElementById('note').value='Next: trace tied search scores.'; d.getElementById('externalHelp').value='reported'; return true;}`);
    await click('checkpoint');
    await until(visible, value => value?.saved.includes('2 Instructor help turns'), 'checkpoint assistance count');
    await vscode.commands.executeCommand('dhimantai.hideCoach');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach');
    await until(visible, value => value?.step === '1' && value.note === 'Next: trace tied search scores.', 'resume checkpoint');
    assert.ok((await visible()).messages.includes(question), 'the milestone conversation survives reopening');
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
    await until(visible, value => value?.review.includes('Review changes') && value.completed, 'changed evidence needs review');
    assert.match((await visible()).progress, /1\/10 marked complete/);
    await vscode.workspace.getConfiguration('dhimantai').update('aiAssistance', false, vscode.ConfigurationTarget.Global);
    await until(visible, value => value?.composerDisabled, 'AI off');
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
    Api.prototype.notebookCoach = async (_path, body: any) => {
      if (body.project_context.observation) return {guidance:'', prompt:'', line:null};
      requests.push(body); return new Promise(resolve => { delayed = resolve; });
    };
    await until(visible, value => !value?.composerDisabled, 'AI on');
    await ask('This response should be cancelled by New chat.');
    await until(async () => !!delayed, Boolean, 'pending Coach request');
    await click('newChat');
    await until(visible, value => value?.messages === '' && !value.composerDisabled, 'New chat clears while a request is pending');
    delayed!({guidance: 'Obsolete reply must not return', prompt: '', line: null});
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await visible()).messages, '');
    Api.prototype.notebookCoach = async (_path, body: any) => {
      if (body.project_context.observation) return {guidance:'', prompt:'', line:null};
      requests.push(body); return {guidance: 'Fresh conversation', prompt: '', line: null};
    };
    await ask('Start from this question.');
    await until(visible, value => value?.messages.includes('Fresh conversation') && !value.composerDisabled, 'fresh Coach reply');
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
    Api.prototype.notebookCoach = async (path, body: any) => {
      if (body.project_context.observation) return {guidance:'', prompt:'', line:null};
      assert.equal(path, '/notebook-coach/project?course=Build%20AI%20Agents%20with%20Python');
      requests.push(body);
      return {guidance: body.project_context.project_id === 'shelf-reading'
        ? 'Compare the query with the title in books.json.' : 'Follow Console.print and the supplied method.', prompt: '', line: null};
    };
    if (CODE_READING_PROJECTS_ENABLED) {
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
      await until(visible,value=>!value?.composerDisabled,'Rich reply complete');
      await click('check');
      await until(visible,value=>value?.check==='Current files · passed','Rich plain text run');
      await shot('04-rich-navigation'); results.push({step:'rich-container-navigation-and-line-context',pass:true});
      await ask('Explain rich/_loop.py and its tests.');
      await until(async()=>requests.at(-1)?.project_context.selected_file,value=>value==='rich/_loop.py','question selects a non-curated source file');
      await until(visible,value=>!value?.composerDisabled,'retrieved source reply complete');
      const retrieved = requests.at(-1).project_context;
      assert.ok(retrieved.files.some((file: any) => file.path === 'README.md'));
      assert.ok(retrieved.structure.files.includes('rich/_loop.py'));
      assert.ok(retrieved.structure.truncated && retrieved.omitted_count > retrieved.omitted.length);
      writeFileSync(join(out, 'context-request.json'), JSON.stringify(requests.at(-1)));
      results.push({step:'question-retrieval-and-public-project-map',pass:true});
      await vscode.commands.executeCommand('dhimantai.openProjectCoach',join(dirname(root),'shelf-reading'));
      await until(visible,value=>value?.title==='Read a codebase · shelf','shelf reading panel');
      assert.match((await visible()).progress, /0\/7 marked complete/);
      assert.ok(vscode.window.activeTextEditor?.document.fileName.endsWith('READING_NOTES.md'), 'the map opens beside its editable notes');
      const speechBefore = speech.length;
      await click('audio-toggle');
      await until(async () => speech.at(-1), text => text?.includes('Repository map and question'), 'speaker requests the current milestone guidance');
      assert.equal(speech.length, speechBefore + 1);
      await shot('05-shelf-map');
      const mapTask = await ui(`d => [...d.querySelectorAll('#task li')].map(item => item.textContent).join(' ')`);
      assert.match(mapTask, /READING_NOTES\.md.*Repository map and question/);
      assert.match(mapTask, /python -m shelf --help/);
      assert.doesNotMatch(mapTask, /python -m shelf list|book lines/i);
      await ui(`d => { [...d.querySelectorAll('#task button')].find(b => b.textContent === 'READING_NOTES.md').click(); return true; }`);
      await until(async () => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.fileName.endsWith('READING_NOTES.md') && editor.document.lineAt(editor.selection.active.line).text;
      }, text => typeof text === 'string' && text.includes('Repository map and question'), 'map notes open at the linked heading');
      const notes = vscode.window.activeTextEditor!;
      assert.match(notes.document.lineAt(notes.selection.active.line).text, /Repository map and question/);
      const mapEdit = new vscode.WorkspaceEdit();
      mapEdit.insert(notes.document.uri, notes.document.lineAt(notes.selection.active.line).range.end,
        '\n- shelf/ — Python package\n- tests/ — checks for expected behaviour\n- books.json — sample input\n');
      assert.ok(await vscode.workspace.applyEdit(mapEdit)); await notes.document.save();
      await until(visible, value => value?.guide.includes('python -m shelf --help'), 'saved map leads to command');
      await click('check');
      await until(visible, value => value?.check === 'Current files · passed' && value.guide.includes('Checkpoint'), 'shelf help ran');
      assert.match(await ui(`d => d.getElementById('output').textContent`), /usage: shelf/);
      assert.ok(await ui(`d => d.getElementById('checkDetails').open`));
      await click('checkpoint');
      assert.equal(await ui(`d => d.activeElement.id === 'note' && d.activeElement.getAttribute('aria-invalid') === 'true'`), true);
      assert.match((await visible()).progress, /0\/7 marked complete/);
      await shot('05-shelf-evidence');
      await ui(`d => { const note = d.getElementById('note'); note.value = 'The search command finds books by query.';
        note.dispatchEvent(new Event('input')); return true; }`);
      await click('checkpoint');
      await until(visible, value => value?.progress.includes('1/7 marked complete') && value.saved.includes('Milestone marked complete'), 'shelf map checkpoint saved');
      await click('next');
      await until(visible, value => value?.step === '1' && !value.completed && value.note === '', 'next shelf milestone');
      assert.match(await ui(`d => d.getElementById('task').textContent`), /python -m shelf list/);
      assert.match((await visible()).guide, /Open shelf\/__main__\.py/);
      const traceHeading = notes.document.getText().split(/\r?\n/).findIndex(line => line.startsWith('## Call and data trace'));
      const traceEdit = new vscode.WorkspaceEdit();
      traceEdit.insert(notes.document.uri, notes.document.lineAt(traceHeading).range.end,
        '\n- shelf/__main__.py calls main in shelf/cli.py. The list branch prints books from load in shelf/storage.py.\n');
      assert.ok(await vscode.workspace.applyEdit(traceEdit)); await notes.document.save();
      await until(visible, value => value?.guide.includes('python -m shelf list') && value.progress === '1/7 marked complete' && !value.review,
        'saved entry trace preserves map completion and prompts list command');
      await click('check');
      await until(visible, value => value?.guide.includes('Which function loaded the books?'), 'successful list run prompts for observed evidence');
      assert.match(await ui(`d => d.getElementById('output').textContent`), /Dune \(1965\) by Frank Herbert/);
      await ui(`d => { d.getElementById('note').value = 'load from shelf/storage.py. Dune (1965) by Frank Herbert.'; return true; }`);
      await click('checkpoint');
      await until(visible, value => value?.progress === '2/7 marked complete' && !value.review && value.guide.includes('3. Follow the data'),
        'entry completion immediately increments progress and names the next milestone');
      await click('checkpoint');
      await until(visible, value => value?.progress === '2/7 marked complete' && value.completed, 'resave leaves both milestones complete');
      await ui(`d => {d.getElementById('projectContent').scrollTop = 0; return true;}`);
      await shot('05-shelf-two-complete');
      const revised = new vscode.WorkspaceEdit();
      const mapLine = notes.document.getText().split(/\r?\n/).findIndex(line => line.includes('shelf/ — Python package'));
      revised.insert(notes.document.uri, notes.document.lineAt(mapLine).range.end, ' with the CLI');
      assert.ok(await vscode.workspace.applyEdit(revised)); await notes.document.save();
      await until(visible, value => value?.progress === '2/7 marked complete' && value.review.includes('1. Map the repository'),
        'a genuine map edit names the affected milestone and keeps both completions');
      await ui(`d => { d.getElementById('reviewList').open = true; d.querySelector('#reviewSteps button').click(); return true; }`);
      await until(visible, value => value?.step === '0' && value.completed && value.note.includes('search command'), 'review opens the saved map checkpoint');
      await click('checkpoint');
      await until(visible, value => value?.progress === '2/7 marked complete' && !value.review, 'confirming evidence clears its review');
      results.push({step:'shelf-map-and-entry-progress-guidance-speech-and-review',pass:true});
      await ui(`d => {const step=d.getElementById('step'); step.value='3'; step.dispatchEvent(new Event('change')); return true;}`);
      await until(visible,value=>value?.step==='3' && value.goal.includes('prediction'),'shelf search step');
      assert.equal(await ui(`d => d.getElementById('projectContent').scrollTop`),0,'new steps start at their goal');
      await click('check');
      await until(visible,value=>value?.check==='Current files · passed','shelf reading run');
      assert.match(await ui(`d => d.getElementById('output').textContent`),/No books found/);
      assert.match((await visible()).status,/not an assessment/);
      assert.equal((await visible()).messages,'','reading projects do not share chat');
      await ask('Why does search dune return No books found?');
      await until(async () => requests.at(-1)?.project_context.project_id, value => value === 'shelf-reading', 'shelf search question reaches Coach');
      assert.match(requests.at(-1).project_context.check.output, /No books found/);
      await until(visible, value => value?.messages.includes('Compare the query') && !value.composerDisabled, 'shelf Coach reply');
      await shot('05-shelf-reading'); results.push({step:'shelf-reading-output-and-isolation',pass:true});
    }
    const shelfRoot = join(dirname(root), 'shelf-capstone');
    await vscode.commands.executeCommand('dhimantai.openProjectCoach', shelfRoot);
    await until(visible, value => value?.title === 'Shelf Capstone · fix a repository bug', 'Shelf capstone panel');
    if (vscode.env.appName === 'dhimantAI') {
      const layout = () => cdp.evaluate(`({
        files: !!document.querySelector('.explorer-folders-view')?.checkVisibility(),
        learn: !!document.querySelector('.pane-header[aria-label*="Learn"]')?.checkVisibility(),
        coach: !!document.querySelector('.part.auxiliarybar')?.checkVisibility()
      })`);
      const readme = vscode.window.activeTextEditor!.document;
      await until(layout, s => s.files && s.coach, 'project files and Coach');
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      await until(layout, s => s.learn && !s.files && !s.coach, 'catalog with only learning navigation');
      await vscode.window.showTextDocument(readme);
      await until(layout, s => s.files && s.coach, 'restored project panels');
      await vscode.commands.executeCommand('workbench.action.navigateBack');
      await until(layout, s => s.learn && !s.files && !s.coach, 'catalog reached through Back');
      await vscode.commands.executeCommand('workbench.action.navigateForward');
      await until(layout, s => s.files && s.coach, 'project reached through Forward');
      await until(visible, value => value?.title === 'Shelf Capstone · fix a repository bug', 'returned Shelf Coach');
      results.push({step:'shelf-catalog-back-and-forward', pass:true});
    }
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
    await until(visible, value => !value?.composerDisabled, 'capstone reply complete');
    execFileSync('git', ['switch', '-c', 'fix-search-case'], {cwd: shelfRoot});
    await ask('Which branch am I on now?');
    await until(async () => requests.at(-1)?.project_context.git?.branch, value => value === 'fix-search-case', 'fresh Git context');
    // A branch switch changes no files: this milestone's test result stays current. Only the capstone checker tracks Git state.
    assert.equal(requests.at(-1).project_context.check.state, 'current');
    await until(visible, value => !value?.composerDisabled, 'Git reply complete');
    await ui(`d => {const step=d.getElementById('step'); step.value='6'; step.dispatchEvent(new Event('change')); return true;}`);
    await until(visible, value => value?.step === '6' && value.goal.includes('Explain the cause'), 'capstone review milestone');
    await click('check');
    await until(visible, value => value?.check === 'Current files · failed', 'capstone checker runs in container');
    assert.match(await ui(`d => d.getElementById('output').textContent`), /checks passed/);
    assert.equal((await visible()).handoffHidden, true, 'capstone does not use the agent teacher-handoff endpoint');
    await shot('06-shelf-capstone'); results.push({step:'shelf-capstone-context-git-regression-and-checker', pass:true});
    const automatic: any[] = [];
    Api.prototype.notebookCoach = async (_path, body: any) => {
      automatic.push(body);
      if (body.project_context.observation === 'git')
        return {guidance:'Your regression test is staged. What behavior will the next commit document?',prompt:'',line:null};
      if (body.project_context.observation === 'check')
        return {guidance:'Compare the current checker output with the behavior the issue describes.',prompt:'',line:null};
      return {guidance:'Look at the boundary case in tests/test_regression.py:6. Which input would test the opposite outcome?', prompt:'', line:6};
    };
    const regression = await vscode.window.showTextDocument(vscode.Uri.file(custom));
    const regressionEdit = new vscode.WorkspaceEdit();
    regressionEdit.insert(regression.document.uri, regression.document.lineAt(regression.document.lineCount - 1).range.end, '\n# Compare one boundary case.\n');
    await ui(`d => { d.getElementById('message').value='My draft question'; return true; }`);
    assert.ok(await vscode.workspace.applyEdit(regressionEdit));
    assert.ok(await regression.document.save());
    const savedSource = regression.document.getText();
    await until(visible, v => v?.messages.includes('Which input would test the opposite outcome?'), 'unsolicited review after a student saves');
    assert.equal(automatic[0].project_context.observation, 'saved');
    assert.equal(automatic[0].project_context.selected_file, 'tests/test_regression.py');
    assert.equal(automatic[0].message, '');
    assert.ok(automatic[0].project_context.observation_line > 0);
    assert.ok(await ui(`d => {const rect=d.querySelector('#conversation article:last-child').getBoundingClientRect(), pane=d.getElementById('projectContent').getBoundingClientRect(); return rect.top < pane.bottom && rect.bottom > pane.top;}`), 'the new observation is visible beside the editor');
    assert.equal((await visible()).draft, 'My draft question');
    assert.equal(regression.document.getText(), savedSource);
    await shot('07-instructor-on-save'); results.push({step:'instructor-guides-after-save-without-a-question', pass:true});
    execFileSync('git', ['add', '--', 'tests/test_regression.py'], {cwd:shelfRoot});
    await until(visible, v => v?.messages.includes('Your regression test is staged.'), 'unsolicited guidance after staging a change');
    assert.ok(automatic.at(-1).project_context.git.changed_files.some((f:any) => f.path === 'tests/test_regression.py' && f.status === 'A '));
    await click('check');
    await until(visible, v => v?.messages.includes('Compare the current checker output'), 'unsolicited guidance after a check');
    assert.equal(automatic.at(-1).project_context.check.status, 'failed');
    results.push({step:'instructor-guides-after-index-and-check-changes',pass:true});
  } catch (error) {
    results.push({step:'failure', error:String(error), visible:await visible(), output:await ui(`d => d.getElementById('output').textContent`)}); await shot('failure'); throw error;
  } finally {
    Api.prototype.notebookCoach = original;
    Api.prototype.dictate = originalDictate; Api.prototype.audioGrant = originalGrant;
    Api.prototype.projectHandoffAvailability = originalAvailability; Api.prototype.sendProjectHandoff = originalSend;
    Api.prototype.projectHandoffDetail = originalDetail;
    (vscode.window as any).showInformationMessage = originalInfo; (vscode.window as any).showSaveDialog = originalSave;
    CourseWorkspaces.prototype.forProject = originalEngine;
    CourseWorkspaces.prototype.recordFor = originalRecord;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({results, artifactDirectory:out},null,2));
    cdp.close();
  }
}
