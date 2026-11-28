import { test } from 'node:test';
import {deliveryBillSamples} from '../src/deliveryBillPractice';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM, type DOMWindow } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { cellLanguages, codeLanguages, RoomCodeSession } from '../src/roomCode';
import { TutorPython } from '../src/tutorPython';
import { emptyNotebook, exportNotebook, importNotebook } from '../src/tutorNotebook';
import { NotebookCells } from '../src/notebookCells';
import { resourceLimitError } from '../src/podman';
import { practiceDocument, PracticeNotebook } from '../src/practiceNotebook';
import { engineeringSkills } from '../src/skillPractice';
import { notebookMessageBar } from '../src/learningComposer';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

function surface(livekit: unknown = {RoomEvent:{}}, composer = notebookMessageBar('Instructor', true, '<button type="button" id="sound"></button>'), practice = false, setup?: (window:DOMWindow) => void) {
  const ids = ['tutor','doubt_solver','end','wide','latest','add-note','add-code','save-notebook','open-notebook','restart-runtime','clear-conversation'];
  const dom = new JSDOM('<!doctype html><header class="workspace-header"><div class="workspace-title"><h1>Implement `subtract_time` &lt; safely</h1></div><div class="workspace-actions"></div></header><main id="feed"></main>' + composer
    + ids.map(id => `<button id="${id}" ${id === 'end' ? 'disabled' : ''}></button>`).join('')
    + '<section class="notebook-toolbar"><div id="saved-task-actions"></div><div class="notebook-jumps"></div><div class="notebook-tools"></div></section><input id="follow-code" type="checkbox" checked><input id="stuck-hints" type="checkbox"><span id="status"></span><span id="code-observer-status"></span><span id="notebook-save-status"></span>'
    + '<select id="cell-language">' + Object.keys(cellLanguages).map(language => `<option>${language}</option>`).join('') + '</select>'
    + '<select id="course-runtime"><option value="course">Course container</option><option value="colab" data-gpu hidden disabled>Google Colab · GPU</option><option value="cloud" data-gpu hidden disabled>Cloud GPU · Jupyter</option><option value="jupyter" data-gpu hidden disabled>Your GPU · Jupyter</option><option value="ssh" data-gpu data-managed-gpu hidden disabled>SSH</option><option value="cloud-cli" data-gpu data-managed-gpu hidden disabled>Cloud Spot GPUs</option><option value="finish" data-gpu hidden disabled>Finish lab</option><option value="setup">Set up / rebuild course</option></select>',
    {runScripts:'outside-only',url:'https://webview.example',pretendToBeVisual:true});
  const w = dom.window, sent: any[] = [];
  if (practice) w.document.body.dataset.notebookMode = 'practice';
  w.document.querySelector('.workspace-title')!.insertAdjacentHTML('afterbegin', '<span id="notebook-mode">DHIMANTAI · PRACTICE NOTEBOOK</span>');
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  w.acquireVsCodeApi = () => ({postMessage:(message: unknown) => sent.push(message)});
  w.LivekitClient = livekit;
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Range.prototype.getClientRects = () => [] as any;
  w.Range.prototype.getBoundingClientRect = () => ({left:0,right:0,top:0,bottom:0,width:0,height:0}) as any;
  const post = (data: object) => w.dispatchEvent(new w.MessageEvent('message',{data,origin:w.location.origin}));
  const click = (id: string) => w.document.getElementById(id)!.click();
  setup?.(w);
  w.eval(readFileSync(resolve(__dirname,'../../media/learning-room/room.js'),'utf8'));
  const code = (element: Element) => EditorView.findFromDOM(element.querySelector<HTMLElement>('.cm-content')!)!;
  return {w,sent,post,click,code,close:async () => {
    w.dispatchEvent(new w.Event('pagehide'));
    await new Promise(r => setTimeout(r,300)); w.close();
  }};
}

test('Doubt Solver applies the mode to the same live chat and restores its draft, examples and selection', async () => {
  const calls: {method:string;payload:string}[] = [];
  const peer = {identity:'worker',isAgent:true,trackPublications:new Map()};
  class Room {
    remoteParticipants = new Map([['worker',peer]]);
    localParticipant = {registerRpcMethod(){}, performRpc:async (call:typeof calls[number]) => {calls.push(call);return 'ok';}};
    on(){} async connect(){} async disconnect(){} registerTextStreamHandler(){}
  }
  const bar = notebookMessageBar('Doubt Solver',false,'<button id="sound"></button>') +
    '<select id="doubt-mode"><option value="adaptive">Adaptive</option><option value="guided">Guided</option><option value="direct">Direct</option></select>';
  const ui = surface({Room,RoomEvent:{}},bar), tick = () => new Promise(resolve=>setTimeout(resolve,10));
  const book = {...emptyNotebook(),doubtId:'20000000-0000-0000-0000-000000000002',textDraft:'I predict four.',
    cells:[{id:'evidence',kind:'board',text:'Count matches for each id.\n\n```python\nprint(1)\n```'}]};
  try {
    ui.post({type:'openTutor',mode:'doubt_solver'});
    selectLesson(ui.w,ui.sent.at(-1).attempt);
    const attempt=ui.sent.at(-1).attempt;
    ui.post({type:'restoreNotebook',attempt,documentKey:'merge',notebook:book});
    ui.post({type:'grant',attempt,url:'unused',token:'unused'}); await tick();
    const select=ui.w.document.querySelector<HTMLSelectElement>('#doubt-mode')!;
    assert.equal(select.value,'adaptive'); assert.equal(select.disabled,false);
    select.value='direct';select.dispatchEvent(new ui.w.Event('change'));await tick();
    assert.deepEqual(JSON.parse(calls.at(-1)!.payload),{doubt_mode:'direct',doubt_id:book.doubtId});
    assert.equal(calls.filter(c=>c.method==='switch_mode').length,1);
    assert.equal(ui.w.document.querySelector<HTMLTextAreaElement>('#message')!.value,book.textDraft);
    assert.equal(ui.w.document.querySelector<HTMLDetailsElement>('[data-cell-id="evidence"] details')!.open,false);
    assert.equal(ui.sent.filter(m=>m.type==='notebookChanged').at(-1)?.notebook.doubtMode,'direct');
    select.value='guided';select.dispatchEvent(new ui.w.Event('change'));await tick();
    assert.deepEqual(JSON.parse(calls.at(-1)!.payload),{doubt_mode:'guided',doubt_id:book.doubtId});
  } finally { await ui.close(); }
});

test('Doubt Solver detects pasted C in a Java cell, switches its compiler and saves the corrected language', async () => {
  class Room {
    remoteParticipants = new Map([['worker', {identity:'worker', isAgent:true, trackPublications:new Map()}]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok'};
    on() {} async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ui = surface({Room, RoomEvent:{}}), {w, sent, post, click, code} = ui;
  const runtime = new NotebookCells(() => ({}), undefined, undefined, 15000);
  const session = new RoomCodeSession({current:async () => true, aiEnabled:() => true,
    run:s => runtime.run(s.language, s.source, s.stdin, {argv:s.argv, files:s.files, interactive:false}),
    coach:async () => { throw new Error('Run does not ask for AI feedback.'); }});
  const source = '#include <stdio.h>\n\nint main() {\n  int numbers[] = {10, 20, 30, 40, 50};\n  int sum = 0;\n  for (int i = 0; i < 5; i++) { sum += numbers[i]; }\n  printf("Sum: %d\\n", sum);\n  printf("Average: %.2f\\n", sum / 5.0);\n  return 0;\n}';
  try {
    post({type:'openTutor', mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(w, sent.at(-1).attempt); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'c-java-mismatch', notebook:emptyNotebook()});
    post({type:'grant', attempt, url:'unused', token:'unused'});
    await new Promise(resolve => setTimeout(resolve, 0));
    const picker = w.document.getElementById('cell-language') as HTMLSelectElement;
    picker.value = 'java'; click('add-code');
    const cell = w.document.querySelector<HTMLElement>('.practice-code-editor')!;
    const cellPicker = cell.querySelector<HTMLSelectElement>('[aria-label="Code cell language"]')!;
    const run = cell.querySelector<HTMLButtonElement>('[data-action="run"]')!;
    const editor = code(cell);
    editor.dispatch({changes:{from:0, insert:'class Main { public static void main(String[] args) {} }'}});
    assert.equal(run.disabled, false, w.document.getElementById('status')!.textContent!);
    run.click(); const oldRun = sent.filter(m => m.type === 'codeAction').at(-1);
    assert.equal(oldRun.language, 'java'); assert.equal(cellPicker.disabled, true);
    picker.value = 'c'; picker.dispatchEvent(new w.Event('change'));
    assert.equal(cellPicker.value, 'java', 'the toolbar only chooses the language for new cells');
    editor.dispatch({changes:{from:0, to:editor.state.doc.length, insert:source}, selection:{anchor:source.length}});
    const warning = cell.querySelector<HTMLElement>('.cell-language-mismatch')!;
    assert.equal(warning.hidden, false); assert.match(warning.textContent!, /looks like C code.*set to Java/);
    const count = sent.filter(m => m.type === 'codeAction').length;
    run.click(); assert.equal(sent.filter(m => m.type === 'codeAction').length, count, 'no Java compile request is sent');
    warning.querySelector<HTMLButtonElement>('button')!.click();
    assert.equal(warning.hidden, true); assert.equal(cellPicker.value, 'c');
    assert.equal(editor, code(cell), 'the editor and undo history are retained');
    assert.equal(editor.state.doc.toString(), source); assert.equal(editor.state.selection.main.head, source.length);
    assert.equal(cell.querySelector('.cm-content')!.getAttribute('aria-label'), 'c code');
    post({...oldRun, type:'codeResult', execution:{status:'exited',exit_code:1,stdout:'',stderr:'Main.java: stale compiler error',truncated:false}});
    assert.equal(cell.querySelector<HTMLElement>('.practice-output')!.hidden, true);
    run.click(); const request = sent.filter(m => m.type === 'codeAction').at(-1);
    assert.equal(request.language, 'c'); assert.equal(request.source, source); assert.ok(request.revision > oldRun.revision);
    await session.handle(request, post);
    assert.equal(cell.querySelector('.practice-output')!.textContent, 'Exited with code 0.\nSum: 150\nAverage: 30.00\n');
    assert.doesNotMatch(cell.querySelector('.practice-output')!.textContent!, /Main.java/);
    cellPicker.value = 'java'; cellPicker.dispatchEvent(new w.Event('change'));
    assert.equal(cell.querySelector<HTMLElement>('.practice-output')!.hidden, true, 'changing language invalidates the previous result');
    assert.equal(cell.querySelector('.cm-content')!.getAttribute('aria-label'), 'java code');
    cellPicker.value = 'c'; cellPicker.dispatchEvent(new w.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 300));
    const saved = sent.filter(m => m.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.drafts[0].language, 'c'); assert.equal(saved.drafts[0].source, source);
    const exported = JSON.parse(JSON.stringify(exportNotebook(saved)));
    assert.equal(exported.cells[0].metadata.vscode.languageId, 'c');
    post({type:'restoreNotebook', attempt, documentKey:'c-java-reopened', notebook:importNotebook(new TextEncoder().encode(JSON.stringify(exportNotebook(saved))))});
    const reopened = w.document.querySelector<HTMLElement>('.practice-code-editor')!;
    assert.equal(reopened.querySelector<HTMLSelectElement>('[aria-label="Code cell language"]')!.value, 'c');
    assert.equal(code(reopened).state.doc.toString(), source);
    assert.equal(reopened.querySelector<HTMLElement>('.practice-output')!.hidden, true);
    // Example cells are mounted from their original fence; their saved correction must win.
    post({type:'restoreNotebook', attempt, documentKey:'corrected-example', notebook:{...saved,
      cells:[{id:'example', kind:'board', text:'```java\n' + source + '\n```'}],
      drafts:[{...saved.drafts[0], key:'example:0'}]}});
    assert.equal(w.document.querySelector<HTMLSelectElement>('.practice-code-editor [aria-label="Code cell language"]')!.value, 'c');
  } finally { session.clear(); runtime.restart(); await ui.close(); }
});

test('Doubt Solver shows the selected course container for Java and C and separates preparation from execution', async () => {
  class Room {
    remoteParticipants = new Map([['worker', {identity:'worker', isAgent:true, trackPublications:new Map()}]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok'};
    on() {} async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ui=surface({Room,RoomEvent:{}}), {w,sent,post,click,code}=ui;
  try {
    post({type:'openTutor',mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(w, sent.at(-1).attempt);const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'shared',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',codeRuntime:'Course container'});
    await new Promise(resolve=>setTimeout(resolve,0));
    const picker=w.document.getElementById('cell-language') as HTMLSelectElement;
    for(const [language,source,label] of [['java','class Main { public static void main(String[] args) {} }','Java'],
      ['c','#include <stdio.h>\nint main() { puts("C"); }','C']]) {
      picker.value=language;click('add-code');
      const cell=Array.from(w.document.querySelectorAll<HTMLElement>('.practice-code-editor')).at(-1)!;
      code(cell).dispatch({changes:{from:0,insert:source}});
      assert.match(cell.querySelector(':scope > small')!.textContent!,new RegExp(label+' · Course container'));
      cell.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
      const request=sent.filter(m=>m.type==='codeAction').at(-1);
      assert.match(cell.querySelector('.practice-status')!.textContent!,/^Preparing container…/);
      post({...request,type:'codeResult',event:{kind:'phase',phase:'preparing'}});
      assert.doesNotMatch(cell.querySelector('.practice-status')!.textContent!,/Running/);
      post({...request,type:'codeResult',event:{kind:'phase',phase:'running'}});
      assert.match(cell.querySelector('.practice-status')!.textContent!,new RegExp('^Running code… '+label+' · Course container'));
      post({...request,type:'codeResult',execution:{status:'exited',exit_code:0,stdout:'ok\n',stderr:'',truncated:false}});
    }
    assert.equal(w.document.querySelector('[value="course"]')!.textContent,'Course container');
    assert.equal(w.document.querySelector('[value="terminal"]'),null);
    post({type:'runtimeRestarted',runtime:'course'});
    for(const cell of w.document.querySelectorAll('.practice-code-editor'))
      assert.match(cell.querySelector(':scope > small')!.textContent!,/Course container/);
  } finally {await ui.close();}
});

test('notebook separates setup errors, compiler failures and actual output across retries', async () => {
  const ui=surface(), {w,sent,post,click,code}=ui;
  try {
    post({type:'openPractice'});const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'runtime-failures',notebook:emptyNotebook()});
    post({type:'practiceReady',attempt,aiEnabled:true,practice:{id:'runtime-task',language:'python'},codeRuntime:'Course container'});
    click('add-code');
    const cell=w.document.querySelector<HTMLElement>('.practice-code-editor')!;
    code(cell).dispatch({changes:{from:0,insert:'print("Runtime ready")'}});
    const status=cell.querySelector<HTMLElement>('.practice-status')!;
    const output=cell.querySelector<HTMLElement>('.practice-output')!;
    const run=cell.querySelector<HTMLButtonElement>('[data-action="run"]')!;
    const reply=(result:object)=>post({...sent.filter(m=>m.type==='codeAction').at(-1),type:'codeResult',...result});
    run.click();assert.match(status.textContent!,/^Preparing container/);
    reply({error:resourceLimitError('crun: open memory.max: No such file or directory','win32')!.message,failureStage:'preparing'});
    assert.match(status.textContent!,/^Code did not run/);
    assert.equal(output.hidden,false);
    assert.match(output.textContent!,/Windows PowerShell outside the course cell and course terminal/);
    assert.match(output.textContent!,/Access is denied/);
    assert.match(output.textContent!,/predicted output are lesson content, not output from this run/);
    assert.doesNotMatch(output.textContent!,/Exited with code|Compilation failed/);
    assert.equal(run.disabled,false);
    run.click();assert.equal(output.hidden,true);assert.equal(output.textContent,'');
    reply({execution:{status:'exited',exit_code:0,stdout:'Runtime ready\n',stderr:'',truncated:false}});
    assert.match(status.textContent!,/completed successfully/);
    assert.equal(output.textContent,'Exited with code 0.\nRuntime ready\n');
    const language=cell.querySelector<HTMLSelectElement>('[aria-label="Code cell language"]')!;
    language.value='cpp';language.dispatchEvent(new w.Event('change'));
    code(cell).dispatch({changes:{from:0,to:code(cell).state.doc.length,insert:'int main() { int count = 5 }'}});
    run.click();reply({execution:{status:'compile_error',exit_code:1,stdout:'',stderr:'main.cpp: expected semicolon',truncated:false}});
    assert.match(status.textContent!,/^Compilation failed/);
    assert.match(output.textContent!,/^Compilation failed \(exit code 1\).*expected semicolon/s);
    assert.doesNotMatch(output.textContent!,/Podman|Runtime ready|PowerShell/);
    run.click();reply({execution:{status:'exited',exit_code:7,stdout:'',stderr:'program failed',truncated:false}});
    assert.match(status.textContent!,/^Run failed/);
    assert.doesNotMatch(status.textContent!,/Compilation failed|Code did not run/);
  } finally {await ui.close();}
});

test('SQL predictions remain distinct from successful, failed and retried execution results', async () => {
  const ui = surface(), {w,sent,post,click,code} = ui;
  try {
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'sql-results',notebook:emptyNotebook()});
    post({type:'practiceReady',attempt,aiEnabled:true,practice:{id:'sql-task',language:'sql'},codeRuntime:'Course'});
    (w.document.getElementById('cell-language') as HTMLSelectElement).value='sql'; click('add-code');
    const cell = w.document.querySelector<HTMLElement>('.practice-code-editor')!;
    code(cell).dispatch({changes:{from:0,insert:'SELECT dept, SUM(salary) FROM employees GROUP BY dept;'}});
    const prediction = cell.querySelector<HTMLTextAreaElement>('.practice-prediction')!;
    const output = cell.querySelector<HTMLElement>('.practice-output')!;
    const status = cell.querySelector<HTMLElement>('.practice-status')!;
    const run = cell.querySelector<HTMLButtonElement>('[data-action="run"]')!;
    prediction.value='IT | 110000';
    assert.match(cell.querySelector('.predict-row')!.textContent!, /Prediction \(not executed\)/);
    const reply = (result:object) => {
      const request = sent.filter(m=>m.type==='codeAction').at(-1);
      post({type:'codeResult',attempt,snippet:request.snippet,revision:request.revision,request:request.request,...result});
    };
    const success = {execution:{status:'exited',exit_code:0,stdout:'IT | 110000\n',stderr:'',truncated:false}};
    run.click(); reply(success);
    assert.match(output.textContent!, /^Executed SQL output/);
    run.click(); assert.equal(output.hidden,true); assert.equal(output.textContent,'');
    reply({execution:{status:'exited',exit_code:1,stdout:'',stderr:'PostgreSQL runtime could not initialize. Your SQL did not run. Restart runtime. [PG_INITDB]',truncated:false}});
    assert.match(output.textContent!, /^SQL execution failed/);
    assert.doesNotMatch(output.textContent!,/110000|Executed SQL output/);
    assert.match(status.textContent!,/prediction has not been verified/);
    assert.equal(prediction.value,'IT | 110000');
    run.click(); reply({error:'Course runtime is unavailable.'});
    assert.equal(output.hidden,true);
    assert.match(status.textContent!,/No current query result.*prediction has not been verified/);
    run.click(); reply(success);
    assert.match(status.textContent!,/Run completed successfully/);
    assert.doesNotMatch(status.textContent!,/failed|not been verified/);
    assert.match(output.textContent!,/^Executed SQL output/);
  } finally { await ui.close(); }
});

for (const media of [false, true]) test(
  'shared notebook context excludes private material and never creates a model turn by itself (media=' + media + ')', async () => {
  const rooms: Room[] = [], chats: string[] = [], observations: any[] = [];
  const agent = {identity:'worker', isAgent:true, trackPublications:new Map()};
  let fail = false;
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async (request:any) => { observations.push(request); return 'ok'; },
      sendText:async (text:string) => { if (fail) throw new Error('offline'); chats.push(text); }};
    constructor() { rooms.push(this); }
    on(name:string, listener:Function) { this.listeners.set(name, listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ui = surface({Room, RoomEvent:Object.fromEntries(['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'].map(name => [name,name]))});
  const {w, sent, post, click, code} = ui;
  const field = w.document.getElementById('message') as HTMLTextAreaElement;
  const ask = async (text:string) => { field.value = text; field.dispatchEvent(new w.Event('input')); click('send'); await new Promise(r => setTimeout(r, 0)); };
  try {
    post({type:'openTutor',mode:'tutor'}); selectLesson(w, sent.at(-1).attempt);
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'message-bar',notebook:{...emptyNotebook(),cells:[
      {id:'local-note',kind:'note',text:'My private scratch work'},
      {id:'local-code',kind:'code',text:'print(42)',packet:{language:'python'}},
    ]}});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,media,lesson:{subject:'Computing', name:'Lists'}}); await new Promise(r => setTimeout(r,0));
    assert.equal(w.document.querySelector('#feed #composer'), null, 'chat is not a notebook cell');
    assert.ok(w.document.querySelector('#message-bar #composer'));
    assert.ok(w.document.querySelector('#message-bar .composer-menu > summary[aria-label="Add attachments"] svg'));
    assert.equal((w.document.getElementById('follow-code') as HTMLInputElement).checked, true);
    field.value = 'Private unsent message'; field.dispatchEvent(new w.Event('input'));
    const editor = w.document.querySelector('.practice-code-editor')!;
    assert.equal(editor.querySelector('[placeholder="Ask about your logic, a line, or an error"]'), null, 'questions use the one message bar');
    assert.deepEqual([...editor.querySelectorAll(':scope > .practice-actions button')].map(button => button.textContent), ['Run','Review with Instructor','Explain code'],
      'a lesson cell keeps Review and Explain beside Run, outside More');
    assert.equal(editor.querySelector('.practice-prediction')!.closest('details'), null, 'the prediction stays in view');
    code(editor).dispatch({changes:{from:0,to:code(editor).state.doc.length,insert:'print(43)'}});
    await new Promise(r => setTimeout(r,800));
    const observed = () => JSON.parse(observations.filter(item => item.method === 'on_editor_activity').at(-1).payload);
    const context = observed();
    click('add-code');
    const added = [...w.document.querySelectorAll<HTMLButtonElement>('[data-remove-cell]')].at(-1)!;
    added.click(); w.document.querySelector<HTMLButtonElement>('[data-confirm-delete]')!.click();
    await new Promise(r => setTimeout(r,0));
    assert.equal(observed().source, 'print(43)', 'deleting a cell keeps sharing the selected code, not a notebook-only snapshot');
    assert.match(w.document.getElementById('code-observer-status')!.textContent!, /^Instructor can see your current snippet/);
    assert.ok(context.notebook.cells.some((cell:any) => cell.text === 'print(43)'));
    assert.doesNotMatch(JSON.stringify(context), /private scratch|Private unsent/);
    assert.equal(chats.length,0,'syncing never creates an Instructor request');
    const runCount = () => sent.filter(m => m.type === 'codeAction' && m.action === 'run').length;
    const before = runCount();
    await ask('Why does this print a number?');
    assert.equal(chats.at(-1),'Why does this print a number?');
    assert.equal(runCount(),before,'Ask Instructor never runs code');
    const previousMessages = chats.length;
    field.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true}));
    await new Promise(r => setTimeout(r,0));
    assert.equal(chats.length,previousMessages,'selected code alone cannot turn an empty draft into a request');
    fail = true; await ask('Explain this code');
    assert.equal(field.value,'Explain this code','delivery failure preserves the draft');
    fail = false; click('send'); await new Promise(r => setTimeout(r,0));
    assert.equal(chats.at(-1),'Explain this code');
    assert.doesNotMatch(chats.at(-1)!,/private scratch/);
    assert.equal(field.value,'');
    const question = '## Your turn\n\n**Section check — Start here**\n\nMeena has five neat sentences, each with a year. Two years are wrong and one fact mixes two mountain ranges — but nothing in the answer shows which parts are wrong.';
    rooms[0].listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify({method:'display_on_screen',content:question,is_question_prompt:true,tutor_checkpoint_id:'question-42'})),agent);
    assert.equal(w.document.getElementById('send-label')!.textContent,'Answer Instructor');
    const replyContext = w.document.getElementById('composer-context')!;
    const preview = 'Your turn Section check — Start here Meena has five neat sentences, each with a year. Two years are wrong and one fact mixes two mountain ranges — but nothing in the answer shows which parts are wrong.';
    assert.equal(replyContext.hidden, false);
    assert.equal(replyContext.textContent, 'Replying to: ' + preview.slice(0, 180) + '…', 'formatting is removed before the preview is shortened');
    assert.equal(replyContext.children.length, 0, 'the preview remains plain text');
    const questionCard = w.document.getElementById('feed')!.lastElementChild!;
    assert.equal(questionCard.querySelector('h2')!.textContent, 'Your turn');
    assert.equal(questionCard.querySelector('strong')!.textContent, 'Section check — Start here', 'the question card retains formatting');
    await ask('Check the facts against reliable sources.');
    assert.match(chats.at(-1)!,/^TUTOR_NOTEBOOK_ANSWER\n/);
    assert.equal(JSON.parse(chats.at(-1)!.split('\n')[1]).checkpoint_id,'question-42');
    assert.equal(w.document.getElementById('send-label')!.textContent,'Ask Instructor');
    assert.equal(replyContext.hidden, true);
    assert.equal(replyContext.textContent, '');
    assert.equal(runCount(),before);
  } finally { await ui.close(); }
});

