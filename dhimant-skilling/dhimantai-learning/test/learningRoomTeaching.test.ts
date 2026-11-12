import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { learningComposer } from '../src/learningComposer';
import { cellLanguages } from '../src/roomCode';
import { emptyNotebook } from '../src/tutorNotebook';
import { lessonPicker } from './lessonPicker';

const events = ['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'];
function room(assistant: 'Instructor' | 'Doubt Solver') {
  const rpcs: any[] = [], chats: string[] = [], rooms: any[] = [];
  const agent = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    listeners = new Map<string, Function>(); remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {registerRpcMethod() {}, performRpc:async (request: any) => { rpcs.push(request); return 'ok'; },
      sendText:async (text: string) => { chats.push(text); },
      streamBytes:async () => ({write:async () => {}, close:async () => {}})};
    constructor() { rooms.push(this); }
    on(name: string, listener: Function) { this.listeners.set(name, listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const ids = ['tutor','doubt_solver','end','wide','latest','add-note','add-code','save-notebook','open-notebook','restart-runtime'];
  const dom = new JSDOM('<!doctype html><header class="workspace-header"><div class="workspace-title"><h1>Notebook</h1></div><div class="workspace-status"><span id="status"></span><small id="notebook-save-status"></small></div></header><main id="feed"></main>'
    + learningComposer(assistant, false, '<button type="button" id="sound"></button>')
    + ids.map(id => `<button id="${id}" ${id === 'end' ? 'disabled' : ''}></button>`).join('')
    + '<input id="follow-code" type="checkbox"><input id="stuck-hints" type="checkbox"><span id="code-observer-status"></span>'
    + '<select id="cell-language">' + Object.keys(cellLanguages).map(language => `<option>${language}</option>`).join('') + '</select>',
    {runScripts:'outside-only', url:'https://webview.example', pretendToBeVisual:true});
  const w = dom.window, sent: any[] = [];
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  w.acquireVsCodeApi = () => ({postMessage:(message: unknown) => sent.push(message)});
  w.LivekitClient = {Room, RoomEvent:Object.fromEntries(events.map(name => [name, name]))};
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.URL.createObjectURL = () => 'blob:preview'; w.URL.revokeObjectURL = () => {};
  w.Range.prototype.getClientRects = () => [] as any;
  w.Range.prototype.getBoundingClientRect = () => ({left:0,right:0,top:0,bottom:0,width:0,height:0}) as any;
  const post = (data: object) => w.dispatchEvent(new w.MessageEvent('message', {data, origin:w.location.origin}));
  w.eval(readFileSync(resolve(__dirname, '../../media/learning-room/room.js'), 'utf8'));
  const publish = (content: string, fields: object = {}) => rooms.at(-1).listeners.get('DataReceived')(
    new TextEncoder().encode(JSON.stringify({method:'display_on_screen', content, ...fields})), agent);
  const data = (packet: object) => rooms.at(-1).listeners.get('DataReceived')(new TextEncoder().encode(JSON.stringify(packet)), agent);
  const tick = () => new Promise(r => setTimeout(r, 0));
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => w.document.querySelector<T>(selector)!;
  return {w, sent, post, rpcs, chats, rooms, publish, data, tick, $, close:async () => { w.dispatchEvent(new w.Event('pagehide')); await tick(); w.close(); }};
}
const chapters = [{id:'c1', name:'Lists'}, {id:'c2', name:'Loops', expired:true}, {id:'c3', name:'Functions', locked:true}, {id:'c4', name:'Classes'}];

test('opening a course shows topic coverage without granting access or losing review notes', async () => {
  const ui = room('Instructor'), {w, sent, post, $} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters:[
      {id:'c1', name:'Lists', progress:{status:'in_progress', covered:1, total:2, needs_review:1, topics:[
        {id:'a', title:'Indexing', status:'covered', needs_review:true}, {id:'b', title:'Slicing', status:'not_started'}]}},
      {id:'c2', name:'Loops', locked:true, progress:{status:'covered', covered:1, total:1,
        topics:[{id:'c', title:'For loop', status:'covered'}]}},
    ]}]});
    assert.match($('#lesson-list').textContent!, /1\/2 chapters covered · 1 in progress/);
    assert.deepEqual([...w.document.querySelectorAll('.topic-coverage s')].map(n => n.textContent), ['Indexing','For loop']);
    assert.match($('.topic-coverage').textContent!, /Covered · Needs review/);
    assert.match($('.topic-coverage').textContent!, /Slicing Not started/);
    const locked = [...w.document.querySelectorAll<HTMLButtonElement>('#lesson-list button')][1];
    assert.equal(locked.disabled, true); assert.match(locked.textContent!, /Locked/);
    locked.click(); assert.equal(sent.some(m => m.type === 'join'), false);
    $<HTMLButtonElement>('#lesson-list button').click();
    assert.equal(sent.at(-1).chapterId, 'c1');
    post({type:'signedOut'});
    assert.equal(w.document.querySelectorAll('.topic-coverage').length, 0);
  } finally { await ui.close(); }
});

