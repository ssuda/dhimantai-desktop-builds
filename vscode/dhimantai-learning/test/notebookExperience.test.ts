import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { cellLanguages, codeLanguages, RoomCodeSession } from '../src/roomCode';
import { TutorPython } from '../src/tutorPython';
import { emptyNotebook } from '../src/tutorNotebook';
import { practiceDocument, PracticeNotebook } from '../src/practiceNotebook';
import { engineeringSkills } from '../src/skillPractice';
import { learningComposer } from '../src/learningComposer';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

function surface(livekit: unknown = {RoomEvent:{}}, composer = learningComposer('Instructor', true, '<button type="button" id="sound"></button>')) {
  const ids = ['tutor','doubt_solver','end','wide','latest','add-note','add-code','save-notebook','open-notebook','restart-runtime','clear-conversation'];
  const dom = new JSDOM('<!doctype html><header class="workspace-header"><div class="workspace-title"><h1>Implement `subtract_time` &lt; safely</h1></div><div class="workspace-actions"></div></header><main id="feed"></main>' + composer
    + ids.map(id => `<button id="${id}" ${id === 'end' ? 'disabled' : ''}></button>`).join('')
    + '<input id="follow-code" type="checkbox" checked><input id="stuck-hints" type="checkbox"><span id="status"></span><span id="code-observer-status"></span><span id="notebook-save-status"></span>'
    + '<select id="cell-language">' + Object.keys(cellLanguages).map(language => `<option>${language}</option>`).join('') + '</select>'
    + '<select id="course-runtime"><option value="course">Course container</option><option value="terminal">Open course terminal</option><option value="setup">Set up / rebuild course</option></select>',
    {runScripts:'outside-only',url:'https://webview.example',pretendToBeVisual:true});
  const w = dom.window, sent: any[] = [];
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  w.acquireVsCodeApi = () => ({postMessage:(message: unknown) => sent.push(message)});
  w.LivekitClient = livekit;
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Range.prototype.getClientRects = () => [] as any;
  w.Range.prototype.getBoundingClientRect = () => ({left:0,right:0,top:0,bottom:0,width:0,height:0}) as any;
  const post = (data: object) => w.dispatchEvent(new w.MessageEvent('message',{data,origin:w.location.origin}));
  const click = (id: string) => w.document.getElementById(id)!.click();
  w.eval(readFileSync(resolve(__dirname,'../../media/learning-room/room.js'),'utf8'));
  const code = (element: Element) => EditorView.findFromDOM(element.querySelector<HTMLElement>('.cm-content')!)!;
  return {w,sent,post,click,code,close:async () => {
    w.dispatchEvent(new w.Event('pagehide'));
    await new Promise(r => setTimeout(r,300)); w.close();
  }};
}

test('shared notebook context excludes private material and never creates a model turn by itself', async () => {
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
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId}); await new Promise(r => setTimeout(r,0));
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
    rooms[0].listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify({method:'display_on_screen',content:'What is 6 times 7?',is_question_prompt:true,tutor_checkpoint_id:'question-42'})),agent);
    assert.equal(w.document.getElementById('send-label')!.textContent,'Answer Instructor');
    assert.match(w.document.getElementById('composer-context')!.textContent!,/What is 6 times 7/);
    await ask('42');
    assert.match(chats.at(-1)!,/^TUTOR_NOTEBOOK_ANSWER\n/);
    assert.equal(JSON.parse(chats.at(-1)!.split('\n')[1]).checkpoint_id,'question-42');
    assert.equal(w.document.getElementById('send-label')!.textContent,'Ask Instructor');
    assert.equal(runCount(),before);
  } finally { await ui.close(); }
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
    post({type:'openTutor',mode:'doubt_solver'});
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
    Object.defineProperties(page, {
      clientHeight:{get:() => 600}, scrollHeight:{get:() => height},
      scrollTop:{get:() => top, set:value => { top = Math.max(0, Math.min(height - 600, value)); }},
    });
    w.document.dispatchEvent(new w.Event('scroll'));
    assert.equal(latest.hidden, false, 'page scrolling updates Jump to latest');
    click('add-note');
    assert.equal(top, 300, 'a new cell does not interrupt reading an older explanation');
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
    const remove = () => cells()[0].querySelector<HTMLButtonElement>('[data-remove-cell]')!.click();
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

