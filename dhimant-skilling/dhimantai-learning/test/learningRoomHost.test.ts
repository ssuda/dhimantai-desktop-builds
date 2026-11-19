import {authoredConfiguration} from './authoredConfiguration';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {readFileSync} from 'node:fs';
import {verifiedKey} from '../src/browserCourseProgress';

// The learning room host runs against a recording VS Code API boundary.
const Module = require('node:module');
const commands = new Map<string, (...args: any[]) => unknown>(), executed: string[] = [];
const config: Record<string, unknown> = {aiAssistance: true};
const panels: any[] = [];
const disposable = {dispose() {}};
const stub: any = new Proxy(function () { return stub; }, {get: (_target, key) => key === 'then' ? undefined : key === 'dispose' ? () => {} : stub, apply: () => disposable, construct: () => stub});
const stubbed = (target: any): any => new Proxy(target, {get: (object, key) => key in object ? object[key] : stub});
const vscode: any = stubbed({
  Uri: {joinPath: (uri: {fsPath: string}, ...parts: string[]) => ({fsPath: join(uri.fsPath, ...parts)}), file: (fsPath: string) => ({fsPath})},
  ViewColumn: {One: 1},
  Disposable: Object.assign(class { dispose() {} }, {from: () => disposable}),
  TabInputWebview: class {},
  EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
  env: stubbed({appName: 'Visual Studio Code'}),
  workspace: stubbed({getConfiguration: () => ({get: (key: string, fallback: unknown) => key in config ? config[key] : fallback}),
    onDidChangeConfiguration: () => disposable, workspaceFolders: [], isTrusted: true}),
  window: stubbed({tabGroups: {all: []}, showInformationMessage: async () => undefined,
    createWebviewPanel: (_type: string, title: string) => {
      const handlers: ((message: unknown) => Promise<void>)[] = [], disposers: (() => void)[] = [];
      const panel = {title, visible: true, disposed: false, posted: [] as any[],
        webview: {cspSource: 'csp', html: '', asWebviewUri: (uri: {fsPath:string}) => 'file://' + uri.fsPath,
          onDidReceiveMessage: (handler: any) => { handlers.push(handler); return {dispose:()=>{const index=handlers.indexOf(handler);if(index>=0)handlers.splice(index,1);}}; },
          postMessage: async (message: unknown) => { panel.posted.push(message); return true; }},
        revealed: 0, reveal() { panel.revealed++; }, onDidDispose: (fn: () => void) => { disposers.push(fn); return disposable; }, onDidChangeViewState: () => disposable,
        dispose() { panel.disposed = true; for (const fn of [...disposers]) fn(); },
        send: async (message: unknown) => { for (const handler of [...handlers]) await handler(message); }};
      panels.push(panel); return panel;
    }}),
  commands: stubbed({registerCommand: (id: string, fn: any) => { commands.set(id, fn); return disposable; },
    executeCommand: async (id: string) => { executed.push(id); }}),
});
const load = Module._load;
Module._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
const { registerLearningRoom } = require('../src/learningRoom') as typeof import('../src/learningRoom');
const { Api, ApiError } = require('../src/api') as typeof import('../src/api');
Api.prototype.practiceCatalog=async()=>({courses:[{name:'Python',chapters:[{id:'python-intro',name:'Lists'}]}],languages:[],question_pools:[]});
Api.prototype.courseRuntime=async title=>({runtime:null,configuration:authoredConfiguration(title)});
const { TutorNotebookStore } = require('../src/tutorNotebookStore') as typeof import('../src/tutorNotebookStore');
Module._load = load;

const snapshot = {snippet: 'code-1', revision: 0, language: 'python', source: 'print(1)', stdin: '', question: 'Why does this fail?'};
const reply = (panel: any, request: number) => panel.posted.find((m: any) => m.type === 'notebookReply' && m.request === request);

