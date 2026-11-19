import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { learningComposer } from '../src/learningComposer';
import { cellLanguages } from '../src/roomCode';
import { emptyNotebook } from '../src/tutorNotebook';
import { lessonPicker, selectLesson } from './lessonPicker';
import {browserCourseProgress, ERP_COURSE} from '../src/browserCourseProgress';

const events = ['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected','ActiveSpeakersChanged','ParticipantAttributesChanged','AudioPlaybackStatusChanged'];
function room(assistant: 'Instructor' | 'Doubt Solver', workspace = false, rpcReply: (request: any) => Promise<string> = async () => 'ok') {
  const rpcs: any[] = [], chats: string[] = [], chatOptions: any[] = [], rooms: any[] = [];
  const agent = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    listeners = new Map<string, Function>(); remoteParticipants = new Map([['worker', agent]]);
    handlers = new Map<string, Function>();
    localParticipant = {registerRpcMethod:(name: string, fn: Function) => this.handlers.set(name, fn), performRpc:async (request: any) => { rpcs.push(request); return rpcReply(request); },
      sendText:async (text: string, options: unknown) => { chats.push(text); chatOptions.push(options); },
      streamBytes:async () => ({write:async () => {}, close:async () => {}})};
    constructor() { rooms.push(this); }
    on(name: string, listener: Function) { this.listeners.set(name, listener); }
    async connect() {} async disconnect() {} registerTextStreamHandler(name: string, fn: Function) { this.handlers.set(name, fn); }
  }
  const ids = ['tutor','doubt_solver','end','wide','latest','add-note','add-code','save-notebook','open-notebook','restart-runtime'];
  const dom = new JSDOM('<!doctype html><header class="workspace-header"><div class="workspace-title"><h1>Notebook</h1></div><div class="workspace-status"><span id="status"></span><small id="notebook-save-status"></small></div></header><main id="feed"></main>'
    + learningComposer(assistant, false, '<button type="button" id="sound"></button>')
    + '<div class="notebook-tools">' + ids.map(id => `<button id="${id}" ${id === 'end' ? 'disabled' : ''}></button>`).join('') + '</div>'
    + '<input id="follow-code" type="checkbox"><input id="stuck-hints" type="checkbox"><span id="code-observer-status"></span>'
    + '<select id="cell-language">' + Object.keys(cellLanguages).map(language => `<option>${language}</option>`).join('') + '</select>',
    {runScripts:'outside-only', url:'https://webview.example', pretendToBeVisual:true});
  const w = dom.window, sent: any[] = [];
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  if (workspace) w.document.body.insertAdjacentHTML('afterbegin', '<select id="workspace-mode"><option value="tutor">Instructor</option><option value="doubt_solver">Doubt Solver</option><option value="practice">Practice</option></select><select id="coaching-language"><option value="en-IN">English</option><option value="te-IN">Telugu</option></select><section id="workspace-practice" hidden><select id="practice-chapter"></select><div id="practice-questions"></div><button id="practice-back"></button></section>');
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
  return {w, sent, post, rpcs, chats, chatOptions, rooms, publish, data, tick, $, close:async () => { w.dispatchEvent(new w.Event('pagehide')); await tick(); w.close(); }};
}
const chapters = [{id:'c1', name:'Lists'}, {id:'c2', name:'Loops', expired:true}, {id:'c3', name:'Functions', locked:true}, {id:'c4', name:'Classes'}];

test('deleting a pending Instructor answer reopens the question and drops its late output across a correction', async () => {
  let acknowledge!: (value: string) => void;
  const ui = room('Instructor', false, async rpc => rpc.method === 'cancel_tutor_request'
    ? new Promise(resolve => { acknowledge = resolve; }) : 'ok');
  const {w, post, sent, $, tick, chatOptions, chats, rooms, rpcs, publish, data} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters}]});
    $('#lesson-list button').click();
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'quiz', notebook:emptyNotebook()});
    post({type:'grant', attempt, url:'unused', token:'unused', chapterId:'c1'}); await tick();
    const live = rooms[0], peer = live.remoteParticipants.get('worker');
    const activity = (state: string) => live.listeners.get('ParticipantAttributesChanged')({'lk.agent.state':state}, peer);
    const field = $<HTMLTextAreaElement>('#message');
    async function submit(text: string) {
      field.value = text; field.dispatchEvent(new w.Event('input')); $('#send').click(); await tick();
    }
    publish('Predict the output.', {is_question_prompt:true, tutor_checkpoint_id:'q1', tutor_answer_kind:'written'});
    await submit('old answer');
    const old = chatOptions[0].attributes.tutor_request_id;
    assert.match(old, /^tutor-request-/);
    activity('thinking');
    assert.equal($('#assistant-activity').textContent, 'Thinking…');
    $('#feed [title="Delete your message"]').click();
    assert.ok(!rpcs.some(r => r.method === 'cancel_tutor_request'), 'confirmation has not been given');
    $('#feed [data-confirm-delete]').click();
    assert.equal($('#assistant-activity').hidden, true);
    assert.deepEqual(JSON.parse(rpcs.at(-1).payload), {tutor_request_id:old});
    assert.doesNotMatch($('#feed').textContent!, /old answer/);
    assert.match(field.placeholder, /Your answer/);
    await submit('corrected answer');
    assert.equal(field.value, 'corrected answer');
    assert.equal(chats.length, 1, 'hold delivery until the backend reopens the checkpoint');
    data({method:'tutor_turn_started', tutor_turn_id:old}); activity('speaking');
    assert.equal($('#assistant-activity').hidden, true);
    let finish!: (text: string) => void;
    const staleTranscript = live.handlers.get('lk.transcription')({info:{attributes:{}},
      readAll:() => new Promise(resolve => { finish = resolve; })}, peer);
    acknowledge('ok'); await tick();
    assert.equal(chats.length, 2);
    assert.equal(JSON.parse(chats[1].split('\n')[1]).checkpoint_id, 'q1');
    const current = chatOptions[1].attributes.tutor_request_id;
    assert.notEqual(current, old);
    data({method:'tutor_turn_started', tutor_turn_id:current}); activity('thinking');
    publish('stale board', {tutor_turn_id:old});
    await live.handlers.get('display_on_screen')({callerIdentity:'worker', payload:JSON.stringify({content:'stale RPC', tutor_request_id:old})});
    finish('stale voice'); await staleTranscript;
    await live.handlers.get('lk.transcription')({info:{attributes:{tutor_request_id:old}},
      readAll:async () => 'stale final transcript'}, peer);
    data({method:'tutor_turn_completed', tutor_turn_id:old});
    assert.equal($('#assistant-activity').textContent, 'Thinking…');
    publish('correct feedback', {tutor_turn_id:current, tutor_checkpoint_id:'q1', tutor_feedback:true});
    data({method:'tutor_turn_completed', tutor_turn_id:current}); activity('listening');
    assert.doesNotMatch($('#feed').textContent!, /stale|old answer/);
    assert.equal(w.document.querySelectorAll('#feed article').length, 3);
    $('#feed [title="Delete your message"]').click(); $('#feed [data-confirm-delete]').click();
    assert.equal(rpcs.filter(r => r.method === 'cancel_tutor_request').length, 1, 'completed cards are ordinary notebook edits');
  } finally { await ui.close(); }
});

