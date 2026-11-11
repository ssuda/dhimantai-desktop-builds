import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {EnvironmentName} from './environments';

export const ERP_COURSE = 'ERPNext Essentials';
/** Guided ERPNext tasks in the bundled course. */
export const ERP_TASK_TOTAL = 18;
export interface BrowserTask {id:string; doctype:string; instructorChapter:string; steps:{field:string; value:unknown}[]}
export interface BrowserObservation {
  sequence:number; course:string; task:string; step:number; training_tag:string;
  route:string; doctype:string; record:string; dirty:boolean; docstatus:number|null;
  fields:Record<string,unknown>; errors:string[];
  action:'view'|'edit'|'check'|'help'|'save'|'next'; result:'matched'|'mismatch'|'not_saved'|null;
}
export interface BrowserUpdate {account:string; environment:EnvironmentName; chapter:string; observation:BrowserObservation|null; help?:string}
/** A task whose saved record matched; explained once the learner has also explained their decision. */
export interface VerifiedTask {record:string; checkedAt:string; assisted:boolean; explained:boolean}
interface Scope {origin:string; account:string; environment:EnvironmentName; learner:string; tasks:BrowserTask[]; current:()=>Promise<boolean>;
  /** The practical course these tasks belong to; ERPNext Essentials when omitted. */
  course?:{id:string; title:string};
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
  if(!object(raw) || Object.keys(raw).sort().join(',')!==['sequence','course','task','step','training_tag','route','doctype','record','dirty','docstatus','fields','errors','action','result'].sort().join(','))return;
  const task=tasks.find(t=>t.id===raw.task);
  if(!task || raw.course!==course || !Number.isSafeInteger(raw.sequence) || raw.sequence<1
      || !Number.isInteger(raw.step) || raw.step<0 || raw.step>=task.steps.length
      || !/^[a-f0-9]{10}$/.test(raw.training_tag) || !text(raw.route,300) || !text(raw.doctype,80) || !text(raw.record,160) || typeof raw.dirty!=='boolean'
      || ![null,0,1,2].includes(raw.docstatus) || !['view','edit','check','help','save','next'].includes(raw.action)
      || ![null,'matched','mismatch','not_saved'].includes(raw.result) || !object(raw.fields)
      || !Array.isArray(raw.errors) || raw.errors.length>3 || !raw.errors.every((v:unknown)=>text(v,500)))return;
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
  private connection={connected:false,detail:'Open Instructor to begin live help.'};
  private events=new EventEmitter();
  onUpdate(listener:(event:BrowserUpdate)=>void) {this.events.on('update',listener);return {dispose:()=>this.events.off('update',listener)};}
  latest(account:string,environment:EnvironmentName) {return this.update?.account===account && this.update.environment===environment?this.update:undefined;}
  setConnection(account:string,environment:EnvironmentName,connected:boolean,detail:string) {
    if(this.scope?.account===account && this.scope.environment===environment)this.connection={connected,detail:detail.slice(0,180)};
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
    this.update={account:scope.account,environment:scope.environment,chapter:task?.instructorChapter??this.update?.chapter??scope.tasks[0].instructorChapter,observation,...(help?{help}:{})};
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
      version:createHash('sha256').update(JSON.stringify(scope.tasks)).digest('hex').slice(0,16),lessons:scope.tasks,verified:scope.verified?.()??{}});
    if(req.method==='POST' && req.url==='/signin')return scope.signIn?reply(200,scope.signIn):reply(404);
    if(req.method==='GET' && req.url==='/state')return reply(200,this.connection);
    if(req.method!=='POST' || !['/observe','/help','/progress'].includes(req.url??''))return reply(404);
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req) {size+=chunk.length;if(size>16000)return reply(413);chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return reply(400);}
    if(!await scope.current() || this.scope!==scope)return reply(410);
    if(req.url==='/progress') {
      if(!object(body) || Object.keys(body).sort().join()!=='assisted,checkedAt,explained,record,task' || !scope.tasks.some(t=>t.id===body.task)
          || !text(body.record,160) || !body.record || !text(body.checkedAt,40) || Number.isNaN(Date.parse(body.checkedAt))
          || typeof body.assisted!=='boolean' || typeof body.explained!=='boolean')return reply(400);
      const accepted=await scope.recordVerified?.(body.task,{record:body.record,checkedAt:body.checkedAt,assisted:body.assisted,explained:body.explained});
      return accepted===false?reply(409,{verified:false}):reply(200,{ok:true});
    }
    if(req.url==='/help') {
      if(!object(body) || Object.keys(body).join()!=='message' || !text(body.message,1500) || !body.message.trim() || !this.update?.observation)return reply(400);
      if(!this.connection.connected)return reply(409,{message:'Instructor is not connected yet.'});
      this.emit(this.update.observation,body.message.trim());return reply(200,{ok:true});
    }
    if(object(body) && Object.keys(body).sort().join(',')==='clear,sequence' && body.clear===true && Number.isSafeInteger(body.sequence) && body.sequence>this.sequence) {
      this.sequence=body.sequence;this.emit(null);return reply(200,{ok:true});
    }
    const observation=browserObservation(body,scope.tasks,scope.course?.id);
    if(!observation || observation.training_tag!==scope.learner.slice(0,10))return reply(400);
    if(observation.sequence<=this.sequence)return reply(409);
    this.sequence=observation.sequence;this.emit(observation);return reply(200,{ok:true});
  }
  async stop() {
    this.emit(null);this.scope=undefined;this.token='';this.update=undefined;
    this.connection={connected:false,detail:'Instructor is not connected.'};
    const server=this.server;this.server=undefined;
    if(server)await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
  }
  dispose() {void this.stop();this.events.removeAllListeners();}
}
