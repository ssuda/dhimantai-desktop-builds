import * as assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Api } from '../../src/api';
import type { Auth } from '../../src/auth';
import type { PracticeBrowser } from '../../src/practiceBrowser';
import { EMAIL, PASSWORD, QUESTION_ID } from './contractServer';
import { notebookHelpActions } from '../../src/practiceConversation';

export async function run() {
  const results: {step: string; ok: boolean; error?: string}[] = [];
  const check = async (step: string, body: () => Promise<void>) => {
    console.log('Learning notebook:', step);
    try { await body(); results.push({step, ok: true}); }
    catch (error) { console.error('Failed:', step, error); results.push({step, ok: false, error: String(error instanceof Error ? error.stack : error)}); }
  };
  const extension = vscode.extensions.getExtension<{auth: Auth; practice: PracticeBrowser}>('optficial.dhimantai-learning')!;
  const {auth, practice} = await extension.activate();
  // These checks cover the Practice panel; suitePracticeNotebook covers the notebook flow.
  await vscode.workspace.getConfiguration('dhimantai').update('practiceEditor', 'panel', vscode.ConfigurationTarget.Global);
  await auth.signInWithPassword(EMAIL, PASSWORD);
  const create = vscode.window.createWebviewPanel, grant = Api.prototype.learningRoom, catalog = Api.prototype.practiceCatalog;
  const audioGrant = Api.prototype.audioGrant, startAudio = Api.prototype.startAudio, speech: string[] = [];
  Api.prototype.audioGrant = async (_path, text) => { speech.push(text); return {url:'wss://lk-prod.dhimant.ai',token:'speech-ticket'}; };
  Api.prototype.startAudio = async (_path, text, ticket) => { assert.equal(ticket,'speech-ticket'); speech.push(text); return {accepted:true}; };
  const secondLesson = '10000000-0000-0000-0000-000000000002', lockedLesson = '10000000-0000-0000-0000-000000000003';
  Api.prototype.practiceCatalog = async function() {
    const data = await catalog.call(this);
    data.courses[0].chapters.push({id:secondLesson,name:'Functions'}, {id:lockedLesson,name:'Classes',locked:true});
    return data;
  };
  const responses: any[] = [];
  const modes: string[] = [];
  const notebooks = new Map<vscode.WebviewPanel, {receive?: (message: any) => Promise<void>; responses: any[]}>();
  let host: vscode.WebviewPanel | undefined, receive: (message: any) => Promise<void>;
  Api.prototype.learningRoom = async mode => { modes.push(mode); return {url: 'wss://lk-prod.dhimant.ai', token: 'fixture'}; };
  (vscode.window as any).createWebviewPanel = (...args: any[]) => {
    const panel = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] === 'dhimantai.learningRoom') {
      host = panel;
      const entry = {receive:undefined as typeof receive | undefined, responses:[] as any[]};
      notebooks.set(panel, entry);
      panel.onDidDispose(() => notebooks.delete(panel));
      const reveal = panel.reveal.bind(panel);
      panel.reveal = (...args) => { host = panel; receive = entry.receive!; reveal(...args); };
      let selectedLocal = false;
      const handlers: ((message:any) => Promise<void>)[] = [];
      (panel.webview as any).onDidReceiveMessage = (handler: any) => { handlers.push(handler); receive = entry.receive = async message => {
        // Explicit local runtime for this contract fixture; the product defaults to the course container.
        if (message.type === 'join' && !selectedLocal) { selectedLocal = true; for (const h of handlers) await h({type:'runtime', runtime:'local'}); }
        for (const h of handlers) await h(message);
      }; return new vscode.Disposable(() => {}); };
      (panel.webview as any).postMessage = async (message: any) => { responses.push(message); entry.responses.push(message); return true; };
    }
    return panel;
  };
  const state = async () => (await fetch(`${process.env.DHIMANTAI_TEST_SERVER}/__state`)).json() as Promise<any>;
  const tabLabels = async (expected: string[]) => {
    const labels = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('dhimantai.learningRoom'))
      .map(tab => tab.label).sort();
    const sorted = [...expected].sort(), deadline = Date.now() + 5000;
    while (JSON.stringify(labels()) !== JSON.stringify(sorted) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(labels(), sorted);
  };
  const request = {type: 'codeAction', action: 'run', attempt: 1, request: 1, snippet: 'code-1', revision: 0,
    language: 'python', source: 'value = 40', stdin: '', question: 'Explore notebook variables.', message: ''};
  try {
    await check('Instructor owns one notebook and consecutive cells share the explicit-run Python namespace', async () => {
      await vscode.commands.executeCommand('dhimantai.openLearningRoom');
      assert.match(host!.webview.html, /Learning notebook/);
      assert.doesNotMatch(host!.webview.html, /Connect Instructor/);
      assert.doesNotMatch(host!.webview.html.split('</header>')[0], /Ask Instructor|Instructor follows my code/);
      assert.match(host!.webview.html, /Let Instructor follow code edits and runs/);
      assert.match(host!.webview.html, /id="follow-code" checked>/, 'Instructor follows the active notebook by default');
      assert.match(host!.webview.html, /<\/main>\s*<footer id="message-bar"/);
      assert.doesNotMatch(host!.webview.html, /id="draft-cell"/);
      assert.match(host!.webview.html, /value="local" selected/, 'this contract fixture disables course containers');
      await receive!({type:'ready'});
      assert.equal(responses.at(-1).type,'openTutor');
      for (const language of ['python','javascript','typescript','c','java','go','rust']) assert.ok(host!.webview.html.includes('value="' + language + '"'));
      await receive!({type:'tutorLessons',attempt:1});
      await receive!({type:'join',mode:'tutor',attempt:1,chapterId:QUESTION_ID});
      assert.equal(responses.at(-1).type,'grant');
      await receive!(request);
      await receive!({...request,snippet:'code-2',request:2,source:'print(value + 2)'});
      const messages = responses.filter(message => message.type === 'codeResult');
      assert.equal(messages.at(-1).execution.stdout,'42\n');
      assert.equal((await state()).coach.length,0,'the code runner never invokes a separate Instructor');
    });
    await check('hiding the notebook preserves its active run session', async () => {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:'Another file'}), {viewColumn:vscode.ViewColumn.One});
      await receive!({...request,snippet:'code-3',request:3,source:'print(value)'});
      assert.equal(responses.filter(message => message.type === 'codeResult').at(-1).execution.stdout,'40\n');
      host!.reveal();
    });
    await check('local drafts survive closing and reopening; old saves cannot overwrite newer edits', async () => {
      const documentKey = responses.find(message => message.type === 'restoreNotebook').documentKey;
      const notebook = {version:1,title:'My notebook',cells:[{id:'note-1',kind:'note',text:'Newest explanation'}],drafts:[]};
      await receive!({type:'notebookChanged',documentKey,sequence:2,notebook});
      await receive!({type:'notebookChanged',documentKey,sequence:1,notebook:{...notebook,title:'Old title'}});
      host!.dispose(); responses.length = 0;
      await vscode.commands.executeCommand('dhimantai.openLearningRoom');
      await receive!({type:'ready'});
      await receive!({type:'tutorLessons',attempt:1});
      await receive!({type:'join',mode:'tutor',attempt:1,chapterId:QUESTION_ID});
      const restored = responses.find(message => message.type === 'restoreNotebook').notebook;
      assert.equal(restored.title,'My notebook'); assert.equal(restored.cells[0].text,'Newest explanation');
    });
    await check('Instructor and Doubt Solver retain independent drafts, runtimes and sessions across tab switches and closure', async () => {
      const tutor = host!, tutorView = notebooks.get(tutor)!;
      const tutorDocument = responses.filter(message => message.type === 'restoreNotebook').at(-1);
      await receive!({...request,source:'value = 40'});
      const saving = receive!({type:'notebookChanged',documentKey:tutorDocument.documentKey,sequence:1,
        notebook:{...tutorDocument.notebook,textDraft:'Unsent lesson question'}});
      const backgroundRun = receive!({...request,request:10,source:'import time\ntime.sleep(0.2)\nprint(value + 2)'});
      await vscode.commands.executeCommand('dhimantai.openDoubtSolver');
      const doubt = host!, doubtView = notebooks.get(doubt)!;
      assert.notEqual(doubt, tutor);
      assert.equal(notebooks.size, 2);
      assert.equal(tutor.options.retainContextWhenHidden, true);
      assert.equal(doubt.options.retainContextWhenHidden, true);
      await receive!({type:'ready'});
      await receive!({type:'join',mode:'doubt_solver',attempt:2});
      await Promise.all([saving, backgroundRun]);
      assert.equal(tutorView.responses.find(message => message.type === 'codeResult' && message.request === 10 && message.execution).execution.stdout, '42\n',
        'an in-flight run finishes in its owning tab after another notebook opens');
      assert.equal(doubtView.responses.some(message => message.type === 'codeResult' && message.request === 10), false);
      assert.equal(modes.at(-1), 'doubt_solver');
      assert.equal(host!.title, 'Doubt Solver notebook');
      const doubtDocument = responses.filter(message => message.type === 'restoreNotebook').at(-1);
      assert.deepEqual(doubtDocument.notebook.cells, []);
      const doubtNotebook = {...doubtDocument.notebook, textDraft:'My private doubt', cells:[{id:'doubt-1',kind:'message',text:'Why is index 3 out of range?'}]};
      await receive!({type:'notebookChanged',documentKey:doubtDocument.documentKey,sequence:1,notebook:doubtNotebook});
      await receive!({type:'notebookChanged',documentKey:tutorDocument.documentKey,sequence:999,notebook:tutorDocument.notebook});
      await receive!({...request,attempt:2,source:'value = 900'});
      const grants = modes.length;
      const opened = () => [...notebooks.values()].flatMap(entry => entry.responses).filter(message => message.type === 'openTutor' || message.type === 'restoreNotebook').length;
      const beforeSwitch = opened();
      for (let i = 0; i < 3; i++) {
        await vscode.commands.executeCommand('dhimantai.openLearningRoom');
        assert.equal(host, tutor);
        await vscode.commands.executeCommand('dhimantai.openDoubtSolver');
        assert.equal(host, doubt);
      }
      assert.equal(notebooks.size, 2, 'commands activate existing panels instead of creating duplicates');
      await tabLabels(['Instructor notebook', 'Doubt Solver notebook']);
      assert.equal(modes.length, grants, 'switching tabs never requests another session');
      assert.equal(opened(), beforeSwitch, 'switching never reloads a notebook or its unsent draft');
      await receive!({type:'tutorLessons',attempt:3});
      await receive!({type:'join',mode:'tutor',attempt:3,chapterId:QUESTION_ID});
      assert.equal(modes.length, grants, 'a Doubt Solver panel cannot switch into Instructor');
      await receive!({...request,attempt:2,request:11,source:'print(value)'});
      assert.equal(doubtView.responses.filter(message => message.type === 'codeResult').at(-1).execution.stdout, '900\n');
      await vscode.commands.executeCommand('dhimantai.openLearningRoom');
      await receive!({...request,request:12,source:'print(value)'});
      assert.equal(tutorView.responses.filter(message => message.type === 'codeResult').at(-1).execution.stdout, '40\n');
      doubt.dispose();
      assert.equal(notebooks.size, 1, 'closing Doubt Solver leaves Instructor open');
      await tabLabels(['Instructor notebook']);
      await receive!({...request,request:13,source:'print(value + 3)'});
      assert.equal(tutorView.responses.filter(message => message.type === 'codeResult').at(-1).execution.stdout, '43\n');
      await vscode.commands.executeCommand('dhimantai.openDoubtSolver');
      assert.notEqual(host, doubt, 'a closed tab can be opened again');
      await receive!({type:'join',mode:'doubt_solver',attempt:1});
      assert.deepEqual(responses.filter(message => message.type === 'restoreNotebook').at(-1).notebook, doubtNotebook);
      await receive!({...request,source:'value = 901'});
      const reopenedDoubt = host!;
      await vscode.commands.executeCommand('dhimantai.openLearningRoom');
      await receive!({type:'tutorLessons',attempt:3});
      assert.equal(responses.at(-1).type, 'tutorLessons');
      const granted = modes.length;
      await receive!({type:'join',mode:'tutor',attempt:3});
      assert.equal(modes.length, granted, 'free-topic Instructor launch cannot obtain a grant');
      assert.match(responses.at(-1).message, /Choose an available lesson/);
      await receive!({type:'join',mode:'tutor',attempt:3,chapterId:lockedLesson});
      assert.equal(modes.length, granted, 'locked lessons cannot obtain an Instructor grant');
      await receive!({type:'join',mode:'tutor',attempt:4,chapterId:QUESTION_ID});
      const restored = responses.filter(message => message.type === 'restoreNotebook').at(-1);
      assert.equal(restored.notebook.cells[0].text, 'Newest explanation');
      assert.equal(restored.notebook.textDraft, 'Unsent lesson question', 'a pending save completes before switching documents');
      assert.notEqual(restored.documentKey, tutorDocument.documentKey);
      assert.equal(responses.at(-1).chapterId, QUESTION_ID);
      await receive!({type:'join',mode:'tutor',attempt:5,chapterId:secondLesson});
      assert.deepEqual(responses.filter(message => message.type === 'restoreNotebook').at(-1).notebook.cells, [],
        'another lesson starts with its own conversation');
      await receive!({type:'join',mode:'tutor',attempt:6,chapterId:QUESTION_ID});
      assert.equal(responses.filter(message => message.type === 'restoreNotebook').at(-1).notebook.textDraft, 'Unsent lesson question');
      host!.dispose(); responses.length = 0;
      assert.equal(notebooks.size, 1, 'closing Instructor leaves Doubt Solver open');
      await tabLabels(['Doubt Solver notebook']);
      await vscode.commands.executeCommand('dhimantai.openDoubtSolver');
      assert.equal(host, reopenedDoubt);
      await receive!({...request,request:14,source:'print(value)'});
      assert.equal(responses.filter(message => message.type === 'codeResult').at(-1).execution.stdout, '901\n');
    });
    await check('Practice leaves learning tabs open and gives source review without retired submission calls', async () => {
      const doubt = host!;
      responses.length = 0;
      await vscode.commands.executeCommand('dhimantai.openExercise', QUESTION_ID);
      assert.ok(notebooks.has(doubt), 'Practice cannot dispose the Doubt Solver tab');
      assert.equal(notebooks.size, 2);
      const title = 'Complete the Word count exercise in Python. Implement `print_words` and `print_top`.';
      assert.equal(host!.title, 'Practice notebook · ' + title);
      assert.ok(host!.webview.html.includes('<h1>' + title + '</h1>'));
      assert.match(host!.webview.html, /Practice notebook/);
      assert.match(host!.webview.html, /id="coach-audio"/, 'Practice can opt into spoken replies beside the input');
      assert.match(host!.webview.html, /id="audio-microphone" disabled/, 'voice input is unavailable');
      assert.match(host!.webview.html, /aria-label="Add attachments"/);
      assert.match(host!.webview.html, /id="attach-images"/);
      assert.match(host!.webview.html, /id="attach-pdfs"/);
      await receive!({type:'ready'});
      assert.equal(responses.at(-1).type,'openPractice');
      const coachBefore = (await state()).coach.length;
      await receive!({type:'join',mode:'tutor',attempt:1});
      assert.equal(responses.at(-1).type,'practiceReady');
      assert.deepEqual({...responses.at(-1).practice.tools}, {tests:2, trace:true});
      const tool = async (name: string, source: string) => {
        await receive!({type:'practiceTool',attempt:1,request:50 + responses.length,tool:name,
          snapshot:{snippet:'code-1',revision:0,language:'python',source,stdin:'',question:'My attempt'}});
        return responses.filter(message => message.type === 'practiceToolResult').at(-1);
      };
      const traced = await tool('trace', 'x = 2\nprint(x * 21)');
      assert.equal(traced.error, undefined); assert.equal(traced.trace.stdout, '42\n');
      assert.ok(traced.trace.steps.some((step: any) => step.locals.x === '2'), 'the trace records values');
      const tested = await tool('tests', 'print("not the answer")');
      assert.equal(tested.error, undefined); assert.equal(tested.tests.length, 2);
      assert.ok(tested.tests.every((row: any) => row.verdict !== 'passed' && row.stdin.startsWith('Arguments: ')));
      const fresh = await tool('variation', 'print(input())');
      assert.equal(fresh.error, undefined); assert.match(fresh.variation.prompt, /predict exactly/i);
      assert.equal((await state()).coach.length, coachBefore, 'tools run code and never ask a model');
      const failedSnapshot = {snippet:'code-1',revision:0,language:'python',source:'print("not the answer")',stdin:'',question:'My attempt'};
      await receive!({type:'notebookTurn',attempt:1,request:61,snapshot:failedSnapshot,message:'Explain failed tests.',prediction:'',strategy:'by_hand',history:[]});
      let turn = (await state()).coach.at(-1);
      assert.equal(turn.public_test.state,'current'); assert.equal(turn.public_test.actual,tested.tests[0].actual);
      assert.equal(turn.public_test.expected,tested.tests[0].expected); assert.equal(turn.stage,'review');
      await receive!({type:'notebookTurn',attempt:1,request:62,snapshot:{...failedSnapshot,source:'print(42)'},message:'Explain failed tests.',prediction:'',strategy:'by_hand',history:[]});
      turn = (await state()).coach.at(-1); assert.equal(turn.public_test.state,'changed');
      assert.equal(turn.public_test.actual,undefined,'edited code never reuses the old failing output');
      const snapshot = {snippet:'code-1',revision:0,language:'python',source:'print(42)',stdin:'',question:'My attempt'};
      await receive!({type:'notebookTurn',attempt:1,request:1,snapshot,message:'Review my attempt.',prediction:'',submitted:true,history:[]});
      const reply = responses.find(message => message.type === 'notebookReply' && message.request === 1);
      assert.equal(reply.error,undefined); assert.equal(reply.submitted,true); assert.ok(reply.content);
      assert.equal(typeof reply.audioId, 'string');
      assert.equal(speech.length, 0, 'a written reply never enables audio without a learner gesture');
      const count = responses.length;
      await receive!({type:'audioJoin',id:'stale-reply',attempt:1});
      await receive!({type:'practiceListen',cellId:'stale-reply'});
      assert.equal(responses.length, count, 'removed playback messages cannot obtain audio grants');
      await receive!({type:'audioJoin',id:reply.audioId,attempt:1});
      assert.equal(responses.at(-1).type,'audioGrant');
      await receive!({type:'audioStart',id:reply.audioId,attempt:1});
      assert.deepEqual(speech,[reply.content,reply.content], 'the speaker narrates the displayed reply');
      assert.equal((await state()).submissions.length,0,'source feedback is never a server assessment');
    });
    await check('Practice rejects feedback when the solution changes during the request', async () => {
      const original = Api.prototype.notebookCoach;
      let release!: (value: any) => void, called!: () => void;
      const started = new Promise<void>(resolve => { called = resolve; });
      Api.prototype.notebookCoach = async () => { called(); return new Promise(resolve => { release = resolve; }); };
      try {
        const snapshot = {snippet:'code-1',revision:1,language:'python',source:'print(41)',stdin:'',question:'My attempt'};
        const pending = receive!({type:'notebookTurn',attempt:1,request:2,snapshot,message:'Explain this.',prediction:'',history:[]});
        await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Practice request never started')), 10000))]);
        await receive!({type:'codeChanged',attempt:1,...snapshot,revision:2,source:'print(42)'});
        release({guidance:'An answer for the old source.',prompt:''}); await pending;
        const reply = responses.filter(message => message.type === 'notebookReply').at(-1);
        assert.match(reply.error,/code changed/); assert.equal(reply.content,undefined);
      } finally { Api.prototype.notebookCoach = original; }
    });
    await check('Practice tree labels reach headings and tabs; reopening refreshes saved titles without losing work', async () => {
      const [course] = await practice.getChildren();
      const [chapter] = await practice.getChildren(course);
      const [textbook] = await practice.getChildren(chapter);
      const [topic] = await practice.getChildren(textbook);
      const [question] = await practice.getChildren(topic);
      assert.equal(question.kind, 'question');
      if (question.kind !== 'question') throw new Error('Missing Practice question');
      const document = responses.find(message => message.type === 'restoreNotebook');
      const note = {id:'private-note', kind:'note', text:'Keep my reasoning about tuples.'};
      const saved = {...document.notebook, title:'Programming exercise', cells:[...document.notebook.cells, note], textDraft:'My unsent answer'};
      await receive!({type:'notebookChanged',documentKey:document.documentKey,sequence:1,notebook:saved});
      responses.length = 0;
      const selected = {...question, question:{...question.question, title:'Tuples and Hashability'}};
      await practice.openQuestion(selected);
      assert.equal(host!.title, 'Practice notebook · Tuples and Hashability');
      assert.ok(host!.webview.html.includes('<h1>Tuples and Hashability</h1>'));
      await receive!({type:'join',mode:'tutor',attempt:1});
      const restored = responses.find(message => message.type === 'restoreNotebook').notebook;
      assert.equal(restored.title, 'Tuples and Hashability');
      assert.deepEqual(restored.cells.at(-1), note);
      assert.equal(restored.textDraft, 'My unsent answer');
      const original = Api.prototype.workspace;
      Api.prototype.workspace = async function(id: string) {
        const result = await original.call(this, QUESTION_ID);
        return {...result, project:{...result.project, question_id:id}};
      };
      try {
        await practice.openQuestion({...question, question:{...question.question,
          id:'10000000-0000-0000-0000-000000000002', title:'Dictionaries & Tuples <comparison>'}});
        assert.equal(host!.title, 'Practice notebook · Dictionaries & Tuples <comparison>');
        assert.ok(host!.webview.html.includes('<h1>Dictionaries &amp; Tuples &lt;comparison&gt;</h1>'));
      } finally { Api.prototype.workspace = original; }
    });
    await check('notebook file dialogs round-trip saved work and give specific errors without replacing the document', async () => {
      const directory = mkdtempSync(join(tmpdir(),'dhimantai-notebook-import-'));
      const file = vscode.Uri.file(join(directory,'saved.ipynb'));
      const saveDialog = vscode.window.showSaveDialog, openDialog = vscode.window.showOpenDialog;
      (vscode.window as any).showSaveDialog = async () => file;
      (vscode.window as any).showOpenDialog = async () => [file];
      try {
        await vscode.commands.executeCommand('dhimantai.openLearningRoom');
        await receive!({type:'tutorLessons',attempt:1});
        await receive!({type:'join',mode:'tutor',attempt:1,chapterId:QUESTION_ID});
        const current = () => responses.filter(message => message.type === 'restoreNotebook').at(-1);
        const notebook = {version:1,title:'Round-trip',textDraft:'Unsent question',cells:[{id:'code-cell',kind:'code',text:'',packet:{language:'python'}}],
          drafts:[{key:'code-cell:0',snippet:'code-1',language:'python',source:'print(605)',stdin:'',prediction:'605',explanation:'',helped:true}]};
        await receive!({type:'exportNotebook',documentKey:current().documentKey,notebook});
        assert.equal(JSON.parse(readFileSync(file.fsPath,'utf8')).nbformat,4);
        await receive!({type:'importNotebook',documentKey:current().documentKey});
        assert.deepEqual(current().notebook,notebook);
        const key = current().documentKey;
        writeFileSync(file.fsPath,'{broken');
        await receive!({type:'importNotebook',documentKey:key});
        assert.match(responses.at(-1).message,/corrupted.*JSON/); assert.equal(current().documentKey,key);
        writeFileSync(file.fsPath,JSON.stringify({nbformat:4,metadata:{language_info:{name:'python'}},cells:[{cell_type:'code',source:['print(42)\n'],outputs:[{text:'old output'}]}]}));
        await receive!({type:'importNotebook',documentKey:key});
        assert.equal(current().notebook.drafts[0].source,'print(42)\n');
        assert.equal(current().notebook.drafts[0].helped,true);
        assert.doesNotMatch(JSON.stringify(current().notebook),/old output/);
      } finally {
        (vscode.window as any).showSaveDialog = saveDialog; (vscode.window as any).showOpenDialog = openDialog;
        rmSync(directory,{recursive:true,force:true});
      }
    });
    await check('all modes send the five help actions through one coach with current test evidence', async () => {
      for (const mode of ['tutor','doubt_solver','practice'] as const) {
        if (mode === 'practice') await vscode.commands.executeCommand('dhimantai.openExercise', QUESTION_ID);
        else await vscode.commands.executeCommand(mode === 'tutor' ? 'dhimantai.openLearningRoom' : 'dhimantai.openDoubtSolver');
        await receive!({type:'ready'});
        if (mode === 'tutor') await receive!({type:'tutorLessons',attempt:80});
        await receive!({type:'join',mode:mode === 'practice' ? 'tutor' : mode,attempt:80,...(mode === 'tutor' ? {chapterId:QUESTION_ID} : {})});
        assert.equal(responses.at(-1).type,mode === 'practice' ? 'practiceReady' : 'grant');
        assert.match(host!.webview.html,/id="notebook-help-actions"/);
        const snapshot = {snippet:'code-90',revision:0,language:'python',source:'print("letters")',stdin:'',question:'Find a word with unique letters.'};
        await receive!({type:'practiceTool',attempt:80,request:800,tool:'my_tests',snapshot,
          cases:[{kind:'regression',reason:'Reject repeated letters',stdin:'',expected:'lamp\n'}]});
        const tested = responses.filter(message => message.type === 'practiceToolResult').at(-1);
        assert.equal(tested.error,undefined); assert.equal(tested.tests[0].verdict,'wrong_answer');
        for (const [i,action] of notebookHelpActions.entries()) {
          await receive!({type:'notebookTurn',attempt:80,request:810+i,snapshot,message:action.message,prediction:'',strategy:action.strategy,history:[],focusLine:1,
            notebookContext:{cells:[{id:'code-90',kind:'code',text:snapshot.source,truncated:false}],truncated:false}});
          const reply = responses.filter(message => message.type === 'notebookReply' && message.request === 810+i).at(-1);
          assert.equal(reply.error,undefined); assert.ok(reply.content);
          const turn = (await state()).coach.at(-1);
          assert.equal(turn.stage,action.stage); assert.equal(turn.strategy,action.strategy);
          assert.equal(turn.source,snapshot.source); assert.equal(turn.focus_line,1);
          assert.equal(turn.notebook_context.cells[0].text,snapshot.source);
          if (action.strategy === 'by_hand') {
            assert.equal(turn.public_test.state,'current'); assert.equal(turn.public_test.actual,'letters\n');
          }
        }
        await receive!({type:'notebookTurn',attempt:80,request:820,snapshot:{...snapshot,revision:1,source:'print("lamp")'},
          message:'Explain failed tests.',prediction:'',strategy:'by_hand',history:[]});
        assert.equal((await state()).coach.at(-1).public_test.state,'changed');
      }
      assert.equal((await state()).submissions.length,0,'help never submits an answer or awards progress');
    });
    await check('changing the service closes every notebook and rejects messages from old sessions', async () => {
      assert.equal(notebooks.size, 3, 'Instructor, Doubt Solver and Practice can stay open together');
      const stale = [...notebooks.values()].map(entry => entry.receive!);
      const cfg = vscode.workspace.getConfiguration('dhimantai');
      const previous = cfg.inspect<string>('environment')?.globalValue;
      try {
        await cfg.update('environment', 'staging', vscode.ConfigurationTarget.Global);
        await tabLabels([]);
        assert.equal(notebooks.size, 0);
        const grants = modes.length;
        for (const receive of stale) await receive({type:'join',mode:'doubt_solver',attempt:99});
        assert.equal(modes.length, grants, 'closed sessions cannot obtain grants for the old service');
        await vscode.commands.executeCommand('dhimantai.openDoubtSolver');
        assert.equal(notebooks.size, 1, 'the new service opens a fresh panel');
        await receive!({type:'ready'});
        assert.deepEqual(responses.at(-1), {type:'openTutor',mode:'doubt_solver'});
      } finally { await cfg.update('environment', previous, vscode.ConfigurationTarget.Global); }
    });
  } finally {
    (vscode.window as any).createWebviewPanel = create;
    Api.prototype.learningRoom = grant; Api.prototype.practiceCatalog = catalog;
    Api.prototype.audioGrant = audioGrant; Api.prototype.startAudio = startAudio;
    for (const panel of [...notebooks.keys()]) panel.dispose();
  }
  writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length, results}, null, 2));
  if (results.some(r => !r.ok)) throw new Error('Learning room integration checks failed');
}