test('an unconfirmed cancellation preserves a queued correction for reconnect', async () => {
  let reject!: (error: Error) => void;
  const ui = room('Instructor', false, async rpc => rpc.method === 'cancel_tutor_request'
    ? new Promise<string>((_, fail) => { reject = fail; }) : 'ok');
  const {w, post, sent, $, tick, chats} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters}]});
    $('#lesson-list button').click();
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'connection', notebook:emptyNotebook()});
    post({type:'grant', attempt, url:'unused', token:'unused', chapterId:'c1'}); await tick();
    const field = $<HTMLTextAreaElement>('#message');
    field.value = 'original'; field.dispatchEvent(new w.Event('input')); $('#send').click(); await tick();
    $('#feed [title="Delete your message"]').click(); $('#feed [data-confirm-delete]').click();
    field.value = 'my correction'; field.dispatchEvent(new w.Event('input')); $('#send').click();
    reject(new Error('disconnected')); await tick();
    assert.deepEqual(chats, ['original']);
    assert.equal(field.value, 'my correction');
    assert.match($('#status').textContent!, /could not confirm cancellation/);
    assert.equal($<HTMLButtonElement>('#tutor').hidden, false);
    const saved = sent.filter(message => message.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.textDraft, 'my correction');
    assert.equal(saved.cells.filter((cell: any) => cell.kind === 'message').length, 0);
  } finally { await ui.close(); }
});

test('Doubt Solver waits for course selection and sends the verified chapter on every new doubt',async()=>{
  let switches=0;
  const ui=room('Doubt Solver',false,async request=>request.method==='switch_mode' && ++switches>1
    ? 'error: Your course access has ended.' : 'ok'), {post,sent,$,tick,rpcs}=ui;
  try {
    post({type:'openTutor',mode:'doubt_solver'});
    assert.equal(sent.at(-1).type,'tutorLessons');
    assert.equal(sent.some(message=>message.type==='join'),false);
    assert.equal($('#composer').hidden,true,'questions stay unavailable until a course is selected');
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    assert.equal(sent.some(message=>message.type==='join'),false);
    $<HTMLButtonElement>('#lesson-list button').click();
    assert.equal(sent.at(-1).mode,'doubt_solver');
    assert.equal(sent.at(-1).chapterId,'c1');
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'course-doubt',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'c1',doubtContext:{chapter_id:'c1',lesson_name:'Lists'}});
    await tick();
    const payload=JSON.parse(rpcs.find(request=>request.method==='switch_mode').payload);
    assert.equal(payload.chapter_id,'c1');assert.equal(payload.mode,'doubt_solver');
    assert.equal($('#composer').hidden,false);
    $<HTMLTextAreaElement>('#message').value='Why does append return None?';
    $<HTMLTextAreaElement>('#message').dispatchEvent(new ui.w.Event('input'));
    $('#send').click();await tick();
    $('#new-doubt').click();await tick();
    assert.equal(sent.at(-1).type,'switchDoubtChat');
    assert.equal(sent.at(-1).newChat,true);
    post({type:'openDoubtChat',chapter:'c1',newChat:true});
    const nextAttempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt:nextAttempt,documentKey:'new-chat',notebook:emptyNotebook()});
    post({type:'grant',attempt:nextAttempt,url:'unused',token:'unused',chapterId:'c1',doubtContext:{chapter_id:'c1',lesson_name:'Lists'}});await tick();
    const next=JSON.parse(rpcs.filter(request=>request.method==='switch_mode').at(-1).payload);
    assert.equal(next.chapter_id,'c1');assert.notEqual(next.doubt_id,payload.doubt_id);
    assert.match($('#status').textContent!,/course access has ended/);
    assert.equal($<HTMLButtonElement>('#tutor').hidden,false,'a refused new doubt must expose Retry');
  } finally {await ui.close();}
});

test('opening a scoped course starts its next available lesson and shows connection state in the document', async () => {
  const ui = room('Instructor'), {post,sent,$,tick} = ui;
  try {
    post({type:'visibility',visible:true});
    assert.match($('#lesson-placeholder').textContent!, /Loading your lessons/, 'the first visibility event must not flash an empty catalog');
    post({type:'openTutor'});
    assert.equal($('#lesson-placeholder').hidden, false);
    assert.match($('#lesson-placeholder').textContent!, /Loading your lessons/);
    assert.equal($<HTMLSelectElement>('#lesson-course').disabled, true);
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,preferredCourse:'Python',courses:[{name:'Python',chapters:[
      {id:'locked',name:'Unavailable',locked:true,progress:{status:'in_progress',topics:[]}},
      {id:'first',name:'Lists',progress:{status:'not_started',topics:[]}},
      {id:'resume',name:'Classes',progress:{status:'in_progress',topics:[]}},
    ]}]});
    assert.equal(sent.at(-1).type, 'join');
    assert.equal(sent.at(-1).chapterId, 'resume');
    assert.match($('.workspace-title h1').textContent!, /Classes/);
    assert.match($('#lesson-placeholder').textContent!, /Connecting to Instructor/);
    assert.equal($('#composer').hidden, false);
    post({type:'restoreNotebook',attempt:sent.at(-1).attempt,documentKey:'resume',notebook:{...emptyNotebook(),cells:[
      {id:'saved',kind:'board',text:'Your earlier lesson'},
    ]}});
    await tick();
    assert.equal($('#lesson-placeholder').hidden, true);
    assert.match($('#feed').textContent!, /Your earlier lesson/);

    post({type:'chooseCourse',course:'New course'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'New course',chapters:[
      {id:'expired',name:'Expired',expired:true},{id:'start',name:'First available'},
    ]}]});
    assert.equal(sent.at(-1).chapterId, 'start', 'a new course opens its first accessible lesson without progress');
  } finally { await ui.close(); }
});

