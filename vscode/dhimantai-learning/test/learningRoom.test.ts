import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { topicTeachBackRequest } from '../src/teachBack';
import { EditorView } from '@codemirror/view';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

test('learning room accepts only host grants, renders agent Markdown and drops late packets on mode change', async () => {
  const dom = new JSDOM('<button id="wide"></button><button id="latest"></button><button id="tutor"></button><button id="doubt_solver"></button><button id="end" disabled></button><button id="sound"></button><span id="status"></span><input id="follow-code" type="checkbox" checked><input id="stuck-hints" type="checkbox"><small id="code-observer-status"></small><main id="feed"></main><form id="composer"><textarea id="message"></textarea><button id="send"></button><button type="button" id="teach-back" disabled></button><button id="video"></button></form>',
    {runScripts:'outside-only', url:'https://webview.example', pretendToBeVisual: true});
  const w = dom.window, sent: any[] = [], chats: any[] = [], rpcs: any[] = [], rooms: Room[] = [];
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  let failSend = false;
  const agent = {identity:'worker', isAgent:true, trackPublications:new Map()};
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker',agent]]);
    localParticipant = {sendText: async (text: string, to: object) => { if (failSend) throw new Error('offline'); chats.push({text, to}); }, registerRpcMethod() {}, performRpc: async (rpc: any) => { rpcs.push(rpc); return 'ok'; }};
    constructor() { rooms.push(this); }
    on(name: string, fn: Function) { this.listeners.set(name,fn); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const names = ['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'];
  w.LivekitClient = {Room,RoomEvent:Object.fromEntries(names.map(n=>[n,n]))};
  w.acquireVsCodeApi = () => ({postMessage:(m: any)=>sent.push(m)});
  w.TextDecoder = TextDecoder;
  w.TextEncoder = TextEncoder;
  w.Range.prototype.getClientRects = () => [] as any;
  w.Range.prototype.getBoundingClientRect = () => ({left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0}) as any;
  const post = (data: object, origin = w.location.origin) => w.dispatchEvent(new w.MessageEvent('message',{data,origin}));
  const html = () => w.document.getElementById('feed')!;
  try {
    w.eval(readFileSync(resolve(__dirname,'../../media/learning-room/room.js'),'utf8'));
    post({type:'openTutor',mode:'doubt_solver'},'https://untrusted.example');
    assert.equal(sent.filter(m => m.type === 'join').length,0,'external frames cannot select a learning mode');
    post({type:'openTutor',mode:'doubt_solver'});
    assert.equal(sent.at(-1).mode,'doubt_solver','the catalog can start directly in Doubt Solver');
    const doubtAttempt = sent.at(-1).attempt;
    post({type:'openTutor',mode:'doubt_solver'});
    assert.equal(sent.at(-1).attempt,doubtAttempt,'reopening the current mode does not restart it');
    post({type:'failed',attempt:doubtAttempt,message:'Could not connect.'});
    assert.equal(w.document.getElementById('tutor')!.textContent,'Retry Doubt Solver');
    w.document.getElementById('tutor')!.click();
    assert.equal(sent.at(-1).mode,'doubt_solver','retry retains the requested learning mode');
    post({type:'openTutor'});
    assert.equal(sent.at(-1).type,'tutorLessons','Instructor opens the lesson chooser without a room grant');
    assert.equal(w.document.getElementById('composer')!.hidden,true,'free-topic entry is unavailable before lesson selection');
    selectLesson(w, sent.at(-1).attempt);
    assert.equal(sent.at(-1).mode,'tutor');
    assert.equal(sent.at(-1).chapterId,chapterId);
    assert.equal(w.document.querySelector<HTMLButtonElement>('#lesson-list button:last-child')!.disabled,true);
    assert.equal(w.document.getElementById('tutor')!.hidden,true);
    assert.equal(w.document.getElementById('end')!.hidden,true);
    const grant = {type:'grant',attempt:sent.at(-1).attempt,url:'unused',token:'unused',chapterId};
    post(grant,'https://untrusted.example'); assert.equal(rooms.length,0);
    post(grant); await new Promise(r=>setTimeout(r,0));
    assert.deepEqual(JSON.parse(rpcs.find(rpc => rpc.method === 'switch_mode').payload), {mode:'tutor',chapter_id:chapterId});
    const receive = rooms[0].listeners.get('DataReceived')!;
    const data = new TextEncoder().encode(JSON.stringify({method:'display_on_screen',content:'## Factors\n\n**Two**\n\n```py\nprint(2)\n```\n\n$2^2$\n\n<img src=x onerror=alert(1)>'}));
    receive(data,{isAgent:false}); assert.equal(html().children.length,0);
    receive(data,agent); assert.equal(html().querySelector('h2')?.textContent,'Factors');
    assert.ok(html().querySelector('strong')); assert.ok(html().querySelector('.cm-content')); assert.ok(html().querySelector('.katex'));
    assert.equal(html().querySelector('img'),null);
    const publish = (content: string, fields = {}) => receive(new TextEncoder().encode(JSON.stringify({method:'display_on_screen', content, ...fields})), agent);
    publish('## 1. The void has a name\n\n**List indexing: position, not value**\nEach index selects a position.', {active_subtopic:'1. The void has a name'});
    assert.equal(html().lastElementChild!.querySelector('h2')!.textContent, 'List indexing: position, not value');
    assert.match(html().lastElementChild!.textContent!, /Each index selects/);
    const question = '  fruits = ["Apple", "Banana", "Mango"]\nif fruits:\n    print(fruits[3])\n';
    const field = w.document.querySelector<HTMLTextAreaElement>('#message')!;
    const teachBack = w.document.getElementById('teach-back') as HTMLButtonElement;
    assert.equal(teachBack.disabled, false);
    field.value = 'My draft explanation';
    teachBack.click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(chats.at(-1).text, topicTeachBackRequest);
    assert.equal(field.value, 'My draft explanation');
    assert.equal(rooms.length, 1, 'teach-back stays in the same conversation');
    for (const text of [question, 'Banana']) {
      field.value = text;
      field.dispatchEvent(new w.Event('input'));
      w.document.getElementById('send')!.click();
      await new Promise(r => setTimeout(r, 0));
      assert.equal(html().lastElementChild!.querySelector('.learner-message')!.textContent, text);
      assert.equal(chats.at(-1).text, text);
      assert.equal(chats.at(-1).to.topic, 'lk.chat');
      assert.deepEqual([...chats.at(-1).to.destinationIdentities], ['worker']);
    }
    assert.equal(rooms.length, 1, 'follow-ups use the same Instructor session');

    const code = 'if 0 <= i < len(fruits):\n    print(fruits[i])';
    publish([
      'Why the index fails', '', '<details open><summary><b>Step 1: Valid indexes</b></summary>',
      '', 'A three-item list ends at index 2.', '', '```python', code, '```', '</details>',
      '<details onclick="bad()"><summary>Step 2: Verify</summary>', 'Try i = 3.', '</details>',
    ].join('\n'));
    const sections = Array.from(html().lastElementChild!.querySelectorAll('details')).filter(d => !d.closest('.practice-code-editor'));
    assert.equal(sections.length, 2);
    assert.ok(sections[0].open && !sections[1].open);
    assert.equal(sections[0].querySelector('summary')!.textContent, 'Step 1: Valid indexes');
    assert.equal(EditorView.findFromDOM(sections[0].querySelector<HTMLElement>('.cm-content')!)!.state.doc.toString(), code + '\n');
    assert.equal(sections[1].attributes.length, 0);
    assert.doesNotMatch(html().lastElementChild!.textContent!, /<\/?(?:details|summary|b)>/);

    const editor = sections[0].querySelector<HTMLElement>('.practice-code-editor')!;
    const source = EditorView.findFromDOM(editor.querySelector<HTMLElement>('.cm-content')!)!;
    const setCode = (text: string) => source.dispatch({changes: {from: 0, to: source.state.doc.length, insert: text}});
    const run = editor.querySelector<HTMLButtonElement>('[data-action=run]')!;
    const check = editor.querySelector<HTMLButtonElement>('[data-action=check]')!;
    const coach = editor.querySelector<HTMLButtonElement>('[data-action=coach]')!;
    const output = editor.querySelector<HTMLElement>('.practice-output')!;
    setCode('print("edited")');
    run.click();
    const requested = sent.at(-1);
    assert.equal(requested.action, 'run'); assert.equal(requested.source, source.state.doc.toString());
    const result = {type: 'codeResult', attempt: requested.attempt, snippet: requested.snippet,
      revision: requested.revision, request: requested.request};
    const execution = {status: 'exited', exit_code: 0, stdout: 'edited\n', stderr: '', truncated: false};
    post({...result, execution}, 'https://untrusted.example'); assert.equal(output.hidden, true);
    post({...result, execution}); assert.match(output.textContent!, /edited/);
    setCode('print("next")');
    assert.equal(output.hidden, true);
    post({...result, execution}); assert.equal(output.hidden, true, 'late runs never restore stale output');
    const prediction = editor.querySelector<HTMLTextAreaElement>('.practice-prediction')!;
    const sentBefore = sent.length;
    check.click();
    assert.equal(sent.length, sentBefore, 'Check first asks for a prediction');
    assert.match(editor.textContent!, /Write your prediction before reviewing/);
    check.click();
    assert.equal(sent.at(-1).prediction, '', 'a second press skips the prediction');
    setCode('print("next")  ');
    setCode('print("next")');
    prediction.value = 'next';
    check.click();
    const checking = sent.at(-1);
    assert.equal(checking.action, 'run'); assert.equal(checking.source, source.state.doc.toString());
    assert.equal(checking.prediction, 'next');
    const checked = {...result, revision: checking.revision, request: checking.request};
    post({...checked, execution: {...execution, stdout: 'next\n'}});
    assert.equal(check.disabled, true, 'Check waits for its review after displaying execution');
    await new Promise(r => setTimeout(r, 0));
    assert.equal(check.disabled, false);
    assert.equal(chats.at(-1).to.attributes.tutor_action_id, 'hint');
    const help = JSON.parse(chats.at(-1).text.split('\n').slice(1).join('\n'));
    assert.equal(help.source, 'print(\"next\")');
    assert.equal(help.prediction, 'next'); assert.equal(help.run.output, 'next\n');
    assert.match(editor.textContent!, /Instructor will respond here/);
    const observed = JSON.parse(rpcs.filter(r => r.method === 'on_editor_activity').at(-1).payload);
    assert.equal(observed.source, 'print("next")'); assert.equal(observed.run.output, 'next\n');
    assert.match(chats.at(-1).text, /^TUTOR_NOTEBOOK_HELP\n/, 'review requests help from the same Instructor, never submits an answer');
    post({type: 'codeSettings', aiEnabled: false});
    assert.equal(coach.disabled, true); assert.equal(check.disabled, true); assert.equal(run.disabled, false);
    post({type: 'codeSettings', aiEnabled: true});
    const follow = w.document.getElementById('follow-code') as HTMLInputElement;
    follow.checked = false; follow.dispatchEvent(new w.Event('change'));
    assert.equal(JSON.parse(rpcs.at(-1).payload).clear, true);
    const count = rpcs.length;
    setCode('print("private edit")');
    await new Promise(r => setTimeout(r, 850));
    assert.equal(rpcs.length, count, 'turning observation off stops background sharing');
    follow.checked = true; follow.dispatchEvent(new w.Event('change'));
    assert.equal(JSON.parse(rpcs.at(-1).payload).source, source.state.doc.toString());
    assert.equal(JSON.parse(rpcs.at(-1).payload).run, null, 'changed code clears the live Instructor run');
    const timers = new Map<number, {callback: () => void; delay: number}>();
    const schedule = w.setTimeout, cancel = w.clearTimeout;
    let timerId = 100000;
    w.setTimeout = ((callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, {callback, delay}); return id; }) as any;
    w.clearTimeout = (id: number) => { timers.delete(id); };
    try {
      setCode('print("first edit")'); setCode('print("paused edit")');
      assert.equal([...timers.values()].filter(t => t.delay === 750).length, 1);
      [...timers.values()].find(t => t.delay === 750)!.callback();
      assert.equal(JSON.parse(rpcs.at(-1).payload).source, 'print("paused edit")');
      assert.equal([...timers.values()].some(t => t.delay > 750), false, 'no unrequested hint unless the learner opts in');
      const stuck = w.document.getElementById('stuck-hints') as HTMLInputElement;
      stuck.checked = true; stuck.dispatchEvent(new w.Event('change'));
      setCode('print("paused edit")  ');
      assert.equal([...timers.values()].some(t => t.delay === 8000), false);
      [...timers.values()].find(t => t.delay === 90000)!.callback();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      assert.match(chats.at(-1).text, /^TUTOR_NOTEBOOK_HELP\n/, 'opted-in hints use the same Instructor');
      const observing = sent.at(-1);
      setCode('print("typing again")');
      post({...result, request: observing.request, revision: observing.revision,
        feedback: {guidance: 'Outdated hint', prompt: '', line: null}});
      assert.doesNotMatch(editor.textContent!, /Outdated hint/);
    } finally { w.setTimeout = schedule; w.clearTimeout = cancel; }

    // A genuine textbook task gets one editor even when the prompt contains no source fence.
    const textbook = {is_question_prompt: true, tutor_checkpoint_id: 'checkpoint-1', tutor_practice_editor: {
      question_id: 'textbook-1', checkpoint_id: 'checkpoint-1', language: 'python', starter: '',
      question: 'Write a program that prints oxygen.', source: 'Textbook exercise',
    }};
    publish('## Your turn\nWrite a program that prints oxygen.', textbook);
    const task = html().lastElementChild!.querySelector<HTMLElement>('.practice-code-editor')!;
    const taskCode = EditorView.findFromDOM(task.querySelector<HTMLElement>('.cm-content')!)!;
    const submit = task.querySelector<HTMLButtonElement>('[data-action=submit]')!;
    assert.equal(taskCode.state.doc.toString(), ''); assert.equal(submit.disabled, true);
    taskCode.dispatch({changes: {from: 0, insert: 'print("oxygen")'}});
    assert.equal(submit.disabled, false);
    const taskCoach = task.querySelector<HTMLButtonElement>('[data-action=coach]')!;
    taskCoach.click();
    await new Promise(r => setTimeout(r, 0));
    assert.match(chats.at(-1).text, /^TUTOR_NOTEBOOK_HELP\n/, 'Ask Instructor is help, never an answer');
    publish('## Your turn\nWrite a program that prints oxygen.', textbook);
    assert.equal(html().lastElementChild!.querySelector('.practice-code-editor'), task);
    assert.equal(taskCode.state.doc.toString(), 'print("oxygen")', 'question replay preserves the draft');
    failSend = true; submit.click(); await new Promise(r => setTimeout(r, 0));
    assert.match(task.textContent!, /was not sent/); assert.equal(submit.disabled, false);
    failSend = false; submit.click(); await new Promise(r => setTimeout(r, 0));
    const submission = JSON.parse(chats.at(-1).text.split('\n').slice(1).join('\n'));
    assert.equal(submission.checkpoint_id, 'checkpoint-1'); assert.equal(submission.question_id, 'textbook-1');
    assert.equal(submission.source, 'print("oxygen")'); assert.equal(submission.helped, true);
    assert.equal(submit.disabled, true, 'no duplicate submission while awaiting Instructor feedback');
    assert.doesNotMatch(html().lastElementChild!.textContent!, /TUTOR_TEXTBOOK_SUBMISSION/);
    publish('Feedback on your solution.', {tutor_feedback: true});
    assert.equal(submit.disabled, true);
    const second = {...textbook, tutor_checkpoint_id: 'checkpoint-2', tutor_practice_editor: {
      ...textbook.tutor_practice_editor, checkpoint_id: 'checkpoint-2', starter: '# Your solution\n',
    }};
    publish('Example input:\n```python\nprint("example")\n```', second);
    const secondCard = html().lastElementChild!;
    assert.equal(secondCard.querySelectorAll('.practice-code-editor').length, 1, 'examples stay read-only');
    assert.match(secondCard.querySelector('pre > code')!.textContent!, /example/);
    const secondSubmit = secondCard.querySelector<HTMLButtonElement>('[data-action=submit]')!;
    publish('A different question.', {is_question_prompt: true, tutor_checkpoint_id: 'checkpoint-3'});
    assert.equal(secondSubmit.disabled, true, 'a later question retires the previous Submit action');

    // A written question is answered from the one message bar at the bottom.
    const send = w.document.getElementById('send') as HTMLButtonElement;
    assert.equal(field.placeholder, 'Your answer and reasoning…');
    assert.match(send.title, /^Answer Instructor/);
    assert.equal(html().lastElementChild!.querySelector<HTMLElement>('[data-question-hint]')!.hidden, false);
    assert.equal(html().querySelector('[aria-label="My answer"]'), null, 'no second answer box in the card');
    field.value = 'Banana is at index 1'; field.dispatchEvent(new w.Event('input')); send.click();
    await new Promise(r => setTimeout(r, 0));
    const answered = JSON.parse(chats.at(-1).text.split('\n').slice(1).join('\n'));
    assert.match(chats.at(-1).text, /^TUTOR_NOTEBOOK_ANSWER\n/);
    assert.equal(answered.checkpoint_id, 'checkpoint-3'); assert.equal(answered.answer, 'Banana is at index 1');
    assert.equal(field.value, '');
    assert.match(send.title, /^Ask Instructor/, 'after answering, the cell asks again');
    publish('Another question.', {is_question_prompt: true, tutor_checkpoint_id: 'checkpoint-4'});
    (w.document.querySelector('.ask-instead') as HTMLButtonElement).click();
    field.value = 'What is an index?'; field.dispatchEvent(new w.Event('input')); send.click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(chats.at(-1).text, 'What is an index?', 'Ask instead sends a plain question');

    const svg = '<svg viewBox="0 0 100 50" onload="bad()"><script>bad()</script>' +
      '<rect width="90" height="40" fill="url(https://untrusted.example)"/>' +
      '<foreignObject><iframe src="https://untrusted.example"/></foreignObject>' +
      '<text x="10" y="20">Banana</text><text x="10" y="38">-2</text></svg>';
    for (const content of [svg, '```svg\n' + svg + '\n```']) {
      publish(content);
      const img = html().lastElementChild!.querySelector('img')!;
      assert.match(img.alt, /Banana, -2/);
      const source = decodeURIComponent(img.src.split(',').slice(1).join(','));
      assert.match(source, /<rect/);
      assert.doesNotMatch(source, /script|onload|foreignObject|iframe|untrusted/);
      assert.doesNotMatch(html().lastElementChild!.textContent!, /<svg|<text/);
    }
    publish('```html\n<details>literal code</details>\n```');
    assert.equal(html().lastElementChild!.querySelector('code')!.textContent, '<details>literal code</details>\n');
    publish('<svg><broken></svg>\n\nThe explanation continues.');
    assert.match(html().lastElementChild!.textContent!, /Diagram unavailable.*The explanation continues/s);
    w.document.getElementById('wide')!.click();
    assert.equal(w.document.body.classList.contains('focus-view'), true);
    assert.equal(w.document.getElementById('wide')!.textContent, 'Exit focus view');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Escape'}));
    assert.equal(w.document.body.classList.contains('focus-view'), false);
    w.document.getElementById('doubt_solver')!.click();
    assert.equal(html().textContent,'','switching modes clears the previous conversation immediately');
    assert.match(field.placeholder,/Ask Doubt Solver or reply/);
    assert.equal(run.disabled, true, 'old Instructor editors cannot run in a different session');
    post({...checked, feedback: {guidance: 'Old session reply', prompt: '', line: null}});
    assert.doesNotMatch(editor.textContent!, /Old session reply/);
    assert.equal(teachBack.disabled, true, 'wait for the next agent to connect');
    const before = html().children.length;
    receive(data,agent); assert.equal(html().children.length,before);
    assert.equal(sent.at(-1).mode,'doubt_solver');
  } finally { w.close(); }
});
