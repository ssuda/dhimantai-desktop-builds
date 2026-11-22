import {activateCourseTools} from './courseEditorTools';
import {run as runInContainer} from './podman';
import type {CellSuggestion} from './studioJsx';
import {CoachAudio, audioPolicy, instructorComposer} from './coachAudio';
import {bindDictation} from './dictation';
import * as vscode from 'vscode';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, stat, rename, mkdtemp, rm} from 'node:fs/promises';
import {join, relative, isAbsolute, sep} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {StudioJsx} from './studioJsx';
import {StudioRun, snapshot, type CheckoutEvidence} from './studioRuntime';
import type {StudioAccess,StudioReply,StudioEntry,StudioDefinition,LessonId,StudioMode} from './studioTypes';
import {Api} from './api';
import {Auth} from './auth';
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
  dictation: Pick<Api, 'dictate'>;
  account: string;
  environment: EnvironmentName;
}
interface Progress {history:string[]; spoken?:{lesson:LessonId; index:number}; prediction?:string; scenario?:Scenario; predicted?:boolean;
  practice?:boolean; demo?:string; example?:Example; evidence?:CheckoutEvidence;
  pendingCheckout?:{lesson:LessonId;prediction?:string;unmatched?:Scenario}; position?:Position; check?:string}
export interface StudioService {
  studioEntry(lesson:LessonId,mode:StudioMode,attempt?:string):Promise<StudioAccess>;
  studioTurn(body:object):Promise<StudioReply>;
}

const shellStyle='body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:14px}h1{font-size:1.4em}section,details,fieldset{margin:1em 0}button,textarea,input,select{font:inherit}button{padding:.4em .65em;margin:.25em .35em .25em 0;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}button:disabled{opacity:.65}textarea,input,select{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:.4em}textarea,input{width:100%}label{display:block}pre{white-space:pre-wrap}summary{cursor:pointer}';
const button=(id:string,label:string,action=id)=>'<button id="'+id+'" data-action="'+action+'">'+label+'</button>';
const ownFile=(root:string,file:string)=>{const name=relative(root,file);return name&&!name.startsWith('..'+sep)&&!isAbsolute(name)?name:undefined;};