for (const media of [false,true]) test(`Instructor accepts written predictions and distinguishes examples from edited runs (${media ? 'desktop' : 'extension'})`, async () => {
  const rooms: Room[] = [], chats: {text:string; options:any}[] = [];
  const agent = {identity:'worker', isAgent:true, trackPublications:new Map()};
  let fail = false;
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok',
      sendText:async (text:string, options:any) => { if (fail) throw new Error('offline'); chats.push({text,options}); }};
    constructor() { rooms.push(this); }
    on(name:string, listener:Function) { this.listeners.set(name, listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ui = surface({Room, RoomEvent:{DataReceived:'DataReceived'}}), {w,sent,post,click,code} = ui;
  const tick = () => new Promise(resolve => setTimeout(resolve,0));
  const board = (packet:object) => rooms[0].listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify({method:'display_on_screen',...packet})),agent);
  const field = w.document.getElementById('message') as HTMLTextAreaElement;
  const answer = async () => { field.value='My prediction'; field.dispatchEvent(new w.Event('input')); click('send'); await tick(); };
  const runtime = new NotebookCells(() => ({}), undefined, undefined, 15000);
  const requestFor = (cell:Element) => { cell.querySelector<HTMLButtonElement>('[data-action="run"]')!.click(); return sent.filter(m=>m.type==='codeAction').at(-1); };
  try {
    post({type:'openTutor',mode:'tutor'}); selectLesson(w,sent.at(-1).attempt);
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'prediction',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,media}); await tick();
    board({content:'What do these programs print?\n```python\nprint(6 * 7)\n```\n```python\nprint(7 * 7)\n```',is_question_prompt:true,tutor_checkpoint_id:'predict-1'});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,0);
    assert.equal(w.document.querySelectorAll('#feed pre > code.language-python').length,2);
    assert.equal(w.document.getElementById('send-label')!.textContent,'Answer Instructor');
    fail=true; await answer();
    assert.equal(field.value,'My prediction');
    fail=false; await answer();
    assert.match(chats.at(-1)!.text,/^TUTOR_NOTEBOOK_ANSWER\n/);
    assert.equal(JSON.parse(chats.at(-1)!.text.split('\n')[1]).checkpoint_id,'predict-1');
    assert.equal(sent.filter(m=>m.type==='codeAction').length,0);

    const prompt='State the printed line and explain why the loop stops.';
    const task={source:'Your turn',question:prompt,starter:'',language:'python',question_id:'q2',checkpoint_id:'q2'};
    board({content:prompt,is_question_prompt:true,tutor_checkpoint_id:'q2',tutor_practice_editor:task});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,0,'legacy prediction with a mistaken language');
    await answer();
    assert.equal(JSON.parse(chats.at(-1)!.text.split('\n')[1]).checkpoint_id,'q2');

    board({content:'Write a Python function.',is_question_prompt:true,tutor_checkpoint_id:'q3',tutor_answer_kind:'code',
      tutor_practice_editor:{...task,question:'Write a Python function.',question_id:'q3',checkpoint_id:'q3'}});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,1);
    assert.equal(w.document.getElementById('send-label')!.textContent,'Ask Instructor');

    const source = ['def check_order(order_id):', '    return str(order_id) == "1043"',
      'def refund_workflow(order_id):', '    return "Escalated" if check_order(order_id) else "Order not found"',
      'assert check_order(1043) and check_order("1043") and not check_order("9999")', 'print(refund_workflow("1043"))'].join('\n');
    board({content:'```python\n'+source+'\n```\nPredicted output (by inspection):\n\n```text\nEscalated\n```'});
    const example=[...w.document.querySelectorAll<HTMLElement>('.practice-code-editor')].at(-1)!;
    const reference=w.document.querySelector('.lesson-output-label')!;
    assert.match(reference.textContent!,/Instructor example.*"1043"/);
    const run=async (output:string)=>{
      const request=requestFor(example);
      const execution = await runtime.run(request.language, request.source, '', {interactive:false});
      assert.equal(execution.exit_code,0,execution.stderr); assert.equal(execution.stdout.trim(),output);
      post({...request,type:'codeResult',execution});
      return request;
    };
    const first=await run('Escalated');
    const view=code(example);
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:source.replace('print(refund_workflow("1043"))','print(refund_workflow("9999"))')}});
    await run('Order not found');
    const live=example.querySelector(':scope > .execution-result')!;
    assert.match(live.textContent!,/Live run.*#2.*"9999".*Order not found/s);
    assert.match(example.querySelector('details .execution-result')!.textContent!,/Earlier run.*#1.*"1043".*Escalated/s);
    post({...first,type:'codeResult',execution:{status:'exited',exit_code:0,stdout:'STALE',stderr:'',truncated:false}});
    assert.doesNotMatch(live.textContent!,/STALE|Escalated/);
    assert.match(reference.textContent!,/"1043"/);
    assert.doesNotMatch(reference.textContent!,/9999/);
    board({content:'Your run returned Order not found.',tutor_feedback:true,tutor_code_review_basis:'learner_reported'});
    assert.match(w.document.getElementById('feed')!.lastElementChild!.textContent!,/Feedback based on learner-reported output/);
    const draft = {key:'checkpoint:q2',snippet:'code-7',language:'python',source:'my earlier attempt',
      stdin:'',prediction:'',explanation:'My reasoning',helped:false};
    post({type:'restoreNotebook',attempt,documentKey:'legacy-quiz',notebook:{...emptyNotebook(),drafts:[draft],
      cells:[{id:'old',kind:'board',text:prompt,packet:{is_question_prompt:true,tutor_checkpoint_id:'q2',tutor_practice_editor:task}}]}});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,0);
    assert.match(w.document.getElementById('feed')!.textContent!,/Previously saved work.*my earlier attempt/s);
    click('save-notebook');
    assert.equal(sent.at(-1).notebook.drafts[0].source,draft.source);

    const concept = 'What should the loop do with an unknown tool?';
    post({type:'restoreNotebook',attempt,documentKey:'old-concept',notebook:{...emptyNotebook(),drafts:[draft],
      cells:[{id:'old',kind:'board',text:concept,packet:{is_question_prompt:true,tutor_checkpoint_id:'q2',
        tutor_answer_kind:'code',tutor_practice_editor:{...task,question:concept}}}]}});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,1);
    board({method:'notebook_resume_ready',checkpoint_id:'q2',verified:true,tutor_answer_kind:'written'});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,0);
    assert.match(w.document.getElementById('feed')!.textContent!,/Previously saved work.*my earlier attempt/s);
    assert.equal(w.document.getElementById('send-label')!.textContent,'Answer Instructor');
    await answer();
    assert.equal(JSON.parse(chats.at(-1)!.text.split('\n')[1]).checkpoint_id,'q2');
  } finally { runtime.restart(); await ui.close(); }
});

test('Doubt Solver runs new and restored Python cells through settings changes and reconnection', async () => {
  const rooms: Room[] = [];
  const agent = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok'};
    constructor() { rooms.push(this); }
    on(name: string, listener: Function) { this.listeners.set(name, listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const events = ['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'];
  const ui = surface({Room, RoomEvent:Object.fromEntries(events.map(name => [name, name]))});
  const {w,sent,post,click,code} = ui;
  const python = new TutorPython(() => ({}));
  const session = new RoomCodeSession({current:async () => true, aiEnabled:() => true,
    run:snapshot => python.run(snapshot.source, snapshot.stdin),
    coach:async () => { throw new Error('Run must not request AI feedback.'); }});
  const cells = () => [...w.document.querySelectorAll<HTMLElement>('.practice-code-editor')];
  const runButton = (cell: HTMLElement) => cell.querySelector<HTMLButtonElement>('[data-action="run"]')!;
  const run = async (cell: HTMLElement, expected: string) => {
    assert.equal(runButton(cell).disabled, false, 'a connected Doubt Solver cell can run');
    const before = sent.length;
    runButton(cell).click();
    const request = sent.slice(before).find(message => message.type === 'codeAction');
    assert.ok(request, 'clicking Run reaches the extension host');
    assert.equal(request.action, 'run');
    await session.handle(request, post);
    assert.equal(cell.querySelector('.practice-output')!.textContent, 'Exited with code 0.\n' + expected);
    assert.equal(cell.querySelector('.practice-status')!.textContent, 'Run completed successfully. Ask Doubt Solver to discuss this result.');
    return request;
  };
  const saved = {...emptyNotebook(), cells:[{id:'saved-code',kind:'code' as const,text:'print(6 * 7)',packet:{language:'python'}}]};
  try {
    post({type:'openTutor',mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(w, sent.at(-1).attempt);
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'doubt-doc',notebook:saved});
    post({type:'workstationState',label:'Ready'});
    assert.equal(runButton(cells()[0]).disabled, true, 'a ready container alone does not activate the session');
    post({type:'grant',attempt,url:'unused',token:'unused',codeRuntime:'Local language tools'});
    await new Promise(resolve => setTimeout(resolve,0));
    assert.equal(w.document.getElementById('status')!.textContent, 'Doubt Solver connected');
    await run(cells()[0], '42\n');

    // The reported failure was an example inside an agent explanation, not an added code cell.
    rooms[0].listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify({
      method:'display_on_screen', content:'## Loops\n\n```python\ncount = 1\nwhile count <= 5:\n    print(count)\n    count += 1\nprint("Done")\n```',
    })), agent);
    const example = cells().at(-1)!;
    assert.doesNotMatch(example.textContent!, /This session is inactive/);
    await run(example, '1\n2\n3\n4\n5\nDone\n');

    click('add-code');
    const fresh = cells().at(-1)!;
    code(fresh).dispatch({changes:{from:0,insert:'import math\nprint(math.factorial(int(input())))'}});
    const input = fresh.querySelector<HTMLTextAreaElement>('details textarea')!;
    input.value = '5\n'; input.dispatchEvent(new w.Event('input'));
    await run(fresh, '120\n');
    post({type:'codeSettings',aiEnabled:false});
    assert.equal(fresh.querySelector<HTMLButtonElement>('[data-action="coach"]')!.disabled, true);
    await run(fresh, '120\n');
    post({type:'codeSettings',aiEnabled:true});
    assert.equal(fresh.querySelector<HTMLButtonElement>('[data-action="coach"]')!.disabled, false);

    // Importing a saved notebook while already connected must also enable its cells.
    post({type:'restoreNotebook',attempt,documentKey:'doubt-copy',notebook:saved});
    await run(cells()[0], '42\n');
    rooms[0].listeners.get('Reconnecting')!();
    assert.equal(runButton(cells()[0]).disabled, true);
    const before = sent.length;
    runButton(cells()[0]).click();
    assert.equal(sent.length, before, 'a reconnecting session cannot send a run');
    rooms[0].listeners.get('Reconnected')!();
    await run(cells()[0], '42\n');
    python.restart();
    post({type:'runtimeRestarted'});
    const previous = await run(cells()[0], '42\n');

    rooms[0].listeners.get('Disconnected')!();
    assert.equal(runButton(cells()[0]).disabled, true);
    session.clear();
    click('tutor');
    const retry = sent.at(-1);
    assert.equal(retry.mode, 'doubt_solver');
    assert.notEqual(retry.attempt, attempt);
    post({type:'restoreNotebook',attempt:retry.attempt,documentKey:'doubt-reopened',notebook:saved});
    post({type:'grant',attempt:retry.attempt,url:'unused',token:'unused'});
    await new Promise(resolve => setTimeout(resolve,0));
    post({...previous,type:'codeResult',error:'Stale session failure'});
    assert.doesNotMatch(cells()[0].textContent!, /Stale session failure/);
    await run(cells()[0], '42\n');
    post({type:'signedOut'});
    assert.equal(cells().length, 0);
  } finally { session.clear(); python.restart(); await ui.close(); }
});