test('Doubt Solver requires an entitled course chapter and runs in that course container', async () => {
  const {NotebookCells}=require('../src/notebookCells') as typeof import('../src/notebookCells');
  const catalog=Api.prototype.practiceCatalog, run=NotebookCells.prototype.run, restart=NotebookCells.prototype.restart, grant=Api.prototype.learningRoom, editor=vscode.window.activeTextEditor;
  let restarts=0;
  const storage=await mkdtemp(join(tmpdir(),'shared-doubt-'));
  const context:any={extensionUri:{fsPath:resolve(__dirname,'../..')},extensionPath:resolve(__dirname,'../..'),
    globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:()=>undefined,update:async()=>{}}};
  const session={user:{id:'learner'},access_token:'token'}, calls:any[]=[];
  const shared={fsPath:join(storage,'programming')};
  const auth:any={session:async()=>session,signIn:async()=>session,accessToken:async()=> 'token'};
  const courses:any={enabled:true,
    recordFor:(uri:any)=>uri===shared ? {account:'learner',course:'Shared programming container',runtime:'programming'}
      : uri.fsPath===join(storage,'java','Main.java') ? {account:'learner',course:'Java Programming'}
      : uri.fsPath===join(storage,'python','main.py') ? {account:'learner',course:'Python'} : undefined,
    programmingFolder:async(owner:string,env:string)=>{calls.push(['folder',owner,env]);return shared;},
    courseFolder:async(scope:any)=>{calls.push(['folder',scope.account,scope.environment]);return {fsPath:scope.course==='Java Programming'?join(storage,'java','Main.java'):join(storage,'python','main.py')};},
    forFile:async(uri:any,language:string,target:any)=>{calls.push(['run',uri,language,target]);return {target:uri.fsPath===join(storage,'java','Main.java')?'Java Programming':'Python'};},
    languageFor:()=>undefined,machineState:()=>undefined};
  try {
    vscode.window.activeTextEditor={document:{uri:{fsPath:join(storage,'java','Main.java')}}};
    Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'grant'});
    NotebookCells.prototype.run=async function(language,source) {
      const engine=await (this as any).engine(language);
      return {status:'exited',exit_code:0,stdout:source,stderr:'',command:language,duration_seconds:0,truncated:false,runtime_target:engine.target};
    };
    NotebookCells.prototype.restart=function(){restarts++;restart.call(this);};
    Api.prototype.practiceCatalog=async()=>({courses:[{name:'Java Programming',chapters:[{id:'java',name:'Classes'},{id:'java-lab',name:'Advanced lab'}]},
      {name:'Python',chapters:[{id:'python',name:'Lists'}]}],languages:[],question_pools:[]});
    const start=executed.length;
    registerLearningRoom(context,()=> 'production',()=>({apiUrl:'https://api.example'}) as any,auth,courses);
    await commands.get('dhimantai.openDoubtSolver')!();const panel=panels.at(-1);
    assert.ok(executed.slice(start).includes('workbench.action.closeSidebar'));
    assert.ok(executed.slice(start).includes('workbench.action.closeAuxiliaryBar'));
    assert.ok(!executed.slice(start).includes('dhimantai.practice.focus'));
    await panel.send({type:'ready'});
    assert.equal(calls.length,0,'opening the notebook does not download or start a course image');
    await panel.send({type:'join',mode:'doubt_solver',attempt:0});
    assert.match(panel.posted.find((m:any)=>m.type==='failed')?.message,/Choose an available chapter/);
    assert.equal(panel.posted.some((m:any)=>m.type==='grant'),false);
    await panel.send({type:'join',mode:'doubt_solver',attempt:1,chapterId:'java'});
    assert.equal(panel.posted.find((m:any)=>m.type==='grant')?.codeRuntime,'Java Programming · Podman');
    assert.equal(panel.posted.find((m:any)=>m.type==='grant')?.doubtContext.chapter_id,'java');
    for(const [request,language,source] of [[1,'java','class Main { public static void main(String[] a) {} }'],[2,'c','int main() { return 0; }']] as const) {
      await panel.send({...snapshot,type:'codeAction',attempt:1,request,snippet:'code-'+request,language,source,action:'run',message:''});
      assert.equal(panel.posted.find((m:any)=>m.type==='codeResult' && m.request===request)?.execution?.exit_code,0);
    }
    assert.deepEqual(calls,[['folder','learner','production'],['run',{fsPath:join(storage,'java','Main.java')},'java',{lesson:'java'}],['run',{fsPath:join(storage,'java','Main.java')},'c',{lesson:'java'}]]);
    assert.equal(executed.slice(start).includes('dhimantai.setupCourse'),false,'no course chooser is opened');
    const before=restarts;
    await panel.send({type:'join',mode:'doubt_solver',attempt:2,chapterId:'java-lab'});
    assert.ok(restarts>before,'a new lab chapter cannot retain the previous runtime session');
    const browsing=restarts;
    await panel.send({type:'tutorLessons',attempt:2,browse:true});
    assert.equal(restarts,browsing,'browsing courses preserves the current runtime');
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='tutorLessons').at(-1).courses.map((c:any)=>c.name),['Java Programming','Python']);
    await panel.send({...snapshot,type:'codeAction',attempt:2,request:3,action:'run',message:''});
    assert.equal(panel.posted.find((m:any)=>m.type==='codeResult' && m.request===3)?.execution?.runtime_target,'Java Programming','browsing does not invalidate the active session');
    await panel.send({type:'join',mode:'doubt_solver',attempt:3,chapterId:'python'});
    assert.equal(panel.posted.find((m:any)=>m.type==='grant' && m.attempt===3)?.doubtContext.chapter_id,'python');
    await panel.send({...snapshot,type:'codeAction',attempt:3,request:4,action:'run',message:''});
    assert.equal(panel.posted.find((m:any)=>m.type==='codeResult' && m.request===4)?.execution?.runtime_target,'Python');
    assert.deepEqual(calls.at(-1),['run',{fsPath:join(storage,'python','main.py')},'python',{lesson:'python'}]);
    Api.prototype.practiceCatalog=async()=>({courses:[{name:'Java Programming',chapters:[{id:'java',name:'Classes',expired:true}]}],languages:[],question_pools:[]});
    await panel.send({type:'join',mode:'doubt_solver',attempt:4,chapterId:'java'});
    assert.match(panel.posted.find((m:any)=>m.type==='failed' && m.attempt===4)?.message,/access.*ended/);
    assert.equal(panel.posted.filter((m:any)=>m.type==='grant').length,3,'expired access never falls back to a general session');
    vscode.window.activeTextEditor={document:{uri:shared}};
    await commands.get('dhimantai.openLearningRoom')!();
    assert.equal(panels.at(-1).title,'Instructor notebook','the shared runtime is never treated as an enrolled course');
  } finally {
    Api.prototype.practiceCatalog=catalog;NotebookCells.prototype.run=run;NotebookCells.prototype.restart=restart;Api.prototype.learningRoom=grant;vscode.window.activeTextEditor=editor;
    for(const panel of panels)if(!panel.disposed)panel.dispose();
    await rm(storage,{recursive:true,force:true});
  }
});