test('lesson loading, failure, retry and empty results remain distinct and preserve a requested lesson', async () => {
  const ui = room('Instructor'), {post,sent,$,tick} = ui;
  try {
    post({type:'chooseCourse',course:'Python',lesson:'c4'});
    const first = sent.at(-1).attempt;
    post({type:'tutorLessons',attempt:first,courses:[],error:'Could not reach dhimantAI. Reload lessons.'});
    assert.doesNotMatch($('#lesson-list').textContent!, /No lessons|Loading/);
    assert.match($('#lesson-placeholder').textContent!, /Could not reach/);
    assert.equal($('#tutor').hidden, false);
    $('#tutor').click();
    const retry = sent.at(-1).attempt;
    assert.match($('#lesson-list').textContent!, /Loading your lessons/);
    post({type:'tutorLessons',attempt:first,courses:[]});
    assert.equal($('#lesson-list').getAttribute('aria-busy'), 'true');
    post({type:'tutorLessons',attempt:retry,preferredCourse:'Python',courses:[{name:'Python',chapters}]});
    assert.equal(sent.at(-1).chapterId, 'c4', 'retry must resume the requested lesson, not silently open the first one');
    post({type:'failed',attempt:sent.at(-1).attempt,message:'Instructor is unavailable. Retry Instructor.'});
    await tick();
    assert.match($('#lesson-placeholder').textContent!, /Instructor is unavailable/);
    assert.equal($('#tutor').hidden, false);
    post({type:'chooseCourse',course:'Empty'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[]});
    assert.match($('#lesson-placeholder').textContent!, /No lessons available/);
    assert.doesNotMatch($('#lesson-list').textContent!, /Loading/);
    post({type:'chooseCourse',course:'Python'});
    const beforeSignOut = sent.at(-1).attempt;
    post({type:'signedOut'});
    post({type:'tutorLessons',attempt:beforeSignOut,courses:[{name:'Python',chapters}]});
    assert.equal($('#lesson-list').getAttribute('aria-busy'), 'false');
    assert.match($('#lesson-placeholder').textContent!, /account changed/);
  } finally { await ui.close(); }
});

test('unscoped Instructor shows selection guidance and does not start a course implicitly', async () => {
  const ui = room('Instructor'), {post,sent,$,tick} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    await tick();
    assert.equal(sent.some(message => message.type === 'join'), false);
    assert.match($('#lesson-placeholder').textContent!, /Choose a course and chapter/);
    assert.equal($('#lesson-placeholder').hidden, false);
    post({type:'chooseCourse',course:'Python',lesson:'c2'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    assert.equal(sent.some(message => message.type === 'join'), false, 'an expired requested lesson must not start another chapter');
  } finally { await ui.close(); }
});

test('learner speech silences the attached audio before the stop RPC resolves and keeps it muted through UI changes',async()=>{
  let finish:((value:string)=>void)|undefined;
  const ui=room('Instructor',false,async request=>request.method==='stop_speaking'?new Promise<string>(resolve=>{finish=resolve;}):'ok');
  const {post,sent,rooms,w,$,rpcs,tick}=ui;
  try {
    post({type:'openTutor'});post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    $('#lesson-list button').click();const attempt=sent.at(-1).attempt;
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'c1',media:true});await tick();
    const live=rooms.at(-1),peer=live.remoteParticipants.get('worker');
    const audio=w.document.createElement('audio');audio.play=async()=>{};audio.pause=()=>{};
    live.listeners.get('TrackSubscribed')({kind:'audio',attach:()=>audio},null,peer);
    live.listeners.get('ParticipantAttributesChanged')({'lk.agent.state':'speaking'},peer);
    live.listeners.get('ActiveSpeakersChanged')([live.localParticipant]);
    assert.equal(audio.muted,true);assert.equal($('#assistant-activity').textContent,'Listening…');
    assert.equal(rpcs.filter(r=>r.method==='stop_speaking').length,1);
    post({type:'visibility',visible:true});assert.equal(audio.muted,true);
    live.listeners.get('ActiveSpeakersChanged')([]);finish?.('ok');await tick();
    assert.equal(audio.muted,true);
    live.listeners.get('ParticipantAttributesChanged')({'lk.agent.state':'listening'},peer);
    live.listeners.get('ParticipantAttributesChanged')({'lk.agent.state':'speaking'},peer);
    assert.equal(audio.muted,false);
  }finally{finish?.('ok');await ui.close();}
});

test('Open in Instructor carries the draft and attempt note without sending a chat',async()=>{
  const ui=room('Doubt Solver',true),{post,sent,$,chats,tick}=ui;
  try {
    post({type:'openTutor',mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(ui.w, sent.at(-1).attempt);const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'doubt',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused'});await tick();
    $<HTMLTextAreaElement>('#message').value='Why does the palindrome stop here?';
    $<HTMLTextAreaElement>('#doubt-tried').value='I compared both ends.';
    assert.equal($('#doubt_solver').hidden,false);$('#doubt_solver').click();await tick();
    const handoff=sent.filter(message=>message.type==='workspaceMode').at(-1);
    assert.equal(handoff.mode,'tutor');assert.equal(handoff.carryDraft,true);
    assert.match(handoff.notebook.textDraft,/palindrome.*What I tried: I compared both ends/s);
    assert.equal(chats.length,0);
  }finally{await ui.close();}
});

test('verified work retires its prediction prompt and labels feedback with the task and training company',async()=>{
  const ui=room('Instructor'),{post,sent,$,publish,tick}=ui;
  const question={id:'buying:prediction:before',task:'buying',kind:'prediction',title:'Order from your supplier',
    question:'Stock after submitting the order?',context:'Predict first.',options:['0','5'],minLength:1,maxLength:800};
  try {
    post({type:'openTutor'});post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:ERP_COURSE,chapters:[{id:'po',name:'Purchase order'}]}]});
    $('#lesson-list button').click();const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'po',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'po',browserCourse:true});await tick();
    post({type:'browserObservation',attempt,chapter:'po',observation:null,question});
    const row=$('[data-browser-question-id="buying:prediction:before"]');
    post({type:'browserObservation',attempt,chapter:'po',observation:{training_tag:'0123456789'},
      question:{...question,id:'buying:explanation:check',kind:'explanation',question:'Why is stock unchanged?',options:[]}});
    assert.equal(row.querySelector<HTMLElement>('.conversation-body')?.hidden,true);
    publish('The purchase order for {{company}} did not receive stock.');
    assert.match($('#feed').textContent!,/Feedback for: Purchase order/);
    assert.match($('#feed').textContent!,/Training 0123456789/);
    assert.doesNotMatch($('#feed').textContent!,/\{\{company\}\}/);
  }finally{await ui.close();}
});