test('notebook scrolling follows new cells in page coordinates and preserves a reader above the bottom', async () => {
  const ui = surface(), {w,post,click} = ui;
  try {
    post({type:'openPractice'});
    post({type:'restoreNotebook',documentKey:'scroll-doc',notebook:emptyNotebook()});
    const page = w.document.documentElement, feed = w.document.getElementById('feed')!;
    const latest = w.document.getElementById('latest')!;
    let height = 2000, top = 300;
    Object.defineProperty(w, 'innerHeight', {value:600});
    feed.getBoundingClientRect = () => ({bottom:height-top}) as DOMRect;
    Object.defineProperties(page, {
      clientHeight:{get:() => 600}, scrollHeight:{get:() => height},
      scrollTop:{get:() => top, set:value => { top = Math.max(0, Math.min(height - 600, value)); }},
    });
    w.document.dispatchEvent(new w.Event('scroll'));
    assert.equal(latest.hidden, false, 'page scrolling updates Jump to latest');
    click('add-note');
    assert.equal(top, 300, 'a new cell does not interrupt reading an older explanation');
    (feed.lastElementChild as HTMLElement).getBoundingClientRect = () => ({top:1700-top}) as DOMRect;
    click('latest');
    assert.equal(top, 1400, 'Jump to latest scrolls the page to the draft cell');
    assert.equal(latest.hidden, true);

    const insert = feed.append.bind(feed);
    feed.append = ((row: Node | string) => {
      height += 1000;
      (row as HTMLElement).getBoundingClientRect = () => ({top:250}) as DOMRect;
      insert(row);
    }) as typeof feed.append;
    click('add-note');
    assert.equal(top, 1650, 'a long new cell opens at its page position, including the header offset');
    assert.equal(latest.hidden, false, 'the rest of the long cell remains below the viewport');
    click('add-note');
    assert.equal(top, 1650, 'later content leaves the reader at the beginning of the long cell');
    const css = readFileSync(resolve(__dirname,'../../webview/room.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
    const rules = (selector: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, s]) => selector.test(s.trim())).map(([, , body]) => body).join(';');
    assert.doesNotMatch(rules(/^#feed$/), /overflow/, 'the feed is not a second scroll area');
    assert.match(rules(/^\.notebook-toolbar$/), /position:\s*sticky/, 'adding cells and Jump to latest stay in view');
    assert.match(rules(/^\.notebook-toolbar$/), /top:\s*0/);
    assert.match(rules(/^\.notebook-toolbar$/), /background:\s*var\(--vscode-editor-background\)/);
    assert.match(rules(/^#lesson-list$/), /max-height:[^;]+;\s*overflow-y:\s*auto/, 'a long lesson list scrolls within its picker');
  } finally { await ui.close(); }
});

test('Practice keeps its exercise heading through startup visibility, restore and retry', async () => {
  const ui = surface(undefined, undefined, true), {w, sent, post} = ui;
  const title = () => w.document.querySelector('h1')!.textContent;
  const label = () => w.document.getElementById('notebook-mode')!.textContent;
  const task: PracticeNotebook = {id:'generated-123456789012345678901234', language:'python', title:'Token-ID Embedding Lookup with Padding Boundary',
    question:'Token-ID Embedding Lookup with Padding Boundary\n\nSum the embeddings.', starter:'', assistance:true, path:'/unused', account:'learner', tests:[]};
  try {
    // The host sends visibility before openPractice; this used to overwrite the server-rendered heading.
    post({type:'visibility', visible:true});
    assert.equal(title(), 'Implement subtract_time < safely');
    assert.equal(label(), 'DHIMANTAI · PRACTICE NOTEBOOK');
    post({type:'openPractice'});
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'practice-title', notebook:practiceDocument(task)});
    assert.equal(title(), task.title, 'restored exercises update the heading before the session is ready');
    post({type:'practiceReady', attempt, practice:task, aiEnabled:true});
    for (const visible of [false, true]) {
      post({type:'visibility', visible});
      assert.equal(title(), task.title);
      assert.equal(label(), 'DHIMANTAI · PRACTICE NOTEBOOK');
    }
    post({type:'failed', attempt, message:'Retry this session.'});
    ui.click('tutor');
    post({type:'restoreNotebook', attempt:sent.at(-1).attempt, documentKey:'practice-title-reopened', notebook:practiceDocument(task)});
    assert.equal(title(), task.title);
    assert.equal(label(), 'DHIMANTAI · PRACTICE NOTEBOOK');
  } finally { await ui.close(); }
});

test('headings, focus view and confirmed cell deletion preserve the remaining notebook after reopen', async () => {
  const ui = surface(), {w,sent,post,click,code} = ui;
  try {
    post({type:'openPractice'});
    post({type:'restoreNotebook',documentKey:'delete-doc',notebook:emptyNotebook()});
    assert.equal(w.document.querySelector('h1 code')!.textContent,'subtract_time');
    assert.equal(w.document.querySelector('h1')!.textContent,'Implement subtract_time < safely');
    click('wide'); assert.equal(w.document.querySelector('.workspace-actions #wide')!.textContent,'Exit focus view');
    click('wide'); assert.equal(w.document.body.classList.contains('focus-view'),false);
    click('add-code'); click('add-code'); click('add-note');
    const cells = () => [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')];
    code(cells()[0]).dispatch({changes:{from:0,insert:'deleted = 1'}});
    code(cells()[1]).dispatch({changes:{from:0,insert:'kept = 2'}});
    const more = cells()[0].querySelector<HTMLDetailsElement>('details.practice-more')!;
    assert.equal(more.open,false);
    assert.ok(more.contains(cells()[0].querySelector('[data-remove-cell]')));
    more.open = true;
    const remove = () => more.querySelector<HTMLButtonElement>('[data-remove-cell]')!.click();
    remove(); assert.equal(cells().length,3);
    assert.equal(w.document.activeElement!.textContent,'Cancel');
    w.document.activeElement!.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert.equal(w.document.querySelector('[data-confirm-delete]'),null); assert.equal(cells().length,3);
    remove(); w.document.querySelector<HTMLButtonElement>('[data-confirm-delete]')!.click();
    assert.equal(cells().length,2);
    cells()[1].querySelector<HTMLButtonElement>('[data-remove-cell]')!.click();
    w.document.querySelector<HTMLButtonElement>('[data-confirm-delete]')!.click();
    await new Promise(r => setTimeout(r,300));
    const saved = sent.filter(m => m.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.cells.length,1); assert.equal(saved.drafts.length,1); assert.equal(saved.drafts[0].source,'kept = 2');
    post({type:'restoreNotebook',documentKey:'delete-doc',notebook:saved});
    assert.equal(code(cells()[0]).state.doc.toString(),'kept = 2');
  } finally { await ui.close(); }
});

test('Python tokens are distinct and skill search keeps its selected skill without an overlapping popup', async () => {
  const ui = surface(), {w,post,click,code} = ui;
  try {
    post({type:'restoreNotebook',documentKey:'highlight-doc',notebook:emptyNotebook()}); click('add-code');
    const cell = w.document.querySelector('.practice-code-editor')!;
    code(cell).dispatch({changes:{from:0,insert:'def greet(name):\n    # Say hello\n    count = 2 + 1\n    return "Hello " + name'}});
    for (const category of ['keyword','variable','function','string','number','comment','operator']) assert.ok(cell.querySelector('.syntax-' + category),category);
    const picker = cell.querySelector<HTMLSelectElement>('[data-skill-picker]')!;
    assert.equal(picker.size,5);
    const search = cell.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = 'unit'; search.dispatchEvent(new w.Event('input'));
    assert.ok([...picker.options].some(option => option.value === 'unit_test'));
    picker.value = 'unit_test'; picker.dispatchEvent(new w.Event('change'));
    assert.match(cell.querySelector('.skill-picker summary')!.textContent!,/unit tests/i);
    search.value = 'no-such-skill'; search.dispatchEvent(new w.Event('input')); assert.equal(picker.hidden,true);
    assert.match(cell.querySelector('.skill-picker summary')!.textContent!,/unit tests/i);
    search.value = ''; search.dispatchEvent(new w.Event('input')); assert.equal(picker.value,'unit_test');
  } finally { await ui.close(); }
});

test('the notebook runtime dropdown offers setup and keeps terminal access in project mode', async () => {
  const ui = surface();
  try {
    const picker = ui.w.document.getElementById('course-runtime') as HTMLSelectElement;
    assert.equal(picker.querySelector('[value="local"]'), null);
    assert.equal(picker.value, 'course');
    assert.equal(picker.querySelector('[value="terminal"]'), null);
    picker.value = 'setup'; picker.dispatchEvent(new ui.w.Event('change'));
    assert.equal(ui.sent.at(-1).type, 'runtime'); assert.equal(ui.sent.at(-1).runtime, 'setup');
    assert.equal(picker.value, 'course');
    ui.post({type:'runtimeSelected', runtime:'course'});
    assert.equal(picker.value, 'course');
    assert.match(ui.w.document.getElementById('status')!.textContent!, /Course container ready/);
  } finally { await ui.close(); }
});

test('notebook saves student notes and cells in every supported language and restores without answer authority', async () => {
  const ui = surface(), {w,sent,post,click,code} = ui;
  try {
    post({type:'restoreNotebook',documentKey:'account-document',notebook:emptyNotebook()});
    const textCell = w.document.getElementById('message') as HTMLTextAreaElement;
    textCell.value = 'My reasoning survives reopening.';
    textCell.dispatchEvent(new w.Event('input'));
    click('add-note');
    const note = w.document.querySelector<HTMLTextAreaElement>('[aria-label="My notes"]')!;
    note.value = 'My reasoning survives reopening.'; note.dispatchEvent(new w.Event('input'));
    assert.match(note.closest('article')!.textContent!, /only you/, 'a note says it stays private');
    assert.ok(note.closest('article')!.querySelector('[data-share="note"]'), 'sharing a note is a separate button');
    click('add-note');
    const empty = Array.from(w.document.querySelectorAll<HTMLTextAreaElement>('[aria-label="My notes"]')).at(-1)!;
    assert.equal(empty.value, '', '＋ Note opens an empty note without a draft');
    assert.equal(w.document.activeElement, empty);
    for (const language of Object.keys(codeLanguages)) {
      (w.document.getElementById('cell-language') as HTMLSelectElement).value = language;
      click('add-code');
      const editor = code(Array.from(w.document.querySelectorAll('.practice-code-editor')).at(-1)!);
      editor.dispatch({changes:{from:0,insert:'student work for ' + language}});
    }
    await new Promise(r => setTimeout(r,300));
    const saved = sent.filter(message => message.type === 'notebookChanged').at(-1);
    assert.equal(saved.notebook.cells[0].text,'My reasoning survives reopening.');
    assert.equal(saved.notebook.drafts.length,Object.keys(codeLanguages).length);
    post({type:'restoreNotebook',documentKey:'account-document',notebook:saved.notebook});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,Object.keys(codeLanguages).length);
    assert.deepEqual(Array.from(w.document.querySelectorAll('.practice-code-editor')).map(element => code(element).state.doc.toString()),
      Object.keys(codeLanguages).map(language => 'student work for ' + language));
    assert.equal(sent.some(message => message.type === 'notebookTurn'),false);
    post({type:'signedOut'});
    assert.equal(w.document.querySelectorAll('article[data-cell-id]').length,0,'a different account never sees the previous notebook');
    assert.equal(textCell.value,'');
  } finally { await ui.close(); }
});

test('the message bar autosaves its multiline draft when sending is unavailable', async () => {
  const ui = surface();
  try {
    ui.post({type:'restoreNotebook',documentKey:'draft-document',notebook:emptyNotebook()});
    const field = ui.w.document.getElementById('message') as HTMLTextAreaElement;
    assert.ok(ui.w.document.getElementById('message-bar')!.contains(field));
    assert.equal(ui.w.document.getElementById('feed')!.contains(field), false);
    field.value = 'My question\nMy reasoning'; field.dispatchEvent(new ui.w.Event('input'));
    assert.equal(ui.w.document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    const enter = new ui.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
    field.dispatchEvent(enter); assert.equal(enter.defaultPrevented,true);
    await new Promise(resolve => setTimeout(resolve,300));
    const saved = ui.sent.filter(message => message.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.textDraft,field.value);
    assert.equal(ui.sent.some(message => message.type === 'notebookTurn'),false);
    ui.post({type:'restoreNotebook',documentKey:'draft-document',notebook:saved});
    assert.equal(field.value,'My question\nMy reasoning');
    assert.equal(ui.w.document.querySelectorAll('#composer').length,1);
  } finally { await ui.close(); }
});

test('Practice review without sample tests shows the service error beside intact code and can retry', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const source = 'from collections import deque\ntasks = deque(["first", "second"])\nprint(tasks.pop())';
    const task: PracticeNotebook = {id:'queue-review',language:'python',title:'Interview Questions on Queues and Deques',
      question:'Implement a FIFO task scheduler.',starter:source,assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:task.id,notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:task.language,title:task.title,tools:{tests:0,trace:true}},aiEnabled:true});
    const element = w.document.querySelector('.practice-code-editor')!;
    assert.equal(element.querySelector<HTMLButtonElement>('[data-tool=tests]')!.disabled, true);
    assert.match(element.querySelector('.sample-availability')!.textContent!, /You can still Run, Review my code/);
    element.querySelector<HTMLButtonElement>('[data-action=run]')!.click();
    const run = sent.at(-1);
    post({type:'codeResult',attempt,snippet:run.snippet,revision:run.revision,request:run.request,
      execution:{status:'exited',exit_code:0,stdout:'second\n',stderr:'',truncated:false}});
    const review = element.querySelector<HTMLButtonElement>('[data-action=submit]')!;
    review.click(); const request = sent.at(-1);
    assert.equal(request.type,'notebookTurn'); assert.equal(request.submitted,true);
    assert.equal(request.snapshot.source,source); assert.equal(request.run.output,'second\n');
    const error = 'The feedback request has unsupported fields. Update the learning service.';
    post({type:'notebookReply',attempt,request:request.request,error}); await tick();
    assert.ok(element.querySelector('.practice-status')!.textContent!.includes(error));
    assert.equal(code(element).state.doc.toString(),source);
    assert.equal(review.disabled,false);
    assert.doesNotMatch(w.document.getElementById('feed')!.textContent!,/Feedback is in your notebook/);
    review.click(); const retry = sent.at(-1);
    post({type:'notebookReply',attempt,request:retry.request,content:'pop removes the newest task. Check which end a FIFO queue removes.'}); await tick();
    assert.match(w.document.getElementById('feed')!.textContent!,/Code review/);
    assert.match(element.querySelector('.practice-status')!.textContent!,/Feedback is in your notebook/);
    assert.equal(code(element).state.doc.toString(),source);
  } finally { await ui.close(); }
});

test('Memory list questions and reviews preserve passing samples and recover from service failures', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const source = 'n = int(input())\nsteps = []\nfor i in range(n):\n    steps.append(input())\nprint(n)\nprint(" -> ".join(steps))';
    const stdin = '3\nobserve\nthink\nact\n', output = '3\nobserve -> think -> act\n';
    const task: PracticeNotebook = {id:'memory-list',language:'python',title:'Agent Memory List: Record Each Loop Step',
      question:'Read n step names. Print the count and the steps joined with ->.',starter:source,
      assistance:true,path:'/notebook-coach/tutor',account:'learner',tests:[{id:'example',kind:'stdio',stdin,expected:output}]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:task.id,notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{...task,tools:{tests:1,trace:true}},aiEnabled:true});
    const element = w.document.querySelector('.practice-code-editor')!;
    element.querySelector<HTMLButtonElement>('[data-tool=tests]')!.click(); const tests = sent.at(-1);
    post({type:'practiceToolResult',attempt,request:tests.request,tool:'tests',
      tests:[{id:'example',verdict:'passed',stdin,expected:output,actual:output,stderr:''}]}); await tick();
    assert.match(element.textContent!, /Sample tests: 1 of 1 passed/);
    assert.match(element.querySelector('.practice-tool-output')!.textContent!, /Sample tests are a quick check.*hidden tests/);
    const field = w.document.getElementById('message') as HTMLTextAreaElement;
    const submit = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit',{cancelable:true}));
    field.value = 'Okay so what is list?'; field.dispatchEvent(new w.Event('input')); submit();
    const asked = sent.filter(m => m.type === 'notebookTurn').at(-1);
    assert.equal(asked.message, field.value); assert.equal(asked.snapshot.source, source);
    const error = 'The feedback request has unsupported fields. Reopen the lesson and ask again; if it continues, update the extension.';
    post({type:'notebookReply',attempt,request:asked.request,error}); await tick();
    assert.ok(w.document.getElementById('status')!.textContent!.includes(error));
    assert.equal(field.value, 'Okay so what is list?', 'a failed request preserves the unsent question');
    assert.equal(code(element).state.doc.toString(), source);
    submit(); const retry = sent.filter(m => m.type === 'notebookTurn').at(-1);
    assert.notEqual(retry.request, asked.request);
    post({type:'notebookReply',attempt,request:retry.request,content:'A list stores several items in order. Each append adds one step.'}); await tick();
    assert.equal(field.value, '');
    assert.match(w.document.getElementById('feed')!.textContent!, /A list stores several items/);
    const review = element.querySelector<HTMLButtonElement>('[data-action=submit]')!;
    review.click(); const failedReview = sent.filter(m => m.type === 'notebookTurn').at(-1);
    assert.equal(failedReview.submitted, true);
    post({type:'notebookReply',attempt,request:failedReview.request,error:'The Coach could not reply. You can retry this step.'}); await tick();
    assert.match(element.querySelector('.practice-status')!.textContent!, /You can retry this step/);
    assert.equal(review.disabled, false);
    review.click(); const reviewed = sent.filter(m => m.type === 'notebookTurn').at(-1);
    post({type:'notebookReply',attempt,request:reviewed.request,content:'Your loop records each step. Consider what happens when the count is zero.'}); await tick();
    assert.match(w.document.getElementById('feed')!.textContent!, /Your loop records each step/);
    assert.match(element.textContent!, /Sample tests: 1 of 1 passed/);
    assert.equal(code(element).state.doc.toString(), source);
  } finally { await ui.close(); }
});

test('Practice uses the same notebook for running, Instructor conversation and explicit source review', async () => {
  const ui = surface(), {w,sent,post,click,code} = ui;
  try {
    const task: PracticeNotebook = {id:'task-1',language:'javascript',title:'Print oxygen',question:'Print oxygen.',
      starter:'',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'});
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'practice-document',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:task.language,title:task.title},aiEnabled:true,codeRuntime:'Local language tools'});
    assert.equal(w.document.getElementById('tutor')!.hidden,true,'Practice starts automatically without Connect Instructor');
    assert.equal(w.document.getElementById('end')!.hidden,true);
    const element = w.document.querySelector('.practice-code-editor')!;
    const resize = element.querySelector<HTMLButtonElement>('[aria-label="Enlarge editor"]')!;
    assert.ok(resize.querySelector('svg'), 'editor resizing uses an accessible icon');
    assert.equal(resize.textContent, '');
    resize.click(); assert.equal(resize.getAttribute('aria-label'), 'Shrink editor');
    assert.equal(element.querySelector('.practice-buffer')!.classList.contains('is-enlarged'), true);
    resize.click();
    const editor = code(element);
    editor.dispatch({changes:{from:0,insert:'console.log("oxygen")'}});
    const run = element.querySelector<HTMLButtonElement>('[data-action=run]')!;
    run.click(); const request = sent.at(-1);
    assert.equal(request.action,'run'); assert.equal(request.language,'javascript');
    assert.equal(sent.some(message => message.type === 'notebookTurn'),false,'Run never asks for assessment or help');
    post({type:'codeResult',attempt,snippet:request.snippet,revision:request.revision,request:request.request,
      execution:{status:'exited',exit_code:1,stdout:'',stderr:'Previous runtime error',truncated:false}});
    assert.match(element.querySelector('.practice-status')!.textContent!, /Run failed/);
    run.click(); const retry = sent.at(-1);
    post({type:'codeResult',attempt,snippet:retry.snippet,revision:retry.revision,request:retry.request,
      execution:{status:'exited',exit_code:0,stdout:'oxygen\n',stderr:'',truncated:false}});
    assert.match(element.textContent!, /Run completed successfully/);
    w.document.getElementById('practice-help')!.click();
    const help = sent.at(-1); assert.equal(help.type,'notebookTurn'); assert.equal(help.submitted,false);
    assert.equal(help.run.output,'oxygen\n');
    assert.equal(help.run.stderr,''); assert.equal(help.run.success,true,'the latest success supersedes the old error');
    post({type:'notebookReply',attempt,request:help.request,content:'What changes if you use a different word?'});
    await new Promise(r => setTimeout(r,0));
    assert.match(w.document.getElementById('feed')!.textContent!,/What changes if/);
    element.querySelector<HTMLButtonElement>('[data-action=submit]')!.click();
    const submitted = sent.at(-1); assert.equal(submitted.type,'notebookTurn'); assert.equal(submitted.submitted,true);
    assert.ok(submitted.history.some((turn: any) => turn.role === 'tutor' && turn.text.includes('What changes')));
    post({type:'notebookReply',attempt,request:submitted.request,content:'The submitted source prints the requested word.'});
    await new Promise(r => setTimeout(r,0));
    assert.match(w.document.getElementById('feed')!.textContent!,/Code review/);
    assert.equal(element.querySelector<HTMLButtonElement>('[data-action=submit]')!.disabled, false, 'feedback does not lock the learner into a completed submission');
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,1);
    assert.equal(w.document.getElementById('sound')!.hidden,true);
    await new Promise(r => setTimeout(r,300));
    const saved = sent.filter(message => message.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.cells.find((cell: any) => cell.packet?.submission)?.packet.submission.assisted,true);
    post({type:'restoreNotebook',documentKey:'imported-copy',notebook:saved});
    const restored = w.document.querySelector('.practice-code-editor')!;
    assert.equal(restored.querySelector<HTMLButtonElement>('[data-action=submit]')!.disabled,false,'same authenticated Practice task remains submittable after import');
    restored.querySelector<HTMLButtonElement>('[data-action=run]')!.click();
    post({type:'runtimeRestarted'});
    assert.equal(restored.querySelector<HTMLButtonElement>('[data-action=run]')!.disabled,false,'restart clears an in-flight run');
    post({type:'failed',attempt,message:'Could not initialize Practice.'});
    assert.equal(w.document.getElementById('tutor')!.hidden,false);
    assert.equal(w.document.getElementById('tutor')!.textContent,'Retry Practice');
  } finally { await ui.close(); }
});

test('Practice offers sample tests, a step-through and a new input, with no help during the new input', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  try {
    const task: PracticeNotebook = {id:'task-2',language:'python',title:'Echo upper',question:'Print the input in uppercase.',
      starter:'',assistance:true,path:'/unused',account:'learner',tests:[{id:'t1',kind:'stdio',stdin:'hi\n',expected:'HI\n'}]};
    post({type:'openPractice'});
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'practice-tools',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:'python',title:task.title,tools:{tests:1,trace:true}},aiEnabled:true,codeRuntime:'Local language tools'});
    const element = w.document.querySelector('.practice-code-editor')!;
    code(element).dispatch({changes:{from:0,insert:'print(input().upper())'}});
    const tool = (name: string) => element.querySelector<HTMLButtonElement>(`[data-tool=${name}]`)!;
    assert.equal(tool('tests').textContent, 'Run sample tests (1)');
    assert.equal(tool('variation').disabled, true, 'a new input waits for the sample tests to pass');
    assert.equal(tool('variation').hidden, true, 'and stays out of the way until then');
    const reply = (result: object) => { const asked = sent.at(-1); post({type:'practiceToolResult',attempt,request:asked.request,tool:asked.tool,...result}); return asked; };
    tool('tests').click();
    const testsAsked = reply({tests:[{id:'t1',verdict:'passed',stdin:'hi\n',expected:'HI\n',actual:'HI\n',stderr:''}]});
    assert.equal(testsAsked.type, 'practiceTool'); assert.equal(testsAsked.tool, 'tests');
    assert.equal(testsAsked.snapshot.source, 'print(input().upper())');
    await new Promise(r => setTimeout(r, 0));
    assert.match(element.textContent!, /Sample tests: 1 of 1 passed/);
    assert.equal(tool('variation').disabled, false); assert.equal(tool('variation').hidden, false);
    tool('trace').click();
    reply({trace:{stdout:'HI\n',stopped:null,error:null,steps:[
      {line:1,event:'line',function:'<module>',output:0,locals:{}},{line:1,event:'return',function:'<module>',output:3,locals:{}}]}});
    await new Promise(r => setTimeout(r, 0));
    assert.match(element.textContent!, /Step 1 of 2 · line 1/);
    Array.from(element.querySelectorAll<HTMLButtonElement>('.trace-nav button')).at(-1)!.click();
    assert.match(element.textContent!, /Step 2 of 2/); assert.match(element.textContent!, /Printed so far:\nHI/);
    tool('variation').click();
    reply({variation:{seed:7,stdin:'ok\n',prompt:'New input in the same shape as yours.',file:{name:'variation-7.txt',content:'ok\n'},argv:[]}});
    await new Promise(r => setTimeout(r, 0));
    const run = element.querySelector<HTMLButtonElement>('[data-action=run]')!;
    const before = sent.length;
    run.click();
    assert.equal(sent.length, before, 'a new-input run needs a prediction first');
    const prediction = element.querySelector<HTMLTextAreaElement>('.practice-prediction')!;
    prediction.value = 'OK';
    run.click();
    const ran = sent.at(-1);
    assert.equal(ran.action, 'run'); assert.equal(ran.stdin, 'ok\n');
    post({type:'codeResult',attempt,snippet:ran.snippet,revision:ran.revision,request:ran.request,
      execution:{status:'exited',exit_code:0,stdout:'OK\n',stderr:'',truncated:false}});
    assert.match(element.textContent!, /You predicted it exactly, on your own/);
  } finally { await ui.close(); }
});