export class StudioLesson {
  private panel?:vscode.WebviewPanel;
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
  private scenario?:Scenario;
  private offerPractice=false;
  private retry=false;
  private readonly draft:{id:string;revision:number;language:string;source:string;example?:string}={id:randomUUID(),revision:0,language:'php',source:''};
  private learnerPosition?:Position;
  private positionListener:vscode.Disposable;
  constructor(private context:vscode.ExtensionContext,readonly root:string,private tempRoot:string,
      private access:StudioAccess,private definition:StudioDefinition,private service:StudioService,
      private progress:Progress,private persist:(p:Progress,a:StudioAccess)=>Promise<void>,
      private startRetry:(lesson:LessonId)=>Promise<void>,private current:()=>Promise<boolean>, private voice:StudioVoice) {
    this.positionListener=vscode.window.onDidChangeTextEditorSelection(e=>{
      const file=ownFile(this.root,e.textEditor.document.uri.fsPath); if(!file)return;
      const s=e.textEditor.selection;this.learnerPosition={file,anchor:[s.anchor.line,s.anchor.character],active:[s.active.line,s.active.character]};
    });
  }
  isCurrent(){return this.current();}
  private get lesson() {return this.definition.entries.find(e=>e.id===this.access.lesson)!;}
  private save(){return this.persist(this.progress,this.access);}
  async open(focus=true) {
    if(this.panel){this.panel.reveal(vscode.ViewColumn.Two);return;}
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
    if(focus) await this.openSource(this.progress.position);
    const panel=this.panel=vscode.window.createWebviewPanel('dhimantai.buildStudio','Instructor · Equipment Desk',vscode.ViewColumn.Two,
      {enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]});
    panel.onDidDispose(()=>{this.panel=undefined;void this.dispose();});
    panel.webview.onDidReceiveMessage(m=>void this.message(m).catch(e=>this.status(e instanceof Error?e.message:'The project action failed.')));
    const media = vscode.Uri.joinPath(this.context.extensionUri,'media');
    const asset = (name:string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media,name));
    const nonce=randomUUID();
    const voiceAvailable = () => panel.visible && !this.disposed && this.panel === panel;
    const playback = this.voice.playback.bind(panel.webview, () => voiceAvailable() ? this.spokenReply() : undefined);
    const dictation = bindDictation(panel.webview, () => voiceAvailable() && !this.busy
      ? {key:this.voiceScope, api:this.voice.dictation, language:'auto'} : undefined);
    panel.onDidDispose(() => { playback.dispose(); dictation.dispose(); });
    panel.onDidChangeViewState(() => {
      if (!panel.visible) void panel.webview.postMessage({type:'audioOff'});
    });
    const composer=instructorComposer(panel.webview,media,nonce,{maxlength:2000,support:
      '<label id="replyKind" hidden>Reply as <select id="replyType"><option value="predict">My prediction</option><option value="ask">A question</option></select></label>'});
    panel.webview.html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src '+panel.webview.cspSource+' \'unsafe-inline\'; img-src data: blob:; media-src blob:; connect-src '+audioPolicy+'; script-src \'nonce-'+nonce+'\' '+panel.webview.cspSource+'"><style>'+shellStyle+
      'body{display:flex;flex-direction:column;height:100vh;box-sizing:border-box;margin:0;gap:8px}.lesson-scroll{flex:1;min-height:0;overflow:auto}#replyKind{margin-bottom:6px} [hidden]{display:none!important}</style><link rel="stylesheet" href="'+asset('learning-room/composer.css')+'"><link rel="stylesheet" href="'+asset('build-studio/buildStudio.css')+'"></head><body><main class="lesson-scroll">'+
      '<h1 id="title"></h1><p id="concept"></p><p id="task"></p><p id="question"></p>'+
      button('practice','Practice inventory')+button('retry','Retry inventory')+
      button('run','Run App')+button('next','Continue')+button('check','Check my work')+
      '<section id="history" role="log" aria-live="polite"></section><details id="tools"><summary>Project tools</summary>'+
      button('demo','Show me in the file')+button('terminal','Open project terminal')+button('assignment','Retry independently','assignment')+'</details>'+
      '<details id="consoleBox"><summary>Project Console</summary><label id="originChoice" hidden>Snippet <select id="origin"><option value="example">Instructor example</option><option value="own">My snippet</option></select></label>'+
      '<div id="projectCell"></div></details><p id="status" role="status"></p></main>'+
      composer+'<script nonce="'+nonce+'" src="'+asset('build-studio/buildStudio.js')+'"></script></body></html>';
    // Prepare the active learner runtime on lesson entry. Completion only reads its metadata.
    if(this.access.lesson==='php') await this.prediction();
    else await this.liveRun();
    await this.state();
    if(this.progress.pendingCheckout?.lesson===this.access.lesson){
      if(await this.deliverCheckout())await this.prediction();
      await this.state();
    }
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
    const text = line?.startsWith(prefix) ? line.slice(prefix.length) : this.question || this.lesson.task;
    const id = createHash('sha256').update(JSON.stringify([this.voiceScope, line ? spoken?.index : null, text])).digest('hex');
    return {id, text, account:this.voice.account, environment:this.voice.environment,
      path:'/notebook-coach/project/equipment-desk',
      query:'?' + new URLSearchParams({attempt:this.access.id, lesson:this.access.lesson})};
  }

  private addGuidance(text:string) {
    this.progress.spoken = {lesson:this.access.lesson, index:this.progress.history.length};
    this.progress.history.push('Instructor · '+text);
  }

  private async state() {
    const e=this.lesson;
    await this.panel?.webview.postMessage({type:'state',voiceScope:this.voiceScope,audioId:this.spokenReply().id,title:e.title,concept:e.concept,task:e.task,question:this.question,
      next:e.id==='request',guided:this.access.mode==='guided',demo:e.demonstration&&this.access.mode==='guided'&&this.hasPredicted&&!this.progress.demo,
      predict:e.id==='php'&&!!this.question&&(this.progress.practice||!this.offerPractice),offerPractice:this.offerPractice&&!this.progress.practice,
      retry:this.retry,draft:this.draft.id,draftRevision:this.draft.revision,attemptLabel:this.access.id.slice(0,8),...this.progress});
  }
  /** A prediction is used up by the checkout it was about. The demonstration stays unlocked. */
  private get hasPredicted(){return !!(this.progress.predicted||this.progress.prediction);}
  private status(text:string){return this.panel?.webview.postMessage({type:'status',text});}
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
    return StudioRun.start(this.root,this.access.id,this.access.release.image,'live',commit,this.tempRoot);
  }
  private async prediction() {
    this.retry=false;this.offerPractice=false;this.scenario=undefined;
    if(this.progress.practice){
      this.scenario={item:'Camera',stock:1,quantity:2};
      this.question='Practice inventory has one camera. Someone asks for two. What happens to the request and the inventory?';return;
    }
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
    this.offerPractice=true;
  }
  private async message(m:any) {
    if(['audioJoin','audioStart','dictate','cancelDictation'].includes(m?.type))return;
    if(this.disposed || !this.panel || !await this.current())return;
    if(m.type==='ready'){await this.state();return;}
    if(m.type==='suggest'||m.type==='resolve'){
      if(typeof m.source!=='string'||!Number.isSafeInteger(m.offset)||m.source.length>12000)return;
      if(m.type==='suggest' && (m.language==='php'||m.language==='sql')){
        const tag=m.language==='php'&&!m.source.trimStart().startsWith('<?php')?'<?php\n':'';
        const items=await this.languageTools?.complete(vscode.Uri.file(join(this.root,this.lesson.file)),m.language,tag+m.source,m.offset+tag.length)??[];
        const result=items.map(item=>({...item,from:item.from! - tag.length,to:item.to! - tag.length}));
        await this.panel.webview.postMessage({type:'result',id:m.id,result});
        return;
      }
      const provider=this.jsx??=new StudioJsx(this.root);
      const result=m.type==='suggest'?provider.suggest(m.source,m.offset):await provider.resolve(m.ticket,m.source,m.offset);
      await this.panel.webview.postMessage({type:'result',id:m.id,result});return;
    }
    if(m.type==='draft'){
      if(m.draft===this.draft.id && Number.isSafeInteger(m.revision) && m.revision>this.draft.revision &&
        typeof m.source==='string' && m.source.length<=12000 && ['sql','php'].includes(m.language) &&
        (!m.example || (m.example===this.progress.example?.id && this.access.mode==='guided')))
        Object.assign(this.draft,{revision:m.revision,source:m.source,language:m.language,example:m.example});
      return;
    }
    if(this.busy)return;
    this.busy=true;await this.panel.webview.postMessage({type:'busy',value:true});
    try {
      await this.status('');
      switch(m.type){
        case 'next': {
          if(this.lesson.id!=='request')return;
          await this.closing;
          await this.deliverCheckout();
          this.access=await this.service.studioEntry('php',this.access.mode,this.access.id);
          this.progress.position=undefined;await this.save();await this.openSource();await this.prediction();break;
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
        case 'check': await this.check();break;
        case 'runSnippet': await this.console(m);break;
        default:return;
      }
      await this.save();await this.state();
      if(m.type==='ask'||m.type==='predict')await this.panel?.webview.postMessage({type:'accepted',draft:m.draft});
    } finally{this.busy=false;await this.panel?.webview.postMessage({type:'busy',value:false});}
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
    await this.panel?.webview.postMessage({type:'console',execution:m.execution,result});
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
    if(index<0||index!==text.lastIndexOf(patch.before)||text.includes(patch.after))throw new Error('The demonstration no longer matches this method. Ask the Instructor about your version.');
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
    if(this.access.lesson==='php'&&!this.progress.prediction)throw new Error('Save your prediction before opening the checkout.');
    await this.saveFiles();
    const visible=vscode.window.visibleTextEditors.find(editor=>editor.viewColumn===vscode.ViewColumn.One && ownFile(this.root,editor.document.uri.fsPath));
    if(visible){
      const {anchor,active}=visible.selection;
      this.learnerPosition={file:relative(this.root,visible.document.uri.fsPath),anchor:[anchor.line,anchor.character],active:[active.line,active.character]};
    }
    this.progress.position=this.learnerPosition??this.progress.position;
    let run:StudioRun;
    try {
      if(this.progress.practice){
        const revision=await snapshot(this.root,this.access.id,'Learner');
        this.experiment=run=await StudioRun.start(this.root,this.access.id,this.access.release.image,'practice',revision.commit,this.tempRoot);
      }else run=await this.liveRun(true);
    }catch(error){
      await this.turn({launch:{kind:this.progress.practice?'practice':'live',status:'failed'}});
      await this.save();await this.state();throw error;
    }
    if(this.disposed || !await this.current()){await run.close();return;}
    const name=run.kind==='practice'?'Practice inventory':'Equipment Desk';
    const panel=this.preview=vscode.window.createWebviewPanel('dhimantai.deskPreview',name,vscode.ViewColumn.Two,{enableScripts:true,retainContextWhenHidden:true});
    const nonce=randomUUID();
    panel.webview.html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src '+run.url+'; style-src \'unsafe-inline\'; script-src \'nonce-'+nonce+'\'"><style>'+shellStyle+'html,body{box-sizing:border-box;height:100%;margin:0}body{display:flex;flex-direction:column}header{display:flex;align-items:center;justify-content:space-between}iframe{flex:1;width:100%;border:0;background:white}</style></head><body><header><strong>'+name+'</strong><button id="back">Back to Instructor</button></header><iframe title="'+name+'" src="'+run.url+'" sandbox="allow-forms allow-scripts allow-same-origin"></iframe><script nonce="'+nonce+'">const api=acquireVsCodeApi();document.getElementById("back").onclick=()=>api.postMessage("back");</script></body></html>';
    panel.webview.onDidReceiveMessage(m=>{if(m==='back')panel.dispose();});
    panel.onDidDispose(()=>{this.preview=undefined;this.closing=this.back(run).catch(e=>{void this.status(String(e));}).finally(()=>{this.closing=undefined;});});
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
      if(!this.disposed && await this.current()){
        await this.save();this.panel?.reveal(vscode.ViewColumn.Two,true);await this.state();
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
    const run=await StudioRun.start(this.root,this.access.id,this.access.release.image,'check',revision.commit,this.tempRoot);
    try{
      const harness=await readFile(join(this.context.extensionPath,'media/build-studio/check.py'),'utf8');
      const report=await run.check(harness);this.progress.check=report;
      this.progress.history.push('Project check · '+report);
    }finally{await run.close();}
  }
  dispose(){
    if(!this.stopping)this.stopping=this.stop();
    return this.stopping;
  }
  private async stop(){
    this.disposed=true;this.symbolRegistration?.dispose();this.positionListener.dispose();await this.preparing?.catch(()=>undefined);this.preview?.dispose();await this.closing;
    this.panel?.dispose();this.jsx?.dispose();await this.experiment?.close();await this.live?.close();
  }
}

interface SavedStudio {id:string; mode:StudioMode; lesson:LessonId; origin:LessonId; progress:Progress}
export function registerBuildStudio(context:vscode.ExtensionContext,auth:Auth,environment:()=>EnvironmentName,service:()=>Environment) {
  let active:StudioLesson|undefined;
  let opening=false;
  const open=async (options:{mode?:StudioMode;lesson?:LessonId;attempt?:string;fresh?:boolean}={})=>{
    if(opening)return;
    opening=true;
    try{
      const owner=(await auth.session()??await auth.signIn())?.user.id;
      if(!owner)return;
      const env=environment(), backend=service();
      const current=async()=>environment()===env&&(await auth.session())?.user.id===owner;
      const api=new Api(auth,()=>{if(environment()!==env)throw new Error('The learning service changed.');return backend;},owner);
      const scope=createHash('sha256').update(env+'\0'+owner).digest('hex').slice(0,24);
      const recordsKey='buildStudio.'+scope;
      const records=context.globalState.get<SavedStudio[]>(recordsKey,[]);
      const mode=options.mode??'guided';
      let saved=options.attempt?records.find(r=>r.id===options.attempt):undefined;
      if(options.attempt && !saved)throw new Error('This saved attempt belongs to a different learning account or service.');
      if(!options.attempt && !options.fresh){
        const matches=records.filter(r=>r.mode===mode&&(!options.lesson||r.lesson===options.lesson));
        if(mode==='guided')saved=matches[0];
        else if(matches.length){
          const choice=await vscode.window.showQuickPick([
            ...matches.map(record=>({label:'Resume assignment · '+(record.lesson==='php'?'Model stock in PHP':'Follow a checkout'),
              description:record.id.slice(0,8),record})),{label:'Start a new assignment',description:'Fresh inventory',record:undefined}
          ],{title:'Equipment Desk'});
          if(!choice)return;
          saved=choice.record;
        }
      }
      const lesson=options.lesson??saved?.lesson??'request';
      const access=await api.studioEntry(lesson,saved?.mode??mode,saved?.id);
      if(!await current())return;
      const media=join(context.extensionPath,'media','build-studio');
      const definition:StudioDefinition=JSON.parse(await readFile(join(media,'entries.json'),'utf8'));
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
      const progress=saved?.progress??{history:[]};await persist(progress,access);
      await active?.dispose();active=undefined;
      // In an empty window opening the first workspace folder restarts the extension host.
      // Persist the server attempt first; activation resumes that specific clone.
      if(!vscode.workspace.workspaceFolders?.length){
        await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(root),false);return;
      }
      if(!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))){
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length,0,{uri:vscode.Uri.file(root),name:'Equipment Desk'});
      }
      active=new StudioLesson(context,root,base,access,definition,api,progress,persist,
        lesson=>open({mode:'independent',lesson,fresh:true}),current,{
          account:owner, environment:env, dictation:api,
          playback:new CoachAudio(context.secrets, () => {
            if(environment() !== env) throw new Error('The learning service changed.');
            return backend;
          })
        });
      await vscode.commands.executeCommand('workbench.view.explorer');
      await active.open();
    }catch(error){void vscode.window.showErrorMessage(error instanceof Error?error.message:'Could not open Equipment Desk.');}
    finally{opening=false;}
  };
  const registration=vscode.commands.registerCommand('dhimantai.equipmentDesk',open);
  const root=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if(root && ownFile(join(context.globalStorageUri.fsPath,'build-studio'),root))
    void open({attempt:root.split(sep).at(-1)});
  const stop=async()=>{const previous=active;active=undefined;await previous?.dispose();};
  const refresh=async()=>{const lesson=active;if(lesson && !await lesson.isCurrent() && active===lesson)await stop();};
  const account=auth.onDidChange(()=>void refresh());
  const environmentChange=vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('dhimantai.environment'))void refresh();});
  return {stop,dispose(){registration.dispose();account.dispose();environmentChange.dispose();void stop();}};
}
