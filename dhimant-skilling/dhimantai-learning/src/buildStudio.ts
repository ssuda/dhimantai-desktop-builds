import {activateCourseTools} from './courseEditorTools';
import {run as runInContainer} from './podman';
import type {CellSuggestion} from './studioJsx';
import {CoachAudio, audioPolicy, instructorComposer} from './coachAudio';
import { coachingLanguages } from './coachingLanguage';
import { bindDictation } from './dictation';
import * as vscode from 'vscode';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, stat, rename, mkdtemp, rm, copyFile, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, relative, isAbsolute, sep} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {StudioJsx} from './studioJsx';
import {StudioRun, snapshot, type CheckoutEvidence} from './studioRuntime';
import type {StudioAccess,StudioReply,StudioEntry,StudioDefinition,LessonId,StudioMode} from './studioTypes';
import {Api} from './api';
import {Auth} from './auth';
import {CoachSurface, type CoachRenderer} from './coachSurface';
import type {ProjectCoach} from './projectCoach';
import type {Environment,EnvironmentName} from './environments';
import {cloneCapstone} from './capstoneRepo';
import {redactSecrets} from './projectContext';

const exec=promisify(execFile);
type Example={id:string; language:'php'|'sql'; source:string};
interface Position {file:string;anchor:[number,number];active:[number,number]}
/** The request a prediction is about: borrowing `quantity` when `stock` remain. */
type Scenario={item:string;stock:number;quantity:number};
const sameScenario=(s:Scenario,e:CheckoutEvidence)=>e.before===s.stock&&e.quantity===s.quantity;
interface StudioVoice {
  playback: Pick<CoachAudio, 'bind'>;
  dictation: Pick<Api, 'voiceInputGrant'>;
  account: string;
  environment: EnvironmentName;
}
interface ChapterProgress {spoken?:{lesson:LessonId; index:number}; prediction?:string; scenario?:Scenario; predicted?:boolean;
  practice?:boolean; demo?:string; example?:Example; evidence?:CheckoutEvidence;
  pendingCheckout?:{lesson:LessonId;prediction?:string;unmatched?:Scenario}; position?:Position; check?:string}
interface Progress extends ChapterProgress {history:string[]; chapters?:Partial<Record<LessonId, ChapterProgress>>}
function chapterProgress(progress:Progress, from:LessonId, to:LessonId):Progress {
  if(from===to)return progress;
  const {history, chapters={}, ...previous}=progress;
  return {...chapters[to], history, chapters:{...chapters,[from]:previous}};
}
export interface StudioService {
  studioEntry(lesson:LessonId,mode:StudioMode,attempt?:string):Promise<StudioAccess>;
  studioTurn(body:object):Promise<StudioReply>;
}

const shellStyle='body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:14px}h1{font-size:1.4em}section,details,fieldset{margin:1em 0}button,textarea,input,select{font:inherit}button{padding:.4em .65em;margin:.25em .35em .25em 0;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}button:disabled{opacity:.65}textarea,input,select{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:.4em}textarea,input{width:100%}label{display:block}pre{white-space:pre-wrap}summary{cursor:pointer}';
const button=(id:string,label:string,action=id)=>'<button id="'+id+'" data-action="'+action+'">'+label+'</button>';
const ownFile=(root:string,file:string)=>{const name=relative(root,file);return name&&name!=='..'&&!name.startsWith('..'+sep)&&!isAbsolute(name)?name:undefined;};