test('a code review during a new-input attempt counts as help, so the prediction is not independent', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  const tick = () => new Promise(r => setTimeout(r, 0));
  try {
    const task: PracticeNotebook = {id:'review-help',language:'python',title:'Echo upper',question:'Print the input in uppercase.',
      starter:'',assistance:true,path:'/unused',account:'learner',tests:[{id:'t1',kind:'stdio',stdin:'hi\n',expected:'HI\n'}]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'review-help',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:'python',title:task.title,tools:{tests:1,trace:true}},aiEnabled:true});
    const element = w.document.querySelector('.practice-code-editor')!;
    code(element).dispatch({changes:{from:0,insert:'print(input().upper())'}});
    const tool = (name: string) => element.querySelector<HTMLButtonElement>(`[data-tool=${name}]`)!;
    const reply = (result: object) => { const asked = sent.at(-1); post({type:'practiceToolResult',attempt,request:asked.request,tool:asked.tool,...result}); };
    tool('tests').click(); reply({tests:[{id:'t1',verdict:'passed',stdin:'hi\n',expected:'HI\n',actual:'HI\n',stderr:''}]}); await tick();
    tool('variation').click(); reply({variation:{seed:3,stdin:'ok\n',prompt:'New input.',file:{name:'v.txt',content:'ok\n'},argv:[]}}); await tick();
    element.querySelector<HTMLButtonElement>('[data-action=submit]')!.click();
    const review = sent.at(-1); assert.equal(review.type,'notebookTurn'); assert.equal(review.submitted,true);
    post({type:'notebookReply',attempt,request:review.request,submitted:true,content:'Your code reads one line.',audioId:'review-audio'}); await tick();
    element.querySelector<HTMLTextAreaElement>('.practice-prediction')!.value = 'OK';
    element.querySelector<HTMLButtonElement>('[data-action=run]')!.click();
    const ran = sent.at(-1);
    post({type:'codeResult',attempt,snippet:ran.snippet,revision:ran.revision,request:ran.request,
      execution:{status:'exited',exit_code:0,stdout:'OK\n',stderr:'',truncated:false}});
    assert.doesNotMatch(element.textContent!, /on your own/);
    assert.match(element.textContent!, /asked for help during this attempt/);
    await new Promise(r => setTimeout(r,300));
    const saved = sent.filter(message => message.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.drafts[0].helped, true, 'review is recorded as help');
    assert.equal(saved.cells.find((cell: any) => cell.packet?.submission)?.packet.submission.assisted, false, 'the reviewed code itself was written unaided');
  } finally { await ui.close(); }
});

test('Doubt Solver uses shared Get Help with a per-doubt help ladder and names Doubt Solver throughout', async () => {
  const composer = notebookMessageBar('Doubt Solver', false, '<button type="button" id="sound"></button>');
  assert.doesNotMatch(composer, /Instructor/);
  assert.match(composer, /id="practice-help"/);
  assert.match(composer, /notebook-help-actions/);
  assert.match(composer, /aria-label="Ask Doubt Solver"/);
  assert.doesNotMatch(composer, /aria-keyshortcuts/);
  const performed: any[] = [];
  const agent = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    listeners = new Map<string, Function>(); remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async (request: any) => { performed.push(request); return 'ok'; }, sendText:async () => {}};
    on(name: string, listener: Function) { this.listeners.set(name, listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const events = ['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'];
  const ui = surface({Room, RoomEvent:Object.fromEntries(events.map(name => [name, name]))}, composer), {w,sent,post} = ui;
  try {
    post({type:'openTutor',mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(w, sent.at(-1).attempt); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'doubt',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused'}); await new Promise(r => setTimeout(r,0));
    assert.equal(w.document.querySelectorAll('#notebook-help-actions button').length, 9);
    assert.equal(w.document.getElementById('audio-microphone'), null);
    const send = w.document.getElementById('send')!;
    assert.equal(send.getAttribute('aria-label'), 'Ask Doubt Solver');
    assert.doesNotMatch(send.getAttribute('aria-label')!, /Ctrl|Cmd/);
    w.document.getElementById('add-code')!.click(); await new Promise(r => setTimeout(r,0));
    assert.ok(performed.some(request => request.method === 'on_editor_activity'));
    assert.match(w.document.getElementById('code-observer-status')!.textContent!, /^Doubt Solver can see/);
  } finally { await ui.close(); }
});

test('learners design local tests, reject stale results and discuss investigations as assisted help', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  try {
    const task: PracticeNotebook = {id:'skills',language:'javascript',title:'Double',question:'Print twice the integer input.',
      starter:'console.log(1)',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'skills',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:task.language,title:task.title,tools:{tests:0,trace:false}},aiEnabled:true});
    let editor = w.document.querySelector('.practice-code-editor')!;
    const unavailable = editor.querySelector<HTMLButtonElement>('[data-tool="tests"]')!;
    assert.equal(unavailable.hidden,false); assert.equal(unavailable.disabled,true);
    assert.match(editor.textContent!, /No runnable sample tests are supplied/);
    const button = (name: string) => editor.querySelector<HTMLButtonElement>(`[data-skill="${name}"]`)!;
    const field = (name: string, value: string) => {
      const input = editor.querySelector<HTMLTextAreaElement>(`[data-skill-field="${name}"]`)!;
      input.value = value; input.dispatchEvent(new w.Event('input')); return input;
    };
    button('add-case').click();
    assert.equal(button('run-cases').disabled,true,'a case needs a reason before running');
    field('case-reason','Zero must double to zero'); field('case-stdin','0\n'); field('case-expected','0\n');
    button('run-cases').click();
    let request = sent.at(-1);
    assert.equal(request.tool,'my_tests'); assert.equal(request.cases[0].expected,'0\n');
    assert.equal(sent.some(m => m.type === 'notebookTurn'),false,'running own cases never asks AI');
    assert.equal(editor.querySelector<HTMLButtonElement>('[data-action="run"]')!.disabled,true);
    field('case-expected','2\n');
    post({type:'practiceToolResult',attempt,request:request.request,tests:[{id:'learner-1',verdict:'passed',actual:'0\n',stderr:''}]});
    await new Promise(r => setTimeout(r,0));
    assert.equal(editor.querySelector('.skill-test-results')!.childElementCount,0,'an edited expectation invalidates an in-flight result');
    field('case-expected','0\n'); button('run-cases').click(); request = sent.at(-1);
    post({type:'practiceToolResult',attempt,request:request.request,tests:[{id:'learner-1',verdict:'passed',actual:'0\n',stderr:''}]});
    await new Promise(r => setTimeout(r,0));
    assert.match(editor.querySelector('.skill-test-results')!.textContent!,/matches your expectation/);
    assert.match(editor.querySelector('.skill-practice')!.textContent!,/do not prove correctness/);
    const beforeInput = sent.filter(m => m.type === 'codeAction').length;
    button('use-input').click();
    assert.equal(sent.filter(m => m.type === 'codeAction').length,beforeInput,'copying a case never runs code automatically');
    assert.equal((editor.querySelector('textarea') as HTMLTextAreaElement).value,'0\n');
    code(editor).dispatch({changes:{from:0,to:code(editor).state.doc.length,insert:'console.log(2)'}});
    assert.equal(editor.querySelector('.skill-test-results')!.childElementCount,0,'code edits invalidate comparisons');
    field('expected','Zero'); field('hypothesis','I always print a constant'); field('experiment','Try two different inputs');
    button('ask-investigation').click(); request = sent.at(-1);
    assert.equal(request.type,'notebookTurn'); assert.equal(request.stage,'debug'); assert.equal(request.submitted,false);
    assert.match(request.message,/I always print a constant/);
    post({type:'notebookReply',attempt,request:request.request,content:'What would disprove that idea?'});
    await new Promise(r => setTimeout(r,0));
    button('ask-case').click(); request = sent.at(-1);
    assert.equal(request.stage,'test'); assert.match(request.message,/Zero must double to zero/);
    post({type:'notebookReply',attempt,request:request.request,content:'Which requirement supports that expectation?'});
    await new Promise(r => setTimeout(r,300));
    const saved = sent.filter(m => m.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.drafts[0].helped,true); assert.equal(saved.drafts[0].skills.cases.length,1);
    assert.equal(saved.drafts[0].skills.hypothesis,'I always print a constant');
    assert.equal(JSON.stringify(saved.drafts).includes('matches your expectation'),false);
    post({type:'restoreNotebook',documentKey:'skills-copy',notebook:saved});
    editor = w.document.querySelector('.practice-code-editor')!;
    assert.equal(editor.querySelector<HTMLTextAreaElement>('[data-skill-field="case-expected"]')!.value,'0\n');
    assert.equal(editor.querySelector('.skill-test-results')!.childElementCount,0,'restoring never restores run evidence');
    post({type:'codeSettings',aiEnabled:false});
    assert.equal(button('ask-investigation').disabled,true);
    assert.equal(button('ask-case').disabled,true);
    assert.equal(button('run-cases').disabled,false,'test execution does not require AI');
    button('run-cases').click(); request = sent.at(-1);
    post({type:'runtimeRestarted'});
    post({type:'practiceToolResult',attempt,request:request.request,tests:[{id:'learner-1',verdict:'passed',actual:'0\n',stderr:''}]});
    await new Promise(r => setTimeout(r,0));
    assert.equal(editor.querySelector('.skill-test-results')!.childElementCount,0,'a runtime restart invalidates in-flight comparisons');
  } finally { await ui.close(); }
});

test('engineering skills explain concepts locally and allow guided practice before any code is written', async () => {
  const ui = surface(), {w,sent,post} = ui;
  try {
    const task:PracticeNotebook = {id:'engineering',language:'python',title:'Double',question:'Double an integer.',starter:'',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'engineering',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:task.language,title:task.title,tools:{tests:0,trace:false}},aiEnabled:true});
    const editor = w.document.querySelector('.practice-code-editor')!;
    const picker = editor.querySelector<HTMLSelectElement>('[data-skill-picker]')!;
    const start = editor.querySelector<HTMLButtonElement>('[data-skill="ask-skill"]')!;
    assert.equal(picker.options.length,engineeringSkills.length);
    assert.equal(start.disabled,false,'understand the requirement before implementing it');
    for (const skill of engineeringSkills) {
      const calls = sent.filter(m => m.type === 'notebookTurn').length;
      picker.value = skill.id; picker.dispatchEvent(new w.Event('change'));
      assert.equal(editor.querySelector('[data-skill-definition]')!.textContent,skill.meaning);
      assert.equal(sent.filter(m => m.type === 'notebookTurn').length,calls,'reading definitions never calls AI');
      start.click(); const request = sent.at(-1);
      assert.equal(request.stage,skill.id); assert.equal(request.snapshot.source,''); assert.equal(request.submitted,false);
      post({type:'notebookReply',attempt,request:request.request,content:'Let us try one small example.'});
      await new Promise(r => setTimeout(r,0));
    }
    post({type:'codeSettings',aiEnabled:false});
    assert.equal(start.disabled,true); assert.equal(picker.disabled,false,'definitions remain available with AI off');
    picker.value = 'debug'; picker.dispatchEvent(new w.Event('change'));
    assert.match(editor.querySelector('[data-skill-definition]')!.textContent!,/actual behavior differs from expected behavior/);
    picker.value = 'unit_test'; picker.dispatchEvent(new w.Event('change'));
    assert.match(editor.querySelector('[data-skill-definition]')!.textContent!,/Testing checks behavior/);
  } finally { await ui.close(); }
});

test('reading and test-writing actions use selected code, and test-code runs expose real output without asserting a grade', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  try {
    const task:PracticeNotebook = {id:'test-code',language:'javascript',title:'Double',question:'Double the input.',starter:'const twice = n => n * 2;',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'test-code',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:task.language,title:task.title,tools:{tests:0,trace:false}},aiEnabled:true});
    const editor = w.document.querySelector('.practice-code-editor')!;
    const button = (name:string) => editor.querySelector<HTMLButtonElement>(`[data-skill="${name}"]`)!;
    for (const [action,stage] of [['ask-reading','read_code'],['ask-start-debug','debug'],['ask-unit-test','unit_test'],['ask-functional-test','functional_test']]) {
      button(action).click(); const request = sent.at(-1);
      assert.equal(request.type,'notebookTurn'); assert.equal(request.stage,stage); assert.equal(request.snapshot.source,task.starter); assert.equal(request.submitted,false);
      post({type:'notebookReply',attempt,request:request.request,content:'Explain the expected result.'});
      await new Promise(r => setTimeout(r,0));
      const latest = [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')].at(-1)!;
      latest.querySelector<HTMLButtonElement>('[data-reply]')!.click(); const followup = sent.at(-1);
      assert.equal(followup.stage,stage,'follow-up keeps the requested learning skill');
      post({type:'notebookReply',attempt,request:followup.request,content:'Let us check that reasoning.'});
      await new Promise(r => setTimeout(r,0));
    }
    const before = sent.filter(m => m.type === 'notebookTurn').length;
    button('run-test-code').click(); let request = sent.at(-1);
    assert.equal(request.type,'practiceTool'); assert.equal(request.tool,'test_code');
    post({type:'practiceToolResult',attempt,request:request.request,execution:{status:'exited',exit_code:1,stdout:'1 test failed',stderr:'AssertionError: 1 != 0',truncated:false,duration_seconds:0.1}});
    await new Promise(r => setTimeout(r,0));
    assert.match(editor.querySelector('.practice-output')!.textContent!,/AssertionError/);
    assert.equal(sent.filter(m => m.type === 'notebookTurn').length,before);
    button('ask-unit-test').click(); request = sent.at(-1);
    assert.equal(request.run.success,false); assert.match(request.run.stderr,/AssertionError/);
    post({type:'notebookReply',attempt,request:request.request,content:'Which requirement supports zero?'});
    await new Promise(r => setTimeout(r,0));
    button('run-test-code').click(); request = sent.at(-1);
    code(editor).dispatch({changes:{from:0,to:code(editor).state.doc.length,insert:'const twice = n => 2 * n;'}});
    post({type:'practiceToolResult',attempt,request:request.request,execution:{status:'exited',exit_code:0,stdout:'old result',stderr:'',truncated:false,duration_seconds:0.1}});
    await new Promise(r => setTimeout(r,0));
    assert.equal(editor.querySelector<HTMLElement>('.practice-output')!.hidden,true,'edited test code rejects an earlier execution');
    post({type:'codeSettings',aiEnabled:false});
    assert.equal(button('run-test-code').disabled,false); assert.equal(button('ask-unit-test').disabled,true);
  } finally { await ui.close(); }
});

test('native debugger actions are explicit, share only requested paused evidence and retain assistance provenance', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  try {
    const task:PracticeNotebook = {id:'native-debug',language:'javascript',title:'Double',question:'Double the input.',
      starter:'console.log(2)',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'native',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:task.language,title:task.title,tools:{tests:0,trace:false}},aiEnabled:true});
    const editor = w.document.querySelector('.practice-code-editor')!;
    const action = (name:string) => editor.querySelector<HTMLButtonElement>(`[data-debug="${name}"]`)!;
    action('start').click(); let request = sent.at(-1);
    assert.equal(request.type,'notebookDebug'); assert.equal(request.action,'start');
    const snapshot = request.snapshot;
    post({type:'notebookDebugState',attempt,snippet:snapshot.snippet,revision:snapshot.revision,state:{phase:'paused',message:'Paused in VS Code.',canInspect:true}});
    post({type:'notebookDebugResult',attempt,request:request.request});
    await new Promise(r => setTimeout(r,0));
    assert.equal(sent.some(m => m.type === 'notebookTurn'),false,'a native pause is never shared automatically');
    action('inspect').click(); request = sent.at(-1);
    assert.equal(request.action,'inspect');
    const evidence = {id:'a'.repeat(24),reason:'breakpoint',line:1,frames:[{name:'main',line:1,selectedSource:true}],variables:[{name:'n',value:'21',type:'number'}],incomplete:false};
    post({type:'notebookDebugResult',attempt,request:request.request,evidence});
    await new Promise(r => setTimeout(r,0));
    const help = sent.at(-1);
    assert.equal(help.type,'notebookTurn'); assert.equal(help.stage,'debug'); assert.equal(help.submitted,false);
    assert.deepEqual(JSON.parse(JSON.stringify(help.debugger)),evidence);
    post({type:'notebookReply',attempt,request:help.request,content:'Predict the value before you step.'});
    await new Promise(r => setTimeout(r,300));
    const saved = sent.filter(m => m.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.drafts[0].helped,true);
    assert.equal(JSON.stringify(saved).includes(evidence.id),false,'paused locals are not saved with notebook history');
    post({type:'notebookDebugState',attempt,snippet:snapshot.snippet,revision:snapshot.revision,state:{phase:'running',message:'Running.'}});
    assert.equal(action('inspect').disabled,true);
    post({type:'notebookDebugState',attempt,snippet:snapshot.snippet,revision:snapshot.revision,state:{phase:'stopped',message:'Stopped.'}});
    action('import').click(); request = sent.at(-1);
    post({type:'notebookDebugResult',attempt,request:request.request,source:'console.log(4)'});
    await new Promise(r => setTimeout(r,0));
    assert.equal(code(editor).state.doc.toString(),'console.log(4)');
    post({type:'codeSettings',aiEnabled:false});
    assert.equal(action('start').disabled,false,'native debugging works with AI off');
    assert.equal(action('inspect').disabled,true);
  } finally { await ui.close(); }
});