test('chapter transitions keep a loading outline until lessons arrive and reject a stale response', async () => {
  const ui=room('Instructor'),{post,sent,$}=ui;
  try {
    post({type:'openTutor'});const first=sent.at(-1).attempt;
    assert.match($('#lesson-list').textContent!,/Loading your lessons/);
    assert.doesNotMatch($('#lesson-list').textContent!,/No lessons/);
    post({type:'chooseCourse',course:'ERPNext Essentials',lesson:'supplier'});
    const next=sent.at(-1).attempt;
    post({type:'tutorLessons',attempt:first,courses:[]});
    assert.equal($('#lesson-list').getAttribute('aria-busy'),'true');
    post({type:'tutorLessons',attempt:next,courses:[{name:'ERPNext Essentials',chapters:[{id:'supplier',name:'Supplier'}]}]});
    assert.equal($('#lesson-list').getAttribute('aria-busy'),'false');
    assert.doesNotMatch($('#lesson-list').textContent!,/Loading|No lessons/);
    assert.equal(sent.filter(message=>message.type==='join').at(-1).chapterId,'supplier');
  } finally {await ui.close();}
});

test('ERPNext reopen shows four verified tasks, keeps the next task unfinished, and ignores Overview teaching resets', async () => {
  const tasks=JSON.parse(readFileSync(resolve(__dirname,'../../media/browser/erpnext/course.json'),'utf8')).lessons;
  const saved=Object.fromEntries(tasks.slice(0,4).map((task:any)=>[task.id,{record:task.id+'-saved',checkedAt:'2026-11-13T00:00:00Z',assisted:false,explained:true}]));
  const progress=browserCourseProgress(tasks,saved), chapter=tasks[4].instructorChapter;
  const catalog=[{name:ERP_COURSE,chapters:tasks.map((task:any)=>({id:task.instructorChapter,name:task.title,
    progress:{status:'not_started',covered:0,total:1,topics:[{id:'overview',title:'Overview',status:'not_started'}]}}))}];
  const ui=room('Instructor'),{w,sent,post,data,tick,$}=ui;
  try {
    post({type:'openTutor',lesson:chapter});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:catalog,browserProgress:progress});
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'erp',notebook:{...emptyNotebook(),lessonId:chapter,cells:[
      {id:'old-progress',kind:'recap',text:'### Lesson progress\n\n- Overview — Not taught',packet:{progressScope:JSON.stringify([ERP_COURSE,tasks[4].title,tasks[4].title])}},
      {id:'private-note',kind:'note',text:'Remember to check stock.'},
    ]}});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:chapter,browserCourse:true,browserProgress:progress});await tick();
    assert.match($('#feed').textContent!,/4\/18 tasks completed/);
    assert.match($('.notebook-progress').textContent!,/Order from your supplier · Not completed · 4\/18 tasks completed/);
    assert.match($('#feed').textContent!,/Create a stock item — Completed/);
    assert.match($('#feed').textContent!,/Order from your supplier — Not completed/);
    assert.equal($<HTMLTextAreaElement>('#feed textarea').value,'Remember to check stock.');
    assert.equal(w.document.querySelectorAll('#lesson-list .lesson-covered').length,4);
    data({method:'topic_update',subject:ERP_COURSE,chapter_name:tasks[4].title,lesson_name:tasks[4].title,
      lesson_topics:[{id:'overview',title:'Overview',covered:false,learning_status:'Not taught'}]});
    assert.doesNotMatch($('#feed').textContent!,/Overview|Not taught/);
    assert.match($('#feed').textContent!,/4\/18 tasks completed/);

    const checked=browserCourseProgress(tasks,{...saved,buying:{record:'PO-1',checkedAt:'2026-11-13T01:00:00Z',assisted:false,explained:false}});
    post({type:'browserObservation',attempt,chapter,observation:null,progress:checked});
    assert.match($('#feed').textContent!,/4\/18 tasks completed.*Explanation pending/s);
    const complete=browserCourseProgress(tasks,{...saved,buying:{record:'PO-1',checkedAt:'2026-11-13T01:00:00Z',assisted:false,explained:true}});
    post({type:'browserObservation',attempt:attempt-1,chapter,observation:null,progress:complete});
    assert.match($('#feed').textContent!,/4\/18 tasks completed/,'stale sessions cannot change progress');
    post({type:'browserObservation',attempt,chapter,observation:null,progress:complete});
    assert.match($('#feed').textContent!,/5\/18 tasks completed/);
    assert.equal([...w.document.querySelectorAll('#feed h3')].filter(n=>n.textContent==='Course progress').length,1);
    post({type:'signedOut'});
    assert.doesNotMatch($('#feed').textContent!,/tasks completed|stock item/);
  } finally {await ui.close();}
});