test('lesson requests cancel on replacement and disposal, and a deadline returns a retryable loading error', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'lesson-loading-'));
  const catalog = Api.prototype.practiceCatalog, timeout = AbortSignal.timeout;
  const requests: {signal:AbortSignal; finish:(result:any)=>void}[] = [];
  const deadlines: AbortController[] = [];
  const session = {user:{id:'learner'},access_token:'token'};
  const auth:any = {session:async()=>session,signIn:async()=>session};
  const context:any = {extensionUri:{fsPath:resolve(__dirname,'../..')},extensionPath:resolve(__dirname,'../..'),
    globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:()=>undefined,update:async()=>{}}};
  try {
    AbortSignal.timeout = ms => {
      assert.equal(ms, 20_000);
      const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal;
    };
    Api.prototype.practiceCatalog = signal => new Promise((finish,reject) => {
      assert.ok(signal);
      signal.addEventListener('abort', () => reject(new Error('Aborted')), {once:true});
      requests.push({signal,finish});
    });
    registerLearningRoom(context,()=> 'production',()=>({apiUrl:'https://api.example'}) as any,auth);
    await commands.get('dhimantai.openLearningRoom')!('Python Programming', 'first');
    const panel = panels.at(-1);
    const first = panel.send({type:'tutorLessons',attempt:1});
    await new Promise(resolve=>setImmediate(resolve));
    const next = panel.send({type:'tutorLessons',attempt:2});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(requests[0].signal.aborted, true);
    requests[1].finish({courses:[{name:'Python',chapters:[{id:'first',name:'First lesson'}]}]});
    await Promise.all([first,next]);
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='tutorLessons').map((m:any)=>m.attempt), [2]);
    const loaded = panel.posted.filter((m:any)=>m.type==='tutorLessons').at(-1);
    assert.equal(loaded.preferredCourse, 'Python', 'the chapter resolves the catalog title to its teaching subject');
    assert.equal(loaded.courses[0].chapters[0].id, 'first');

    const slow = panel.send({type:'tutorLessons',attempt:3});
    await new Promise(resolve=>setImmediate(resolve));
    deadlines.at(-1)!.abort(new DOMException('Timed out','TimeoutError'));
    await slow;
    const failed = panel.posted.filter((m:any)=>m.type==='tutorLessons').at(-1);
    assert.equal(failed.attempt, 3);
    assert.match(failed.error, /took too long.*reload lessons/);
    const pending = panel.send({type:'tutorLessons',attempt:4});
    await new Promise(resolve=>setImmediate(resolve));
    panel.dispose(); await pending;
    assert.equal(requests.at(-1)!.signal.aborted, true);
    assert.equal(panel.posted.some((m:any)=>m.type==='tutorLessons' && m.attempt===4), false);
  } finally {
    Api.prototype.practiceCatalog = catalog; AbortSignal.timeout = timeout;
    for (const panel of panels) if (!panel.disposed) panel.dispose();
    await rm(storage,{recursive:true,force:true});
  }
});

test('ERPNext source-folder reopen restores durable task checks without a running browser and isolates accounts',async()=>{
  const storage=await mkdtemp(join(tmpdir(),'erp-progress-'));
  const grant=Api.prototype.learningRoom,catalog=Api.prototype.practiceCatalog,forms=Api.prototype.guidedErpForms;
  const course=JSON.parse(readFileSync(resolve(__dirname,'../../media/browser/erpnext/course.json'),'utf8'));
  const saved=Object.fromEntries(course.lessons.slice(0,4).map((task:any)=>[task.id,{record:task.id+'-saved',checkedAt:'2026-11-13T00:00:00Z',assisted:false,explained:true}]));
  const durable=new Map([[verifiedKey('production','alice'),saved]]);
  let session={user:{id:'alice'},access_token:'token'};
  const auth:any={session:async()=>session,signIn:async()=>session,accessToken:async()=> 'token'};
  const context:any={extensionUri:{fsPath:resolve(__dirname,'../..')},extensionPath:resolve(__dirname,'../..'),
    globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:(key:string,fallback:any)=>durable.get(key)??fallback,update:async()=>{}}};
  const chapter=course.lessons[4].instructorChapter;
  const open=async()=>{
    registerLearningRoom(context,()=> 'production',()=>({apiUrl:'https://api.example'}) as any,auth);
    await commands.get('dhimantai.openLearningRoom')!('ERPNext Essentials',chapter);
    const panel=panels.at(-1);
    await panel.send({type:'tutorLessons',attempt:1});
    await panel.send({type:'join',mode:'tutor',chapterId:chapter,attempt:2});
    return panel;
  };
  try {
    Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'grant'});
    Api.prototype.practiceCatalog=(async()=>({courses:[{name:'ERPNext Essentials',chapters:course.lessons.map((task:any)=>({id:task.instructorChapter,name:task.title}))}]})) as any;
    Api.prototype.guidedErpForms=async()=>course;
    for(let restart=0;restart<2;restart++) {
      const panel=await open();
      for(const type of ['tutorLessons','grant']) {
        const progress=panel.posted.find((m:any)=>m.type===type)?.browserProgress;
        assert.ok(progress,`${type} carries persisted practical progress`);
        assert.equal(progress.tasks.filter((t:any)=>t.status==='completed').length,4);
        assert.equal(progress.tasks[4].status,'not_started');
      }
      panel.dispose();
    }
    session={user:{id:'bob'},access_token:'token'};
    const other=await open();
    assert.equal(other.posted.find((m:any)=>m.type==='grant').browserProgress.tasks.filter((t:any)=>t.status==='completed').length,0);
    other.dispose();
    Api.prototype.guidedErpForms=async()=>{throw new Error('Course service unavailable');};
    const unavailable=await open();
    assert.equal(unavailable.posted.find((m:any)=>m.type==='grant').browserProgress,undefined,'unavailable progress is not fabricated as zero');
    assert.equal(durable.get(verifiedKey('production','alice')),saved,'reopening never overwrites durable evidence');
  } finally {
    Api.prototype.learningRoom=grant;Api.prototype.practiceCatalog=catalog;Api.prototype.guidedErpForms=forms;
    for(const panel of panels)if(!panel.disposed)panel.dispose();
    await rm(storage,{recursive:true,force:true});
  }
});