test('lesson chooser explains ended access, keeps reload reachable and refreshes when the learner returns', async () => {
  const ui = room('Instructor'), {w, sent, post, $} = ui;
  try {
    post({type:'openTutor'});
    const attempt = sent.at(-1).attempt;
    post({type:'tutorLessons', attempt, courses:[{name:'Python', chapters}]});
    const expired = [...w.document.querySelectorAll<HTMLButtonElement>('#lesson-list button')].find(b => /Loops/.test(b.textContent!))!;
    assert.equal(expired.textContent, 'Loops · Access ended · Buy again');
    assert.equal(expired.disabled, false, 'focusable, so its explanation is reachable');
    assert.equal(expired.getAttribute('aria-disabled'), 'true');
    assert.match($(`#${expired.getAttribute('aria-describedby')}`).textContent!, /buy the course again/);
    expired.click();
    assert.equal(sent.at(-1).type, 'courseCatalog');
    assert.equal(sent.some(m => m.type === 'join'), false);
    assert.equal($('#tutor').hidden, false, 'Reload lessons is always reachable');
    assert.equal($('#tutor').textContent, 'Reload lessons');
    const before = sent.filter(m => m.type === 'tutorLessons').length;
    post({type:'visibility', visible:false}); post({type:'visibility', visible:true});
    assert.equal(sent.filter(m => m.type === 'tutorLessons').length, before + 1, 'returning from the catalog reloads lessons');
    post({type:'tutorLessons', attempt, courses:[{name:'Python', chapters:chapters.map(c => ({...c, expired:false}))}, {name:'SQL', chapters:[{id:'s1', name:'Joins'}]}]});
    assert.match($('#lesson-list').textContent!, /Loops$|Loops(?!.*Access)/);
    post({type:'chooseCourse', course:'SQL'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters}, {name:'SQL', chapters:[{id:'s1', name:'Joins'}]}], preferredCourse:'Python'});
    assert.equal($<HTMLSelectElement>('#lesson-course').value, 'SQL', 'opening another course preselects it');
  } finally { await ui.close(); }
});