test('a guiding question stays on speaker leakage after a failed import, and recap retains the failed activity until its own rerun', async () => {
  const ui = room('Instructor'), {w, sent, post, publish, chats, chatOptions, data, tick, $} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Speech to text', chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();
    const attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'stt', notebook:emptyNotebook()});
    post({type:'grant', attempt, url:'unused', token:'unused', chapterId:'c1'}); await tick();
    $('#add-code').click();
    const editor = EditorView.findFromDOM($('.cm-editor'))!;
    editor.dispatch({changes:{from:0, insert:'from transformers import pipeline'}});
    $<HTMLButtonElement>('[data-action="run"]').click();
    const request = sent.filter(message => message.type === 'codeAction').at(-1);
    const execution = {status:'exited', exit_code:1, stdout:'', stderr:"ModuleNotFoundError: No module named 'transformers'", truncated:false};
    post({...request, type:'codeResult', execution});
    publish('Team A splits audio clips randomly; Team B holds out speakers. Which avoids speaker leakage and why?',
      {is_question_prompt:true, tutor_checkpoint_id:'speaker-leakage'});
    $('#practice-help').click(); await tick();
    assert.match(chats.at(-1)!, /Ask me one question.*Team A.*Team B.*speaker leakage/s);
    assert.equal(chatOptions.at(-1).attributes.tutor_action_id, 'hint', 'help is not graded as an answer');
    assert.equal(sent.some(message => message.type === 'notebookTurn'), false, 'the earlier selected code is not sent to a separate coach');
    assert.match($('#composer-context').textContent!, /Team A/, 'the open lesson question remains active');

    data({method:'tutor_session_summary', big_idea:'Keep speakers separate.', is_complete:true, partial_session:false, summary_scope:'full',
      lesson_progress:{total:3, completed_count:3}});
    assert.match($('#feed').textContent!, /Lesson completed.*3\/3 lesson sections completed/s);
    assert.match($('.execution-followup').textContent!, /Coding follow-up pending.*transformers/s);
    assert.ok($('[data-next-lesson]'));

    $('#add-code').click();
    const other = [...w.document.querySelectorAll<HTMLElement>('.practice-code-editor')].at(-1)!;
    const otherEditor = EditorView.findFromDOM(other.querySelector('.cm-editor')!)!;
    otherEditor.dispatch({changes:{from:0, insert:'print(1)'}});
    other.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
    const otherRequest = sent.filter(message => message.type === 'codeAction').at(-1);
    post({...otherRequest, type:'codeResult', execution:{...execution, exit_code:0, stderr:'', stdout:'1'}});
    assert.match($('.execution-followup').textContent!, /transformers/, 'another successful cell cannot resolve the import failure');

    await new Promise(resolve => setTimeout(resolve, 300));
    const saved = sent.filter(message => message.type === 'notebookChanged').at(-1).notebook;
    assert.equal(saved.executionIssues.length, 1);
    post({type:'restoreNotebook', attempt, documentKey:'stt', notebook:saved});
    assert.match($('.execution-followup').textContent!, /Recorded on this computer.*transformers/s);
    assert.equal($<HTMLElement>('.practice-output').hidden, true, 'history is not restored as current run evidence');
    $<HTMLButtonElement>('[data-action="run"]').click();
    const rerun = sent.filter(message => message.type === 'codeAction').at(-1);
    post({...rerun, request:rerun.request + 100, type:'codeResult', execution:{...execution, exit_code:0, stderr:''}});
    assert.ok($('.execution-followup'), 'a stale or mismatched completion cannot clear an issue');
    post({...rerun, type:'codeResult', execution:{...execution, exit_code:0, stderr:'', truncated:true}});
    assert.match($('.execution-followup').textContent!, /Output incomplete/);
    $<HTMLButtonElement>('[data-action="run"]').click();
    const complete = sent.filter(message => message.type === 'codeAction').at(-1);
    post({...complete, type:'codeResult', execution:{...execution, exit_code:0, stderr:''}});
    assert.equal($('.execution-followup'), null, 'only the affected cell’s complete successful rerun clears its follow-up');
  } finally { await ui.close(); }
});

test('partial and unconfirmed recaps do not show next lesson as a completion action', async () => {
  const ui = room('Instructor'), {sent, post, data, chats, tick, $} = ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons', attempt:sent.at(-1).attempt, courses:[{name:'Python', chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();
    const attempt = sent.at(-1).attempt;
    post({type:'grant', attempt, url:'unused', token:'unused', chapterId:'c1'}); await tick();
    data({method:'tutor_session_summary', big_idea:'Partial work', is_complete:false, partial_session:true, summary_scope:'partial'});
    assert.match($('#feed').textContent!, /Session ended — lesson still in progress/);
    assert.equal($('[data-next-lesson]'), null);
    $<HTMLButtonElement>('#feed .lesson-actions button').click(); await tick();
    assert.match(chats.at(-1)!, /resume the unfinished lesson/);
    data({method:'tutor_session_summary', big_idea:'No completion evidence'});
    assert.match($('#feed article:last-child').textContent!, /completion has not been confirmed/);
    assert.equal($('[data-next-lesson]'), null);
  } finally { await ui.close(); }
});

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

    data({method:'tutor_session_summary', big_idea:'Indexes are positions.', work_on:'negative indexes', is_complete:true, partial_session:false, summary_scope:'full'});
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

