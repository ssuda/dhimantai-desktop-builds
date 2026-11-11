import {test} from 'node:test';
import * as assert from 'node:assert/strict';
const Module=require('node:module');
const commands=new Map<string,Function>(), starts:any[]=[], stopped:string[]=[], revoked:string[]=[], opened:string[]=[];
let release:(()=>void)|undefined;
const disposable={dispose(){}};
class EventEmitter{event=()=>disposable;fire(){}dispose(){}}
const vscode={EventEmitter,commands:{registerCommand:(name:string,fn:Function)=>{commands.set(name,fn);return disposable;},
  getCommands:async()=>['workbench.action.browser.open'],executeCommand:async(name:string,options:any)=>{
    if(name==='workbench.action.browser.open'){assert.equal(options.openToSide,true);assert.equal(options.reuseUrlFilter,'http://127.0.0.1:*/{desk,desk/**,app/**,login,assets/frappe/dhimantai/**}');opened.push(options.url);}
  }},
  workspace:{onDidChangeConfiguration:()=>disposable},ProgressLocation:{Notification:1},
  window:{withProgress:async(_:unknown,fn:Function)=>fn({report(){}}),showInformationMessage:async()=>undefined,showErrorMessage:async()=>undefined},
  Uri:{joinPath:(base:any,...parts:string[])=>({fsPath:[base.fsPath,...parts].join('/')}),parse:(value:string)=>value},
  env:{openExternal:async(url:string)=>{opened.push(url);},clipboard:{writeText:async()=>{}}}};
class Runtime {
  constructor(_bin:string,_media:string,readonly key:string){}
  async start(_admin:string,learner:any){starts.push({key:this.key,learner});if(release===undefined)return 'http://127.0.0.1:1234';await new Promise<void>(resolve=>{release=resolve;});return 'http://127.0.0.1:1234';}
  async stop(){stopped.push(this.key);}
  async revoke(id:string){revoked.push(id);}
}
const original=Module._load;
Module._load=function(request:string,...args:unknown[]){
  if(request==='vscode')return vscode;
  if(request==='./podman')return {ensurePodman:async()=>'/podman'};
  if(request==='./browserSandbox')return {...original.call(this,request,...args),ErpSandbox:Runtime};
  return original.call(this,request,...args);
};
const {BrowserCourses}=require('../src/browserCourses');
Module._load=original;
test('accounts share a local instance but use different ERPNext credentials; refresh does not stop work and switching revokes the old login',async()=>{
  let session:any={user:{id:'account-a'}}, listener:Function=()=>{};
  const auth={session:async()=>session,onDidChange:(fn:Function)=>{listener=fn;return disposable;}};
  const secrets=new Map();
  const context={extensionUri:{fsPath:'/extension'},globalStorageUri:{fsPath:'/profile'},
    secrets:{get:async(k:string)=>secrets.get(k),store:async(k:string,v:string)=>secrets.set(k,v)}};
  const courses=new BrowserCourses(context,auth,()=> 'production',{append(){},appendLine(){}});
  const open=commands.get('dhimantai.openBrowserCourse')!;
  await open('erpnext-essentials');
  listener({...session,access_token:'renewed'});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(stopped.length,0,'token refresh preserves the running instance');
  session={user:{id:'account-b'}};listener(session);await courses.stopping;
  await open('erpnext-essentials');
  assert.equal(starts[0].key,starts[1].key,'account is not part of the container stack identity');
  assert.notEqual(starts[0].learner.id,starts[1].learner.id);
  assert.notEqual(starts[0].learner.password,starts[1].learner.password);
  assert.deepEqual(revoked,[starts[0].learner.id]);
  assert.equal(opened.length,2);
  assert.ok(opened.every(url=>url.includes('/assets/frappe/dhimantai/launch.html#learner=')), 'login handoff never nests an encoded query');
  await courses.stop();courses.dispose();
});