test('only the ERPNext Instructor owns connection state, and an explicit handoff recovers its disconnected draft',async()=>{
  const storage=await mkdtemp(join(tmpdir(),'erp-instructor-'));
  const grant=Api.prototype.learningRoom,catalog=Api.prototype.practiceCatalog;
  const states:any[]=[],listeners=new Set<(event:any)=>void>();
  const chapter='11111111-2222-4333-8444-555555555555';
  const question={id:'supplier:check',task:'supplier',kind:'explanation',title:'Create a supplier',
    question:'Why keep a separate customer record?',context:'Saved supplier.',options:[],minLength:30,maxLength:500};
  const observed={account:'alice',environment:'production',chapter,observation:{course:'erpnext-essentials',task:'supplier'},question};
  const bridge:any={onUpdate:(fn:any)=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};},
    progress:()=>({tasks:[{id:'supplier',chapter,title:'Create a supplier',status:'checked'}]}),
    setConnection:(account:string,environment:string,connected:boolean,detail:string)=>states.push({account,environment,connected,detail}),
    latest:()=>observed};
  const session={user:{id:'alice'},access_token:'token'};
  let delayed:Promise<typeof session>|undefined;
  const auth:any={session:()=>{const pending=delayed;delayed=undefined;return pending??Promise.resolve(session);},
    signIn:async()=>session,accessToken:async()=> 'token'};
  const context:any={extensionUri:{fsPath:resolve(__dirname,'../..')},extensionPath:resolve(__dirname,'../..'),
    globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:()=>undefined,update:async()=>{}}};
  try {
    Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'grant'});
    Api.prototype.practiceCatalog=(async()=>({courses:[{name:'ERPNext Essentials',chapters:[{id:chapter,name:'Create a supplier'}]}]})) as any;
    registerLearningRoom(context,()=> 'production',()=>({apiUrl:'https://api.example'}) as any,auth,undefined,undefined,bridge);
    await commands.get('dhimantai.openLearningRoom')!('ERPNext Essentials',chapter);
    const instructor=panels.at(-1);
    await instructor.send({type:'join',mode:'tutor',chapterId:chapter,attempt:1});
    await instructor.send({type:'browserState',attempt:1,connected:true});
    assert.equal(states.at(-1).connected,true);
    const restore=instructor.posted.find((m:any)=>m.type==='restoreNotebook');
    const answer='Separate records distinguish what we owe suppliers from what customers owe us.';
    await instructor.send({type:'notebookChanged',documentKey:restore.documentKey,sequence:1,
      notebook:{...restore.notebook,textDraft:answer}});

    await commands.get('dhimantai.openDoubtSolver')!();const doubt=panels.at(-1);
    await doubt.send({type:'join',mode:'doubt_solver',attempt:1,chapterId:chapter});
    const before=states.length;doubt.dispose();
    assert.equal(states.length,before,'closing another notebook must not disconnect the active Instructor');

    let finish!:(value:typeof session)=>void;
    delayed=new Promise(resolve=>{finish=resolve;});
    const late=instructor.send({type:'browserState',attempt:1,connected:true});
    await instructor.send({type:'leave'});
    assert.equal(states.at(-1).connected,false,'leaving updates the bridge synchronously, even without a final webview RPC');
    const left=states.length;finish(session);await late;
    assert.equal(states.length,left,'a late state message cannot mark the old session connected');

    let posted=instructor.posted.length;
    for(const listener of listeners)listener(observed);
    assert.equal(instructor.posted.length,posted,'background observations never reconnect a closed session');
    for(const listener of listeners)listener({...observed,focusQuestion:question.id});
    assert.deepEqual(instructor.posted.at(-1),{type:'chooseCourse',course:'ERPNext Essentials',lesson:chapter});
    await instructor.send({type:'join',mode:'tutor',chapterId:chapter,attempt:2});
    assert.equal(instructor.posted.filter((m:any)=>m.type==='restoreNotebook').at(-1).notebook.textDraft,answer);
    const handoff=instructor.posted.filter((m:any)=>m.type==='browserObservation').at(-1);
    assert.equal(handoff.attempt,2);assert.equal(handoff.focusQuestion,question.id);
    await instructor.send({type:'browserState',attempt:2,connected:true});
    for(const listener of listeners)listener({...observed,reconnect:true});
    assert.deepEqual(instructor.posted.at(-1),{type:'browserReconnect',attempt:2});
    instructor.dispose();assert.equal(states.at(-1).connected,false,'closing the owning Instructor clears its connection');
    const count=panels.length;
    for(const listener of [...listeners])listener({...observed,reconnect:true});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(panels.length,count+1,'explicit reconnect reopens a closed Instructor panel');
    const reopened=panels.at(-1);
    await reopened.send({type:'join',mode:'tutor',chapterId:chapter,attempt:1});
    assert.equal(reopened.posted.find((m:any)=>m.type==='restoreNotebook').notebook.textDraft,answer);
  } finally {
    Api.prototype.learningRoom=grant;Api.prototype.practiceCatalog=catalog;
    for(const panel of panels)if(!panel.disposed)panel.dispose();
    await rm(storage,{recursive:true,force:true});
  }
});