for (const language of ['en-IN', 'te-IN']) test(`Doubt Solver reports a rejected connection and Retry sends the saved question in ${language}`, async () => {
  let acknowledge!: (value: string) => void;
  const ui = room('Doubt Solver', true, request => request.method === 'switch_mode'
    ? new Promise(resolve => { acknowledge = resolve; }) : Promise.resolve('ok'));
  const {w, sent, post, rpcs, chats, rooms, publish, tick, $} = ui;
  try {
    post({type:'coachingLanguage', language});
    post({type:'openTutor', mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(ui.w, sent.at(-1).attempt);
    let attempt = sent.at(-1).attempt;
    post({type:'restoreNotebook', attempt, documentKey:'doubt', notebook:emptyNotebook()});
    const field = $<HTMLTextAreaElement>('#message'), send = $<HTMLButtonElement>('#send');
    field.value = 'Why does dividing by x lose a solution?'; field.dispatchEvent(new w.Event('input'));
    post({type:'grant', attempt, url:'unused', token:'unused'}); await tick();
    assert.equal(send.disabled, true, 'connecting cannot send a question');
    const first = JSON.parse(rpcs.find(r => r.method === 'switch_mode').payload);
    assert.equal(first.mode, 'doubt_solver'); assert.equal(first.language, language);
    acknowledge('error: choose Instructor, Doubt Solver or Study in this room'); await tick();
    assert.match($('#status').textContent!, /Doubt Solver.*connection request.*Contact support/);
    assert.doesNotMatch($('#status').textContent!, /Study/);
    assert.equal($('#notebook-help-status').textContent, $('#status').textContent);
    assert.equal($('#tutor').textContent, 'Retry Doubt Solver'); assert.equal($('#tutor').hidden, false);
    assert.equal(send.disabled, true); assert.equal(chats.length, 0);

    $('#tutor').click();
    const retried = sent.filter(m => m.type === 'join').at(-1);
    assert.ok(retried.attempt > attempt); assert.equal(retried.mode, 'doubt_solver');
    assert.match($('#status').textContent!, /Connecting to Doubt Solver/);
    assert.equal(field.value, 'Why does dividing by x lose a solution?');
    assert.equal($('#tutor').hidden, true); assert.equal(send.disabled, true);
    post({type:'failed', attempt, message:'Late failure from the old attempt'});
    assert.doesNotMatch($('#status').textContent!, /Late failure/);
    attempt = retried.attempt;
    post({type:'restoreNotebook', attempt, documentKey:'retried-doubt', notebook:sent.filter(m => m.type === 'notebookChanged').at(-1).notebook});
    post({type:'grant', attempt, url:'unused', token:'unused'}); await tick();
    assert.equal(rooms.length, 2);
    const retry = JSON.parse(rpcs.filter(r => r.method === 'switch_mode').at(-1).payload);
    assert.equal(retry.mode, first.mode); assert.equal(retry.language, first.language);
    assert.match(retry.doubt_id, /^[0-9a-f-]{36}$/, 'an unsent question gets a fresh doubt on notebook restore');
    assert.equal(send.disabled, true, 'a grant alone does not make the agent ready');
    acknowledge('ok'); await tick();
    assert.equal($('#status').textContent, 'Doubt Solver connected'); assert.equal(send.disabled, false);
    assert.equal($('#tutor').hidden, true);
    send.click(); await tick();
    assert.equal(chats.at(-1), 'Why does dividing by x lose a solution?');
    publish('Dividing by x assumes x is nonzero. Check x = 0 first.');
    assert.match($('#feed').textContent!, /Check x = 0 first/);
  } finally { await ui.close(); }
});

test('Doubt Solver keeps repeated service failures visible and retries only on request', async () => {
  const ui = room('Doubt Solver', false, async request => request.method === 'switch_mode'
    ? 'error: Learning service temporarily unavailable. Retry shortly.' : 'ok');
  const {w, sent, post, rpcs, tick, $} = ui;
  try {
    post({type:'openTutor', mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(ui.w, sent.at(-1).attempt);
    for (let retry = 0; retry < 3; retry++) {
      const attempt = sent.filter(m => m.type === 'join').at(-1).attempt;
      post({type:'restoreNotebook', attempt, documentKey:'doubt', notebook:{...emptyNotebook(), textDraft:'My unsent question'}});
      post({type:'grant', attempt, url:'unused', token:'unused'}); await tick();
      assert.equal($('#status').textContent, 'Learning service temporarily unavailable. Retry shortly.');
      assert.equal($<HTMLButtonElement>('#send').disabled, true);
      assert.equal($<HTMLTextAreaElement>('#message').value, 'My unsent question');
      assert.equal($('#tutor').hidden, false);
      await tick();
      assert.equal(sent.filter(m => m.type === 'join').length, retry + 1);
      assert.equal(rpcs.filter(r => r.method === 'switch_mode').length, retry + 1);
      if (retry < 2) $('#tutor').click();
    }
  } finally { await ui.close(); }
});

test('Doubt Solver keeps doubts separate, recaps the current one on reconnect and sends attempt context', async () => {
  const ui = room('Doubt Solver'), {w, sent, post, rpcs, chats, rooms, publish, tick, $} = ui;
  try {
    post({type:'openTutor', mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(ui.w, sent.at(-1).attempt);
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
    assert.equal(sent.at(-1).type,'switchDoubtChat');
    assert.ok($('#feed').textContent!.includes('Dividing by x'), 'keep the old chat until its save succeeds');
    post({type:'openDoubtChat',chapter:'c1',newChat:true});
    attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'fresh-chat',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'c1'});await tick();
    assert.equal($('#feed').textContent,'', 'the new chat is a separate document');
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
    post({type:'openTutor', mode:'doubt_solver'}); if (sent.at(-1).type === 'tutorLessons') selectLesson(ui.w, sent.at(-1).attempt);
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

test('course workspace filters lessons, offers scoped Practice and saves the current draft with a mode switch', async () => {
  const ui=room('Instructor',true), {w,post,sent,$,tick}=ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,preferredCourse:'Python',courses:[{name:'Python',chapters},{name:'SQL',chapters:[{id:'s1',name:'Joins'}]}]});
    assert.deepEqual([...w.document.querySelectorAll('#lesson-course option')].map(o=>o.textContent),['Python']);
    $<HTMLButtonElement>('#lesson-list button').click();
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'python',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'c1'}); await tick();
    const picker=$<HTMLSelectElement>('#workspace-mode');picker.value='practice';picker.dispatchEvent(new w.Event('change'));
    assert.equal(sent.at(-1).type,'workspacePractice');assert.equal(sent.at(-1).chapterId,'c1');
    post({type:'workspacePractice',course:'Python',chapterId:'c1',chapters,questions:[{id:'p1',title:'Write a loop'}]});
    assert.equal($('#practice-questions').textContent,'Write a loop');
    $<HTMLButtonElement>('#practice-back').click();
    $<HTMLTextAreaElement>('#message').value='My unsent reasoning';
    picker.value='doubt_solver';picker.dispatchEvent(new w.Event('change'));
    const change=sent.at(-1);
    assert.equal(change.type,'workspaceMode');assert.equal(change.mode,'doubt_solver');
    assert.equal(change.documentKey,'python');assert.equal(change.notebook.textDraft,'My unsent reasoning');
    assert.equal(picker.disabled,true);
    post({type:'workspaceError',message:'Save failed'});assert.equal(picker.disabled,false);
  } finally { await ui.close(); }
});

test('coaching language reaches live Tutor, duplicate figures stay in history, and recap totals real XP once', async () => {
  const ui=room('Instructor',true), {post,sent,$,tick,rpcs,publish,data,w}=ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'python',notebook:emptyNotebook()});
    post({type:'coachingLanguage',language:'te-IN'});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'c1'});await tick();
    assert.equal(JSON.parse(rpcs.find(r=>r.method==='switch_mode').payload).language,'te-IN');
    const image='![Agent loop](https://example.com/agent.png)';
    publish('## Agent loop\n\n'+image+'\n\nObserve then act.');
    publish('## Feedback\n\n'+image+'\n\nNow consider a list.');
    assert.equal(w.document.querySelectorAll('#feed img').length,1,'feedback does not copy an already displayed diagram');
    publish('Use this figure to answer the question.\n\n'+image,{is_question_prompt:true,tutor_checkpoint_id:'q'});
    assert.equal(w.document.querySelectorAll('#feed img').length,2,'a question keeps its givens');
    data({method:'award_xp',award_id:'award-1',amount:20,reason:'Persistence'});
    data({method:'award_xp',award_id:'award-1',amount:20,reason:'Persistence'});
    data({method:'award_xp',award_id:'award-2',amount:10,reason:'A clear explanation'});
    data({method:'award_xp',award_id:'invalid',amount:-10});
    data({method:'tutor_session_summary',big_idea:'Lists keep values in order.'});
    assert.match($('#feed').textContent!,/Lesson XP earned: 30 XP/);
    data({method:'award_xp',award_id:'late-award',amount:10,reason:'Finished the lesson'});
    assert.match($('#feed').textContent!,/Lesson XP earned: 40 XP/,'awards delivered just after the recap update its total');
    publish('Write a Python program to print two words.',{is_question_prompt:true,tutor_checkpoint_id:'write',tutor_practice_editor:{
      checkpoint_id:'write',question_id:'write',language:'python',starter:'',question:'Print two words.',source:'Your turn'}});
    assert.ok($('#feed .cm-editor'),'the code-writing question has an integrated editor');
    assert.ok([...w.document.querySelectorAll('#feed button')].some(b=>b.textContent==='Run'));
  } finally { await ui.close(); }
});