test('Instructor teaches through open questions, struggle signals, Your turn cells and a next step after the recap', async () => {
  const ui = room('Instructor'), {w, sent, post, rpcs, chats, publish, data, tick, $} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'lesson', notebook:emptyNotebook()});
    post({type:'grant', attempt, url:'unused', token:'unused', chapterId:'c1', codeLanguage:'sql', media:true, lesson:{subject:'Python', name:'Lists'}});
    await tick();
    assert.equal($<HTMLSelectElement>('#cell-language').value, 'sql', 'the course language is used for new cells');
    const switched = JSON.parse(rpcs.find(r => r.method === 'switch_mode').payload);
    assert.equal(switched.chapter_id, 'c1', 'the desktop room also names the chapter, so access is checked');
    assert.equal(switched.lesson_name, 'Lists');

    data({method:'topic_update', subject:'Python', chapter_name:'Lists', lesson_name:'Lists', lesson_topics:[
      {id:'a', title:'Indexing', covered:true, learning_status:'Needs review'},
      {id:'b', title:'Slicing', covered:false, learning_status:'Not taught'},
    ]});
    assert.equal($('#lesson-list .topic-coverage s').textContent, 'Indexing');
    assert.match($('#lesson-list .topic-coverage').textContent!, /Needs review/);
    assert.match($('#feed').innerHTML, /<s>Indexing<\/s>/, 'live recap also strikes only covered topics');
    data({method:'tutor_example_progress', subject:'Python', chapter_name:'Lists', lesson_name:'Lists',
      solved_example_id:'example', lesson_topics:[{id:'x',title:'Example only',covered:true,learning_status:'Taught — not assessed'}]});
    assert.doesNotMatch($('#lesson-list').textContent!, /Example only/);

    publish('What does `xs[-1]` return?', {is_question_prompt:true, tutor_checkpoint_id:'q1'});
    const actions = () => [...w.document.querySelectorAll<HTMLButtonElement>('[data-lesson-action]')].filter(b => !b.hidden);
    assert.deepEqual(actions(), [], 'an open question offers the existing help ladder, not Continue or a worked example');
    assert.equal($<HTMLButtonElement>('#practice-help').disabled, false);
    publish('Not quite: negative indexes count from the end.', {tutor_feedback:true, tutor_checkpoint_id:'q1'});
    assert.equal(w.document.getElementById('smaller-step')?.hidden ?? true, true);
    assert.deepEqual(actions().map(b => b.textContent), ['Continue'], 'feedback restores the one current lesson control');
    assert.equal($('#feed [data-lesson-action]'), null, 'saved cards never carry session actions');
    publish('Try again: what does `xs[-2]` return?', {is_question_prompt:true, tutor_checkpoint_id:'q2'});
    publish('Still not quite.', {tutor_feedback:true, tutor_checkpoint_id:'q2'});
    const chip = $<HTMLButtonElement>('#smaller-step');
    assert.equal(chip.hidden, false, 'two unaccepted answers offer a smaller step');
    chip.click(); await tick();
    assert.match(chats.at(-1)!, /smaller question.*don’t give me the answer/);
    assert.equal(chip.hidden, true);

    publish('Lists keep order.\n\nYour turn: write `xs[0]` for `[4, 5]` and predict the output.');
    const turn = $('#feed article:last-child .your-turn');
    assert.equal(turn.querySelector('strong')!.textContent, 'Your turn');
    assert.match(turn.textContent!, /predict the output/);
    assert.equal($('#feed article:last-child .conversation-body').firstElementChild!.textContent, 'Lists keep order.');
    assert.doesNotMatch($('#feed article:last-child .conversation-body').textContent!, /Your turn:/);
    assert.ok(turn.classList.contains('is-open'));
    const field = $<HTMLTextAreaElement>('#message');
    field.value = 'It prints 4'; field.dispatchEvent(new w.Event('input')); $<HTMLButtonElement>('#send').click(); await tick();
    assert.equal(turn.classList.contains('is-open'), false, 'the Your turn cell closes when the learner replies');

    data({method:'tutor_session_summary', big_idea:'Indexes are positions.', work_on:'negative indexes'});
    const next = $<HTMLButtonElement>('[data-next-lesson]');
    assert.equal(next.textContent, 'Next lesson: Classes', 'skips ended and locked lessons');
    $<HTMLButtonElement>('[data-review-weak]').click(); await tick();
    assert.match(chats.at(-1)!, /keep practising: negative indexes/);
    next.click();
    assert.equal(sent.at(-1).type, 'join'); assert.equal(sent.at(-1).chapterId, 'c4');
  } finally { await ui.close(); }
});