test('generated exercises keep independent tabs and saved work even when titles match, and reopen after reload', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'practice-notebooks-'));
  const pick = vscode.window.showQuickPick;
  const opened: any[] = [], documents: any[] = [];
  const context: any = {extensionUri: {fsPath: resolve(__dirname, '../..')}, extensionPath: resolve(__dirname, '../..'),
    globalStorageUri: {fsPath: storage}, secrets: {onDidChange: () => disposable}, globalState: {get: () => undefined, update: async () => {}}};
  const session = {user: {id: 'learner'}, access_token: 'token'};
  const auth: any = {session: async () => session, signIn: async () => session, accessToken: async () => 'token'};
  const register = () => registerLearningRoom(context, () => 'production', () => ({apiUrl:'https://api.example'}) as any, auth);
  try {
    register();
    for (const title of ['Token-ID Embedding Lookup', 'Token-ID Embedding Lookup', 'Count words']) {
      await commands.get('dhimantai.openPracticeNotebook')!('', 'learner', 'Python', {
        exercise:{title, task:'Print twelve.', example_input:'', expected_output:'12'},
        course:'Python', chapter:'Variables', language:'python', kernel:'python3', difficulty:'easy',
        validation:'reference_execution', tests:[{id:'example', kind:'stdio', stdin:'', expected:'12\n'}],
      });
      const panel = panels.at(-1);
      const imagePolicy = panel.webview.html.match(/img-src ([^;]+);/)?.[1].split(/\s+/);
      assert.ok(imagePolicy?.includes('https:'), 'textbook storage images can load in the actual notebook webview');
      assert.ok(!imagePolicy?.includes('http:') && !imagePolicy?.includes('*'));
      opened.push(panel);
      assert.ok(opened.every(p => !p.disposed), 'generating another exercise must keep every previous tab open');
      assert.equal(panel.title, 'Practice notebook · ' + title);
      await panel.send({type:'join', mode:'tutor', attempt:1});
      const document = panel.posted.find((m: any) => m.type === 'restoreNotebook');
      assert.ok(document);
      const notebook = {...document.notebook, textDraft:'Unsent answer ' + opened.length,
        cells:[...document.notebook.cells, {id:'my-note', kind:'note', text:'Reasoning ' + opened.length}],
        drafts:[{key:'practice-question:0', snippet:'code-1', language:'python', source:'print(' + opened.length + ')',
          stdin:'', prediction:'', explanation:'', helped:false}]};
      await panel.send({type:'notebookChanged', documentKey:document.documentKey, sequence:1, notebook});
      documents.push(notebook);
    }
    assert.equal(new Set(documents.map(n => n.exerciseId)).size, 3, 'identical titles still have separate document IDs');
    // Background tabs remain writable after opening another exercise.
    const first = opened[0], firstKey = first.posted.find((m: any) => m.type === 'restoreNotebook').documentKey;
    documents[0].textDraft = 'Revised while another exercise is open';
    await first.send({type:'notebookChanged', documentKey:firstKey, sequence:2, notebook:documents[0]});
    const history = () => TutorNotebookStore.practiceHistory(join(storage, 'tutor-notebooks'), 'production', 'learner');
    assert.equal((await history()).length, 3);
    for (const notebook of documents) {
      assert.deepEqual((await history()).find(item => item.notebook.exerciseId === notebook.exerciseId)!.notebook, notebook);
      vscode.window.showQuickPick = async (choices: any[]) => choices.find(c => c.practice.id === notebook.exerciseId);
      const count = panels.length;
      await commands.get('dhimantai.practiceHistory')!();
      assert.equal(panels.length, count, 'reopening an already open exercise reveals its tab');
      assert.equal(opened[documents.indexOf(notebook)].revealed, 1);
    }
    for (const panel of opened) panel.dispose();
    register(); // A fresh registration has no retained panels, like restarting the extension.
    for (const notebook of documents) {
      vscode.window.showQuickPick = async (choices: any[]) => choices.find(c => c.practice.id === notebook.exerciseId);
      await commands.get('dhimantai.practiceHistory')!();
      const panel = panels.at(-1);
      assert.equal(panel.title, 'Practice notebook · ' + notebook.title);
      await panel.send({type:'join', mode:'tutor', attempt:1});
      assert.deepEqual(panel.posted.find((m: any) => m.type === 'restoreNotebook').notebook, notebook);
      panel.dispose();
    }
  } finally {
    vscode.window.showQuickPick = pick;
    for (const panel of panels) panel.dispose();
    await rm(storage, {recursive:true, force:true});
  }
});

test('learning room host: other mode opens its own tab, mismatched joins fail, and every help request gets a reply', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'learning-room-host-'));
  const grant = Api.prototype.learningRoom, coach = Api.prototype.notebookCoach;
  try {
    const context: any = {extensionUri: {fsPath: resolve(__dirname, '../..')}, extensionPath: resolve(__dirname, '../..'),
      globalStorageUri: {fsPath: storage}, secrets: {onDidChange: () => disposable}, globalState: {get: () => undefined, update: async () => {}}};
    const session = {user: {id: 'alice'}, access_token: 'token'};
    const auth: any = {session: async () => session, signIn: async () => session, accessToken: async () => 'token'};
    registerLearningRoom(context, () => 'production', () => ({apiUrl: 'https://api.example'}) as any, auth);

    await commands.get('dhimantai.openLearningRoom')!();
    const tutor = panels.at(-1);
    await tutor.send({type: 'openOtherMode'});
    assert.equal(executed.filter(id => id !== 'setContext').at(-1), 'dhimantai.openDoubtSolver');
    assert.equal(tutor.disposed, false, 'this lesson tab stays open');
    await tutor.send({type: 'join', mode: 'doubt_solver', attempt: 4});
    assert.match(tutor.posted.find((m: any) => m.type === 'failed' && m.attempt === 4)?.message, /This tab is for Instructor/);
    await tutor.send({type: 'notebookTurn', attempt: 9, request: 1, snapshot, message: 'Help'});
    assert.match(reply(tutor, 1).error, /session changed/i, 'no session still answers instead of leaving a 60 second wait');

    Api.prototype.learningRoom = async () => ({url: 'wss://lk-prod.dhimant.ai', token: 'grant'});
    await commands.get('dhimantai.openDoubtSolver')!();
    const switched = panels.at(-1);
    await switched.send({type:'workspaceMode',mode:'tutor'});
    assert.match(switched.webview.html, /data-notebook-mode="tutor"/);
    assert.doesNotMatch(switched.webview.html, /id="learning-(?:outline|coach)"/);
    assert.match(switched.webview.html, /id="course-selection"/);
    await commands.get('dhimantai.openDoubtSolver')!();
    const doubt = panels.at(-1);
    assert.notEqual(doubt, switched);
    assert.equal(switched.disposed, false);
    assert.match(doubt.webview.html, /data-notebook-mode="doubt_solver"/);
    assert.doesNotMatch(doubt.webview.html, /id="learning-(?:outline|coach)"/);
    const count = panels.length;
    await commands.get('dhimantai.openDoubtSolver')!();
    assert.equal(panels.length, count);
    assert.equal(doubt.revealed, 1);
    await doubt.send({type: 'join', mode: 'doubt_solver', attempt: 1, chapterId:'python-intro'});
    assert.ok(doubt.posted.some((m: any) => m.type === 'grant' && m.attempt === 1));
    await doubt.send({type: 'openOtherMode'});
    assert.equal(executed.filter(id => id !== 'setContext').at(-1), 'dhimantai.openLearningRoom');

    config.aiAssistance = false;
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 2, snapshot, message: 'Help', prediction: ''});
    assert.match(reply(doubt, 2).error, /AI assistance is off/);
    config.aiAssistance = true;

    const calls: {path: string; body: any}[] = [];
    let finish!: () => void;
    Api.prototype.notebookCoach = (async function (path: string, body: any) {
      calls.push({path, body});
      if (calls.length === 1) await new Promise<void>(done => { finish = done; });
      if (calls.length === 2) throw new ApiError(403, 'Your course access has ended.');
      return {guidance: 'Look at the index.', prompt: 'Your turn: print the last valid index.', line: null};
    }) as any;
    const doubtId = '3b241101-e2bb-4255-8caf-4136c566a962';
    const first = doubt.send({type: 'notebookTurn', attempt: 1, request: 3, snapshot, message: 'Help', prediction: '', doubtId, helpLevel: 2,
      history: [{role: 'learner', text: 'Why index 3?'}]});
    await new Promise(r => setTimeout(r, 10));
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 4, snapshot, message: 'Again', prediction: ''});
    assert.match(reply(doubt, 4).error, /still answering/, 'a busy request is refused with a reply');
    finish(); await first;
    assert.equal(calls[0].path, '/notebook-coach/doubt');
    assert.equal(calls[0].body.doubt_id, doubtId);
    assert.equal(calls[0].body.help_level, 2, 'Doubt Solver help climbs the ladder');
    assert.equal(calls[0].body.chapter_id, undefined);
    assert.match(reply(doubt, 3).content, /Your turn: print the last valid index/);
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 5, snapshot, message: 'Help', prediction: '', doubtId});
    assert.equal(reply(doubt, 5).accessEnded, true, 'ended access is marked so the notebook offers the catalog');
    await doubt.send({type: 'notebookTurn', attempt: 1, request: 6, snapshot, message: 'Help', prediction: '', attachments: 'broken'});
    assert.match(reply(doubt, 6).error, /attachments could not be read/, 'a bad attachment is explained, never silently dropped');
  } finally {
    Api.prototype.learningRoom = grant; Api.prototype.notebookCoach = coach;
    for (const panel of panels) panel.dispose();
    await rm(storage, {recursive: true, force: true});
  }
});

