import {BrowserQuestion,validBrowserQuestion,validBrowserAnswer} from './browserQuestion';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {EnvironmentName} from './environments';
import type {BusinessShift} from './erpShift';
import {BrowserDemonstration,DemonstrationResult,validDemonstration,validDemonstrationResult} from './browserDemonstration';
import {resolveTask} from './apps/verifier';
import {browserCourseProgress, BrowserCourseProgress, ERP_COURSE} from './browserCourseProgress';
export {ERP_COURSE} from './browserCourseProgress';

/** Guided ERPNext tasks in the bundled course. */
export const ERP_TASK_TOTAL = 18;
export interface BrowserTask {id:string; doctype:string; instructorChapter:string; steps:{field:string; value:unknown}[];
  title?:string; scenario?:string; readOnly?:boolean; guidance?:string}
export interface BrowserObservation {
  sequence:number; course:string; task:string; step:number; training_tag:string;
  route:string; doctype:string; record:string; dirty:boolean; docstatus:number|null;
  fields:Record<string,unknown>; errors:string[];
  action:'view'|'edit'|'check'|'help'|'save'|'next'; result:'matched'|'mismatch'|'not_saved'|null;
  shift?: {id:'first-business-shift'; snapshot:string; failures:number; helpRequests:number; support:'brief'|'evidence'|'navigation'; completed:string[]};
}
export interface BrowserUpdate {account:string; environment:EnvironmentName; chapter:string; observation:BrowserObservation|null; progress?:BrowserCourseProgress; help?:string; question?:BrowserQuestion|null; taskStatus?:string; focusQuestion?:string; reconnect?:boolean; brief?:{id:string; title:string; text:string}}
/** A task whose saved record matched; explained once the learner has also explained their decision. */
export interface VerifiedTask {record:string; checkedAt:string; assisted:boolean; explained:boolean}
interface Scope {origin:string; account:string; environment:EnvironmentName; learner:string; tasks:BrowserTask[]; current:()=>Promise<boolean>;
  /** The practical course these tasks belong to; ERPNext Essentials when omitted. */
  course?:{id:string; title:string; /** Replaces the closing statement's title; {{company}} is the learner's company. */ finale?:string; shift?:BusinessShift};
  handover?:()=>{text:string; recorded:string; at:string}|undefined;
  recordHandover?:(text:string,recorded:string)=>Promise<boolean>;
  recordAction?:(action:BrowserDemonstration,result:DemonstrationResult)=>void;
  /** The learner's own training login, handed only to the launch page on the training origin. */
  signIn?:{usr:string; pwd:string};
  verified?:()=>Record<string,VerifiedTask>;
  /** Records a claim only after the desktop has re-checked it; false means the record did not verify. */
  recordVerified?:(task:string,done:VerifiedTask)=>Promise<boolean|void>}
const object = (x:unknown):x is Record<string,any> => !!x && typeof x==='object' && !Array.isArray(x);
const text = (x:unknown,n:number):x is string => typeof x==='string' && x.length<=n;
const scalar = (x:unknown) => x===null || typeof x==='boolean' || typeof x==='number' && Number.isFinite(x) || text(x,600);