test('restored cards share one current lesson control and optional actions follow the latest response', async () => {
  const ui = room('Instructor'), {w, sent, post, publish, chats, tick, $} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();
    const attempt = sent.at(-1).attempt;
    const saved = {...emptyNotebook(), cells:[0,1,2].map(index => ({id:'saved-'+index, kind:'board' as const,
      text:'Explanation '+index, packet:{tutor_action_menu:{actions:['hint','workedExample','testMe']}}}))};
    post({type:'restoreNotebook', attempt, documentKey:'lesson', notebook:saved});
    post({type:'grant', attempt, url:'unused', token:'unused', chapterId:'c1'}); await tick();
    assert.equal(w.document.querySelectorAll('#feed article').length, 3);
    assert.equal($('#feed .lesson-actions'), null, 'history contains explanations without repeated session controls');
    const current = $<HTMLButtonElement>('#composer-mode-actions [data-lesson-action="continueLesson"]');
    assert.equal(current.hidden, false); assert.equal(current.type, 'button');
    const options = () => [...w.document.querySelectorAll<HTMLButtonElement>('#notebook-help-actions [data-lesson-action]')].filter(b => !b.hidden);
    assert.deepEqual(options().map(b => b.textContent), ['Worked example','Try on my own']);
    assert.equal($<HTMLDetailsElement>('.more-asks').open, false);
    const field = $<HTMLTextAreaElement>('#message'); field.value = 'My unsent answer';
    options()[0].click(); await tick();
    assert.match(chats.at(-1)!, /Show a worked example/);
    assert.equal(field.value, 'My unsent answer', 'an optional action does not submit the draft');
    publish('Here is the example.', {tutor_action_menu:{actions:['summarize']}});
    assert.deepEqual(options().map(b => b.textContent), ['Recap'], 'older cards cannot keep stale choices active');
    assert.equal(w.document.querySelectorAll('[data-lesson-action="continueLesson"]').length, 1);
    assert.equal($('#composer-mode-actions [data-lesson-action="continueLesson"]'), current, 'typing and new replies preserve the control');
    $<HTMLButtonElement>('#end').click(); await tick();
    assert.equal(current.disabled, true); assert.ok(options().every(b => b.disabled));
  } finally { await ui.close(); }
});

test('an open question offers a smaller step after a long pause, never the answer', async () => {
  const ui = room('Instructor'), {w, sent, post, publish, tick, $} = ui;
  const timers: {callback: () => void; delay: number}[] = [], schedule = w.setTimeout;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'lesson', notebook:emptyNotebook()});
    post({type:'grant', attempt, url:'unused', token:'unused', chapterId:'c1'}); await tick();
    w.setTimeout = ((callback: () => void, delay: number) => { timers.push({callback, delay}); return schedule(() => {}, 0); }) as any;
    publish('Why does `xs[3]` fail for three items?', {is_question_prompt:true, tutor_checkpoint_id:'idle', tutor_practice_editor:undefined});
    w.dispatchEvent(new w.Event('focusin'));
    $('#feed').dispatchEvent(new w.Event('focusin', {bubbles:true})); await tick();
    const idle = timers.filter(t => t.delay === 95000).at(-1);
    assert.ok(idle, 'a long pause on an open question is watched');
    idle!.callback();
    assert.equal($('#smaller-step').hidden, false);
  } finally { w.setTimeout = schedule; await ui.close(); }
});