test('Instructor deduplicates mixed image deliveries, explicit revisits and question givens', async () => {
  const ui=room('Instructor'),{post,sent,$,tick,publish,data,w}=ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'mixed-visuals',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'c1'});await tick();
    const source='https://example.com/agent(1).png?version=2';
    const image=`![Agent loop](${source} "Original")`;
    const payload={method:'draw_svg',image_url:source,label:'Figure [1]'};
    const count=()=>w.document.querySelectorAll('#feed img.board-image').length;
    data(payload);
    publish(image+'\n\nObserve, decide, act.');
    data({...payload,method:'display_image',caption:'Caption changed'});
    assert.equal(count(),1,'separate tool events and inline Markdown show one figure');
    assert.match($('#feed').textContent!,/Observe, decide, act/);

    // A learner can revisit a figure, once, even when the agent emits it through both paths.
    const field=$<HTMLTextAreaElement>('#message');
    field.value='Please explain this diagram again.';field.dispatchEvent(new w.Event('input'));
    $('#send').click();await tick();
    publish(image+'\n\n'+image+'\n\nFollow the arrows.');
    data(payload);data(payload);
    assert.equal(count(),2,'one requested repeat, including duplicates in the same response');
    field.value='Continue';field.dispatchEvent(new w.Event('input'));$('#send').click();await tick();
    data(payload);assert.equal(count(),2,'a later ordinary turn does not repeat it');

    const question={is_question_prompt:true,tutor_checkpoint_id:'figure-question'};
    data({...payload,...question});
    publish(image+'\n\nWhich arrow returns to the start?',question);
    publish('Read this figure.\n\n'+image,question);
    assert.equal(count(),3,'a new question retains one copy of its givens');
    assert.match($('#feed').textContent!,/Which arrow returns to the start/);
    const next={is_question_prompt:true,tutor_checkpoint_id:'next-figure-question'};
    publish(image+'\n\nWhat happens after observing?',next);
    data({...payload,...next});
    assert.equal(count(),4,'another question can deliberately reuse the figure');
    publish('Correct: the agent decides what to do.',{tutor_feedback:true,tutor_checkpoint_id:next.tutor_checkpoint_id,correct:true});
    assert.equal($<HTMLButtonElement>('#composer-mode-actions [data-lesson-action="continueLesson"]').hidden,false,
      'a question image must not capture feedback intended for the written question');
    const imageOnly={is_question_prompt:true,tutor_checkpoint_id:'image-only'};
    data({...payload,...imageOnly});publish(image,imageOnly);
    assert.equal(count(),5);
    assert.match($('#feed').textContent!,/Use the figure above to answer/);
    assert.equal($('label[for="message"]').textContent,'Your answer to Instructor','an image-only question still accepts an answer');

    await new Promise(resolve=>setTimeout(resolve,300));
    const saved=sent.filter(message=>message.type==='notebookChanged').at(-1).notebook;
    post({type:'restoreNotebook',attempt,documentKey:'mixed-visuals',notebook:saved});
    assert.equal(count(),5,'saved questions and intentional revisits retain their figures');
  } finally {await ui.close();}
});

test('older Instructor notebooks hide duplicate images on reopen without rewriting saved text', async () => {
  const ui=room('Instructor'),{post,sent,$,w}=ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();const attempt=sent.at(-1).attempt;
    const source='https://example.com/original.png', svg='<svg viewBox="0 0 100 50"><text x="10" y="20">Agent</text></svg>';
    const legacy={...emptyNotebook(),cells:[
      {id:'original',kind:'diagram',text:`![Figure](<${source}>)`,packet:{image_url:source,label:'Figure'}},
      {id:'inline-copy',kind:'board',text:`![Other caption](${source})\n\nThe arrows show the loop.`},
      {id:'event-copy',kind:'diagram',text:`![Figure](<${source}>)`,packet:{image_url:source,label:'Figure'}},
      {id:'svg',kind:'diagram',text:svg},
      {id:'svg-copy',kind:'board',text:'```svg\n'+svg+'\n```\n\nNotice the direction.'},
    ]};
    post({type:'restoreNotebook',attempt,documentKey:'older-images',notebook:legacy});
    assert.equal(w.document.querySelectorAll('#feed img.board-image').length,1);
    assert.equal(w.document.querySelectorAll('#feed img.board-diagram').length,1);
    assert.equal(w.document.querySelectorAll('#feed article').length,4,'duplicate-only cards are hidden');
    assert.equal(w.document.querySelector('.notebook-index option[value="event-copy"]'),null,'navigation only lists visible entries');
    assert.match($('#feed').textContent!,/The arrows show the loop/);
    assert.match($('#feed').textContent!,/Notice the direction/);
    const field=$<HTMLTextAreaElement>('#message');field.value='Keep this draft';field.dispatchEvent(new w.Event('input'));
    await new Promise(resolve=>setTimeout(resolve,300));
    const saved=sent.filter(message=>message.type==='notebookChanged').at(-1).notebook;
    assert.deepEqual(JSON.parse(JSON.stringify(saved.cells)),legacy.cells,'display cleanup preserves the original notebook content');
  } finally {await ui.close();}
});