test('learning room host: a notebook without course data says so, and a data question before it is ready still gets a reply', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'learning-room-data-'));
  const grant = Api.prototype.learningRoom;
  try {
    const context: any = {extensionUri: {fsPath: resolve(__dirname, '../..')}, extensionPath: resolve(__dirname, '../..'),
      globalStorageUri: {fsPath: storage}, secrets: {onDidChange: () => disposable}, globalState: {get: () => undefined, update: async () => {}}};
    const session = {user: {id: 'bob'}, access_token: 'token'};
    const auth: any = {session: async () => session, signIn: async () => session, accessToken: async () => 'token'};
    registerLearningRoom(context, () => 'production', () => ({apiUrl: 'https://api.example'}) as any, auth);
    Api.prototype.learningRoom = async () => ({url: 'wss://lk-prod.dhimant.ai', token: 'grant'});
    await commands.get('dhimantai.openDoubtSolver')!();
    const doubt = panels.at(-1);
    await doubt.send({type: 'join', mode: 'doubt_solver', attempt: 1, chapterId:'python-intro'});
    await new Promise(r => setTimeout(r, 10));
    assert.ok(doubt.posted.some((m: any) => m.type === 'courseData' && m.state === 'none'), 'no course data outside AI at Work');
    await doubt.send({type: 'dataAsk', attempt: 1, request: 7, question: 'Which branch sold the most?'});
    assert.match(doubt.posted.find((m: any) => m.type === 'dataReply' && m.request === 7).error, /not ready/);
    await doubt.send({type: 'dataAsk', attempt: 2, request: 8, question: 'x'});
    assert.match(doubt.posted.find((m: any) => m.type === 'dataReply' && m.request === 8).error, /session changed/i);
  } finally {
    Api.prototype.learningRoom = grant;
    for (const panel of panels) panel.dispose();
    await rm(storage, {recursive: true, force: true});
  }
});