/** Only authored training fields can leave the ERPNext page; never arbitrary DOM, cookies or passwords. */
export function browserObservation(raw:unknown,tasks:BrowserTask[],course='erpnext-essentials'):BrowserObservation|undefined {
  if(!object(raw) || Object.keys(raw).sort().join(',')!==['sequence','course','task','step','training_tag','route','doctype','record','dirty','docstatus','fields','errors','action','result',...(raw.shift===undefined?[]:['shift'])].sort().join(','))return;
  const task=tasks.find(t=>t.id===raw.task);
  if(!task || raw.course!==course || !Number.isSafeInteger(raw.sequence) || raw.sequence<1
      || !Number.isInteger(raw.step) || raw.step<0 || raw.step>=task.steps.length
      || !/^[a-f0-9]{10}$/.test(raw.training_tag) || !text(raw.route,300) || !text(raw.doctype,80) || !text(raw.record,160) || typeof raw.dirty!=='boolean'
      || ![null,0,1,2].includes(raw.docstatus) || !['view','edit','check','help','save','next'].includes(raw.action)
      || ![null,'matched','mismatch','not_saved'].includes(raw.result) || !object(raw.fields)
      || !Array.isArray(raw.errors) || raw.errors.length>3 || !raw.errors.every((v:unknown)=>text(v,500)))return;
  if(raw.shift!==undefined) {
    const s=raw.shift;
    if(course!=='erpnext-essentials' || !object(s) || Object.keys(s).sort().join(',')!=='completed,failures,helpRequests,id,snapshot,support'
      || s.id!=='first-business-shift' || !['stock','payables','delivery','receivables'].includes(raw.task)
      || typeof s.snapshot!=='string' || !/^[a-f0-9]{32}$/.test(s.snapshot)
      || ![s.failures,s.helpRequests].every(n=>Number.isInteger(n)&&n>=0&&n<=99)
      || !['brief','evidence','navigation'].includes(s.support) || !Array.isArray(s.completed) || s.completed.length>4
      || new Set(s.completed).size!==s.completed.length || !s.completed.every(id=>['stock','payables','delivery','receivables'].includes(id)))return;
  }
  for(const [name,value] of Object.entries(raw.fields)) {
    const field=task.steps.find(s=>s.field===name);
    if(!field)return;
    if(Array.isArray(field.value)) {
      const keys=new Set(field.value.flatMap(row=>object(row)?Object.keys(row):[]));
      if(!Array.isArray(value) || value.length>10 || !value.every(row=>object(row) && Object.entries(row).every(([k,v])=>keys.has(k)&&scalar(v))))return;
    } else if(!scalar(value))return;
  }
  return raw as BrowserObservation;
}