test('muted Instructor failure is visible once, keeps work, ignores retired turns and supports Continue', async () => {
  const ui=room('Instructor'),{sent,post,data,tick,$,chats,chatOptions}=ui;
  try {
    post({type:'openTutor'});
    post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'AI-Assisted Kafka',chapters}]});
    $<HTMLButtonElement>('#lesson-list button').click();
    const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'ai-kafka-failure',notebook:emptyNotebook()});
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId:'c1'});await tick();
    $('#sound').click();
    $('#add-code').click();
    const editor=EditorView.findFromDOM($('.cm-editor'))!;
    editor.dispatch({changes:{from:0,insert:'print("keep my work")'}});
    data({method:'tutor_turn_started',tutor_turn_id:'current'});
    data({method:'tutor_request_failed',tutor_turn_id:'old',message:'Stale failure'});
    assert.doesNotMatch($('#feed').textContent!,/Stale failure/);
    const packet={method:'tutor_request_failed',tutor_turn_id:'current',tutor_step_id:'answer-step',message:'A technical problem interrupted this step. Tap Continue to retry.'};
    data(packet);data(packet);
    assert.equal([...ui.w.document.querySelectorAll('#feed article')].filter(e=>e.textContent?.includes('A technical problem')).length,1);
    assert.match($('#status').textContent!,/Tap Continue/);
    assert.equal(editor.state.doc.toString(),'print("keep my work")');
    data({method:'display_on_screen',tutor_step_id:'another-step',content:'Another explanation.'});
    assert.match($('#feed').textContent!,/A technical problem/,'another step cannot resolve this failure');
    data({method:'display_on_screen',tutor_step_id:'answer-step',content:'Your source is correct.',tutor_feedback:true});
    assert.doesNotMatch($('#feed').textContent!,/A technical problem/);
    assert.match($('#status').textContent!,/recovered/);
    data(packet);
    assert.doesNotMatch($('#feed').textContent!,/A technical problem/,'late failure cannot replace delivered feedback');
    data({...packet,tutor_step_id:'next-step'});
    assert.match($('#feed').textContent!,/A technical problem/,'a distinct failed step remains retryable');
    const next=[...ui.w.document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Continue')!;
    next.click();await tick();
    assert.equal(chatOptions.at(-1).attributes.tutor_action_id,'continueLesson');
    assert.ok(chats.at(-1));
    data({method:'tutor_turn_started',tutor_turn_id:'retry'});
    const retried={...packet,tutor_turn_id:'retry',tutor_step_id:'retry-step',tutor_retry_of_step_id:'next-step'};
    data(retried);
    assert.equal([...ui.w.document.querySelectorAll('#feed article')].filter(e=>e.textContent?.includes('A technical problem')).length,1,'repeated failure updates the same interrupted activity');
    assert.match($('#status').textContent!,/Tap Continue/,'a repeated failure still updates the current send status');
    data({method:'display_on_screen',tutor_step_id:'unrelated',content:'An unrelated card.'});
    assert.match($('#feed').textContent!,/A technical problem/);
    data({method:'display_on_screen',tutor_step_id:'retry-step',tutor_retry_of_step_id:'next-step',content:'Your saved answer is correct.',tutor_feedback:true});
    assert.doesNotMatch($('#feed').textContent!,/A technical problem/,'a successful Continue clears the original failure despite its new step ID');
    data(retried);
    assert.doesNotMatch($('#feed').textContent!,/A technical problem/,'late retry failure cannot undo accepted feedback');
    assert.equal(editor.state.doc.toString(),'print("keep my work")');
  } finally {await ui.close();}
});

test('reopening sends the exact pending question, preserves the draft and returns to the stopping point without a session recap',async()=>{
  const ui=room('Instructor'),{post,sent,$,tick,rpcs,data}=ui;
  try {
    post({type:'openTutor'});post({type:'tutorLessons',attempt:sent.at(-1).attempt,courses:[{name:'Python',chapters}]});
    $('#lesson-list button').click(); const attempt=sent.at(-1).attempt;
    post({type:'restoreNotebook',attempt,documentKey:'saved',notebook:{...emptyNotebook(),textDraft:'not sent yet',cells:[
      {id:'setup',kind:'board',text:'Define saved = 41',packet:{active_subtopic:'Variables'}},
      {id:'q',kind:'board',text:'## Your turn\n\nPrint saved',packet:{is_question_prompt:true,tutor_checkpoint_id:'question-1',tutor_question_prompt:'Print saved',active_subtopic:'Variables'}},
      {id:'note',kind:'note',text:'Private detail'},
    ]}});
    post({type:'grant',attempt,url:'wss://localhost',token:'test',chapterId:'c1'});await tick();
    const payload=JSON.parse(rpcs.find(request=>request.method==='switch_mode').payload);
    assert.equal(payload.notebook_resume.question.text,'Print saved');
    assert.equal(payload.notebook_resume.question.submitted,false);
    assert.doesNotMatch(JSON.stringify(payload),/Private detail|not sent yet/);
    assert.doesNotMatch($('#feed').textContent!, /Session recap|Previously covered|questions? received feedback/i);
    assert.match($('#stopping-point').textContent!, /still waiting for your answer/);
    post({type:'runtimeHistory',documentKey:'saved',count:1,needsRestore:true});
    assert.match($('#stopping-point #runtime-restore').textContent!, /Python variables need restoring/);
    assert.equal($('#stopping-point').lastElementChild?.textContent,'Return to stopping point');
    $('#stopping-point > button').click();
    assert.equal(ui.w.document.activeElement?.getAttribute('data-cell-id'), 'q');
    assert.equal($<HTMLTextAreaElement>('#message').value,'not sent yet');
    assert.equal(ui.chats.length,0,'restoring must not send Continue or the draft');
    data({method:'notebook_resume_ready',checkpoint_id:'question-1',verified:true});await tick();
    assert.match($('#composer-context').textContent!,/Print saved/);
  }finally{await ui.close();}
});