test('course workspace switches Instructor, Doubt and Practice in one tab without mixing drafts',async()=>{
  const storage=await mkdtemp(join(tmpdir(),'course-workspace-'));
  const original={catalog:Api.prototype.practiceCatalog,grant:Api.prototype.learningRoom,questions:Api.prototype.practiceQuestions,workspace:Api.prototype.workspace,written:Api.prototype.writtenPractice};
  const state=new Map<string,unknown>(), session={user:{id:'learner'},access_token:'token'};
  const auth:any={session:async()=>session,signIn:async()=>session,accessToken:async()=> 'token'};
  const context:any={extensionUri:{fsPath:resolve(__dirname,'../..')},extensionPath:resolve(__dirname,'../..'),
    globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:(key:string)=>state.get(key),update:async(key:string,value:unknown)=>{state.set(key,value);}}};
  const task='10000000-0000-0000-0000-000000000001', asked:string[]=[];
  try {
    Api.prototype.practiceCatalog=async()=>({courses:[{name:'Python',chapters:[{id:'py',name:'Lists'}]},{name:'SQL',chapters:[{id:'sql',name:'Joins'}]}],languages:[],question_pools:['textbook']});
    Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'grant'});
    Api.prototype.practiceQuestions=async(chapter)=>{asked.push(chapter);return {questions:[{id:task,title:'Write a loop',language:'python'},{id:'written',title:'Explain a loop',language:'',kind:'written'}]};};
    Api.prototype.writtenPractice=async()=>({id:'written',title:'Explain a loop',question:'Explain how a loop stops.',course:'Python',kind:'written',assessment:'feedback_only',preparation:'recommended'});
    Api.prototype.workspace=async()=>({project:{question_id:task,title:'Write a loop',brief:'Print three numbers.',languages:['python'],code_assistance_allowed:true},
      draft:{payload:{language:'python',notebook:{cells:[]}}}} as any);
    registerLearningRoom(context,()=> 'production',()=>({apiUrl:'https://api.example'}) as any,auth);
    await commands.get('dhimantai.openLearningRoom')!('Python','py');
    const panel=panels.at(-1), count=panels.length;
    if (process.env.DHIMANTAI_COURSE_PREVIEW) await writeFile(process.env.DHIMANTAI_COURSE_PREVIEW,panel.webview.html);
    await panel.send({type:'tutorLessons',attempt:1});
    assert.deepEqual(panel.posted.at(-1).courses.map((c:any)=>c.name),['Python']);
    await panel.send({type:'join',mode:'tutor',chapterId:'sql',attempt:2});
    assert.equal(panel.posted.at(-1).type,'failed');
    await panel.send({type:'join',mode:'tutor',chapterId:'py',attempt:3});
    const restored=()=>panel.posted.filter((m:any)=>m.type==='restoreNotebook').at(-1);
    let saved=restored();
    await panel.send({type:'coachingLanguage',language:'te-IN'});
    assert.equal(state.get('dhimantai.coachingLanguage.production.learner'),'te-IN');
    const change=async(mode:string,draft:string,questionId?:string)=>{
      await panel.send({type:'workspaceMode',mode,questionId,documentKey:saved.documentKey,notebook:{...saved.notebook,textDraft:draft}});
      assert.notEqual(panel.posted.at(-1)?.type,'workspaceError',panel.posted.at(-1)?.message);
      assert.equal(panels.length,count);assert.equal(panel.disposed,false);
    };
    await change('doubt_solver','Instructor draft');
    await panel.send({type:'join',mode:'doubt_solver',attempt:1});saved=restored();
    assert.notEqual(saved.notebook.textDraft,'Instructor draft');
    await change('tutor','Doubt draft');
    await panel.send({type:'join',mode:'tutor',chapterId:'py',attempt:1});saved=restored();
    assert.equal(saved.notebook.textDraft,'Instructor draft');
    await change('doubt_solver','Instructor draft');
    await panel.send({type:'join',mode:'doubt_solver',attempt:1});
    await commands.get('dhimantai.openLearningRoom')!('Python','py');
    assert.equal(panels.length,count,'reopening the course from Doubt uses the same tab');
    const reopened=panel.posted.length;
    await panel.send({type:'join',mode:'tutor',chapterId:'py',attempt:1});saved=restored();
    assert.ok(panel.posted.slice(reopened).some((message:any)=>message.type==='grant'));
    await panel.send({type:'workspacePractice',chapterId:'py'});
    assert.deepEqual(asked,['py']);assert.equal(panel.posted.at(-1).course,'Python');
    await panel.send({type:'workspaceMode',mode:'practice',questionId:'foreign',documentKey:saved.documentKey,notebook:saved.notebook});
    assert.equal(panel.posted.at(-1).type,'workspaceError');
    await change('practice','Instructor draft',task);
    await panel.send({type:'join',mode:'tutor',attempt:1});saved=restored();
    assert.equal(saved.notebook.exerciseId,task);
    await change('tutor','Practice draft');
    await panel.send({type:'join',mode:'tutor',chapterId:'py',attempt:1});
    assert.equal(restored().notebook.textDraft,'Instructor draft');
    const history=await TutorNotebookStore.practiceHistory(join(storage,'tutor-notebooks'),'production','learner');
    assert.equal(history.find(item=>item.notebook.exerciseId===task)?.notebook.textDraft,'Practice draft');
    saved=restored();await panel.send({type:'workspacePractice',chapterId:'py'});
    await change('practice','Instructor draft','written');
    assert.match(panel.webview.html,/Back to course/);
    await panel.send({type:'backToCourse',answer:'The condition becomes false.',assistance:'None',usedTutor:false});
    assert.equal(panels.length,count);
    await panel.send({type:'join',mode:'tutor',chapterId:'py',attempt:1});
    assert.equal(restored().notebook.textDraft,'Instructor draft');
    assert.equal((state.get('writtenPractice.production.learner.written') as any).answer,'The condition becomes false.');
    saved=restored();await change('doubt_solver','Instructor draft');
    await panel.send({type:'join',mode:'doubt_solver',attempt:1});saved=restored();
    const files=[{name:'attempt.png',type:'image/png',data:'YWJj'}];
    await panel.send({type:'workspaceMode',mode:'tutor',carryDraft:true,files,documentKey:saved.documentKey,
      notebook:{...saved.notebook,textDraft:'Please explain my two-pointer attempt.'}});
    await panel.send({type:'join',mode:'tutor',chapterId:'py',attempt:1});saved=restored();
    assert.equal(saved.notebook.textDraft,'Please explain my two-pointer attempt.');
    assert.ok(saved.notebook.cells.some((cell:any)=>cell.kind==='note' && cell.text==='Instructor draft'));
    assert.deepEqual(panel.posted.filter((m:any)=>m.type==='handoffAttachments').at(-1).files,files);
    await panel.send({type:'join',mode:'tutor',chapterId:'py',attempt:2});
    assert.equal(restored().notebook.cells.filter((cell:any)=>cell.kind==='note' && cell.text==='Instructor draft').length,1,'reconnect does not duplicate the handoff');
    saved=restored();await panel.send({type:'workspacePractice',chapterId:'py'});
    await change('practice','Instructor draft','written');
    panel.dispose();
    await commands.get('dhimantai.openLearningRoom')!('Python','py');
    assert.equal(panels.length,count+1,'closing a written task must release its course workspace');
  } finally {
    Api.prototype.practiceCatalog=original.catalog;Api.prototype.learningRoom=original.grant;
    Api.prototype.practiceQuestions=original.questions;Api.prototype.workspace=original.workspace;Api.prototype.writtenPractice=original.written;
    for(const panel of panels)panel.dispose();await rm(storage,{recursive:true,force:true});
  }
});