test('Doubt Solver keeps doubts separate, recaps the current one on reconnect and sends attempt context', async () => {
  const ui = room('Doubt Solver'), {w, sent, post, rpcs, chats, rooms, publish, tick, $} = ui;
  try {
    post({type:'openTutor', mode:'doubt_solver'});
    let attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'doubt', notebook:emptyNotebook()});
    post({type:'grant', attempt, url:'unused', token:'unused', doubtContext:{chapter_id:'c1', lesson_name:'Lists'}}); await tick();
    const first = JSON.parse(rpcs.find(r => r.method === 'switch_mode').payload);
    assert.equal(first.mode, 'doubt_solver'); assert.match(first.doubt_id, /^[0-9a-f-]{36}$/);
    assert.equal(first.chapter_id, 'c1'); assert.equal(first.lesson_name, 'Lists');
    assert.equal(first.recap, undefined);
    assert.equal($('#doubt-tried-nudge').hidden, false, 'the first message of a doubt nudges for what was tried');
    $<HTMLTextAreaElement>('#doubt-tried').value = 'I divided both sides by x';
    const field = $<HTMLTextAreaElement>('#message');
    field.value = 'Why do I lose a solution?'; field.dispatchEvent(new w.Event('input'));
    $<HTMLButtonElement>('#send').click(); await tick();
    assert.equal(chats.at(-1), 'What I tried: I divided both sides by x\nWhy do I lose a solution?');
    assert.equal($<HTMLTextAreaElement>('#doubt-tried').value, '');
    assert.equal($('#doubt-tried-nudge').hidden, true, 'a nudge, not a requirement, and only once per doubt');
    publish('Dividing by x assumes x ≠ 0.\n\nYour turn: check x = 0 in the original equation.');

    // Reconnecting restores the conversation of this doubt only.
    rooms.at(-1).listeners.get('Disconnected')(); $<HTMLButtonElement>('#tutor').click();
    attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'doubt-again', notebook:sent.filter(m => m.type === 'notebookChanged').at(-1).notebook});
    post({type:'grant', attempt, url:'unused', token:'unused'}); await tick();
    const again = JSON.parse(rpcs.filter(r => r.method === 'switch_mode').at(-1).payload);
    assert.equal(again.doubt_id, first.doubt_id);
    assert.deepEqual(again.recap.map((item: any) => item.role), ['learner', 'doubt_solver']);
    assert.match(again.recap[0].text, /Why do I lose a solution/);

    $<HTMLButtonElement>('#new-doubt').click(); await tick();
    assert.ok($('#feed .doubt-divider'), 'a divider marks the new doubt');
    const fresh = JSON.parse(rpcs.filter(r => r.method === 'switch_mode').at(-1).payload);
    assert.notEqual(fresh.doubt_id, first.doubt_id); assert.equal(fresh.recap, undefined);

    const files = [{name:'attempt.png', type:'image/png', size:3, arrayBuffer:async () => new Uint8Array([1,2,3]).buffer}];
    // The file picker returns the learner's chosen file.
    w.document.createElement = ((original) => function (this: Document, tag: string) {
      const element = original.call(this, tag);
      if (tag === 'input') Object.defineProperty(element, 'click', {value:() => { Object.defineProperty(element, 'files', {value:files}); element.onchange?.(new w.Event('change')); }});
      return element;
    })(w.document.createElement) as any;
    $<HTMLButtonElement>('#attach-images').click();
    const roles = $<HTMLFieldSetElement>('#attachment-role');
    assert.equal(roles.hidden, false);
    assert.equal(roles.querySelector<HTMLInputElement>('input:checked')!.value, 'question', '"The question" is the default');
    const mine = roles.querySelector<HTMLInputElement>('input[value="learner_attempt"]')!;
    mine.checked = true; mine.dispatchEvent(new w.Event('change'));
    field.value = 'Is my working right?'; field.dispatchEvent(new w.Event('input'));
    $<HTMLButtonElement>('#send').click(); await tick(); await tick();
    assert.match(chats.at(-1)!, /\nAttachment role: learner_attempt\nStudent typed message: Is my working right\?/);

    // Explain problem stays in the active doubt's LiveKit conversation.
    w.document.querySelector<HTMLButtonElement>('#notebook-help-actions button')!.click();
    await tick();
    assert.match(chats.at(-1)!, /Is my working right/);
    assert.doesNotMatch(chats.at(-1)!, /lose a solution/);
    // Code help names the doubt and shares only its conversation.
    w.document.querySelector<HTMLButtonElement>('#notebook-help-actions [data-practice-strategy="trace"]')!.click();
    const turn = sent.filter(m => m.type === 'notebookTurn').at(-1);
    assert.equal(turn.doubtId, fresh.doubt_id);
    assert.equal(turn.history.some((item: any) => /lose a solution/.test(item.text)), false);
    post({type:'notebookReply', attempt, request:turn.request, error:'Your course access has ended.', accessEnded:true}); await tick();
    assert.equal($('#access-notice').hidden, false);
    $<HTMLButtonElement>('#access-notice button').click();
    assert.equal(sent.at(-1).type, 'courseCatalog');
  } finally { await ui.close(); }
});