export class StudioLesson {
  private get webview() { return this.surface.webviewFor(this.render); }
  private preview?:vscode.WebviewPanel;
  private live?:StudioRun;
  private preparing?:Promise<StudioRun>;
  private symbolRegistration?:vscode.Disposable;
  private languageTools?:{complete:(uri:vscode.Uri,language:string,source:string,offset:number)=>Promise<CellSuggestion[]>};
  private experiment?:StudioRun;
  private closing?:Promise<void>;
  private busy=false;
  private disposed=false;
  private stopping?:Promise<void>;
  private jsx?:StudioJsx;
  private question='';
  private selectedVoiceLanguage = 'auto';
  private detectedLanguage?: string;
  private scenario?:Scenario;
  private offerPractice=false;
  private retry=false;
  private readonly draft:{id:string;revision:number;language:string;source:string;example?:string}={id:randomUUID(),revision:0,language:'php',source:''};
  private learnerPosition?:Position;
  private positionListener:vscode.Disposable;
  constructor(private context:vscode.ExtensionContext,readonly root:string,private tempRoot:string,
      private access:StudioAccess,private definition:StudioDefinition,private service:StudioService,
      private progress:Progress,private persist:(p:Progress,a:StudioAccess)=>Promise<void>,
      private startRetry:(lesson:LessonId)=>Promise<void>,private current:()=>Promise<boolean>, private voice:StudioVoice, private readonly surface:CoachSurface) {
    this.positionListener=vscode.window.onDidChangeTextEditorSelection(e=>{
      const file=ownFile(this.root,e.textEditor.document.uri.fsPath); if(!file)return;
      const s=e.textEditor.selection;this.learnerPosition={file,anchor:[s.anchor.line,s.anchor.character],active:[s.active.line,s.active.character]};
    });
  }
  isCurrent(){return this.current();}
  private get lesson() {return this.definition.entries.find(e=>e.id===this.access.lesson)!;}
  private get nextLesson(){return this.definition.entries[this.definition.entries.indexOf(this.lesson)+1];}
  get attemptId(){return this.access.id;}
  private get guided() { return this.access.mode === 'guided'; }
  private get brief() { return this.guided ? this.lesson.task : this.lesson.assignment ?? this.lesson.title; }
  private save(){return this.persist(this.progress,this.access);}
  async open(focus=true) {
    if(this.symbolRegistration){await this.reveal();return;}
    await activateCourseTools(this.context.extensionPath,this.definition.editor_extensions);
    this.languageTools=vscode.extensions.getExtension('optficial.equipment-desk-languages')?.exports;
    this.symbolRegistration=vscode.commands.registerCommand('dhimantai.equipmentDeskSymbols',async(uri:vscode.Uri,language:string,prefix:string)=>{
      if(this.disposed || !ownFile(this.root,uri.fsPath) || !await this.current() || !/^[a-z_]\w*$/i.test(prefix))return [];
      const live=this.live??await this.preparing;
      if(!live)return [];
      const command=language==='sql'?['python3','/opt/build-studio/runtime.py','schema']:language==='php'?['php','/opt/build-studio/symbols.php']:undefined;
      if(!command)return [];
      const names:string[]=JSON.parse(await runInContainer(live.bin,['exec',live.container,...command]));
      if(this.disposed || this.live!==live || !await this.current())return [];
      return names.filter(s=>typeof s==='string' && s.toLowerCase().startsWith(prefix.toLowerCase())).slice(0,100);
    });
    await this.ensureLessonFiles();
    if(focus) await this.openSource(this.progress.position);
    if (this.disposed || !await this.current()) return;
    await this.reveal();
    // Prepare the active learner runtime on lesson entry. Completion only reads its metadata.
    if(this.access.lesson==='php') await this.prediction();
    else {
      try { await this.liveRun(); }
      catch(error) { await this.status(error instanceof Error ? error.message : 'Project runtime unavailable.'); }
    }
    await this.state();
    if(this.progress.pendingCheckout?.lesson===this.access.lesson){
      if(await this.deliverCheckout())await this.prediction();
      await this.state();
    }
  }
  async resume() {
    const source = vscode.window.activeTextEditor?.document.uri;
    if (!source || !ownFile(this.root, source.fsPath)) await this.openSource(this.learnerPosition ?? this.progress.position);
    await this.reveal(true);
  }
  async reveal(preserveFocus = false) {
    if (this.disposed || !await this.current()) return;
    this.surface.select(this.render);
    await this.surface.show(preserveFocus, true);
    await this.state();
  }
  hide() { return this.surface.hide(this.render); }
  private readonly render: CoachRenderer = webview => {
    void vscode.commands.executeCommand('setContext', 'dhimantai.projectOpen', false);
    const messages = webview.onDidReceiveMessage(m => {
      void this.message(m).catch(e => this.status(e instanceof Error ? e.message : 'The project action failed.'));
    });
    const media = vscode.Uri.joinPath(this.context.extensionUri,'media');
    webview.options = {enableScripts:true, localResourceRoots:[media]};
    const asset = (name:string) => webview.asWebviewUri(vscode.Uri.joinPath(media,name));
    const nonce=randomUUID();
    const voiceAvailable = () => this.surface.visible && !this.disposed && this.webview === webview;
    const playback = this.voice.playback.bind(webview, () => voiceAvailable() ? this.spokenReply() : undefined);
    const dictation = bindDictation(webview, () => voiceAvailable() && !this.busy
      ? {key:this.voiceScope, api:this.voice.dictation, language:this.selectedVoiceLanguage} : undefined);
    const composer=instructorComposer(webview,media,nonce,{assistant:'Project Mentor',maxlength:2000,support:
      '<label id="replyKind" hidden>Reply as <select id="replyType"><option value="predict">My prediction</option><option value="ask">A question</option></select></label>'});
    webview.html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src '+webview.cspSource+' \'unsafe-inline\'; img-src data: blob:; media-src blob:; connect-src '+audioPolicy+'; script-src \'nonce-'+nonce+'\' '+webview.cspSource+'"><style>'+shellStyle+
      'body{display:flex;flex-direction:column;height:100vh;box-sizing:border-box;margin:0;gap:8px}.lesson-scroll{flex:1;min-height:0;overflow:auto}#replyKind{margin-bottom:6px} [hidden]{display:none!important}</style><link rel="stylesheet" href="'+asset('learning-room/composer.css')+'"><link rel="stylesheet" href="'+asset('build-studio/buildStudio.css')+'"></head><body><main class="lesson-scroll">'+
      '<h1 id="title"></h1><p id="concept"></p><p id="task"></p><ul id="criteria" hidden></ul><p id="question"></p>'+
      button('practice','Practice inventory')+button('retry','Retry inventory')+
      button('run','Run App')+button('next','Continue')+button('check','Check my work')+
      '<section id="history" role="log" aria-live="polite"></section><details id="tools"><summary>Project tools</summary>'+
      button('demo','Show me in the file')+button('terminal','Open project terminal')+button('assignment','Retry independently','assignment')+'</details>'+
      '<details id="consoleBox"><summary>Project Console</summary><label id="originChoice" hidden>Snippet <select id="origin"><option value="example">Mentor example</option><option value="own">My snippet</option></select></label>'+
      '<div id="projectCell"></div></details><p id="status" role="status"></p></main>'+
      composer+'<script nonce="'+nonce+'" src="'+asset('build-studio/buildStudio.js')+'"></script></body></html>';
    return vscode.Disposable.from(messages, playback, dictation);
  };
  private async ensureLessonFiles() {
    if(this.lesson.id!=='testing')return;
    const tests=join(this.root,'tests');
    await mkdir(tests,{recursive:true});
    if(!ownFile(await realpath(this.root),await realpath(tests)))throw new Error('Open the tests directory inside your project.');
    await copyFile(join(this.context.extensionPath,'media/build-studio/check_checkout.py'),join(tests,'check_checkout.py'),constants.COPYFILE_EXCL)
      .catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});
  }
  async selectChapter(lesson:LessonId) {
    if(this.busy)throw new Error('Wait for the current project action to finish before changing chapters.');
    if(lesson===this.access.lesson){
      await this.service.studioEntry(lesson,this.access.mode,this.access.id);
      return this.resume();
    }
    this.busy=true;
    try {await this.moveTo(lesson);}
    finally {this.busy=false;await this.webview?.postMessage({type:'busy',value:false});}
  }
  private async moveTo(lesson:LessonId) {
    this.preview?.dispose();
    await this.closing;
    await this.deliverCheckout();
    await this.save();
    const access=await this.service.studioEntry(lesson,this.access.mode,this.access.id);
    if(this.disposed || !await this.current())return;
    this.progress=chapterProgress(this.progress,this.access.lesson,access.lesson);
    this.access=access;
    this.question='';this.retry=false;this.offerPractice=false;this.scenario=undefined;this.learnerPosition=undefined;
    await this.save();
    await this.ensureLessonFiles();
    await this.openSource(this.progress.position);
    await this.reveal();
    if(lesson==='php'){await this.prediction();await this.state();}
  }
  private async openSource(position?:Position) {
    const entry=this.lesson;
    const candidate=join(this.root,position?.file??entry.file);
    if(!ownFile(this.root,candidate))throw new Error('The saved file is outside this attempt.');
    const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(candidate));
    const sym=doc.positionAt(Math.max(0,doc.getText().indexOf(entry.symbol)));
    const selection=position?new vscode.Selection(new vscode.Position(...position.anchor),new vscode.Position(...position.active)):new vscode.Selection(sym,sym);
    const editor=await vscode.window.showTextDocument(doc,{viewColumn:vscode.ViewColumn.One,preview:false});
    editor.selection=selection;editor.revealRange(selection);
  }
  private get voiceScope() { return this.access.id + '/' + this.access.lesson; }

  private spokenReply() {
    const spoken = this.progress.spoken;
    const line = spoken?.lesson === this.access.lesson ? this.progress.history[spoken.index] : undefined;
    const prefix = 'Instructor · ';
    const text = line?.startsWith(prefix) ? line.slice(prefix.length) : this.question || this.brief;
    const language = this.selectedVoiceLanguage === 'auto' ? this.detectedLanguage : this.selectedVoiceLanguage;
    const query = new URLSearchParams({attempt:this.access.id, lesson:this.access.lesson});
    if (language) query.set('language', language);
    const id = createHash('sha256').update(JSON.stringify([this.voiceScope, line ? spoken?.index : null, text, language])).digest('hex');
    return {id, text, account:this.voice.account, environment:this.voice.environment,
      path:'/notebook-coach/project/equipment-desk',
      query:'?' + query};
  }

  private addGuidance(text:string) {
    this.progress.spoken = {lesson:this.access.lesson, index:this.progress.history.length};
    this.progress.history.push('Instructor · '+text);
  }

  private async state() {
    const e=this.lesson;
    await this.webview?.postMessage({type:'state',voiceScope:this.voiceScope,selectedVoiceLanguage:this.selectedVoiceLanguage,audioId:this.spokenReply().id,title:this.guided ? e.title : 'Equipment Desk assignment',concept:this.guided ? e.concept : '',task:this.brief,question:this.question,
      next:this.nextLesson?.title,stockCheck:e.id==='php',criteria:e.checks,guided:this.guided,demo:e.demonstration&&this.guided&&this.hasPredicted&&!this.progress.demo,
      predict:e.id==='php'&&!!this.question&&(this.progress.practice||!this.offerPractice),predictionOptional:!this.guided,offerPractice:this.offerPractice&&!this.progress.practice,
      retry:this.retry,draft:this.draft.id,draftRevision:this.draft.revision,attemptLabel:this.access.id.slice(0,8),...this.progress});
  }
  /** A prediction is used up by the checkout it was about. The demonstration stays unlocked. */
  private get hasPredicted(){return !!(this.progress.predicted||this.progress.prediction);}
  private status(text:string){return this.webview?.postMessage({type:'status',text});}
  private async saveFiles() {
    const dirty=vscode.workspace.textDocuments.filter(d=>d.isDirty&&d.uri.scheme==='file'&&ownFile(this.root,d.uri.fsPath));
    if(dirty.length && (await vscode.window.showWarningMessage('Save your project edits before running?',{modal:true},'Save and run')!=='Save and run' ||
       !(await Promise.all(dirty.map(d=>d.save()))).every(Boolean))) throw new Error('Run cancelled. Your edits are still open.');
  }
  private async liveRun(refresh=false) {
    if(this.preparing)await this.preparing;
    if(this.live && !refresh)return this.live;
    this.preparing=this.prepareLive();
    try{return this.live=await this.preparing;}
    finally{this.preparing=undefined;}
  }
  private async prepareLive(){
    const {commit,tree}=await snapshot(this.root,this.access.id,'Learner');
    if(this.live){
      const prior=(await exec('git',['rev-parse',this.live.revision+'^{tree}'],{cwd:this.root})).stdout.trim();
      if(prior===tree)return this.live;
      await this.live.close(); this.live=undefined;
    }
    return StudioRun.start(this.root,this.access.id,this.access.release.image,'live',commit,this.tempRoot,text=>{void this.status(text);});
  }
  /** Guided lessons require a prediction before a checkout. Assignments offer the same question as optional
   * practice: independence withholds examples and demonstrations, not the habit of predicting. */
  private async prediction() {
    this.retry=false;this.offerPractice=false;this.scenario=undefined;
    if(this.progress.practice){
      this.scenario={item:'Camera',stock:1,quantity:2};
      this.question='Practice inventory has one camera. Someone asks for two. What happens to the request and the inventory?';return;
    }
    await this.status('Reading the live inventory for your prediction…');
    try{
      const counts=await (await this.liveRun()).inventory();
      for(const name of this.definition.items){
        const n=counts.get(name);
        if(n!==undefined && Number.isInteger(n)&&n>=0&&n<this.definition.quantity.max){
          this.scenario={item:name,stock:n,quantity:n+1};
          this.question='Your desk shows '+n+' available for '+name+'. Someone requests '+(n+1)+'. What should the app return, and how many should remain?';return;
        }
      }
      this.question='Every available request fits the current stock. Use Practice inventory to explore a shortage.';
    }catch{this.question='The inventory reader is unavailable. Retry the read or use Practice inventory.';this.retry=true;}
    finally{await this.status('');}
    this.offerPractice=true;
  }
  private async message(m:any) {
    if(['audioJoin','audioStart','voiceInputGrant','cancelDictation'].includes(m?.type))return;
    if(this.disposed || !this.webview || !await this.current())return;
    if(m.type==='ready'){await this.state();return;}
    if(m.type==='suggest'||m.type==='resolve'){
      if(typeof m.source!=='string'||!Number.isSafeInteger(m.offset)||m.source.length>12000)return;
      if(m.type==='suggest' && (m.language==='php'||m.language==='sql')){
        const tag=m.language==='php'&&!m.source.trimStart().startsWith('<?php')?'<?php\n':'';
        const items=await this.languageTools?.complete(vscode.Uri.file(join(this.root,this.lesson.file)),m.language,tag+m.source,m.offset+tag.length)??[];
        const result=items.map(item=>({...item,from:item.from! - tag.length,to:item.to! - tag.length}));
        await this.webview?.postMessage({type:'result',id:m.id,result});
        return;
      }
      const provider=this.jsx??=new StudioJsx(this.root);
      const result=m.type==='suggest'?provider.suggest(m.source,m.offset):await provider.resolve(m.ticket,m.source,m.offset);
      await this.webview?.postMessage({type:'result',id:m.id,result});return;
    }
    if(m.type==='draft'){
      if(m.draft===this.draft.id && Number.isSafeInteger(m.revision) && m.revision>this.draft.revision &&
        typeof m.source==='string' && m.source.length<=12000 && ['sql','php'].includes(m.language) &&
        (!m.example || (m.example===this.progress.example?.id && this.access.mode==='guided')))
        Object.assign(this.draft,{revision:m.revision,source:m.source,language:m.language,example:m.example});
      return;
    }
    if (m.type === 'voiceLanguage') {
      if (!this.busy && m.scope === this.voiceScope && typeof m.value === 'string' &&
          (m.value === 'auto' || Object.hasOwn(coachingLanguages, m.value))) {
        this.selectedVoiceLanguage = m.value;
        this.detectedLanguage = undefined;
      }
      await this.state();
      return;
    }
    if(this.busy)return;
    if ((m.type === 'ask' || m.type === 'predict') && this.selectedVoiceLanguage === 'auto' &&
        typeof m.spokenLanguage === 'string' && Object.hasOwn(coachingLanguages, m.spokenLanguage))
      this.detectedLanguage = m.spokenLanguage;
    this.busy=true;await this.webview?.postMessage({type:'busy',value:true});
    try {
      await this.status('');
      switch(m.type){
        case 'next': {
          const next=this.nextLesson;
          if(next)await this.moveTo(next.id);
          break;
        }
        case 'retry':
          await this.prediction();delete this.progress.spoken;break;
        case 'practice':
          if(!this.offerPractice)return;
          this.progress.practice=true;this.progress.prediction=undefined;this.progress.scenario=undefined;
          await this.prediction();delete this.progress.spoken;break;
        case 'terminal': {
          const live=await this.liveRun();vscode.window.createTerminal({name:'Equipment Desk',shellPath:live.bin,shellArgs:['exec','-it','--workdir','/course',live.container,'/bin/bash']}).show();break;
        }
        case 'predict':
          if(typeof m.prediction==='string'&&m.prediction.trim()&&this.lesson.id==='php')
            {this.progress.prediction=m.prediction.trim().slice(0,500);this.progress.scenario=this.scenario;this.progress.predicted=true;
              this.progress.history.push('Your prediction · '+this.progress.prediction);}
          break;
        case 'demo': await this.demonstrate();break;
        case 'run': await this.showApp();break;
        case 'ask':
          if(typeof m.message==='string'&&m.message.trim())await this.turn({message:m.message.slice(0,2000),attachments:Array.isArray(m.attachments)?m.attachments:[]});break;
        case 'assignment': await this.startRetry(this.access.lesson);return;
        case 'check': if(this.lesson.id==='php')await this.check();break;
        case 'runSnippet': await this.console(m);break;
        default:return;
      }
      await this.save();await this.state();
      if(m.type==='ask'||m.type==='predict')await this.webview?.postMessage({type:'accepted',draft:m.draft});
    } finally{this.busy=false;await this.webview?.postMessage({type:'busy',value:false});}
  }
  private async console(m:any) {
    const {language,source,execution}=m;
    const matches=()=>m.draft===this.draft.id && m.revision===this.draft.revision && source===this.draft.source && language===this.draft.language;
    if(!matches() || !['php','sql'].includes(language) || typeof source!=='string' ||
      source.length>12000 || typeof execution!=='string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(execution))return;
    const example=this.draft.example;
    const live=await this.liveRun();
    if(this.disposed || !await this.current() || !matches())return;
    const result=await live.snippet(language,source,execution);
    await this.webview?.postMessage({type:'console',execution:m.execution,result});
    const observation:Record<string,unknown>={run:live.id,execution:m.execution??randomUUID(),language,
      origin:example?'instructor':'learner',status:result.error?'error':'executed'};
    // Only an authored read can contribute values to the Instructor. Match its item
    // parameter, independently check the database and keep all other output local.
    const read=language==='sql'
      ? /^SELECT\s+available\s+FROM\s+items\s+WHERE\s+name\s*=\s*(['"])(?<item>Camera|Tripod)\1\s*;?$/i
      : /^(?:<\?php\s+)?\$camera\s*=\s*\\App\\Models\\Item::where\(\s*(?:'name'|"name")\s*,\s*(['"])(?<item>Camera|Tripod)\1\s*\)->firstOrFail\(\s*\)\s*;\s*return\s*\[\s*\$camera->available\s*,\s*get_debug_type\(\s*\$camera->available\s*\)\s*\]\s*;?\s*(?:\?>)?$/;
    const item=read.exec(source.trim())?.groups?.item;
    if(item && !result.error){
      const observed=(await live.inventory()).get(item);
      const verified=language==='sql'?JSON.stringify(result.columns)==='["available"]' &&
        JSON.stringify(result.rows)===JSON.stringify([[String(observed)]]):
        JSON.stringify(result.value)===JSON.stringify([observed,'int']);
      if(observed!==undefined&&verified)Object.assign(observation,{item,available:observed,...(language==='php'?{valueType:'int'}:{})});
    }
    if(result.error&&Number.isInteger(result.line))observation.line=result.line;
    await this.turn({console:observation});
  }
  private async turn(fields:{message?:string;attachments?:unknown[];console?:Record<string,unknown>;launch?:{kind:'live'|'practice';status:'failed'}}) {
    const reply=await this.service.studioTurn({attempt:this.access.id,lesson:this.access.lesson,turn:randomUUID(),...fields});
    if(!await this.current()||this.disposed)return;
    if(fields.message)this.progress.history.push('You · '+fields.message);
    this.addGuidance(reply.guidance);
    if(this.access.mode==='guided'&&reply.example)this.progress.example={...reply.example,id:randomUUID()};
  }
  private async demonstrate() {
    const patch=this.lesson.demonstration;
    if(!patch||this.access.mode!=='guided'||!this.hasPredicted||this.progress.demo)return;
    const openBuffers=()=>{
      const buffers=new Map<string,string>();
      for(const d of vscode.workspace.textDocuments){
        const name=ownFile(this.root,d.uri.fsPath);
        if(name&&d.isDirty)buffers.set(name,d.getText());
      }
      return buffers;
    };
    const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(join(this.root,this.lesson.file)));
    const version=doc.version,text=doc.getText(),index=text.indexOf(patch.before);
    if(index<0||index!==text.lastIndexOf(patch.before)||text.includes(patch.after))throw new Error('The demonstration no longer matches this method. Ask the mentor about your version.');
    const id=randomUUID();
    const expected=text.slice(0,index)+patch.after+text.slice(index+patch.before.length);
    const before=await snapshot(this.root,this.access.id,'Learner',openBuffers(),{id});
    if(doc.version!==version)throw new Error('Your file changed. Reopen the demonstration.');
    const editor=await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
    if(!await editor.edit(builder=>builder.replace(new vscode.Range(doc.positionAt(index),doc.positionAt(index+patch.before.length)),patch.after)))throw new Error('The edit could not be applied.');
    const after=await snapshot(this.root,this.access.id,'Instructor',openBuffers(),{id,before:before.commit,file:this.lesson.file,expected});
    this.progress.demo=before.commit+'..'+after.commit;this.addGuidance('The validated quantity is now a PHP integer. What will your checkout do with it?');
  }
  private async showApp() {
    await this.closing;
    if(this.preview){this.preview.reveal(vscode.ViewColumn.Two);return;}
    if(this.guided&&this.access.lesson==='php'&&!this.progress.prediction)throw new Error('Save your prediction before opening the checkout.');
    await this.saveFiles();
    const visible=vscode.window.visibleTextEditors.find(editor=>editor.viewColumn===vscode.ViewColumn.One && ownFile(this.root,editor.document.uri.fsPath));
    if(visible){
      const {anchor,active}=visible.selection;
      this.learnerPosition={file:relative(this.root,visible.document.uri.fsPath),anchor:[anchor.line,anchor.character],active:[active.line,active.character]};
    }
    this.progress.position=this.learnerPosition??this.progress.position;
    let run:StudioRun;
    await this.status(this.progress.practice?'Starting isolated Practice inventory…':'Starting Equipment Desk…');
    try {
      if(this.progress.practice){
        const revision=await snapshot(this.root,this.access.id,'Learner');
        this.experiment=run=await StudioRun.start(this.root,this.access.id,this.access.release.image,'practice',revision.commit,this.tempRoot,text=>{void this.status(text);});
      }else run=await this.liveRun(true);
    }catch(error){
      await this.turn({launch:{kind:this.progress.practice?'practice':'live',status:'failed'}});
      await this.save();await this.state();throw error;
    }
    if(this.disposed || !await this.current()){await run.close();return;}
    await this.status('');
    const name=run.kind==='practice'?'Practice inventory':'Equipment Desk';
    const panel=this.preview=vscode.window.createWebviewPanel('dhimantai.deskPreview',name,vscode.ViewColumn.Two,{enableScripts:true,retainContextWhenHidden:true});
    const nonce=randomUUID();
    panel.webview.html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src '+run.url+'; style-src \'unsafe-inline\'; script-src \'nonce-'+nonce+'\'"><style>'+shellStyle+'html,body{box-sizing:border-box;height:100%;margin:0}body{display:flex;flex-direction:column}header{display:flex;align-items:center;justify-content:space-between}iframe{flex:1;width:100%;border:0;background:white}</style></head><body><header><strong>'+name+'</strong><button id="back">Back to Project Mentor</button></header><iframe title="'+name+'" src="'+run.url+'" sandbox="allow-forms allow-scripts allow-same-origin"></iframe><script nonce="'+nonce+'">const api=acquireVsCodeApi();document.getElementById("back").onclick=()=>api.postMessage("back");</script></body></html>';
    panel.webview.onDidReceiveMessage(m=>{if(m==='back')panel.dispose();});
    panel.onDidDispose(()=>{this.preview=undefined;this.closing=this.back(run).catch(e=>{void this.status(String(e));}).finally(()=>{this.closing=undefined;});});
    // Keep the lesson mounted so returning from the preview also restores unsent edits.
    if (this.surface.native) await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
  }
  private async back(run:StudioRun) {
    try{
      const {prediction,scenario}=this.progress;
      const last=await run.evidence();
      // Compare a prediction only with the request it was about, even if the learner tried others after it.
      const matched=last&&prediction&&scenario?(await run.checkouts()).filter(e=>sameScenario(scenario,e)).at(-1):undefined;
      const event=matched??last;
      if(event && !this.disposed && await this.current()){
        if(this.progress.evidence?.request!==event.request || this.progress.evidence.run!==event.run) {
          this.progress.evidence=event;
          this.progress.pendingCheckout={lesson:this.access.lesson,
            ...(prediction&&scenario&&sameScenario(scenario,event)?{prediction:redactSecrets(prediction)}:{}),
            ...(prediction&&scenario&&!sameScenario(scenario,event)?{unmatched:scenario}:{})};
          await this.save();
        }
        if(await this.deliverCheckout())await this.prediction();
      }
    }finally{
      if(run===this.experiment){await run.close();this.experiment=undefined;}
      if(!this.disposed && this.surface.selected(this.render) && await this.current()){
        await this.save();await this.reveal(true);
        await vscode.commands.executeCommand('workbench.view.explorer');await this.openSource(this.progress.position);
      }
    }
  }
  /** Returns true when the checkout used up the learner's prediction, so a new one is needed. */
  private async deliverCheckout() {
    const {evidence,pendingCheckout}=this.progress;
    if(!evidence || pendingCheckout?.lesson!==this.access.lesson)return false;
    // The runtime request is a UUID. A retry can recover the reply already committed by the service.
    const reply=await this.service.studioTurn({attempt:this.access.id,lesson:pendingCheckout.lesson,turn:evidence.request,
      checkout:evidence,prediction:pendingCheckout.prediction});
    if(!await this.current() || this.disposed || pendingCheckout!==this.progress.pendingCheckout)return false;
    const other=pendingCheckout.unmatched;
    // A live checkout that changed the stock makes the predicted scenario impossible to run, so ask again.
    const stale=!!other && evidence.kind==='live' && evidence.after!==other.stock;
    const about=other?' Your prediction was about requesting '+other.quantity+' when '+other.stock+' '+other.item+' '+
      (other.stock===1?'was':'were')+' available':'';
    this.addGuidance(reply.guidance+(!other?'':stale?about+'. The stock has changed since, so make a new prediction for the current count.':
      about+', so it is still open. Run that request to test it.'));
    delete this.progress.pendingCheckout;
    const used=!!pendingCheckout.prediction||stale;
    if(used){delete this.progress.prediction;delete this.progress.scenario;}
    await this.save();
    return used;
  }
  private async check() {
    await this.saveFiles();
    const revision=await snapshot(this.root,this.access.id,'Learner');
    const run=await StudioRun.start(this.root,this.access.id,this.access.release.image,'check',revision.commit,this.tempRoot,text=>{void this.status(text);});
    try{
      const harness=await readFile(join(this.context.extensionPath,'media/build-studio/check.py'),'utf8');
      const {report,guidance}=await run.check(harness);
      if (this.disposed || !await this.current()) return;
      this.progress.check=report;
      this.progress.history.push('Project check · '+report);
      this.addGuidance(guidance);
      await this.save();
    }finally{await run.close();}
  }
  dispose(){
    if(!this.stopping)this.stopping=this.stop();
    return this.stopping;
  }
  private async stop(){
    this.disposed=true;this.surface.release(this.render);this.symbolRegistration?.dispose();this.positionListener.dispose();await this.preparing?.catch(()=>undefined);this.preview?.dispose();await this.closing;
    this.jsx?.dispose();await this.experiment?.close();await this.live?.close();
  }
}

interface DeskOptions {mode?:StudioMode;lesson?:LessonId;attempt?:string;fresh?:boolean}
interface SavedStudio {id:string; mode:StudioMode; lesson:LessonId; origin:LessonId; progress:Progress}
function studioScope(environment:EnvironmentName, account:string) {
  return createHash('sha256').update(environment+'\0'+account).digest('hex').slice(0,24);
}
export function registerBuildStudio(context:vscode.ExtensionContext,auth:Auth,environment:()=>EnvironmentName,service:()=>Environment,
    surface:CoachSurface, projects:ProjectCoach, browseProjects:()=>Promise<void>) {
  let active:StudioLesson|undefined;
  let opening=false;
  let pendingFolder:{uri:vscode.Uri; name:string}|undefined;
  const addPendingFolder=()=>{
    const folders=vscode.workspace.workspaceFolders;
    const requested=pendingFolder;
    if (!requested || !folders?.length) return;
    // VS Code accepts another folder update after confirming the previous one.
    if (folders.some(folder=>folder.uri.toString()===requested.uri.toString()) ||
        vscode.workspace.updateWorkspaceFolders(folders.length,0,requested)) pendingFolder=undefined;
  };
  const open=async (options:DeskOptions={})=>{
    if(opening)return;
    opening=true;
    try{
      const owner=(await auth.session()??await auth.signIn())?.user.id;
      if(!owner)return;
      const env=environment(), backend=service();
      const current=async()=>environment()===env&&(await auth.session())?.user.id===owner;
      const api=new Api(auth,()=>{if(environment()!==env)throw new Error('The learning service changed.');return backend;},owner);
      const scope=studioScope(env,owner);
      const recordsKey='buildStudio.'+scope;
      const records=context.globalState.get<SavedStudio[]>(recordsKey,[]);
      const mode=options.mode??'guided';
      const media=join(context.extensionPath,'media','build-studio');
      const definition:StudioDefinition=JSON.parse(await readFile(join(media,'entries.json'),'utf8'));
      let saved=options.attempt?records.find(r=>r.id===options.attempt):undefined;
      if(options.attempt && !saved)throw new Error('This saved attempt belongs to a different learning account or service.');
      if(!options.attempt && !options.fresh){
        const matches=records.filter(r=>r.mode===mode&&(!options.lesson||r.lesson===options.lesson));
        if(mode==='guided')saved=matches[0]??records.find(r=>r.mode==='guided');
        else if(matches.length){
          const choice=await vscode.window.showQuickPick([
            ...matches.map(record=>({label:'Resume assignment · '+(definition.entries.find(e=>e.id===record.lesson)?.title??record.lesson),
              description:record.id.slice(0,8),record})),{label:'Start a new assignment',description:'Fresh inventory',record:undefined}
          ],{title:'Equipment Desk'});
          if(!choice)return;
          saved=choice.record;
        }
      }
      const lesson=options.lesson??saved?.lesson??'request';
      if(active && saved?.id===active.attemptId && await active.isCurrent())return await active.selectChapter(lesson);
      const access=await api.studioEntry(lesson,saved?.mode??mode,saved?.id);
      if(!await current())return;
      const entry=definition.entries.find(e=>e.id===access.entry);
      if(!entry || access.release.version!==definition.version || entry.commit!==access.release.checkpoints[entry.checkpoint] ||
         !/^[a-f\d-]{36}$/.test(access.id))throw new Error('The published starter and desktop bundle differ. Update the course bundle first.');
      const base=join(context.globalStorageUri.fsPath,'build-studio',scope);
      await mkdir(base,{recursive:true});
      const root=join(base,access.id);
      if(!(await stat(root).catch(()=>undefined))){
        const temp=await mkdtemp(join(base,'clone-'));
        try{
          await cloneCapstone(join(media,entry.checkpoint+'.bundle'),join(temp,'desk'));
          const head=(await exec('git',['rev-parse','HEAD'],{cwd:join(temp,'desk')})).stdout.trim();
          if(head!==entry.commit)throw new Error('The starter failed its checkpoint verification.');
          await rename(join(temp,'desk'),root);
        }finally{await rm(temp,{recursive:true,force:true});}
      }
      if(!await current())return;
      const persist=async(progress:Progress,a:StudioAccess)=>{
        if(!await current())return;
        const list=context.globalState.get<SavedStudio[]>(recordsKey,[]).filter(r=>r.id!==a.id);
        list.unshift({id:a.id,origin:a.entry,lesson:a.lesson,mode:a.mode,progress});
        await context.globalState.update(recordsKey,list);
      };
      const progress=saved?chapterProgress(saved.progress,saved.lesson,access.lesson):{history:[]};await persist(progress,access);
      await active?.dispose();active=undefined;
      // In an empty window opening the first workspace folder restarts the extension host.
      // Persist the server attempt first; activation resumes that specific clone.
      if(!vscode.workspace.workspaceFolders?.length){
        await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(root),false);return;
      }
      pendingFolder={uri:vscode.Uri.file(root),name:'Equipment Desk · '+(access.mode==='guided'?'Guided':'Assignment')+' · '+access.id.slice(0,8)};
      addPendingFolder();
      active=new StudioLesson(context,root,base,access,definition,api,progress,persist,
        lesson=>open({mode:'independent',lesson,fresh:true}),current,{
          account:owner, environment:env, dictation:api,
          playback:new CoachAudio(context.secrets, () => {
            if(environment() !== env) throw new Error('The learning service changed.');
            return backend;
          })
        }, surface);
      await vscode.commands.executeCommand('workbench.view.explorer');
      await active.open();
    }catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'Could not open Equipment Desk.');}
    finally{opening=false;}
  };
  const deskStorage = join(context.globalStorageUri.fsPath, 'build-studio');
  const openRoot = async (root:string, restoring = false) => {
    const path = relative(deskStorage, root);
    if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) {
      return projects.open(root, restoring);
    }
    const [scope, attempt, ...rest] = path.split(sep);
    const owner = (await auth.session())?.user.id;
    if (!owner || scope !== studioScope(environment(), owner) || !/^[a-f\d-]{36}$/.test(attempt ?? '') || rest.length) {
      void vscode.window.showInformationMessage('Sign in with the account and service that own this Project Mentor attempt.');
      return;
    }
    if (active?.root === root && await active.isCurrent()) return active.resume();
    return open({attempt});
  };
  const folders = () => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
  const folderFor = (uri:vscode.Uri) => {
    if (active && uri.scheme==='file' && (uri.fsPath===active.root || ownFile(active.root,uri.fsPath))) return active.root;
    return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  };
  const editorRoot = () => {
    const uri = vscode.window.activeTextEditor?.document.uri ?? vscode.window.activeNotebookEditor?.notebook.uri;
    return uri && folderFor(uri);
  };
  const launch = async (target?:string | vscode.Uri | ({project:'equipment-desk'} & DeskOptions)) => {
    if (target && typeof target === 'object' && 'project' in target && target.project === 'equipment-desk') return open(target);
    if (target instanceof vscode.Uri) {
      const root=folderFor(target);
      if (root) return openRoot(root);
      void vscode.window.showInformationMessage('Open this file’s project folder to use Project Mentor.');
      return;
    }
    let root = typeof target === 'string' ? target : editorRoot();
    if (!root) {
      const available = folders();
      if (!available.length) return browseProjects();
      root = available.length === 1 ? available[0].uri.fsPath : (await vscode.window.showQuickPick(
        available.map(f => ({label:f.name, root:f.uri.fsPath})), {placeHolder:'Choose a project for Project Mentor'}))?.root;
    }
    if (root) await openRoot(root);
  };
  const restore = async () => {
    const roots = new Set([editorRoot(), ...folders().map(f => f.uri.fsPath)]);
    for (const root of roots) if (root && (ownFile(deskStorage, root) || await projects.canRestore(root))) {
      await openRoot(root, true);
      break;
    }
  };
  let lastTab:vscode.Tab | undefined;
  const followTab = () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!active || tab === lastTab || opening) return;
    lastTab = tab;
    const input = tab?.input;
    if (input instanceof vscode.TabInputWebview && (input.viewType.endsWith('dhimantai.buildStudio') || input.viewType.endsWith('dhimantai.deskPreview'))) return;
    if (input instanceof vscode.TabInputText && input.uri.scheme === 'file' && ownFile(active.root,input.uri.fsPath)) {
      void active.reveal(true);
    } else {
      void active.hide();
    }
  };
  const menuTarget = async (uri:vscode.Uri) => {
    const root=folderFor(uri);
    if (root && ownFile(deskStorage,root)) return {project:() => openRoot(root)};
    return projects.menuTarget(uri);
  };
  const registrations = [
    vscode.workspace.onDidChangeWorkspaceFolders(addPendingFolder),
    vscode.window.tabGroups.onDidChangeTabs(followTab),
    vscode.window.tabGroups.onDidChangeTabGroups(followTab),
    vscode.commands.registerCommand('dhimantai.openProjectMentor', launch),
    // Keep old keybindings and links usable without a second command-palette entry.
    vscode.commands.registerCommand('dhimantai.openBuildStudio', launch),
    vscode.commands.registerCommand('dhimantai.openProjectCoach', launch),
    vscode.commands.registerCommand('dhimantai.equipmentDesk', open),
  ];
  const stop=async()=>{const previous=active;active=undefined;pendingFolder=undefined;await previous?.dispose();};
  const refresh=async()=>{const lesson=active;if(lesson && !await lesson.isCurrent() && active===lesson)await stop();};
  const account=auth.onDidChange(()=>void refresh());
  const environmentChange=vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('dhimantai.environment'))void refresh();});
  return {stop,restore,menuTarget,onMenuChange:projects.onMenuChange,dispose(){registrations.forEach(d=>d.dispose());account.dispose();environmentChange.dispose();void stop();}};
}