test('speech introduction offers external GPU setup without enabling unreviewed cloud rental',async()=>{
  const storage=await mkdtemp(join(tmpdir(),'speech-runtime-'));
  const grant=Api.prototype.learningRoom,catalog=Api.prototype.practiceCatalog;
  const chapter='11111111-2222-4333-8444-555555555555';
  const session={user:{id:'alice'},access_token:'token'};
  const auth:any={session:async()=>session,signIn:async()=>session,accessToken:async()=> 'token'};
  const context:any={extensionUri:{fsPath:resolve(__dirname,'../..')},extensionPath:resolve(__dirname,'../..'),
    globalStorageUri:{fsPath:storage},secrets:{onDidChange:()=>disposable},globalState:{get:()=>undefined,update:async()=>{}}};
  try {
    Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'grant'});
    for(const [course,lesson,external,managed] of [
      ['Developing Speech-to-Text Models','Chapter 1: Speech Recognition and the Development Loop',true,false],
      ['Developing TTS Models with IndicSpeak','Chapter 1: TTS Models and the IndicSpeak Workflow',true,true],
      ['Python Programming Language','Introduction',false,false],
    ] as const) {
      Api.prototype.practiceCatalog=(async()=>({courses:[{name:course,chapters:[{id:chapter,name:lesson}]}]})) as any;
      registerLearningRoom(context,()=> 'production',()=>({apiUrl:'https://api.example'}) as any,auth);
      await commands.get('dhimantai.openLearningRoom')!(course,chapter);
      const panel=panels.at(-1);
      await panel.send({type:'tutorLessons',attempt:1});
      await panel.send({type:'join',mode:'tutor',chapterId:chapter,attempt:2});
      const granted=panel.posted.find((m:any)=>m.type==='grant');
      assert.ok(granted,JSON.stringify(panel.posted));
      assert.equal(granted.gpuRuntimes,external,course);
      assert.equal(granted.managedGpuRuntimes,managed,course);
      if(!managed)assert.equal(granted.gpuCount,0,'optional setup is not a GPU requirement');
      panel.dispose();
    }
  }finally{
    Api.prototype.learningRoom=grant;Api.prototype.practiceCatalog=catalog;
    for(const panel of panels)if(!panel.disposed)panel.dispose();
    await rm(storage,{recursive:true,force:true});
  }
});

test('Course Notes follows notebook edits and writes through the lesson that owns the note', async () => {
  const storage = await mkdtemp(join(tmpdir(),'course-notes-host-')), grant = Api.prototype.learningRoom;
  const session = {user:{id:'learner'},access_token:'token'};
  const auth:any = {session:async()=>session, signIn:async()=>session};
  const context:any = {extensionUri:{fsPath:resolve(__dirname,'../..')}, extensionPath:resolve(__dirname,'../..'),
    globalStorageUri:{fsPath:storage}, secrets:{onDidChange:()=>disposable}, globalState:{get:()=>undefined,update:async()=>{}}};
  try {
    Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'grant'});
    registerLearningRoom(context,()=> 'production',()=>({apiUrl:'https://api.example'}) as any,auth);
    await commands.get('dhimantai.openDoubtSolver')!();
    const doubt=panels.at(-1);
    await doubt.send({type:'join',mode:'doubt_solver',attempt:1,chapterId:'python-intro'});
    const doubtDoc=doubt.posted.find((m:any)=>m.type==='restoreNotebook');
    await doubt.send({type:'courseNotes',documentKey:doubtDoc.documentKey});
    const notes=panels.at(-1);
    await notes.send({type:'load'});assert.deepEqual(notes.posted.at(-1).notes,[]);

    await commands.get('dhimantai.openLearningRoom')!('Python','python-intro');
    const room=panels.at(-1);
    await room.send({type:'join',mode:'tutor',attempt:1,chapterId:'python-intro'});
    const {documentKey,notebook}=room.posted.find((m:any)=>m.type==='restoreNotebook');
    const changed=(sequence:number,text:string)=>room.send({type:'notebookChanged',sequence,documentKey,notebook:{...notebook,
      cells:[{kind:'note',id:'note',text},{kind:'note',id:'blank',text:'   '}]}});
    await changed(1,'From Instructor');
    const latestNotes=()=>notes.posted.filter((m:any)=>m.type==='notes').at(-1).notes;
    for (let i=0;i<100 && !latestNotes().length;i++) await new Promise(done=>setTimeout(done,10));
    assert.deepEqual(latestNotes().map((n:any)=>n.text),['From Instructor']);
    await notes.send({type:'save',scope:latestNotes()[0].scope,id:'note',text:'From Course Notes',expected:'From Instructor'});
    assert.equal(room.posted.at(-1).type,'courseNoteUpdated');assert.equal(room.posted.at(-1).documentKey,documentKey);
    const original=new TutorNotebookStore(join(storage,'tutor-notebooks'),'production','learner\0tutor:python-intro');
    await changed(2,'From Instructor');
    assert.equal((await original.load()).cells[0].text,'From Course Notes','an older snapshot cannot undo the note edit');
    await changed(3,'From Course Notes');
    await changed(4,'Edited again in Instructor');
    for (let i=0;i<100 && latestNotes()[0].text!=='Edited again in Instructor';i++) await new Promise(done=>setTimeout(done,10));
    assert.equal(latestNotes()[0].text,'Edited again in Instructor');
    assert.equal((await original.load()).cells[0].text,'Edited again in Instructor');
  } finally {
    Api.prototype.learningRoom=grant;
    for(const panel of panels) if(!panel.disposed) panel.dispose();
    await rm(storage,{recursive:true,force:true});
  }
});