test('a notebook saved by another window is never overwritten silently', async () => {
  const ui = room('Doubt Solver'), {sent, post, $} = ui;
  try {
    post({type:'openTutor', mode:'doubt_solver'});
    post({type:'restoreNotebook', attempt:sent.at(-1).attempt, documentKey:'doubt', notebook:emptyNotebook()});
    post({type:'notebookError', documentKey:'doubt', conflict:true, message:'This notebook changed in another window.'});
    assert.match($('#notebook-save-status').textContent!, /another window/);
    $<HTMLButtonElement>('#notebook-conflict button').click();
    assert.equal(sent.at(-1).type, 'reloadNotebook'); assert.equal(sent.at(-1).documentKey, 'doubt');
    $<HTMLButtonElement>('#notebook-conflict button:last-child').click();
    assert.equal(sent.at(-1).type, 'overwriteNotebook');
    post({type:'restoreNotebook', documentKey:'newer', notebook:emptyNotebook()});
    assert.equal(document_conflict(ui), null);
    post({type:'failed', attempt:sent.filter(m => m.type === 'join').at(-1).attempt, accessEnded:true, message:'Your course access has ended.'});
    assert.match($('#access-notice').textContent!, /access has ended.*Open Course Catalog/);
  } finally { await ui.close(); }
});
const document_conflict = (ui: ReturnType<typeof room>) => ui.w.document.getElementById('notebook-conflict');

test('Continue learning resumes its chapter directly, and the picker marks the one next step', async () => {
  const progress = (status: string) => ({status, covered:status === 'covered' ? 2 : 0, total:2, topics:[]});
  const course = {name:'Python', chapters:[{id:'c1', name:'Lists', progress:progress('covered')},
    {id:'c2', name:'Loops', progress:progress('in_progress')}, {id:'c3', name:'Functions', locked:true, progress:progress('not_started')}]};
  const resumed = room('Instructor');
  try {
    resumed.post({type:'openTutor', lesson:'c2'});
    resumed.post({type:'tutorLessons', attempt:resumed.sent.at(-1).attempt, courses:[course]});
    assert.equal(resumed.sent.at(-1).type, 'join');
    assert.equal(resumed.sent.at(-1).chapterId, 'c2', 'the requested chapter starts without another click');
    const joins = resumed.sent.filter(m => m.type === 'join').length;
    resumed.post({type:'chooseCourse', course:'Python', lesson:'c2'});
    assert.equal(resumed.sent.filter(m => m.type === 'join' || m.type === 'tutorLessons').length, joins + 1,
      'continuing the lesson already open keeps its session instead of reloading lessons');
  } finally { await resumed.close(); }
  const picker = room('Instructor'), {w, $} = picker;
  try {
    picker.post({type:'openTutor', lesson:'c3'});
    picker.post({type:'tutorLessons', attempt:picker.sent.at(-1).attempt, courses:[course]});
    assert.equal(picker.sent.some(m => m.type === 'join'), false, 'a locked chapter is never started automatically');
    assert.equal(w.document.querySelectorAll('.lesson-outline.up-next').length, 1);
    assert.match($('.lesson-outline.up-next').textContent!, /Loops.*Pick up here · In progress/);
    const done = $<HTMLButtonElement>('#lesson-list .lesson-outline > button');
    assert.ok(done.classList.contains('lesson-covered'));
    assert.equal(done.querySelector('s'), null, 'a covered chapter is shown as done, not struck through');
    assert.equal(done.disabled, false, 'covered chapters stay revisitable');
  } finally { await picker.close(); }
});