test('Practice conversation is interactive, collapsible and removable without losing code, notes or assistance', async () => {
  const ui = surface(), {w,sent,post,click,code} = ui;
  const submit = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', {cancelable:true}));
  const tick = () => new Promise(r => setTimeout(r, 0));
  try {
    const task: PracticeNotebook = {id:'conversation',language:'python',title:'Time objects',question:'Return whether t1 is after t2.',
      starter:'',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'conversation-doc',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:task,aiEnabled:true});
    let element = w.document.querySelector('.practice-code-editor')!;
    const editor = code(element); editor.dispatch({changes:{from:0,insert:'print(7)'}});
    click('add-note');
    const field = w.document.getElementById('message') as HTMLTextAreaElement;
    field.value = 'explain me about this topic'; field.dispatchEvent(new w.Event('input')); submit();
    const request = sent.at(-1);
    assert.equal(request.type, 'notebookTurn');
    assert.equal((w.document.getElementById('practice-help') as HTMLButtonElement).disabled, true);
    submit(); (w.document.getElementById('practice-help') as HTMLButtonElement).click();
    assert.equal(sent.filter(m => m.type === 'notebookTurn').length, 1, 'all entry points share the pending request lock');
    assert.equal((w.document.getElementById('clear-conversation') as HTMLButtonElement).disabled, true);
    post({type:'notebookReply',attempt,request:request.request,content:'An object groups related values. What does hour hold?',
      replies:['Got it','Not yet','Explain differently'],audioId:'reply-1'});
    await tick();
    const rows = () => [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')].filter(row => row.querySelector('.conversation-header'));
    assert.equal(rows().length, 2);
    assert.equal(rows()[0].querySelector<HTMLElement>('.conversation-body')!.hidden, false);
    assert.equal(rows()[1].querySelector<HTMLElement>('.conversation-body')!.hidden, false);
    assert.equal(rows()[1].querySelector('[data-listen]'), null, 'written replies have no narration or replay action');
    const action = [...rows()[1].querySelectorAll<HTMLButtonElement>('[data-reply]')].find(b => b.textContent === 'Not yet')!;
    action.click(); const second = sent.at(-1);
    assert.match(second.message, /Not yet/); assert.match(second.message, /An object groups/);
    action.click(); assert.equal(sent.filter(m => m.type === 'notebookTurn').length, 2);
    post({type:'notebookReply',attempt,request:second.request,content:'Think of a school bag holding different items.',audioId:'reply-2'});
    await tick();
    const readable = () => rows().filter(row => !row.querySelector<HTMLElement>('.conversation-body')!.hidden).map(row => {
      const content = row.querySelector('.conversation-body')!.cloneNode(true) as HTMLElement;
      content.querySelectorAll('.practice-reply-stale,.lesson-actions').forEach(control => control.remove());
      return content.textContent;
    });
    assert.equal(readable().length, 4, 'both prompts and replies remain expanded');
    const exchanges = readable();
    click('add-code');
    const secondEditor = [...w.document.querySelectorAll('.practice-code-editor')].at(-1)!;
    code(secondEditor).dispatch({changes:{from:0,insert:'print(42)'}});
    code(secondEditor).focus(); code(element).focus();
    element.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
    const running = sent.filter(m => m.type === 'codeAction').at(-1);
    post({type:'codeResult',attempt,request:running.request,snippet:running.snippet,revision:running.revision,execution:{status:'exited',exit_code:0,stdout:'7\n',stderr:'',duration_ms:1}});
    post({type:'visibility',visible:false}); post({type:'visibility',visible:true});
    assert.deepEqual(readable(), exchanges, 'cell focus, edits, runs and hiding preserve visible exchanges');
    field.value = 'Explain another example'; field.dispatchEvent(new w.Event('input')); submit();
    const failed = sent.filter(m => m.type === 'notebookTurn').at(-1);
    post({type:'notebookReply',attempt,request:failed.request,error:'Unavailable'}); await tick();
    assert.deepEqual(readable(), exchanges, 'a failed request preserves earlier readable exchanges');
    await new Promise(r => setTimeout(r,300));
    const withHistory = sent.filter(m => m.type === 'notebookChanged').at(-1).notebook;
    post({type:'restoreNotebook',documentKey:'conversation-doc',notebook:withHistory});
    element = w.document.querySelector('.practice-code-editor')!;
    assert.deepEqual(readable(), exchanges, 'restoring a notebook keeps both pairs readable');
    rows()[1].querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    assert.equal(rows()[1].querySelector<HTMLElement>('.conversation-body')!.hidden, true, 'only an explicit collapse hides a reply');
    rows()[1].querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    assert.equal(rows()[1].querySelector<HTMLElement>('.conversation-body')!.hidden, false);
    rows()[0].querySelector<HTMLButtonElement>('[data-remove-conversation]')!.click();
    assert.equal(rows().length, 4, 'messages stay until deletion is confirmed');
    w.document.querySelector<HTMLButtonElement>('[data-confirm-delete]')!.click();
    assert.equal(rows().length, 3);
    click('clear-conversation');
    assert.equal(rows().length, 3);
    w.document.querySelector<HTMLButtonElement>('[data-confirm-delete]')!.click(); assert.equal(rows().length, 0);
    assert.equal(code(element).state.doc.toString(), 'print(7)');
    assert.ok(w.document.querySelector('[data-cell-id="practice-question"]'));
    assert.ok(w.document.querySelector('[aria-label="My notes"]'));
    await new Promise(r => setTimeout(r, 300));
    const saved = sent.filter(m => m.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.drafts[0].helped, true, 'clearing replies cannot erase assistance provenance');
    field.value = 'Explain the question'; field.dispatchEvent(new w.Event('input')); submit();
    const third = sent.at(-1); assert.equal(third.history.length, 0, 'deleted messages leave request history');
    post({type:'notebookReply',attempt,request:third.request,error:'Unavailable'}); await tick();
    assert.equal((w.document.getElementById('practice-help') as HTMLButtonElement).disabled, false);
    assert.equal(rows().length, 0, 'failed requests do not append duplicate turns');
    post({type:'notebookReply',attempt,request:third.request,content:'Late reply',audioId:'stale'}); await tick();
    assert.equal(rows().length, 0); assert.equal(sent.some(m => ['audioJoin', 'practiceListen'].includes(m.type)), false);
    post({type:'restoreNotebook',documentKey:'conversation-doc',notebook:saved});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length, 2);
    assert.equal(code(w.document.querySelector('.practice-code-editor')!).state.doc.toString(), 'print(7)');
  } finally { await ui.close(); }
});


test('Flutter Practice actions preserve selected-line context and retire replies after edits or runtime changes', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  const tick = () => new Promise(r => setTimeout(r, 0));
  try {
    const task: PracticeNotebook = {id:'flutter',language:'python',title:'Values',question:'Print a value.',starter:'',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'flutter-doc',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:task,aiEnabled:true});
    const editor = code(w.document.querySelector('.practice-code-editor')!);
    editor.dispatch({changes:{from:0,insert:'value = 7\nprint(value)'},selection:{anchor:10}});
    const actions = [...w.document.querySelectorAll<HTMLButtonElement>('[data-practice-strategy]')];
    assert.deepEqual(actions.map(b => b.textContent), ['Explain problem','Explain code','Explain simply','Summarise','Explain errors','Explain failed tests','Give an example','Quiz me','Next step']);
    actions[1].click(); const request = sent.at(-1);
    assert.equal(request.strategy, 'trace'); assert.equal(request.focusLine, 2);
    assert.match(request.message, /starting with the selected line/);
    assert.ok(actions.every(b => b.disabled));
    post({type:'notebookReply',attempt,request:request.request,content:'Line 2 prints the stored value.',line:2,
      strategy:'walkthrough',replies:['Explain line 1','I understand this line']}); await tick();
    const row = [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')].at(-1)!;
    const replies = [...row.querySelectorAll<HTMLButtonElement>('[data-reply]')];
    assert.deepEqual(replies.map(b => b.textContent), ['Go to line 2','Explain line 1','I understand this line']);
    replies[0].click(); assert.equal(editor.state.selection.main.from, 10);
    assert.equal(editor.state.selection.main.to, editor.state.doc.length);
    replies[1].click(); const followup = sent.at(-1);
    assert.equal(followup.strategy,'walkthrough'); assert.match(followup.message,/Explain line 1/);
    post({type:'notebookReply',attempt,request:followup.request,content:'Line 1 stores the number.',line:1,replies:['Try a different value']}); await tick();
    assert.ok(replies.every(b => b.disabled), 'only the latest reply owns follow-up actions');
    const latest = [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')].at(-1)!;
    assert.equal(latest.querySelector<HTMLButtonElement>('[data-reply]')!.disabled, false);
    editor.dispatch({changes:{from:8,to:9,insert:'8'}});
    assert.ok([...latest.querySelectorAll<HTMLButtonElement>('[data-reply]')].every(b => b.disabled));
    assert.equal(latest.querySelector<HTMLElement>('.practice-reply-stale')!.hidden, false);
    assert.equal(actions[1].disabled, false, 'a fresh teaching request remains available after an edit');
    actions[8].click(); const next = sent.at(-1); assert.equal(next.strategy,'small_steps');
    post({type:'notebookReply',attempt,request:next.request,content:'Try one value.',replies:['I have an idea']}); await tick();
    const current = [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')].at(-1)!;
    post({type:'runtimeRestarted'});
    assert.equal(current.querySelector<HTMLButtonElement>('[data-reply]')!.disabled, true);
  } finally { await ui.close(); }
});

test('a sentence-starter reply chip goes to the message box for the learner to finish, never sent half-written', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  const tick = () => new Promise(r => setTimeout(r, 0));
  try {
    const task: PracticeNotebook = {id:'split',language:'python',title:'Split',question:'Split a line.',starter:'',assistance:true,path:'/unused',account:'learner',tests:[]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'starter-doc',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:task,aiEnabled:true});
    code(w.document.querySelector('.practice-code-editor')!).dispatch({changes:{from:0,insert:'line = input()'}});
    const actions = [...w.document.querySelectorAll<HTMLButtonElement>('[data-practice-strategy]')];
    actions[1].click(); const request = sent.at(-1);
    post({type:'notebookReply',attempt,request:request.request,content:'Which index holds the value?',
      replies:['Index 0 holds the key, so the value is at...','Show me a smaller example']}); await tick();
    const row = [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')].at(-1)!;
    const [starter, full] = [...row.querySelectorAll<HTMLButtonElement>('[data-reply]')];
    const before = sent.length;
    starter.click();
    assert.equal(sent.slice(before).filter(m => m.type === 'notebookMessage' || m.message).length, 0, 'the starter is not sent');
    const field = w.document.getElementById('message') as HTMLTextAreaElement;
    assert.equal(field.value, 'Index 0 holds the key, so the value is at ');
    assert.equal(w.document.activeElement, field);
    full.click(); assert.match(sent.at(-1).message, /Show me a smaller example/);
  } finally { await ui.close(); }
});

test('Practice keeps Run and samples visible, optional tools in More, and help in its conversation', async () => {
  const ui = surface(), {w,sent,post,code} = ui;
  try {
    const task: PracticeNotebook = {id:'ladder',language:'python',title:'Echo',question:'Echo\n\nPrint the input.\n\nExample input\n\nhi\n\nExpected output\n\nhi',
      starter:'',assistance:true,path:'/unused',account:'learner',tests:[{id:'t1',kind:'stdio',stdin:'hi\n',expected:'hi\n'}]};
    post({type:'openPractice'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:'ladder',notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{id:task.id,language:'python',title:task.title,tools:{tests:1,trace:true}},aiEnabled:true,
      help:{next:1,waiting:false,trend:'Solve a problem with passing samples to start your record.'}});
    assert.match(w.document.querySelector('#feed h3')!.textContent!, /Echo/, 'the task title is a heading');
    assert.equal(w.document.querySelectorAll('#feed pre').length >= 2, true, 'examples are shown as literal text');
    const editor = w.document.querySelector('.practice-code-editor')!;
    assert.equal(editor.querySelector('[data-action="coach"]'), null, 'a Practice task asks Instructor in one place, below it');
    const prediction = editor.querySelector<HTMLTextAreaElement>('.practice-prediction')!;
    assert.equal(prediction.closest('details'), null, 'the prediction stays in view next to Run');
    assert.equal(prediction.closest('label')!.nextElementSibling, editor.querySelector('.practice-actions'));
    assert.equal(editor.querySelector<HTMLDetailsElement>('.practice-more')!.open, false, 'optional actions start collapsed');
    const row = editor.querySelector('.practice-actions')!;
    assert.deepEqual(Array.from(row.querySelectorAll<HTMLButtonElement>('button')).filter(b => !b.hidden).map(b => b.textContent),
      ['Run','Run sample tests (1)']);
    assert.equal(editor.querySelector('[data-action=submit]')?.textContent, 'Review my code');
    assert.ok(editor.querySelector('[data-action=submit]')?.closest('.practice-more'));
    assert.ok(editor.querySelector('[data-tool=trace]')?.closest('.practice-more'));
    const help = w.document.getElementById('practice-help') as HTMLButtonElement;
    assert.equal(help.textContent, 'Ask me a guiding question'); assert.equal(help.disabled, false);
    code(editor).dispatch({changes:{from:0,insert:'print(input())'}});
    help.click();
    const turn = sent.at(-1);
    assert.equal(turn.type, 'notebookTurn'); assert.equal(turn.helpLevel, 1);
    assert.match(turn.message, /Ask me one question/);
    assert.equal(turn.snapshot.source, 'print(input())');
    post({type:'notebookReply',attempt,request:turn.request,content:'What does input() return?'});
    await new Promise(r => setTimeout(r, 0));
    post({type:'helpState',next:1,waiting:true,trend:'Solve a problem with passing samples to start your record.'});
    assert.equal(help.textContent, 'Ask me a guiding question', 'the same rung until the learner tries again');
    assert.match(w.document.getElementById('help-note')!.textContent!, /run your code to unlock/);
    post({type:'helpState',next:2,waiting:false,trend:'Last 1 solved: 0 without help.'});
    assert.equal(help.textContent, 'Give me a hint'); assert.equal(w.document.getElementById('help-note')!.textContent, '');
    assert.equal(w.document.getElementById('help-trend')!.textContent, 'Last 1 solved: 0 without help.');
    assert.equal(w.document.querySelectorAll('#help-steps .used').length, 1);
    help.click();
    assert.equal(sent.at(-1).helpLevel, 2);
  } finally { await ui.close(); }
});


test('cell controls stream output, send live input, stop runs and persist shell/database drafts', async()=>{
  const ui=surface(); const {w,post,sent,click,code}=ui;
  try{
    post({type:'openPractice'});const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'cell-session',notebook:emptyNotebook()});
    post({type:'practiceReady',attempt,aiEnabled:true,practice:{id:'task',language:'python',tools:{tests:0,trace:true}},help:{},codeRuntime:'Course'});
    for(const language of ['bash','zsh','sql','pglab']){
      (w.document.getElementById('cell-language') as HTMLSelectElement).value=language;click('add-code');
      const cell=Array.from(w.document.querySelectorAll<HTMLElement>('.practice-code-editor')).at(-1)!;
      code(cell).dispatch({changes:{from:0,to:code(cell).state.doc.length,insert:'echo ready'}});
      const run=cell.querySelector<HTMLButtonElement>('[data-action="run"]')!;run.click();
      const request=sent.filter(m=>m.type==='codeAction').at(-1);assert.equal(request.language,language);
      assert.equal(run.textContent,'Stop');assert.equal(run.disabled,false);
      post({type:'codeResult',attempt,snippet:request.snippet,revision:request.revision,request:request.request,event:{kind:'stream',stream:'stdout',text:'live output'}});
      assert.match(cell.querySelector('.practice-output')!.textContent!,/live output/);
      post({type:'codeResult',attempt,snippet:request.snippet,revision:request.revision,request:request.request,event:{kind:'display',data:{'text/plain':'displayed text'}}});
      assert.match(cell.textContent!,/displayed text/);
      run.click();assert.equal(sent.at(-1).type,'cellControl');assert.equal(sent.at(-1).action,'stop');
      post({type:'codeResult',attempt,snippet:request.snippet,revision:request.revision,request:request.request,execution:{status:'cancelled',exit_code:null,stdout:'live output',stderr:'',truncated:false}});
      assert.equal(run.textContent,'Run');
    }
    await new Promise(r=>setTimeout(r,350));
    const saved=sent.filter(m=>m.type==='notebookChanged').at(-1).notebook;
    assert.deepEqual(Array.from(saved.drafts,(d:any)=>d.language),['bash','zsh','sql','pglab']);
  }finally{await ui.close();}
});

test('Tab accepts shell language-provider completions and indents when no completion is selected',async()=>{
  const ui=surface();const {w,post,sent,click,code}=ui;
  const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  try{
    post({type:'openPractice'});const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'completion-session',notebook:emptyNotebook()});
    post({type:'practiceReady',attempt,aiEnabled:true,practice:{id:'task',language:'python',tools:{tests:0,trace:false}},help:{},codeRuntime:'Course'});
    (w.document.getElementById('cell-language') as HTMLSelectElement).value='bash';click('add-code');
    const cell=w.document.querySelector<HTMLElement>('.practice-code-editor')!;
    const view=code(cell);view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'ec'},selection:{anchor:2}});view.focus();
    const content=cell.querySelector<HTMLElement>('.cm-content')!;
    content.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',code:'Space',ctrlKey:true,bubbles:true}));
    await wait(200);
    const request=sent.filter(m=>m.type==='cellCompletion').at(-1);assert.ok(request);assert.equal(request.language,'bash');
    post({type:'cellCompletions',attempt,request:request.request,items:[{label:'echo',apply:'echo',from:0,to:2}]});
    await wait(120);
    content.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',code:'Tab',bubbles:true,cancelable:true}));
    assert.equal(view.state.doc.toString(),'echo');
    view.dispatch({changes:{from:0,to:4,insert:''},selection:{anchor:0}});await wait(50);
    content.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',code:'Tab',bubbles:true,cancelable:true}));
    assert.match(view.state.doc.toString(),/^\s+$/);
  }finally{await ui.close();}
});


for (const mode of ['tutor', 'doubt_solver'] as const) test(`${mode}: Explain problem follows the current discussion despite an older selected Python cell`, async () => {
  const chats: string[] = [], rooms: Room[] = [];
  let fail = false;
  const peer = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker',peer]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok', sendText:async (text:string) => {
      if (fail) throw new Error('offline'); chats.push(text);
    }};
    constructor() { rooms.push(this); }
    on(event:string, listener:Function) { this.listeners.set(event,listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ui = surface({Room,RoomEvent:{DataReceived:'DataReceived'}}), {w,sent,post,code,click} = ui;
  const tick = () => new Promise(resolve => setTimeout(resolve,0));
  const question = 'Why is the cross product perpendicular to both vectors, and how does its magnitude depend on the angle?';
  try {
    post({type:'openTutor',mode});
    if (mode === 'tutor') selectLesson(w,sent.at(-1).attempt);
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'cross-product',notebook:{...emptyNotebook(),cells:[
      {id:'python-question',kind:'message',text:'Explain Python variable assignment.'},
      {id:'python-code',kind:'code',text:'x = 5\ny = x\nx = 10\nprint(x, y)',packet:{language:'python'}},
      ...(mode === 'doubt_solver' ? [{id:'math-doubt',kind:'recap',text:'New doubt',packet:{doubt_divider:true,doubt_id:'vectors'}}] : []),
      {id:'vector-question',kind:'message',text:question},
      {id:'private-note',kind:'note',text:'PRIVATE scratch'},
    ]}});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId}); await tick();
    code(w.document.querySelector('.practice-code-editor')!).focus();
    const action = w.document.querySelector<HTMLButtonElement>('[data-practice-strategy="plan"]')!;
    action.click(); await tick();
    assert.match(chats.at(-1)!, /Explain this problem from our current discussion/);
    assert.ok(chats.at(-1)!.endsWith(question));
    assert.doesNotMatch(chats.at(-1)!, /variable assignment|x = 5|PRIVATE/);
    assert.equal(sent.filter(message => message.type === 'notebookTurn').length,0);
    action.click(); await tick();
    assert.ok(chats.at(-1)!.endsWith(question), 'the earlier action label cannot replace the question');
    fail = true; action.click(); await tick();
    assert.match(w.document.getElementById('status')!.textContent!, /delivery could not be confirmed/);
    fail = false;
    if (mode === 'doubt_solver') {
      click('new-doubt');
      post({type:'openDoubtChat',chapter:chapterId,newChat:true});
      const newAttempt=sent.at(-1).attempt;
      post({type:'restoreNotebook',attempt:newAttempt,documentKey:'new-doubt',notebook:emptyNotebook()});
      post({type:'grant',attempt:newAttempt,url:'unused',token:'unused',chapterId});await tick();
      const field = w.document.getElementById('message') as HTMLTextAreaElement;
      field.value = 'What does a dot product measure?'; field.dispatchEvent(new w.Event('input')); click('send'); await tick();
      action.click(); await tick();
      assert.match(chats.at(-1)!, /dot product measure/);
      assert.doesNotMatch(chats.at(-1)!, /cross product|variable assignment/);
    }
    const publish = (packet:object) => rooms.at(-1)!.listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify(packet)),peer);
    const before = w.document.querySelectorAll('article').length;
    publish({method:'draw_svg',action:'clear',svg:''});
    publish({method:'draw_svg',action:'update',svg:'  '});
    assert.equal(w.document.querySelectorAll('article').length,before,'clearing a canvas does not create a failed diagram');
    const simple = '<svg viewBox="0 0 100 50"><path d="M0 0L80 30" style="fill:none;stroke:#2563eb"/></svg>';
    publish({method:'draw_svg',svg:'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' + simple});
    assert.ok(w.document.querySelector('article:last-child img.board-diagram'),'standard plot document wrappers are supported');
    publish({method:'draw_svg',svg:'```svg\n<svg viewBox="0 0 100 50"><path d="M0 0L80 30" style="fill:none;stroke:#2563eb"/></svg>\n```'});
    assert.ok(w.document.querySelector('article:last-child img.board-diagram'), 'tool payload fences are supported');
    publish({method:'draw_svg',svg:'<svg><broken></svg>'});
    assert.equal(w.document.querySelector('.diagram-alternative'),null,'an earlier turn is not a fallback');
    publish({method:'display_on_screen',content:'The product measures a relationship between vectors.\n\n$|A \\times B| = |A||B|\\sin\\theta$'});
    const alternative = w.document.querySelector('.diagram-alternative')!;
    assert.match(alternative.textContent!, /relationship between vectors/);
    assert.ok(alternative.querySelector('.katex'), 'the fallback keeps mathematical notation readable');
    assert.doesNotMatch(alternative.textContent!, /variable assignment|PRIVATE/);
    publish({method:'draw_svg',svg:'<!DOCTYPE svg [<!ENTITY leak SYSTEM "https://evil.test/secret">]>' + simple});
    assert.ok(w.document.querySelector('article:last-child .diagram-unavailable'),'custom DTDs remain rejected');
    await new Promise(resolve => setTimeout(resolve,300));
    const saved = sent.filter(message => message.type === 'notebookChanged').at(-1).notebook;
    post({type:'restoreNotebook',attempt,documentKey:'cross-product',notebook:saved});
    assert.match(w.document.querySelector('.diagram-alternative')!.textContent!, /relationship between vectors/);
    click('clear-conversation'); w.document.querySelector<HTMLButtonElement>('[data-confirm-delete]')!.click();
    assert.equal(w.document.querySelector('.diagram-alternative'),null,'deleting the explanation also removes its fallback copy');
  } finally { await ui.close(); }
});