test('the runtime dropdown opens container terminals and setup without a host runtime option', async () => {
  const ui = surface();
  try {
    const picker = ui.w.document.getElementById('course-runtime') as HTMLSelectElement;
    assert.equal(picker.querySelector('[value="local"]'), null);
    assert.equal(picker.value, 'course');
    for (const runtime of ['terminal', 'setup']) {
      picker.value = runtime; picker.dispatchEvent(new ui.w.Event('change'));
      assert.equal(ui.sent.at(-1).type, 'runtime'); assert.equal(ui.sent.at(-1).runtime, runtime);
      assert.equal(picker.value, 'course');
    }
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
    assert.equal(saved.notebook.drafts.length,7);
    post({type:'restoreNotebook',documentKey:'account-document',notebook:saved.notebook});
    assert.equal(w.document.querySelectorAll('.practice-code-editor').length,7);
    assert.deepEqual(Array.from(w.document.querySelectorAll('.practice-code-editor')).map(element => code(element).state.doc.toString()),
      Object.keys(codeLanguages).map(language => 'student work for ' + language));
    assert.equal(sent.some(message => message.type === 'notebookTurn'),false);
    post({type:'signedOut'});
    assert.equal(w.document.querySelectorAll('article[data-cell-id]').length,0,'a different account never sees the previous notebook');
    assert.equal(textCell.value,'');
  } finally { await ui.close(); }
});

test('the separate message bar autosaves unsent work, and Enter never sends it', async () => {
  const ui = surface();
  try {
    ui.post({type:'restoreNotebook',documentKey:'draft-document',notebook:emptyNotebook()});
    const field = ui.w.document.getElementById('message') as HTMLTextAreaElement;
    assert.ok(ui.w.document.getElementById('message-bar')!.contains(field));
    assert.equal(ui.w.document.getElementById('feed')!.contains(field), false);
    field.value = 'My question\nMy reasoning'; field.dispatchEvent(new ui.w.Event('input'));
    const enter = new ui.w.KeyboardEvent('keydown',{key:'Enter',cancelable:true});
    field.dispatchEvent(enter); assert.equal(enter.defaultPrevented,false);
    await new Promise(resolve => setTimeout(resolve,300));
    const saved = ui.sent.filter(message => message.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.textDraft,field.value);
    assert.equal(ui.sent.some(message => message.type === 'notebookTurn'),false);
    ui.post({type:'restoreNotebook',documentKey:'draft-document',notebook:saved});
    assert.equal(field.value,'My question\nMy reasoning');
    assert.equal(ui.w.document.querySelectorAll('#composer').length,1);
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

test('Doubt Solver uses shared Get Help without the Practice ladder and names Doubt Solver throughout', async () => {
  const composer = learningComposer('Doubt Solver', false, '<button type="button" id="sound"></button>');
  assert.doesNotMatch(composer, /practice-help|Instructor/);
  assert.match(composer, /notebook-help-actions/);
  assert.match(composer, /aria-label="Ask Doubt Solver" aria-keyshortcuts="Control\+Enter Meta\+Enter"/);
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
    post({type:'openTutor',mode:'doubt_solver'}); const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'doubt',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused'}); await new Promise(r => setTimeout(r,0));
    assert.equal(w.document.querySelectorAll('#notebook-help-actions button').length, 5);
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
    assert.deepEqual(actions.map(b => b.textContent), ['Explain problem','Explain code','Explain errors','Explain failed tests','Next step']);
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
    actions[4].click(); const next = sent.at(-1); assert.equal(next.strategy,'small_steps');
    post({type:'notebookReply',attempt,request:next.request,content:'Try one value.',replies:['I have an idea']}); await tick();
    const current = [...w.document.querySelectorAll<HTMLElement>('article[data-cell-id]')].at(-1)!;
    post({type:'runtimeRestarted'});
    assert.equal(current.querySelector<HTMLButtonElement>('[data-reply]')!.disabled, true);
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


for (const mode of ['practice', 'tutor', 'doubt_solver'] as const) test(`${mode}: all five Get Help actions share requests, context and inline replies`, async () => {
  const chats: string[] = [];
  const peer = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    remoteParticipants = new Map([['worker', peer]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async () => 'ok', sendText:async (text:string) => { chats.push(text); }};
    on() {} async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const assistant = mode === 'doubt_solver' ? 'Doubt Solver' : 'Instructor';
  const ui = surface({Room, RoomEvent:{}}, learningComposer(assistant, mode === 'practice', '<button type="button" id="sound"></button>'));
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
    const actions = [...w.document.querySelectorAll<HTMLButtonElement>('#notebook-help-actions button')];
    assert.deepEqual(actions.map(action => action.textContent), ['Explain problem','Explain code','Explain errors','Explain failed tests','Next step']);
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
    const strategies = ['plan','trace','read_error','by_hand','small_steps'];
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
    const reply = [...w.document.querySelectorAll<HTMLButtonElement>('[data-reply]')].find(button => !button.disabled)!;
    reply.click();
    const followup = sent.filter(message => message.type === 'notebookTurn').at(-1);
    assert.match(followup.message,/About your reply: Shared reply 4/);
    post({type:'notebookReply',attempt,request:followup.request,error:'Service unavailable'}); await tick();
    assert.ok(actions.every(button => !button.disabled));
    assert.match(w.document.getElementById('status')!.textContent!,/Service unavailable/);
    assert.match(w.document.getElementById('notebook-help-status')!.textContent!,/Service unavailable/, 'failure stays visible beside Get Help');
    post({type:'codeSettings',aiEnabled:false});
    assert.ok(actions.every(button => button.disabled));
  } finally { await ui.close(); }
});