/** Loopback-only transport between our ERPNext image and the existing Instructor webview. */
export class BrowserLearning {
  private server?:Server;
  private scope?:Scope;
  private token='';
  private port=0;
  private sequence=0;
  private update?:BrowserUpdate;
  private question:BrowserQuestion|null=null;
  private answer?:{id:string; answer:string};
  private taskAction?:{id:string; task:string; kind?:'open'};
  private taskStatus='';
  private demonstration?:{command:BrowserDemonstration&{expiresAt:number};finish:(result:DemonstrationResult)=>void};
  private demonstrations=new Map<string,Promise<DemonstrationResult>>();
  private connection={connected:false,detail:'Open Instructor to begin live help.'};
  private events=new EventEmitter();
  onUpdate(listener:(event:BrowserUpdate)=>void) {this.events.on('update',listener);return {dispose:()=>this.events.off('update',listener)};}
  latest(account:string,environment:EnvironmentName) {return this.update?.account===account && this.update.environment===environment?this.update:undefined;}
  progress(account:string,environment:EnvironmentName) {
    const scope=this.scope;
    return scope?.account===account && scope.environment===environment
      ? browserCourseProgress(scope.tasks,scope.verified?.()??{}) : undefined;
  }
  async demonstrate(account:string,environment:EnvironmentName,request:unknown):Promise<DemonstrationResult> {
    const reject=(message:string):DemonstrationResult=>({status:'rejected',message});
    const scope=this.scope;
    if(!scope||scope.account!==account||scope.environment!==environment||!scope.course?.shift||!validDemonstration(request))return reject('No active business shift for this action.');
    if(!await scope.current()||this.scope!==scope)return reject('The training account changed.');
    const previous=this.demonstrations.get(request.id);if(previous)return previous;
    if(this.demonstrations.size>=64)return reject('The demonstration budget for this launch is exhausted. Reopen the shift to continue.');
    const observed=this.update?.observation;
    if(this.demonstration||this.taskAction||!this.connection.connected||observed?.task!==request.task||observed.shift?.snapshot!==request.snapshot)
      return reject('The current form or connection changed. Use the latest observation.');
    let complete!:(result:DemonstrationResult)=>void;
    const promise=new Promise<DemonstrationResult>(resolve=>{complete=resolve;});
    this.demonstrations.set(request.id,promise);
    const started=Date.now();
    const timer=setTimeout(()=>finish({status:'uncertain',message:'The demonstration timed out. Inspect the form; the action will not be retried automatically.'}),10000);
    const finish=(result:DemonstrationResult)=>{
      if(this.demonstration?.command.id!==request.id)return;
      clearTimeout(timer);this.demonstration=undefined;
      const measured={...result,duration_ms:Date.now()-started};
      try{scope.recordAction?.(request,measured);}catch{}
      complete(measured);
    };
    this.demonstration={command:{...request,expiresAt:started+8500},finish};
    return promise;
  }
  async answerQuestion(account:string,environment:EnvironmentName,id:string,answer:unknown) {
    const scope=this.scope, question=this.question;
    if(!scope || scope.account!==account || scope.environment!==environment || question?.id!==id
      || !validBrowserAnswer(question,answer) || !await scope.current() || this.scope!==scope || this.question?.id!==id)return false;
    // The webview calls this only after the existing Instructor transport accepts the learner's answer.
    this.answer={id,answer};return true;
  }
  async continueTask(account:string,environment:EnvironmentName,task:string) {
    const scope=this.scope;
    if(!scope || this.demonstration || scope.account!==account || scope.environment!==environment || this.update?.observation?.task!==task
      || !await scope.current() || this.scope!==scope || this.update?.observation?.task!==task)return false;
    if(!this.taskAction)this.taskAction={id:randomBytes(16).toString('hex'),task};
    return this.taskAction.task===task;
  }
  async chooseChapter(account:string,environment:EnvironmentName,chapter:string) {
    const scope=this.scope,task=scope?.tasks.find(t=>t.instructorChapter===chapter);
    if(!scope || !task || this.demonstration || scope.account!==account || scope.environment!==environment || this.taskAction
        || !await scope.current() || this.scope!==scope || this.taskAction)return false;
    // Navigation changes neither saved evidence nor completion. The player checks
    // for unsaved work before moving both panels to the selected chapter.
    this.taskAction={id:randomBytes(16).toString('hex'),task:task.id,kind:'open'};return true;
  }
  setConnection(account:string,environment:EnvironmentName,connected:boolean,detail:string) {
    if(this.scope?.account===account && this.scope.environment===environment) {
      this.connection={connected,detail:detail.slice(0,180)};
      if(!connected)this.demonstration?.finish({status:'interrupted',message:'Instructor disconnected. Control is with the student.'});
    }
  }
  async start(scope:Scope) {
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(scope.origin) || !/^[a-f0-9]{20}$/.test(scope.learner))throw new Error('Invalid training origin.');
    await this.stop();this.scope=scope;this.token=randomBytes(32).toString('hex');this.sequence=0;
    const server=createServer((req,res)=>{void this.handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
    this.server=server;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address || typeof address==='string')throw new Error('Could not start the training connection.');
    this.port=address.port;
    return new URLSearchParams({learner:scope.learner,bridge:String(this.port),token:this.token}).toString();
  }
  private emit(observation:BrowserObservation|null,help?:string) {
    const scope=this.scope;if(!scope)return;
    const task=scope.tasks.find(t=>t.id===observation?.task);
    const situation=scope.course?.shift&&task?(task as BrowserTask&{business?:BusinessShift['situations'][string]}).business:undefined;
    const personalized=situation&&resolveTask(situation,scope.learner.slice(0,10),Object.fromEntries(Object.entries(scope.verified?.()||{}).map(([k,v])=>[k,v.record])));
    let brief=personalized?{id:scope.learner+':'+task!.id,title:personalized.title,
      text:[scope.course!.shift!.brief.replaceAll('{{company}}','Training '+scope.learner.slice(0,10)),personalized.brief,
        ...personalized.documents.map(d=>`**${d.title}:** ${d.text}`),'Work in ERPNext. Ask Instructor to demonstrate when needed; use Continue here to review your saved work.'].join('\n\n')}:undefined;
    if (!brief && task?.scenario && (!scope.course || scope.course.id === 'erpnext-essentials')) {
      const scenario = task.scenario.replaceAll('{{tag}}', scope.learner.slice(0,10))
        .replaceAll('{{company}}', 'Training ' + scope.learner.slice(0,10));
      brief = {id:scope.learner+':'+task.id, title:task.title || task.doctype,
        text:scenario + '\n\n' + (task.guidance === 'none' ? '' : `Work in ERPNext's **${task.doctype}** view. `)
          + (task.readOnly ? 'Inspect the existing record; this task does not need a new record.'
            : 'Complete the record described above and save it. Submit only when the task asks for a submitted transaction.')
          + ' Return to Instructor and use Continue to check the saved result.'};
    }
    const verified = task && scope.verified?.()[task.id];
    if (task && verified && observation?.record === verified.record && !observation.dirty) {
      brief = {id:scope.learner+':'+task.id+':verified:'+verified.record, title:'Saved record verified',
        text:`**${task.doctype}: ${verified.record}** matched this task's saved-record checks at ${verified.checkedAt}. `
          + (verified.explained ? 'Your explanation is recorded. Continue when ready.' : 'The record check passed. Complete the explanation with Instructor before continuing.')};
    }
    const handover=scope.course?.shift&&scope.handover?.();
    if(handover&&task?.id===scope.course!.shift!.live.at(-1))brief={id:scope.learner+':handover:'+handover.at,title:'Your saved handover',
      text:handover.text+'\n\n**ERPNext evidence at handover:**\n\n'+handover.recorded+'\n\nSaved as practice evidence. Review Instructor’s feedback on your reasoning.'};
    this.update={account:scope.account,environment:scope.environment,chapter:task?.instructorChapter??this.update?.chapter??scope.tasks[0].instructorChapter,observation,progress:this.progress(scope.account,scope.environment),question:this.question,taskStatus:this.taskStatus,...(help?{help}:{}),...(brief?{brief}:{})};
    this.events.emit('update',this.update);
  }
  private async handle(req:IncomingMessage,res:ServerResponse) {
    const scope=this.scope;
    const reply=(code:number,value?:unknown)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(value===undefined?'':JSON.stringify(value));};
    if(!scope || req.headers.host!==`127.0.0.1:${this.port}` || req.headers.origin!==scope.origin)return reply(403);
    res.setHeader('Access-Control-Allow-Origin',scope.origin);res.setHeader('Vary','Origin');
    if(req.method==='OPTIONS') {res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');return reply(204);}
    const supplied=req.headers.authorization?.slice(7);
    if(!req.headers.authorization?.startsWith('Bearer ') || !supplied || !/^[a-f0-9]{64}$/.test(supplied) || supplied.length!==this.token.length
        || !timingSafeEqual(Buffer.from(supplied),Buffer.from(this.token)))return reply(401);
    if(!await scope.current() || this.scope!==scope)return reply(410);
    if(req.method==='GET' && req.url==='/course')return reply(200,{id:scope.course?.id??'erpnext-essentials',title:scope.course?.title??ERP_COURSE,
      version:createHash('sha256').update(JSON.stringify(scope.tasks)).digest('hex').slice(0,16),lessons:scope.tasks,verified:scope.verified?.()??{},
      ...(scope.course?.finale?{finale:scope.course.finale}:{}),...(scope.course?.shift?{shift:scope.course.shift,handover:scope.handover?.()}: {})});
    if(req.method==='POST' && req.url==='/signin')return scope.signIn?reply(200,scope.signIn):reply(404);
    if(req.method==='GET' && req.url==='/state')return reply(200,{...this.connection,questionId:this.question?.id??null,...(this.answer?{answer:this.answer}:{}),...(this.taskAction?{taskAction:this.taskAction}:{}),...(this.demonstration?{demonstration:this.demonstration.command}:{})});
    if(req.method!=='POST' || !['/observe','/help','/progress','/question','/focus','/reconnect','/continue-result','/handover','/status','/demonstration-result'].includes(req.url??''))return reply(404);
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req) {size+=chunk.length;if(size>16000)return reply(413);chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return reply(400);}
    if(!await scope.current() || this.scope!==scope)return reply(410);
    if(req.url==='/status') {
      if(!scope.course?.shift||!object(body)||Object.keys(body).join()!=='status'||!text(body.status,600))return reply(400);
      this.taskStatus=body.status;this.emit(this.update?.observation??null);return reply(200,{ok:true});
    }
    if(req.url==='/demonstration-result') {
      if(!object(body)||!text(body.id,32))return reply(400);
      const {id,...result}=body;
      if(!validDemonstrationResult(result))return reply(400);
      if(this.demonstration?.command.id===id)this.demonstration.finish(result);
      // Late acknowledgements never replay an action or change a timeout into success.
      return this.demonstrations.has(id)?reply(200,{ok:true}):reply(409);
    }
    if(req.url==='/handover') {
      if(!scope.course?.shift || !scope.recordHandover || !object(body) || Object.keys(body).sort().join(',')!=='recorded,text'
        || !text(body.text,800) || body.text.trim().length<40 || !text(body.recorded,2000))return reply(400);
      return await scope.recordHandover(body.text.trim(),body.recorded)?reply(200,{ok:true}):reply(409,{verified:false});
    }
    if(req.url==='/reconnect') {
      if(!object(body) || Object.keys(body).length || !this.update?.observation)return reply(409);
      // An explicit request changes only the Instructor transport. Saved ERPNext work stays intact.
      this.events.emit('update',{...this.update,reconnect:true});return reply(200,{ok:true});
    }
    if(req.url==='/focus') {
      if(!object(body) || Object.keys(body).join()!=='id' || !this.question || body.id!==this.question.id
          || !this.update?.observation || this.question.task!==this.update.observation.task)return reply(409);
      // One explicit handoff, never replayed by latest() or a background update.
      this.events.emit('update',{...this.update,focusQuestion:this.question.id});return reply(200,{ok:true});
    }
    if(req.url==='/continue-result') {
      if(!object(body) || !this.taskAction || body.id!==this.taskAction.id || !text(body.status,600))return reply(409);
      this.taskAction=undefined;this.taskStatus=body.status;this.emit(this.update?.observation??null);return reply(200,{ok:true});
    }
    if(req.url==='/question') {
      if(!object(body) || Object.keys(body).join()!=='question' || (body.question!==null &&
        (!validBrowserQuestion(body.question) || !scope.tasks.some(t=>t.id===body.question.task)
          || this.update?.observation?.task!==body.question.task)))return reply(400);
      if(this.question?.id!==body.question?.id)this.answer=undefined;
      this.question=body.question;
      this.emit(this.update?.observation??null);return reply(200,{ok:true});
    }
    if(req.url==='/progress') {
      if(!object(body) || Object.keys(body).sort().join()!=='assisted,checkedAt,explained,record,task' || !scope.tasks.some(t=>t.id===body.task)
          || !text(body.record,160) || !body.record || !text(body.checkedAt,40) || Number.isNaN(Date.parse(body.checkedAt))
          || typeof body.assisted!=='boolean' || typeof body.explained!=='boolean')return reply(400);
      const accepted=await scope.recordVerified?.(body.task,{record:body.record,checkedAt:body.checkedAt,assisted:body.assisted,explained:body.explained});
      if(!await scope.current() || this.scope!==scope)return reply(410);
      const observed = this.update?.observation;
      if (accepted !== false && observed && observed.task === body.task) this.emit(observed);
      return accepted===false?reply(409,{verified:false}):reply(200,{ok:true});
    }
    if(req.url==='/help') {
      if(!object(body) || Object.keys(body).join()!=='message' || !text(body.message,1500) || !body.message.trim() || !this.update?.observation)return reply(400);
      if(!this.connection.connected)return reply(409,{message:'Instructor is not connected yet.'});
      this.emit(this.update.observation,body.message.trim());return reply(200,{ok:true});
    }
    if(object(body) && Object.keys(body).sort().join(',')==='clear,sequence' && body.clear===true && Number.isSafeInteger(body.sequence) && body.sequence>this.sequence) {
      this.sequence=body.sequence;this.question=null;this.answer=undefined;this.taskAction=undefined;this.taskStatus='';this.emit(null);return reply(200,{ok:true});
    }
    const observation=browserObservation(body,scope.tasks,scope.course?.id);
    if(!observation || observation.training_tag!==scope.learner.slice(0,10))return reply(400);
    if(!!observation.shift!==!!scope.course?.shift)return reply(400);
    if(observation.sequence<=this.sequence)return reply(409);
    if(this.question?.task!==observation.task){this.question=null;this.answer=undefined;this.taskStatus='';}
    this.sequence=observation.sequence;this.emit(observation);return reply(200,{ok:true});
  }
  async stop() {
    this.demonstration?.finish({status:'interrupted',message:'The training session ended. Control is with the student.'});this.demonstrations.clear();
    this.question=null;this.answer=undefined;this.taskAction=undefined;this.taskStatus='';this.emit(null);this.scope=undefined;this.token='';this.update=undefined;
    this.connection={connected:false,detail:'Instructor is not connected.'};
    const server=this.server;this.server=undefined;
    if(server)await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
  }
  dispose() {void this.stop();this.events.removeAllListeners();}
}