for (const mode of ['practice', 'tutor', 'doubt_solver'] as const) test(`${mode}: all nine Get Help actions share requests, context and inline replies`, async () => {
  const chats: string[] = [];
  const peer = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    remoteParticipants = new Map([['worker', peer]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok', sendText:async (text:string) => { chats.push(text); }};
    on() {} async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const assistant = mode === 'doubt_solver' ? 'Doubt Solver' : 'Instructor';
  const ui = surface({Room, RoomEvent:{}}, notebookMessageBar(assistant, mode === 'practice', '<button type="button" id="sound"></button>'));
  const {w,sent,post,code,click} = ui;
  const tick = () => new Promise(resolve => setTimeout(resolve,0));
  const question = 'What is the longest word you can think of where each letter appears only once?';
  const task: PracticeNotebook = {id:'letters',language:'python',title:question,question,starter:'',assistance:true,path:'/unused',account:'learner',tests:[]};
  try {
    post(mode === 'practice' ? {type:'openPractice'} : {type:'openTutor',mode});
    if (mode === 'tutor') selectLesson(w, sent.at(-1).attempt);
    const attempt = sent.at(-1).attempt;
    const initial = mode === 'practice' ? practiceDocument(task) : {...emptyNotebook(),cells:[{id:'question',kind:'board',text:question}]};
    post({type:'restoreNotebook',attempt,documentKey:mode,notebook:initial});
    post(mode === 'practice' ? {type:'practiceReady',attempt,practice:task,aiEnabled:true}
      : {type:'grant',attempt,url:'unused',token:'unused',chapterId});
    await tick();
    const actions = [...w.document.querySelectorAll<HTMLButtonElement>('#notebook-help-actions [data-practice-strategy]')];
    assert.deepEqual(actions.map(action => action.textContent), ['Explain problem','Explain code','Explain simply','Summarise','Explain errors','Explain failed tests','Give an example','Quiz me','Next step']);
    actions[0].click();
    const empty = sent.filter(message => message.type === 'notebookTurn').at(-1);
    assert.equal(empty.snapshot.source,'', 'problem help works before writing code');
    assert.equal(empty.submitted,false);
    assert.equal(empty.snapshot.question,question);
    post({type:'notebookReply',attempt,request:empty.request,content:'Find a word with no repeated letters.'}); await tick();
    if (mode !== 'practice') click('add-code');
    const element = w.document.querySelector('.practice-code-editor')!;
    const editor = code(element);
    editor.dispatch({changes:{from:0,insert:'word = "letters"\nprint(missing)'},selection:{anchor:17}}); editor.focus();
    click('add-note');
    const note = w.document.querySelector<HTMLTextAreaElement>('[aria-label="My notes"]')!;
    note.value = 'PRIVATE scratch'; note.dispatchEvent(new w.Event('input'));
    element.querySelector<HTMLButtonElement>('[data-action=run]')!.click();
    const run = sent.filter(message => message.type === 'codeAction').at(-1);
    post({type:'codeResult',attempt,request:run.request,snippet:run.snippet,revision:run.revision,
      execution:{status:'exited',exit_code:1,stdout:'',stderr:'NameError: missing',truncated:false,duration_ms:1}});
    const strategies = ['plan','trace','simplify','reflect','read_error','by_hand','walkthrough','by_hand','small_steps'];
    for (const [i,action] of actions.entries()) {
      action.click();
      const request = sent.filter(message => message.type === 'notebookTurn').at(-1);
      assert.equal(request.strategy,strategies[i]); assert.equal(request.submitted,false);
      assert.equal(request.snapshot.source,editor.state.doc.toString());
      assert.equal(request.focusLine,2); assert.equal(request.run.stderr,'NameError: missing');
      assert.doesNotMatch(JSON.stringify(request),/PRIVATE scratch/);
      assert.ok(actions.every(button => button.disabled));
      const count = sent.filter(message => message.type === 'notebookTurn').length;
      action.click(); assert.equal(sent.filter(message => message.type === 'notebookTurn').length,count);
      post({type:'notebookReply',attempt,request:request.request,content:`Shared reply ${i}`,replies:['Explain more','I have an idea']});
      await tick();
      assert.match(w.document.getElementById('feed')!.textContent!,new RegExp(`Shared reply ${i}`));
      assert.ok(actions.every(button => !button.disabled));
      assert.match(w.document.getElementById('status')!.textContent!,new RegExp('^' + assistant + ' replied'));
    }
    assert.deepEqual(chats,[], 'Get Help uses the same coach path in every mode, never answer/chat delivery');
    const formal = w.document.querySelector<HTMLButtonElement>('[data-lesson-action="formalExplanation"]');
    if (mode === 'practice') assert.ok(!formal || formal.hidden);
    else {
      assert.ok(formal && !formal.hidden && !formal.disabled);
      formal.click(); await tick();
      assert.equal(chats.at(-1),'Give me the formal version of this explanation.');
    }
    const reply = [...w.document.querySelectorAll<HTMLButtonElement>('[data-reply]')].find(button => !button.disabled)!;
    reply.click();
    const followup = sent.filter(message => message.type === 'notebookTurn').at(-1);
    assert.match(followup.message,/^Explain more\. Answer this request itself; do not repeat your last reply\./, 'a chip asks for its own intent first');
    assert.match(followup.message,/Your last reply, for context only: Shared reply 8/);
    post({type:'notebookReply',attempt,request:followup.request,error:'Service unavailable'}); await tick();
    assert.ok(actions.every(button => !button.disabled));
    assert.match(w.document.getElementById('status')!.textContent!,/Service unavailable/);
    assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/Service unavailable/, 'failure stays visible beside Get Help');
    post({type:'codeSettings',aiEnabled:false});
    assert.ok(actions.every(button => button.disabled));
  } finally { await ui.close(); }
});

test('desktop media controls explain connection, session and mode restrictions without starting capture', async () => {
  let captured = 0;
  class Room {
    remoteParticipants = new Map([['worker', {identity:'worker', isAgent:true, trackPublications:new Map()}]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok'};
    on() {} async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ui = surface({Room, RoomEvent:{}, createLocalAudioTrack:async () => {captured++;}},
    notebookMessageBar('Instructor', false, '<button type="button" id="audio-microphone" data-live-mic></button><button type="button" id="sound"></button>', true));
  const {w,post,sent,click} = ui, tick = () => new Promise(r => setTimeout(r,0));
  const message = w.document.getElementById('media-control-status')!;
  const mic = w.document.getElementById('audio-microphone') as HTMLButtonElement;
  try {
    post({type:'openTutor'}); selectLesson(w,sent.at(-1).attempt);
    // Not being connected is already in the header; the microphone keeps the reason in its own label.
    assert.equal(message.hidden,true); assert.match(mic.title, /Connect to Instructor/); assert.equal(mic.getAttribute('aria-label'),mic.title); assert.equal(mic.disabled,true);
    let attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'no-media',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,media:false}); await tick();
    assert.equal(message.hidden,false); assert.match(message.textContent!, /Microphone unavailable/);
    assert.equal((w.document.getElementById('audio-camera') as HTMLButtonElement).disabled,false, 'still photos use the attachment channel');
    assert.equal(mic.title,message.textContent); assert.equal(mic.getAttribute('aria-describedby'),message.id);
    click('audio-microphone'); assert.equal(captured,0);
    post({type:'openTutor',mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(w, sent.at(-1).attempt); attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'doubt-media',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',media:true}); await tick();
    assert.equal(message.hidden,true); assert.equal(mic.disabled,false);
    assert.equal((w.document.getElementById('audio-camera') as HTMLButtonElement).disabled,false);
    post({type:'openTutor'}); selectLesson(w,sent.at(-1).attempt); attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'voice-enabled',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,media:true}); await tick();
    assert.equal(message.hidden,true); assert.equal(mic.disabled,false); assert.equal(mic.title,'Start microphone');
    assert.equal(captured,0,'making capture available never opts the learner in');
  } finally { await ui.close(); }
});

test('Instructor activity survives microphone shutdown and clears on idle, reconnect and session changes', async () => {
  const rpcs:any[]=[];
  const rooms: Room[] = [];
  const agent = {identity:'worker', isAgent:true, attributes:{'lk.agent.state':'thinking'}, trackPublications:new Map()};
  let stopped = 0;
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async (request:any) => {rpcs.push(request);return 'ok';}, publishTrack:async () => {}, unpublishTrack:async () => {}};
    constructor() { rooms.push(this); }
    on(name:string, listener:Function) { this.listeners.set(name, listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const names = ['ParticipantAttributesChanged','TrackSubscribed','DataReceived','Reconnecting','Reconnected','Disconnected'];
  let grantMicrophone!: () => void;
  const permission = new Promise<void>(resolve => { grantMicrophone = resolve; });
  const ui = surface({Room, RoomEvent:Object.fromEntries(names.map(name => [name,name])),
    createLocalAudioTrack:async () => { await permission; return {stop() { stopped++; }, mediaStreamTrack:{addEventListener() {}}}; }},
    notebookMessageBar('Instructor', false, '<button type="button" id="audio-microphone" data-live-mic></button><button type="button" id="sound"></button>', true));
  const {w,post,sent,click} = ui, tick = () => new Promise(r => setTimeout(r,0));
  const activity = w.document.getElementById('assistant-activity')!;
  try {
    assert.equal(activity.hidden, true);
    post({type:'openTutor'}); selectLesson(w,sent.at(-1).attempt);
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'linux-voice',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,media:true}); await tick();
    assert.equal(activity.textContent, 'Thinking…', 'hydrate a response already processing when connected');
    assert.equal(activity.hidden, false);
    const state = (value:string) => {
      agent.attributes['lk.agent.state'] = value;
      rooms[0].listeners.get('ParticipantAttributesChanged')!({'lk.agent.state':value},agent);
    };
    state('listening'); assert.equal(activity.hidden, true);
    const audio = w.document.createElement('audio');
    audio.play = async () => {};
    audio.pause = () => {};
    rooms[0].listeners.get('TrackSubscribed')!({kind:'audio', attach:() => audio}, {}, agent);
    state('speaking');
    // Two full on/off cycles while replying: the mic controls input only and never stops the reply.
    for (let cycle = 0; cycle < 2; cycle++) {
      click('audio-microphone');
      if (cycle === 0) grantMicrophone();
      await tick();
      assert.equal(w.document.getElementById('audio-microphone')!.getAttribute('aria-pressed'),'true');
      assert.equal(audio.muted, false, `turning the microphone on (cycle ${cycle + 1}) keeps the reply audible`);
      click('audio-microphone'); await tick();
      assert.equal(audio.muted, false, `turning the microphone off (cycle ${cycle + 1}) keeps the reply audible`);
    }
    assert.equal(rpcs.some(r => r.method === 'stop_speaking'), false, 'toggling the microphone never stops the reply');
    click('audio-microphone'); await tick();
    state('thinking');
    click('audio-microphone'); await tick();
    assert.equal(stopped,3);
    assert.equal(w.document.getElementById('audio-microphone')!.getAttribute('aria-pressed'),'false');
    assert.equal(w.document.getElementById('status')!.textContent,'Microphone off.');
    assert.ok(rpcs.some(r=>r.method==='toggle_audio' && JSON.parse(r.payload).commit_turn===true));
    assert.equal(activity.hidden,false);
    assert.equal(activity.textContent,'Thinking…','stopping capture must not clear an in-flight response');
    rooms[0].listeners.get('ParticipantAttributesChanged')!({'lk.agent.state':'listening'},{identity:'other',isAgent:true});
    rooms[0].listeners.get('ParticipantAttributesChanged')!({'lk.agent.state':'listening'},{identity:'learner',isAgent:false});
    rooms[0].listeners.get('ParticipantAttributesChanged')!({'unrelated':'value'},agent);
    assert.equal(activity.textContent,'Thinking…','only this session’s agent state affects its indicator');
    state('speaking'); assert.equal(activity.textContent,'Replying…');
    state('listening'); assert.equal(activity.hidden,true); assert.equal(activity.textContent,'');
    const svg = '<svg viewBox="0 0 320 120"><text x="10" y="30">Terminal → shell</text></svg>';
    const receive = rooms[0].listeners.get('DataReceived')!;
    receive(new TextEncoder().encode(JSON.stringify({method:'display_on_screen',content:'```svg\n' + svg + '\n```\n\nWhat does `pwd` mean?',is_question_prompt:true,tutor_checkpoint_id:'pwd'})),agent);
    assert.equal(w.document.getElementById('composer-context')!.textContent,'Replying to: Diagram What does pwd mean?');
    assert.ok(w.document.querySelector('#feed img.board-diagram'));
    assert.equal(w.document.querySelector('[data-lesson-action="continueLesson"]'),null,'an unanswered question still requires an answer');
    receive(new TextEncoder().encode(JSON.stringify({method:'display_on_screen',content:'The shell interprets pwd.',tutor_feedback:true,tutor_checkpoint_id:'pwd'})),agent);
    assert.ok(w.document.querySelector('.composer-quick-actions #practice-help'));
    assert.equal(w.document.querySelector<HTMLButtonElement>('.composer-quick-actions [data-lesson-action="continueLesson"]')!.hidden,false);
    state('thinking'); rooms[0].listeners.get('Reconnecting')!();
    assert.equal(activity.hidden,true);
    state('speaking'); assert.equal(activity.hidden,true,'do not display activity for a disconnected transport');
    rooms[0].listeners.get('Reconnected')!(); assert.equal(activity.textContent,'Replying…');
    click('end'); assert.equal(activity.hidden,true);
    state('thinking'); assert.equal(activity.hidden,true,'late events from the old room are ignored');
  } finally { await ui.close(); }
});

test('browser task questions use the Instructor composer and acknowledge progress only after delivery', async () => {
  const messages:string[]=[],rpcs:any[]=[],tracks:any[]=[],rooms:Room[]=[];
  const agent={identity:'worker',isAgent:true,trackPublications:new Map()};let fail=false,failObservation=false;
  class Room {
    listeners=new Map<string,Function>();
    remoteParticipants=new Map([['worker',agent]]);
    localParticipant={registerRpcMethod(){},performRpc:async(request:any)=>{
      rpcs.push(request);if(failObservation&&request.method==='on_browser_activity')throw new Error('offline');return 'ok';},
      sendText:async(text:string)=>{if(fail)throw new Error('offline');messages.push(text);},
      publishTrack:async(track:any)=>{tracks.push(track);},unpublishTrack:async()=>{}};
    constructor(){rooms.push(this);}
    on(name:string,listener:Function){this.listeners.set(name,listener);}
    async connect(){} async disconnect(){} async startAudio(){} registerTextStreamHandler(){}
  }
  const track={stop(){},mediaStreamTrack:{addEventListener(){}}};
  const ui=surface({Room,RoomEvent:Object.fromEntries(['Reconnecting','Reconnected','Disconnected'].map(name=>[name,name])),createLocalAudioTrack:async()=>track},
    notebookMessageBar('Instructor',false,'<button type="button" id="audio-microphone" data-live-mic disabled></button><button type="button" id="sound"></button>', true));
  const {w,post,sent,click}=ui,wait=()=>new Promise(r=>setTimeout(r,10));
  try {
    post({type:'openTutor',mode:'tutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'ERPNext Essentials',chapters:[
      {id:chapterId,name:'Company accounts'},{id:'next-chapter',name:'Customers'}]},
      {name:'Python',chapters:[{id:'python-chapter',name:'Lists'}]}]});
    w.document.querySelector<HTMLButtonElement>('#lesson-list button')!.click();const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'browser',notebook:emptyNotebook()});
    const connection = 'a'.repeat(32);
    const erpnextRuntime = {sites:[{id:connection,name:'Warehouse Training',origin:'https://erp.example.com'}]};
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,media:true,browserCourse:true,erpnextRuntime});await wait();
    const runtime = w.document.getElementById('course-runtime') as HTMLSelectElement;
    assert.equal(runtime.disabled,false);
    assert.equal(runtime.querySelector('option[value="erpnext:connect"]')?.textContent,'Connect to ERPNext…');
    assert.equal(runtime.querySelector(`option[value="erpnext:${connection}"]`)?.textContent,'Warehouse Training');
    runtime.value = `erpnext:${connection}`;runtime.dispatchEvent(new w.Event('change'));
    assert.deepEqual({...sent.at(-1)},{type:'runtime',runtime:`erpnext:${connection}`,attempt});
    post({type:'erpnextRuntime',attempt,state:{...erpnextRuntime,active:connection}});
    assert.equal(runtime.selectedOptions[0].textContent,'ERPNext · Warehouse Training');
    const mic=w.document.getElementById('audio-microphone') as HTMLButtonElement;
    assert.equal(mic.disabled,false);click('audio-microphone');await wait();
    assert.equal(mic.disabled,false,'capture finishes with the microphone still operable');
    assert.equal(mic.getAttribute('aria-pressed'),'true');assert.equal(mic.title,'Stop microphone');assert.equal(tracks.length,1);
    assert.ok(rpcs.some(r=>r.method==='toggle_audio'&&JSON.parse(r.payload).input_enabled===true));
    click('audio-microphone');await wait();assert.equal(mic.getAttribute('aria-pressed'),'false');
    const question={id:'company:check-1',task:'company',kind:'explanation',title:'Company accounts',
      question:'What grows when you bill a customer?',context:'Saved record: Training company.',options:[],minLength:30,maxLength:500};
    const update=(q:unknown)=>post({type:'browserObservation',attempt,chapter:chapterId,observation:{task:'company'},question:q});
    update(question);update(question);
    assert.equal(w.document.querySelectorAll('[data-browser-question-id]').length,1,'repeat observations do not duplicate the question');
    assert.match(w.document.getElementById('feed')!.textContent!,/What grows when you bill a customer/);
    assert.equal(w.document.querySelectorAll('#message-bar textarea').length,1);
    const continueButton=w.document.querySelector<HTMLButtonElement>('[data-browser-continue]')!;
    assert.equal(continueButton.textContent,'Answer question');
    continueButton.click();
    assert.equal(sent.some(m=>m.type==='browserContinue'),false,'Continue points at the unanswered Instructor question');
    const field=w.document.getElementById('message') as HTMLTextAreaElement;
    const shortcut=(target:Element,extra={})=>{
      const event=new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...extra});
      target.dispatchEvent(event);return event;
    };
    let forwarded=0;w.addEventListener('keydown',()=>{forwarded++;});
    field.value='Short';field.dispatchEvent(new w.Event('input'));click('send');await wait();
    assert.equal(field.value,'Short');assert.equal(messages.length,0);
    assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/Write 30–500 characters/,'invalid answers explain why the button did not send');
    (w.document.querySelector('.ask-instead') as HTMLButtonElement).click();
    const attachment=w.document.querySelector<HTMLElement>('[aria-label="Add attachments"]')!;
    attachment.focus();update(question);
    assert.equal(w.document.activeElement,attachment,'background task updates do not steal focus');
    post({type:'browserObservation',attempt,chapter:chapterId,observation:{task:'company'},question,focusQuestion:question.id});
    assert.equal(w.document.activeElement,field);assert.equal(field.value,'Short','handoff preserves an existing draft');
    assert.equal(field.placeholder,'Your answer and reasoning…','an explicit handoff restores answer mode');
    field.value='Receivables increase because the customer now owes us for this invoice.';
    field.dispatchEvent(new w.Event('input'));
    assert.equal(shortcut(field,{isComposing:true}).defaultPrevented,false,'IME confirmation never submits');
    assert.equal(shortcut(field,{shiftKey:true}).defaultPrevented,false,'Shift+Enter keeps a multiline draft');
    const before=forwarded;
    for (const extra of [{ctrlKey:true}, {metaKey:true}]) {
      assert.equal(shortcut(field,extra).defaultPrevented,false);
    }
    assert.equal(shortcut(field,{repeat:true}).defaultPrevented,true);
    await wait();assert.equal(messages.length,0,'modified or repeated Enter does not submit');
    post({type:'browserObservation',attempt,chapter:chapterId,observation:{task:'company'},question,focusQuestion:question.id});
    await wait();assert.equal(messages.length,0,'opening the answer box never submits even a complete draft');
    rooms[0].listeners.get('Reconnecting')!();
    assert.equal(sent.filter(m=>m.type==='browserState').at(-1).connected,false,'ERPNext immediately sees the reconnecting state');
    assert.equal((w.document.getElementById('send') as HTMLButtonElement).disabled,true);
    shortcut(field);
    assert.ok(field.value);assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/Reconnecting/);
    const observations=rpcs.filter(r=>r.method==='on_browser_activity').length;
    rooms[0].listeners.get('Reconnected')!();await wait();
    assert.ok(rpcs.filter(r=>r.method==='on_browser_activity').length>observations,'reconnection resynchronizes the form without waiting for an edit');
    assert.equal(sent.filter(m=>m.type==='browserState').at(-1).connected,true);
    assert.equal(messages.length,0,'reconnection never sends the unfinished draft');
    failObservation=true;click('send');await wait();
    assert.equal(sent.filter(m=>m.type==='browserState').at(-1).connected,false,'RPC failure cannot leave a stale connected indicator');
    assert.ok(field.value);assert.equal(sent.some(m=>m.type==='browserAnswer'),false);
    assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/draft.*Reconnect Instructor/);
    failObservation=false;
    fail=true;click('send');await wait();
    assert.equal(sent.some(m=>m.type==='browserAnswer'),false);assert.ok(field.value);
    assert.match(w.document.getElementById('status')!.textContent!,/delivery could not be confirmed/);
    assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/draft is still here.*before sending again/);
    fail=false;assert.equal(shortcut(field).defaultPrevented,true);await wait();
    assert.equal(forwarded,before,'editing keys never escape to the desktop workbench');
    assert.match(messages.at(-1)!,/Question: What grows.*\nMy answer: Receivables/);
    assert.equal(sent.filter(m=>m.type==='browserAnswer').length,1);assert.equal(field.value,'');
    assert.equal(continueButton.textContent,'Continue task');
    continueButton.click();
    assert.equal(sent.filter(m=>m.type==='browserContinue').length,1,'Continue goes through the practical task player');
    assert.equal(messages.length,1,'Continue does not send an unrelated generic lesson prompt');
    update({...question,id:'company:prediction',kind:'prediction',options:['Cash grows','Receivables grow'],minLength:1});
    const choices=w.document.querySelectorAll<HTMLButtonElement>('[data-browser-question="company:prediction"]');
    choices[1].click();assert.equal(field.value,'Receivables grow');click('send');await wait();
    assert.match(messages.at(-1)!,/without revealing the outcome/);
    update(null);assert.equal(choices[0].disabled,true,'old questions cannot answer a later task');
    const joins=sent.filter(m=>m.type==='join').length;
    click('skip-chapter');
    assert.equal(sent.at(-1).type,'browserChooseChapter');assert.equal(sent.at(-1).chapterId,'next-chapter');
    assert.equal(sent.filter(m=>m.type==='join').length,joins,'browser courses move both panels together, after the unsaved-form check');
    const coursePicker=w.document.getElementById('lesson-course') as HTMLSelectElement;
    coursePicker.value='Python';coursePicker.dispatchEvent(new w.Event('change'));
    w.document.querySelector<HTMLButtonElement>('#lesson-list button')!.click();
    assert.equal(sent.at(-1).type,'join');assert.equal(sent.at(-1).chapterId,'python-chapter','changing courses leaves the browser course normally');
  } finally {await ui.close();}
});

