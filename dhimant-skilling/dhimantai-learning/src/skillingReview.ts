import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Auth } from './auth';
import { Api } from './api';
import { Environment, EnvironmentName } from './environments';
import { SkillingProfile, SkillingReview } from './skilling';

export interface ReviewDetail {
  submission:{id:string;course_id:string;kind:string;source_hash:string;created_at:string;payload:{title:string;requirements?:string;explanation?:string;assistance:string;
    files?:{path:string;text:string}[];questions?:{id:string;topic:string;prompt:string}[];answers?:Record<string,string>}};
  reviews:{id:string;payload:SkillingReview;created_at:string}[];profile:SkillingProfile;
}
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export class SkillingReviewView implements vscode.Disposable {
  private panel?:vscode.WebviewPanel;private detail?:ReviewDetail;private sequence=0;private busy=false;private offset=0;
  private queue:{id:string;title:string;learner:string;kind:string;latest_review:string|null}[]=[];
  private owner='';private environment?:EnvironmentName;private api?:Api;private notice='';
  private subscriptions:vscode.Disposable[];
  constructor(private auth:Auth,private env:()=>EnvironmentName,private service:()=>Environment) {
    this.subscriptions=[vscode.commands.registerCommand('dhimantai.reviewReadiness',()=>this.open()),
      auth.onDidChange(()=>this.clear()),vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('dhimantai.environment'))this.clear();})];
  }
  dispose(){this.sequence++;this.panel?.dispose();this.subscriptions.forEach(s=>s.dispose());}
  private clear(){this.sequence++;this.api=undefined;this.owner='';this.detail=undefined;this.queue=[];this.panel?.dispose();}
  private async open(){
    if(!this.panel){this.panel=vscode.window.createWebviewPanel('dhimantai.readinessReviews','Assigned readiness reviews',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[]});
      this.panel.onDidDispose(()=>{this.panel=undefined;this.sequence++;});
      this.panel.webview.onDidReceiveMessage(m=>void this.handle(m));}
    this.panel.reveal();await this.load();
  }
  private async current(sequence:number){return sequence===this.sequence&&this.environment===this.env()&&(await this.auth.session())?.user.id===this.owner;}
  private async load(id?:string){
    const sequence=++this.sequence;this.notice='Loading assigned assessments…';this.render();
    try{
      const owner=(await this.auth.session())?.user.id;if(!owner)throw new Error('Sign in with an approved teacher account.');
      const environment=this.env(),backend=this.service();
      this.owner=owner;this.environment=environment;
      const api=new Api(this.auth,()=>{if(this.env()!==environment)throw new Error('Your service changed.');return backend;},owner);
      const result=id?await api.skillingReview(id):await api.skillingReviewQueue(this.offset);
      if(!(await this.current(sequence)))return;
      this.api=api;if('submission' in result)this.detail=result;else{this.detail=undefined;this.queue=result.submissions;}
      this.notice='';this.render();
    }catch(error){if(sequence===this.sequence){this.notice=error instanceof Error?error.message:'Review unavailable.';this.render();}}
  }
  private render(){
    if(!this.panel)return;const nonce=randomBytes(16).toString('hex'),d=this.detail,s=d?.submission;
    const button=(title:string,type:string,id='')=>`<button data-action="${type}" data-id="${esc(id)}" ${this.busy?'disabled':''}>${esc(title)}</button>`;
    const criteria=s?.kind==='weekly'?Object.fromEntries((s.payload.questions??[]).map(q=>[q.id,q.topic])):d?.profile.rubrics?.[s?.kind??'']??d?.profile.criteria??{};
    const scope=JSON.stringify(`${this.owner}:${this.environment}:${s?.id??'queue'}`).replaceAll('<','\\u003c');
    this.panel.webview.html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'nonce-${nonce}';script-src 'nonce-${nonce}'"><style nonce="${nonce}">
      body{max-width:900px;margin:auto;padding:24px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);line-height:1.6}button{padding:7px 12px;margin:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}label{display:block;margin:14px 0}textarea,select{display:block;width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit;padding:8px}section{border:1px solid var(--vscode-panel-border);padding:16px;margin:18px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder)}
      </style></head><body><h1>Assigned readiness assessments</h1><p role="status">${esc(this.notice)}</p>${button('Refresh','refresh')}${s?button('Back to queue','back'):''}
      ${s&&d?`<h2>${esc(s.payload.title)} · ${esc(s.kind)}</h2><p>Frozen ${esc(s.created_at)} · ${esc(s.source_hash)}</p><p>Declared assistance: ${esc(s.payload.assistance)}</p>
      <pre>${esc(s.payload.requirements??'')}</pre><pre>${esc(s.payload.explanation??'')}</pre>
      ${s.payload.files?.map(f=>button('View '+f.path,'file',f.path)).join('')??''}
      ${s.payload.questions?.map(q=>`<section><strong>${esc(q.topic)}</strong><p>${esc(q.prompt)}</p><pre>${esc(s.payload.answers?.[q.id])}</pre></section>`).join('')??''}
      <p>Review the exact frozen files. Run the submitted work in an assessor-controlled environment using your own test inputs. For practical and defence sessions, verify identity and observe execution and a new change. Learner screenshots, reported scores and AI judgments alone are insufficient.</p>
      <p>Ratings: 0 missing, 1 substantial gaps, 2 needs support, 3 demonstrated, 4 strong independent delivery. Every essential criterion must reach 3.</p>
      ${Object.entries(criteria).map(([key,label])=>`<section><label>${esc(label)}<select data-field="rating:${esc(key)}"><option value="">Select rating…</option>${[0,1,2,3,4].map(n=>`<option value="${n}">${n}/4</option>`).join('')}</select></label><label>Observed evidence<textarea data-field="evidence:${esc(key)}" maxlength="2000" rows="3"></textarea></label></section>`).join('')}
      <label>Task, test procedure and requested change<textarea data-field="task" maxlength="4000" rows="4"></textarea></label>
      <label>Assessment environment and permitted assistance (published on certificate)<textarea data-field="conditions" maxlength="2000" rows="3"></textarea></label>
      <label><input type="checkbox" data-field="observed"> I observed the practical work or defence session.</label><label><input type="checkbox" data-field="identity_checked"> I verified learner identity for the observed session.</label><label><input type="checkbox" data-field="unfamiliar_task"> I assigned an unfamiliar practical task during the session.</label>
      <label>Feedback, remediation and next action<textarea data-field="next_step" maxlength="4000" rows="4"></textarea></label>${button('Record independent assessment','save')}
      ${d.reviews.map(r=>`<details><summary>${esc(r.created_at)} · ${r.payload.score}/100</summary><pre>${esc(r.payload.next_step)}</pre></details>`).join('')}`:
      `<p>Only learners in your teaching roster or explicitly assigned to you are listed. Assignments are managed by the institution or platform.</p>${this.queue.map(q=>`<section><strong>${esc(q.learner)} · ${esc(q.title)}</strong><p>${esc(q.kind)} · ${q.latest_review?'Reviewed':'Awaiting review'}</p>${button('Review','open',q.id)}</section>`).join('')}${this.offset?button('Previous page','previous'):''}${this.queue.length===50?button('Next page','next'):''}`}
      <script nonce="${nonce}">const vscode=acquireVsCodeApi(),scope=${scope};let state=vscode.getState();if(!state||state.scope!==scope)state={scope,fields:{}};
      for(const el of document.querySelectorAll('[data-field]')){const v=state.fields[el.dataset.field];if(v!==undefined){if(el.type==='checkbox')el.checked=v;else el.value=v;}}
      function collect(){return Object.fromEntries([...document.querySelectorAll('[data-field]')].map(e=>[e.dataset.field,e.type==='checkbox'?e.checked:e.value]));}
      document.addEventListener('input',()=>{state.fields=collect();state.requestId=null;vscode.setState(state);});document.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b||b.disabled)return;state.fields=collect();state.requestId=state.requestId||crypto.randomUUID();vscode.setState(state);vscode.postMessage({type:b.dataset.action,id:b.dataset.id,fields:state.fields,requestId:state.requestId});});</script></body></html>`;
  }
  private async handle(m:{type:string;id?:string;requestId:string;fields?:Record<string,unknown>}){
    if(this.busy)return;const api=this.api,seq=this.sequence;if(!api||!(await this.current(seq)))return;
    if(m.type==='refresh')return this.load(this.detail?.submission.id);
    if(m.type==='open'&&this.queue.some(q=>q.id===m.id))return this.load(m.id);
    if(m.type==='back'){this.offset=0;return this.load();}
    if(m.type==='next'||m.type==='previous'){this.offset=Math.max(0,this.offset+(m.type==='next'?50:-50));return this.load();}
    try{
      const d=this.detail;if(!d)return;
      if(m.type==='file'){
        const file=d.submission.payload.files?.find(f=>f.path===m.id);if(!file)return;
        const doc=await vscode.workspace.openTextDocument({content:file.text,language:'plaintext'});
        if(await this.current(seq))await vscode.window.showTextDocument(doc,{preview:true,viewColumn:vscode.ViewColumn.Beside});return;
      }
      if(m.type!=='save')return;
      const f=m.fields??{},keys=d.submission.kind==='weekly'?(d.submission.payload.questions??[]).map(q=>q.id):Object.keys(d.profile.rubrics?.[d.submission.kind]??d.profile.criteria);
      if(keys.some(k=>typeof f['rating:'+k]!=='string'||!/^[0-4]$/.test(String(f['rating:'+k]))))throw new Error('Select a rating for every required criterion.');
      this.busy=true;this.notice='Recording assessment…';this.render();
      await api.saveSkillingReview(d.submission.id,{request_id:m.requestId,expected_review:d.reviews[0]?.id??null,review:{
        ratings:Object.fromEntries(keys.map(k=>[k,{rating:Number(f['rating:'+k]),evidence:f['evidence:'+k]}])),
        conditions:f.conditions,task:f.task,next_step:f.next_step,observed:f.observed===true,identity_checked:f.identity_checked===true,unfamiliar_task:f.unfamiliar_task===true}});
      if(await this.current(seq))await this.load(d.submission.id);
    }catch(error){if(seq===this.sequence)this.notice=error instanceof Error?error.message:'Could not record assessment.';}
    finally{this.busy=false;this.render();}
  }
}