test('opening the same ERPNext lesson reconnects after disconnect and preserves the saved answer',async()=>{
  const rooms:Room[]=[],messages:string[]=[];
  const agent={identity:'worker',isAgent:true,trackPublications:new Map()};
  class Room {
    listeners=new Map<string,Function>();remoteParticipants=new Map([['worker',agent]]);
    localParticipant={registerRpcMethod(){},performRpc:async()=> 'ok',sendText:async(text:string)=>{messages.push(text);}};
    constructor(){rooms.push(this);}on(name:string,listener:Function){this.listeners.set(name,listener);}
    async connect(){}async disconnect(){}registerTextStreamHandler(){}
  }
  const ui=surface({Room,RoomEvent:{Disconnected:'Disconnected',DataReceived:'DataReceived'}}),{w,post,sent,click}=ui;
  const wait=()=>new Promise(r=>setTimeout(r,10));
  try {
    post({type:'openTutor',mode:'tutor'});selectLesson(w,sent.at(-1).attempt);
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'supplier',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,browserCourse:true});await wait();
    const question={id:'supplier:check',task:'supplier',kind:'explanation',title:'Create a supplier',
      question:'Why keep a separate customer record?',context:'Saved supplier record.',options:[],minLength:30,maxLength:500};
    post({type:'browserObservation',attempt,chapter:chapterId,observation:{task:'supplier'},question});
    const field=w.document.getElementById('message') as HTMLTextAreaElement;
    const answer='Separate records keep payables and receivables distinct for the same company.';
    field.value=answer;field.dispatchEvent(new w.Event('input'));
    rooms[0].listeners.get('Disconnected')!();
    const saved=sent.filter(m=>m.type==='notebookChanged').at(-1).notebook;
    assert.equal(saved.textDraft,answer);assert.equal(field.value,answer);
    post({type:'chooseCourse',course:'ERPNext Essentials',lesson:chapterId});
    const retry=sent.filter(m=>m.type==='join').at(-1);
    assert.notEqual(retry.attempt,attempt,'the same lesson can reconnect instead of silently ignoring the request');
    post({type:'restoreNotebook',attempt:retry.attempt,documentKey:'supplier-retry',notebook:saved});
    post({type:'grant',attempt:retry.attempt,url:'unused',token:'unused',chapterId,browserCourse:true});
    post({type:'browserObservation',attempt:retry.attempt,chapter:chapterId,observation:{task:'supplier'},question,focusQuestion:question.id});await wait();
    assert.equal(field.value,answer);assert.equal(messages.length,0);
    assert.equal(w.document.getElementById('notebook-help-status')!.textContent,'','the earlier failure is cleared; the connection is reported once, in the header');
    assert.equal(w.document.getElementById('status')!.textContent,'Instructor connected');
    click('send');await wait();
    assert.equal(messages.length,1);assert.match(messages[0],/My answer: Separate records/);
    assert.equal(field.value,'');assert.equal(sent.filter(m=>m.type==='browserAnswer').length,1);
    rooms[1].listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify({method:'display_on_screen',
      content:'Correct: separate supplier and customer records keep payables and receivables distinct.'})),agent);
    assert.match(w.document.getElementById('feed')!.textContent!,/Correct: separate supplier and customer records/);
  }finally{await ui.close();}
});


test('an ERP answer waits for lesson preload without a second send or false delivery error',async()=>{
  const messages:string[]=[],observations:any[]=[];
  const agent={identity:'worker',isAgent:true,trackPublications:new Map()};let loaded=false;
  class Room {
    remoteParticipants=new Map([['worker',agent]]);
    localParticipant={registerRpcMethod(){},performRpc:async(request:any)=>{
      if(request.method==='on_browser_activity' && JSON.parse(request.payload).task) {
        observations.push(JSON.parse(request.payload));return loaded?'ok':'unavailable';
      }
      return 'ok';
    },sendText:async(text:string)=>{messages.push(text);}};
    on(){}async connect(){}async disconnect(){}registerTextStreamHandler(){}
  }
  const ui=surface({Room,RoomEvent:{}}),{w,post,sent,click}=ui,wait=()=>new Promise(r=>setTimeout(r,10));
  try {
    post({type:'openTutor',mode:'tutor'});selectLesson(w,sent.at(-1).attempt);
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'erp-preload',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,browserCourse:true});await wait();
    const question={id:'supplier:check',task:'supplier',kind:'explanation',title:'Supplier',question:'Why separate records?',
      context:'Saved supplier.',options:[],minLength:30,maxLength:500};
    post({type:'browserObservation',attempt,chapter:chapterId,observation:{task:'supplier'},question});await wait();
    const field=w.document.getElementById('message') as HTMLTextAreaElement;
    field.value='Supplier and customer records keep payables and receivables separate.';field.dispatchEvent(new w.Event('input'));click('send');await wait();
    assert.equal(messages.length,0);assert.ok(field.value);
    assert.doesNotMatch(w.document.getElementById('notebook-help-status')!.textContent!,/unavailable|could not/);
    loaded=true;await new Promise(r=>setTimeout(r,300));
    assert.equal(messages.length,1);assert.equal(field.value,'');
    assert.equal(sent.filter(m=>m.type==='browserAnswer').length,1);
    assert.deepEqual(observations[0],observations[1],'only the same read-only snapshot is retried');
  }finally{await ui.close();}
});

test('ERPNext observation failure exposes reconnect and preserves the unsent explanation',async()=>{
  const messages:string[]=[],observations:number[]=[],rooms:Room[]=[];
  const agent={identity:'worker',isAgent:true,trackPublications:new Map()};let failed=true;
  class Room {
    remoteParticipants=new Map([['worker',agent]]);
    localParticipant={registerRpcMethod(){},performRpc:async(request:any)=>{
      if(request.method==='on_browser_activity') {
        observations.push(JSON.parse(request.payload).sequence);
        if(failed)throw new Error('Method not supported at destination');
      }
      return 'ok';
    },sendText:async(text:string)=>{messages.push(text);}};
    constructor(){rooms.push(this);}on(){}async connect(){}async disconnect(){}registerTextStreamHandler(){}
  }
  const ui=surface({Room,RoomEvent:{}}),{w,post,sent,click}=ui,wait=()=>new Promise(r=>setTimeout(r,10));
  try {
    post({type:'openTutor',mode:'tutor'});selectLesson(w,sent.at(-1).attempt);
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'erp-retry',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId,browserCourse:true});await wait();
    const question={id:'item:check',task:'item',kind:'explanation',title:'Stock item',question:'Why maintain stock?',
      context:'Saved item record.',options:[],minLength:30,maxLength:500};
    post({type:'browserObservation',attempt,chapter:chapterId,observation:{task:'item'},question});await wait();
    const field=w.document.getElementById('message') as HTMLTextAreaElement;
    const answer='Maintain Stock records stock movements for this physical item.';
    field.value=answer;field.dispatchEvent(new w.Event('input'));
    const retryButton=w.document.getElementById('tutor') as HTMLButtonElement;
    assert.equal(retryButton.hidden,false);assert.equal(retryButton.textContent,'Reconnect Instructor');
    assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/Reconnect Instructor/);
    assert.doesNotMatch(w.document.getElementById('notebook-help-status')!.textContent!,/draft/i);
    click('send');await wait();
    assert.equal(field.value,answer);assert.equal(messages.length,0);
    assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/draft.*Reconnect Instructor/);
    assert.doesNotMatch(w.document.getElementById('notebook-help-status')!.textContent!,/Method not supported/);
    click('tutor');
    const retry=sent.filter(m=>m.type==='join').at(-1);
    assert.notEqual(retry.attempt,attempt);
    assert.equal(field.value,answer,'the draft stays visible even while reconnecting');
    assert.equal(sent.filter(m=>m.type==='notebookChanged').at(-1).notebook.textDraft,answer);
    failed=false;
    post({type:'grant',attempt:retry.attempt,url:'unused',token:'unused',chapterId,browserCourse:true});await wait();
    post({type:'browserObservation',attempt:retry.attempt,chapter:chapterId,observation:{task:'item'},question});await wait();
    assert.equal(messages.length,0,'reconnect does not submit the answer');
    assert.equal(retryButton.hidden,true);
    assert.ok(observations.every((n,i)=>i===0||n>observations[i-1]),'a rejoined worker never receives reset sequence numbers');
    click('send');await wait();assert.equal(messages.length,1);
    assert.equal(sent.filter(m=>m.type==='browserAnswer').length,1);
  }finally{await ui.close();}
});

test('GPU runtime selection stays selected and late CPU state cannot reroute the notebook', async () => {
  const ui=surface();try {
    const picker=ui.w.document.getElementById('course-runtime') as HTMLSelectElement;
    ui.post({type:'runtimeSelected',runtime:'cloud',label:'Cloud GPU · Jupyter',ready:true,message:'GPU connected. Compute costs are separate.'});
    assert.equal(picker.value,'cloud');
    ui.post({type:'workstationState',label:'CPU ready',machines:{machines:['course'],selected:'course'}});
    assert.equal(picker.value,'cloud');
    ui.post({type:'runtimeError',message:'Reconnect the selected GPU. No CPU fallback.'});
    assert.equal(picker.value,'cloud');
    assert.match(ui.w.document.getElementById('status')!.textContent!,/Reconnect/);
    ui.post({type:'runtimeSelected',runtime:'course'});
    assert.equal(picker.value,'course');
    ui.post({type:'runtimeSelected',runtime:'cloud',label:'Cloud GPU · Jupyter'});
    ui.post({type:'openPractice'});
    const attempt=ui.sent.at(-1).attempt;
    ui.post({type:'practiceReady',attempt,practice:{id:'cpu',language:'python'},codeRuntime:'Course'});
    assert.equal(picker.value,'course','opening CPU Practice removes a previous cloud selection');
    assert.equal((picker.querySelector('[value="cloud"]') as HTMLOptionElement).disabled,true);
  } finally {await ui.close();}
});

test('managed compute finishes only for the active full lesson and saves its recap before cleanup',async()=>{
  const rooms:any[]=[],agent={identity:'worker',isAgent:true,trackPublications:new Map()};
  class Room {
    listeners=new Map<string,Function>();remoteParticipants=new Map([['worker',agent]]);
    localParticipant={registerRpcMethod(){},performRpc:async()=> 'ok',sendText:async()=>{}};
    constructor(){rooms.push(this);}on(name:string,listener:Function){this.listeners.set(name,listener);}
    async connect(){}async disconnect(){}registerTextStreamHandler(){}
  }
  const ui=surface({Room,RoomEvent:Object.fromEntries(['DataReceived','Disconnected','Reconnecting','Reconnected','ParticipantDisconnected'].map(name=>[name,name]))});
  try {
    ui.post({type:'openTutor',mode:'tutor'});selectLesson(ui.w,ui.sent.at(-1).attempt);const attempt=ui.sent.at(-1).attempt;
    ui.post({type:'restoreNotebook',attempt,documentKey:'gpu-summary',notebook:emptyNotebook()});
    ui.post({type:'grant',attempt,url:'unused',token:'unused',chapterId,gpuRuntimes:true,gpuCount:2});await new Promise(resolve=>setTimeout(resolve,0));
    ui.post({type:'runtimeSelected',runtime:'cloud-cli',ready:true});
    const publish=(patch:object)=>rooms[0].listeners.get('DataReceived')(new TextEncoder().encode(JSON.stringify({method:'tutor_session_summary',subject:'Python',chapter:'Lists',topic:'Lists',is_complete:true,partial_session:false,summary_scope:'full',big_idea:'Saved recap',...patch})),agent);
    publish({partial_session:true,summary_scope:'partial'});assert.equal(ui.sent.filter(m=>m.type==='finishLab').length,0);
    publish({chapter:'Different chapter'});assert.equal(ui.sent.filter(m=>m.type==='finishLab').length,0);
    publish({});
    assert.equal(ui.sent.at(-1).type,'finishLab');assert.equal(ui.sent.at(-1).chapterId,chapterId);
    const saved=ui.sent.at(-2);assert.equal(saved.type,'notebookChanged');assert.equal(saved.documentKey,'gpu-summary');
    assert.ok(saved.notebook.cells.some((c:any)=>c.kind==='recap'&&c.text.includes('Saved recap')));
  }finally{await ui.close();}
});

test('silent completed cells explain no output without passing failed or cancelled runs', async () => {
  class Room {
    remoteParticipants = new Map([['worker', {identity:'worker', isAgent:true, trackPublications:new Map()}]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok'};
    on() {} async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ui = surface({Room, RoomEvent:{}}), {w,sent,post,click,code} = ui;
  try {
    post({type:'openTutor',mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(w, sent.at(-1).attempt); const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'silent',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused'}); await new Promise(resolve=>setTimeout(resolve,0));
    click('add-code'); const cell=w.document.querySelector<HTMLElement>('.practice-code-editor')!;
    code(cell).dispatch({changes:{from:0,insert:'assert 2 + 2 == 4'}});
    const status=cell.querySelector('.practice-status')!;
    for(const [state,exit,message] of [['exited',0,/successfully with no output.*passing assertions/],
      ['exited',1,/Run failed/],['cancelled',null,/Stopped/]] as const) {
      cell.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
      const request=sent.filter(m=>m.type==='codeAction').at(-1);
      post({type:'codeResult',attempt,snippet:request.snippet,revision:request.revision,request:request.request,
        execution:{status:state,exit_code:exit,stdout:'',stderr:exit===1?'AssertionError':'',truncated:false}});
      assert.match(status.textContent!,message);
      if(exit!==0)assert.doesNotMatch(status.textContent!,/successfully/);
    }
  } finally {await ui.close();}
});

test('sticky notebook index expands earlier explanations and retains chapter coverage', async () => {
  const ui=surface(), {w,sent,post}=ui;
  try {
    post({type:'openTutor',mode:'tutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters:[
      {id:'lists',name:'Lists',progress:{status:'covered',covered:1,total:1,topics:[]}},
      {id:chapterId,name:'Functions',progress:{status:'in_progress',covered:1,total:3,topics:[]}}
    ]}]});
    w.document.querySelectorAll<HTMLButtonElement>('#lesson-list button')[1].click();
    const attempt=sent.at(-1).attempt, notebook=emptyNotebook();
    notebook.cells=[{id:'explanation',kind:'board',text:'## Save the module\n\nRun the save cell first.',collapsed:true},
      {id:'verify',kind:'code',text:'assert 2 + 2 == 4',packet:{language:'python'}}];
    post({type:'restoreNotebook',attempt,documentKey:'navigation',notebook});
    const summary=w.document.querySelector('.notebook-progress')!;
    assert.match(summary.textContent!,/Functions.*1\/3 topics taught.*1\/2 chapters taught/);
    assert.match(summary.getAttribute('title')!,/mastery.*separately/);
    const select=w.document.querySelector<HTMLSelectElement>('.notebook-index')!;
    assert.equal(select.hidden,false);assert.match(select.options[1].textContent!,/Save the module/);
    select.value='explanation';select.dispatchEvent(new w.Event('change'));
    const row=w.document.querySelector<HTMLElement>('[data-cell-id="explanation"]')!;
    assert.equal(row.classList.contains('is-collapsed'),false);assert.equal(w.document.activeElement,row);
    assert.equal(select.value,'');
    post({type:'restoreNotebook',attempt,documentKey:'empty',notebook:emptyNotebook()});
    assert.equal(select.options.length,1);assert.equal(select.hidden,true);
  } finally {await ui.close();}
});

test('learning preferences restore before greeting and changing a persona keeps the current lesson', async () => {
  const {learningPreferencesHtml} = await import('../src/learningPreferences');
  const calls:any[] = [];
  class Room {
    remoteParticipants = new Map([['worker',{identity:'worker',isAgent:true,trackPublications:new Map()}]]);
    localParticipant = {registerRpcMethod(){},performRpc:async (request:any)=>{calls.push(request);return 'ok';}};
    on(){} async connect(){} async disconnect(){} registerTextStreamHandler(){}
  }
  const ui = surface({Room,RoomEvent:{}}, notebookMessageBar('Instructor',true,'<button id="sound"></button>')+learningPreferencesHtml);
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  try {
    ui.post({type:'openTutor',mode:'doubt_solver'}); if (ui.sent.at(-1).type === 'tutorLessons') selectLesson(ui.w, ui.sent.at(-1).attempt);
    const attempt=ui.sent.at(-1).attempt;
    const preferences={preferred_name:'Varun',check_frequency:'minimal',voice:'calm',doubt_style:'guided'};
    ui.post({type:'learningPreferences',preferences});
    ui.post({type:'restoreNotebook',attempt,documentKey:'preferences',notebook:emptyNotebook()});
    ui.post({type:'grant',attempt,url:'unused',token:'unused'}); await tick();
    const applied=calls.find(call=>call.method==='set_learning_preferences');
    assert.deepEqual(JSON.parse(applied.payload),preferences);
    assert.ok(calls.indexOf(applied)<calls.findIndex(call=>call.method==='switch_mode'));
    assert.equal((ui.w.document.getElementById('preferred-name') as HTMLInputElement).value,'Varun');
    const style=ui.w.document.getElementById('doubt-style') as HTMLSelectElement;
    assert.equal(style.value,'guided');
    assert.equal(ui.w.document.getElementById('doubt-style-setting')!.hidden,false);
    style.value='direct'; style.dispatchEvent(new ui.w.Event('change'));
    ui.post({type:'learningPreferences',preferences:ui.sent.at(-1).preferences}); await tick();
    assert.equal(JSON.parse(calls.at(-1).payload).doubt_style,'direct');
    const voice=ui.w.document.getElementById('preferred-voice') as HTMLSelectElement;
    voice.value='energetic'; voice.dispatchEvent(new ui.w.Event('change'));
    const save=ui.sent.at(-1);
    assert.equal(save.type,'learningPreferences'); assert.equal(save.preferences.voice,'energetic');
    ui.post({type:'learningPreferences',preferences:save.preferences}); await tick();
    assert.equal(calls.filter(call=>call.method==='switch_mode').length,1,'a voice choice must not restart the lesson');
    assert.equal(JSON.parse(calls.filter(call=>call.method==='set_learning_preferences').at(-1).payload).voice,'energetic');
    assert.match(ui.w.document.getElementById('learning-preferences-status')!.textContent!,/next spoken reply/);
  } finally {await ui.close();}
});

test('session restore is explicit and scoped to the current notebook',async()=>{
  const ui=surface(),{post,w,sent}=ui;
  try {
    post({type:'restoreNotebook',documentKey:'lesson-a',notebook:emptyNotebook()});
    post({type:'runtimeHistory',documentKey:'lesson-a',count:2,needsRestore:true});
    assert.match(w.document.getElementById('runtime-restore')!.textContent!,/repeats file writes/);
    assert.equal(sent.some(m=>m.type==='restoreRuntime'),false);
    w.document.querySelector<HTMLButtonElement>('#runtime-restore button')!.click();
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))),{type:'restoreRuntime',documentKey:'lesson-a'});
    const bar = w.document.getElementById('runtime-restore')!;
    const state = {type:'runtimeHistory',documentKey:'lesson-a',count:2,needsRestore:true};
    post({...state,error:'Restoration stopped at code-2'});
    assert.equal(bar.querySelector('[role="alert"]')?.textContent,'Restoration stopped at code-2');
    assert.doesNotMatch(w.document.getElementById('status')!.textContent!,/Restoration stopped/);
    bar.querySelector<HTMLButtonElement>('button.quiet')!.click();
    assert.equal(bar.querySelector('[role="alert"]'),null,'Start fresh clears the error before confirmation');
    assert.equal(bar.querySelector('[data-confirm-delete]')!.textContent,'Start fresh');
    bar.querySelector<HTMLButtonElement>('.delete-confirmation button')!.click();
    assert.equal(sent.some(m=>m.type==='freshRuntime'),false,'Cancel preserves the recorded runs');
    post({...state,restoreBlockReason:'This history includes interactive input. Choose Start fresh.'});
    assert.match(bar.querySelector('[role="alert"]')!.textContent!,/interactive input/);
    const buttons = [...bar.querySelectorAll('button')];
    assert.deepEqual(buttons.map(button=>button.textContent),['Start fresh']);
    buttons[0].click();
    assert.equal(bar.querySelector('[role="alert"]'),null);
    bar.querySelector<HTMLButtonElement>('[data-confirm-delete]')!.click();
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))),{type:'freshRuntime',documentKey:'lesson-a'});
    post({type:'runtimeHistory',documentKey:'another-lesson',count:0,needsRestore:false});
    assert.equal(w.document.getElementById('runtime-restore')!.hidden,false);
    post({type:'runtimeHistory',documentKey:'lesson-a',count:2,needsRestore:false});
    assert.equal(w.document.getElementById('runtime-restore')!.hidden,true);
  } finally {await ui.close();}
});

test('Doubt Solver prevents missing ScriptedModel setup, accepts a repaired lesson cell and shows its actual output', async () => {
  class Room {
    remoteParticipants = new Map([['worker',{identity:'worker',isAgent:true,trackPublications:new Map()}]]);
    localParticipant = {registerRpcMethod(){},performRpc:async()=> 'ok'};
    on(){} async connect(){} async disconnect(){} registerTextStreamHandler(){}
  }
  const ui=surface({Room,RoomEvent:{}}),{w,sent,post,code}=ui;
  const runtime=new NotebookCells(()=>({}),undefined,undefined,15000);
  const source=readFileSync(resolve(__dirname,'../../../../content/courses/build-ai-agents/chapters/ch01_agent_loop.py'),'utf8');
  const program=source.match(/```python\n(class ScriptedModel:[\s\S]*?)\n```/)![1];
  const missing=program.slice(program.indexOf('model = ScriptedModel'));
  try {
    post({type:'openTutor',mode:'doubt_solver'});selectLesson(w,sent.at(-1).attempt);const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'scripted-model',notebook:{...emptyNotebook(),cells:[
      {id:'example',kind:'board',text:'Predict the third printed line.\n\n```python\n'+missing+'\n```'},
      {id:'reading',kind:'board',text:'```python prediction-only\nprint(undefined_name)\n```'},
    ]}});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId});await new Promise(r=>setTimeout(r,0));
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,1,'reading-only snippets have no Run control');
    assert.match(w.document.querySelector('.code-reading-only')!.textContent!,/Prediction only · not executable/);
    const cell=w.document.querySelector('.practice-code-editor')!,run=cell.querySelector<HTMLButtonElement>('[data-action="run"]')!;
    assert.equal(run.disabled,true);assert.match(cell.querySelector('.code-completeness')!.textContent!,/Missing setup: ScriptedModel/);
    run.click();assert.equal(sent.filter(m=>m.type==='codeAction').length,0);
    const editor=code(cell);editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:program}});
    assert.equal(run.disabled,false,'adding the exact lesson definition enables Run');
    run.click();const request=sent.filter(m=>m.type==='codeAction').at(-1);
    const execution=await runtime.run(request.language,request.source,'',{interactive:false});
    post({...request,type:'codeResult',execution});
    assert.equal(execution.exit_code,0);assert.equal(execution.stdout.trim().split('\n').at(-1),'None 3');
    assert.match(cell.querySelector('.practice-output')!.textContent!,/None 3/);
    assert.doesNotMatch(cell.querySelector('.practice-output')!.textContent!,/NameError/);
  } finally {await runtime.close();await ui.close();}
});


test('a stalled Doubt Solver delivery releases the composer, keeps the draft and never retries automatically',async()=>{
  let sends=0,finish:()=>void=()=>{};const rpcs:any[]=[];
  class Room {
    remoteParticipants=new Map([['worker',{identity:'worker',isAgent:true,trackPublications:new Map()}]]);
    localParticipant={registerRpcMethod(){},performRpc:async(rpc:any)=>{rpcs.push(rpc);return 'ok';},
      sendText:()=>{sends++;return new Promise<void>(resolve=>{finish=resolve;});}};
    on(){}async connect(){}async disconnect(){}registerTextStreamHandler(){}
  }
  const ui=surface({Room,RoomEvent:{}}),{w,sent,post,click}=ui;
  const original=w.setTimeout.bind(w);w.setTimeout=((fn:any,ms?:number,...args:any[])=>original(fn,ms===20000?5:ms,...args)) as any;
  try {
    post({type:'openTutor',mode:'doubt_solver'});selectLesson(w,sent.at(-1).attempt);const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'delivery',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId});await new Promise(r=>setTimeout(r,0));
    const field=w.document.getElementById('message') as HTMLTextAreaElement;
    field.value='Let me practise lists';field.dispatchEvent(new w.Event('input'));click('send');
    await new Promise(r=>setTimeout(r,30));
    assert.equal(sends,1);assert.equal(field.value,'Let me practise lists');
    assert.equal((w.document.getElementById('send') as HTMLButtonElement).disabled,false);
    assert.match(w.document.getElementById('status')!.textContent!,/timed out.*Check for a reply/);
    finish();await new Promise(r=>setTimeout(r,0));
    assert.equal(sends,1);assert.equal(field.value,'Let me practise lists');
    assert.doesNotMatch(w.document.getElementById('feed')!.textContent!,/Let me practise lists/);
    const observations=rpcs.filter(r=>r.method==='on_editor_activity').length;
    click('send');await new Promise(r=>setTimeout(r,0));
    assert.equal(sends,2,'only the learner explicitly retries');
    assert.equal(rpcs.filter(r=>r.method==='on_editor_activity').length,observations,'unchanged code context is not sent again');
    finish();await new Promise(r=>setTimeout(r,0));
    assert.equal(field.value,'');
  } finally {await ui.close();}
});

for (const mode of ['tutor','doubt_solver']) {
  test(mode + ' stages a camera photo locally and sends it only on Submit', async () => {
    let videoPublications = 0, stops = 0;
    const uploads:any[] = [], messages:any[] = [];
    class Room {
      remoteParticipants = new Map([['worker',{identity:'worker',isAgent:true,trackPublications:new Map()}]]);
      localParticipant = {
        registerRpcMethod() {}, performRpc:async ()=>'ok', publishTrack:async () => {videoPublications++;},
        streamBytes:async (options:any) => { uploads.push(options); return {write:async()=>{},close:async()=>{}}; },
        sendText:async (text:string, options:any) => { messages.push({text,options}); },
      };
      on() {} async connect() {} async disconnect() {} registerTextStreamHandler() {}
    }
    const ui = surface({Room,RoomEvent:{}},notebookMessageBar(mode==='tutor'?'Instructor':'Doubt Solver',false,
      '<button type="button" id="audio-microphone" data-live-mic></button><button type="button" id="sound"></button>', true));
    const {w,post,sent,click} = ui, tick = () => new Promise(resolve=>setTimeout(resolve,0));
    const track = Object.assign(new w.EventTarget(),{readyState:'live',stop(){stops++;}});
    const stream = {getVideoTracks:()=>[track],getTracks:()=>[track]};
    let openCamera = async () => stream;
    Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:(constraints:any)=>{
      assert.equal(constraints.audio,false); return openCamera();
    }}});
    w.HTMLDialogElement.prototype.showModal = function() { this.open=true; };
    w.HTMLMediaElement.prototype.play = async function() { this.dispatchEvent(new w.Event('loadeddata')); };
    Object.defineProperty(w.HTMLVideoElement.prototype,'videoWidth',{value:640});
    Object.defineProperty(w.HTMLVideoElement.prototype,'videoHeight',{value:480});
    w.HTMLCanvasElement.prototype.getContext = (()=>({drawImage(){}})) as any;
    w.HTMLCanvasElement.prototype.toBlob = function(callback) { callback(new w.Blob(['still'],{type:'image/jpeg'})); };
    w.File.prototype.arrayBuffer = async () => new Uint8Array([1,2,3,4,5]).buffer;
    w.URL.createObjectURL = ()=>'blob:photo'; w.URL.revokeObjectURL = ()=>{};
    try {
      post({type:'openTutor',mode});
      if (sent.at(-1).type==='tutorLessons') selectLesson(w,sent.at(-1).attempt);
      const attempt=sent.at(-1).attempt;
      post({type:'restoreNotebook',attempt,documentKey:'photo',notebook:emptyNotebook()});
      post({type:'grant',attempt,url:'unused',token:'unused',chapterId,media:true}); await tick();
      assert.equal(w.document.getElementById('audio-camera')!.title,'Take photo');
      click('audio-camera'); await tick(); w.document.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
      assert.equal(stops,1); assert.equal(w.document.querySelector('#attachments img'),null);
      click('audio-camera'); await tick(); w.document.querySelector<HTMLButtonElement>('[data-capture]')!.click();
      assert.equal(stops,2); assert.equal(w.document.querySelector('dialog'),null);
      assert.ok(w.document.querySelector('#attachments img')); assert.equal(uploads.length,0); assert.equal(messages.length,0);
      const field = w.document.getElementById('message') as HTMLTextAreaElement;
      field.value='Explain my diagram.'; field.dispatchEvent(new w.Event('input'));
      click('send'); await tick(); await tick();
      assert.equal(uploads.length,1); assert.equal(uploads[0].topic,'images'); assert.equal(uploads[0].mimeType,'image/jpeg');
      assert.equal(messages.length,1); assert.match(messages[0].text,/Explain my diagram/);
      assert.equal(messages[0].options.topic,'lk.chat');
      assert.equal(messages[0].options.attributes.image_submission_id,uploads[0].attributes.image_submission_id);
      assert.equal(w.document.querySelector('#attachments img'),null);
      openCamera = async () => { throw new w.DOMException('denied','NotAllowedError'); };
      click('audio-camera'); await tick();
      assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/permission was denied/);
      assert.equal(w.document.querySelector('dialog'),null);
      let allow!: (media:typeof stream)=>void;
      openCamera = () => new Promise(resolve=>{allow=resolve;});
      click('audio-camera'); w.dispatchEvent(new w.Event('pagehide')); allow(stream); await tick();
      assert.equal(stops,3); assert.equal(w.document.querySelector('#attachments img'),null);
      assert.equal(videoPublications,0); assert.equal(uploads.length,1);
    } finally { await ui.close(); }
  });
}

for (const mode of ['tutor','doubt_solver','practice'] as const) test(mode + ' streams the desktop microphone to its K–12 agent', async () => {
  const rpcs:any[] = [], handlers = new Map<string, Function>(), streams:string[] = [], peer = {identity:'worker',isAgent:true,trackPublications:new Map()};
  let published = 0, stopped = 0, subscribed = 0;
  class Room {
    remoteParticipants = new Map([[peer.identity,peer]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async (r:any) => {rpcs.push(r); return 'ok';},
      publishTrack:async () => {published++;}, unpublishTrack:async () => {}};
    on(name:string, handler:Function) { handlers.set(name,handler); }
    registerTextStreamHandler(name:string) { streams.push(name); }
    async connect() {} async disconnect() {} async startAudio() {}
  }
  const bar = notebookMessageBar(mode === 'doubt_solver' ? 'Doubt Solver' : 'Instructor', mode === 'practice',
    '<button id="audio-microphone" type="button" data-live-mic></button><button id="sound" type="button"></button>');
  const ui = surface({Room, RoomEvent:{TrackPublished:'published', TrackSubscribed:'subscribed', DataReceived:'data'},
    createLocalAudioTrack:async () => ({stop() { stopped++; }, mediaStreamTrack:{addEventListener() {}}})}, bar, mode === 'practice');
  const {w, post, sent, click} = ui, tick = () => new Promise(resolve => setTimeout(resolve,0));
  try {
    const task:PracticeNotebook = {id:'letters',language:'python',title:'Letters',question:'Count the letters.',starter:'',assistance:true,path:'/unused',account:'learner',tests:[]};
    const practice = mode === 'practice';
    post(practice ? {type:'openPractice'} : {type:'openTutor',mode});
    if (sent.at(-1)?.type === 'tutorLessons') selectLesson(w,sent.at(-1).attempt);
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:mode, notebook:practice ? practiceDocument(task) : emptyNotebook()});
    post(practice ? {type:'practiceReady',attempt,practice:task,aiEnabled:true} : {type:'grant',attempt,url:'unused',token:'unused',chapterId,media:true});
    await tick();
    const mic = w.document.getElementById('audio-microphone')!;
    const field = w.document.querySelector<HTMLTextAreaElement>('#message')!;
    field.value = 'Unsent keyboard draft'; field.dispatchEvent(new w.Event('input'));
    click('audio-microphone');
    if (practice) {
      const cancelled = sent.at(-1);
      assert.equal(cancelled.type,'practiceVoice');
      click('audio-microphone');
      post({type:'practiceVoiceGrant',id:cancelled.id,url:'unused',token:'old'});
      assert.equal(published,0);
      click('audio-microphone');
      const failed = sent.at(-1);
      post({type:'practiceVoiceGrant',id:failed.id,error:'Voice unavailable'});
      assert.match(w.document.getElementById('status')!.textContent!,/Voice unavailable/);
      assert.equal(mic.title,'Start microphone');
      click('audio-microphone');
      post({type:'practiceVoiceGrant',id:sent.at(-1).id,url:'unused',token:'unused'});
    }
    await tick();
    const payload = JSON.parse(rpcs.find(r=>r.method==='switch_mode').payload);
    assert.equal(payload.mode, practice ? 'pyq_practice' : mode);
    if (practice) {
      assert.equal(payload.practice_kind,'regular');
      assert.equal(payload.practice_initial_question.question_id,task.id);
      assert.match(payload.practice_initial_question.question_text,/Count the letters/);
    }
    assert.equal(published,1); assert.equal(mic.getAttribute('aria-pressed'),'true');
    click('audio-microphone'); await tick();
    assert.equal(stopped,1); assert.equal(mic.getAttribute('aria-pressed'),'false');
    assert.deepEqual(JSON.parse(rpcs.filter(r=>r.method==='toggle_audio').at(-1).payload), {input_enabled:false,commit_turn:true});
    handlers.get('published')!({kind:'audio',setSubscribed:(value:boolean) => {if(value)subscribed++;}},peer);
    assert.equal(subscribed,1);
    assert.equal(streams.includes('lk.transcription'),false);
    assert.equal(sent.some(m=>['voiceInputGrant','notebookTurn'].includes(m.type)),false);
    assert.equal(field.value,'Unsent keyboard draft');
    click('audio-microphone'); await tick(); assert.equal(published,2);
    post({type:'visibility',visible:false}); await tick();
    assert.equal(stopped,2);
    assert.equal(rpcs.filter(r=>JSON.parse(r.payload).commit_turn).length,1);
  } finally { await ui.close(); }
});

test('delivery bill shows the public calls, directs a manual boundary run and grades only on request', async () => {
  const ui = surface(), {w, sent, post, code} = ui;
  try {
    const task: PracticeNotebook = {id:'75141e8f-b5ce-56c8-befc-c325019517bf',language:'python',title:'Calculate a delivery bill',
      question:'Run the public examples and try a boundary case of your own.',
      starter:'def bill(quantity, unit_price, delivery):\n    return quantity * unit_price + delivery',
      assistance:true,path:'/unused',account:'learner',tests:[
        {id:'t1',kind:'function',call:'bill(3, 20, 5)',expected:'65'},
        {id:'t2',kind:'function',call:'bill(1, 4, 0)',expected:'4'}]};
    post({type:'openPractice'});
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',documentKey:task.id,notebook:practiceDocument(task)});
    post({type:'practiceReady',attempt,practice:{...task,tools:{tests:2,trace:true,boundaryPractice:true,billSamples:deliveryBillSamples(task.id, task.tests)}},aiEnabled:true});
    const element = w.document.querySelector('.practice-code-editor')!;
    element.querySelector<HTMLButtonElement>('[data-tool=tests]')!.click();
    const request = sent.at(-1).request;
    post({type:'practiceToolResult', attempt, request, tests:task.tests.map(t =>
      ({id:t.id, call:t.call, verdict:'passed', stdin:'Call: ' + t.call, expected:t.expected, actual:t.expected, stderr:''}))});
    await new Promise(resolve => setTimeout(resolve, 0));
    const feedback = element.querySelector<HTMLElement>('.practice-tool-output')!;
    assert.match(feedback.textContent!, /2 of 2 passed/);
    assert.match(feedback.textContent!, /bill\(3, 20, 5\) → 65/);
    assert.match(element.textContent!, /Practice checks incomplete.*print\(bill\(3, 20, 5\)\).*print\(bill\(1, 4, 0\)\).*zero items/s);
    assert.equal(element.querySelector<HTMLButtonElement>('[data-tool=variation]')!.hidden, true);
    assert.equal(sent.some(m => m.tool === 'grade'), false);
    feedback.querySelector('button')!.click();
    const grade = sent.at(-1);
    assert.equal(grade.tool, 'grade');
    post({type:'practiceToolResult',attempt,request:grade.request});
    await new Promise(resolve => setTimeout(resolve, 0));
    const editor = code(element);
    editor.dispatch({changes:{from:editor.state.doc.length,insert:'\nprint(bill(0, 20, 5))'}});
    assert.equal(feedback.hidden, true, 'editing retires results for the old buffer');
    const runCell = async (observed: {args:string[];result:string}[]) => {
      element.querySelector<HTMLButtonElement>('[data-action=run]')!.click();
      const run = sent.at(-1);
      assert.equal(run.action, 'run');
      post({type:'codeResult',attempt,snippet:run.snippet,revision:run.revision,request:run.request,
        execution:{status:'exited',exit_code:0,stdout:'',stderr:'',truncated:false,
          lessonTrace:{steps:[],limited:false,outputAligned:true,functionCalls:observed}}});
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    await runCell([{args:['0','20','5'],result:'5'}]);
    assert.match(element.textContent!, /Practice checks incomplete.*print\(bill\(3, 20, 5\)\)/s);
    editor.dispatch({changes:{from:editor.state.doc.length,insert:'\nprint(bill(3, 20, 5))\nprint(bill(1, 4, 0))'}});
    await runCell([{args:['0','20','5'],result:'5'},{args:['3','20','5'],result:'65'},{args:['1','4','0'],result:'4'}]);
    assert.match(element.textContent!, /Practice checks complete.*bill\(0, 20, 5\) returned 5/s);
  } finally { await ui.close(); }
});
