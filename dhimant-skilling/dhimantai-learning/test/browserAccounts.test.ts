import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {join} from 'node:path';
const Module=require('node:module');
const commands=new Map<string,Function>(), starts:any[]=[], stopped:string[]=[], revoked:string[]=[], opened:string[]=[];
const inputAnswers: string[] = [];
const inputTitles: string[] = [];
const instructor: {course:string;chapter:string}[] = [];
let release:(()=>void)|undefined;
const disposable={dispose(){}};
class EventEmitter{event=()=>disposable;fire(){}dispose(){}}
const vscode={EventEmitter,commands:{registerCommand:(name:string,fn:Function)=>{commands.set(name,fn);return disposable;},
  getCommands:async()=>['workbench.action.browser.open'],executeCommand:async(name:string,options:any,chapter:string)=>{
    if(name==='workbench.action.browser.open'){assert.equal(options.openToSide,true);assert.equal(options.reuseUrlFilter,'http://127.0.0.1:*/{desk,desk/**,app/**,login,assets/frappe/dhimantai/**}');opened.push(options.url);}
    if(name==='dhimantai.openLearningRoom')instructor.push({course:options,chapter});
  }},
  workspace:{onDidChangeConfiguration:()=>disposable,getConfiguration:()=>({get:()=>''})},ProgressLocation:{Notification:1},
  window:{withProgress:async(_:unknown,fn:Function)=>fn({report(){}}),showInformationMessage:async()=>undefined,showErrorMessage:async()=>undefined,
    showInputBox:async ({title, validateInput}: {title:string;validateInput?: (v:string)=>string|undefined})=>{
      inputTitles.push(title);const answer=inputAnswers.shift();assert.equal(answer===undefined?undefined:validateInput?.(answer),undefined);return answer;}},
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
const {HostedErpConnections}=require('../src/apps/hostedErp');
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

test('the ERPNext catalog opens the Instructor before starting a browser runtime',async()=>{
  const count=starts.length;
  const auth={session:async()=>({user:{id:'account-a'}}),onDidChange:()=>disposable};
  const context={extensionUri:{fsPath:join(__dirname,'../..')},globalStorageUri:{fsPath:'/profile'},globalState:{get:(_:string,value:unknown)=>value}};
  const courses=new BrowserCourses(context,auth,()=> 'staging',{append(){},appendLine(){}},{latest:()=>undefined,stop:async()=>{}});
  try {
    const payload=require('../../media/browser/erpnext/course.json');
    const chapter=payload.lessons[1].instructorChapter;
    await commands.get('dhimantai.openBrowserCourse')!('erpnext-essentials',true,chapter);
    assert.deepEqual(instructor.at(-1),{course:'ERPNext Essentials',chapter});
    assert.equal(starts.length,count,'the learner can choose a hosted connection without starting Podman');
  } finally {await courses.stop();courses.dispose();}
});

test('named ERPNext connections reuse secret-storage credentials and stay scoped to the signed-in account',async()=>{
  const metadata=new Map(), secrets=new Map();
  const get=(data:Map<string,unknown>)=>(key:string,fallback?:unknown)=>data.get(key)??fallback;
  const store=new HostedErpConnections({globalState:{get:get(metadata),update:async(k:string,v:unknown)=>{metadata.set(k,v);}},
    secrets:{get:async(k:string)=>get(secrets)(k),store:async(k:string,v:string)=>{secrets.set(k,v);}}});
  const previousFetch=globalThis.fetch;
  const requests: {url:string;password:string|null}[] = [];
  globalThis.fetch=async (url,init)=>{
    requests.push({url:String(url),password:(init?.body as URLSearchParams).get('pwd')});
    return (init?.body as URLSearchParams).get('pwd')==='initial-password' && requests.length===2
      ? new Response('{}',{status:401})
      : new Response('{"home_page":"/app"}',{headers:{'Set-Cookie':'sid=erp-session; HttpOnly'}});
  };
  try {
    inputTitles.length=0;
    inputAnswers.push('https://west.example.com/app/purchase-receipt','West Distribution','warehouse@example.com','initial-password');
    const first=await store.connect('staging','account-a','connect',async()=>true);
    assert.equal(first.server.landingPath(),'/app');
    assert.deepEqual(store.list('staging','account-a'),[],'cancelled or failed browser opens can avoid persisting credentials');
    await first.save();
    assert.deepEqual(store.list('staging','account-a'),[{id:first.id,name:'West Distribution',origin:'https://west.example.com'}]);
    assert.deepEqual(store.list('production','account-a'),[]);
    assert.deepEqual(store.list('staging','account-b'),[]);
    assert.equal(JSON.stringify([...metadata]).includes('initial-password'),false);
    assert.equal(secrets.size,1);
    inputAnswers.push('rotated-password');
    const reconnected=await store.connect('staging','account-a',first.id,async()=>true);
    await reconnected.save();
    const again=await store.connect('staging','account-a',first.id,async()=>true);
    assert.equal(again.login,'warehouse@example.com');
    assert.deepEqual(inputTitles.slice(4),['ERPNext training password']);
    assert.deepEqual(requests.map(item=>item.password),['initial-password','initial-password','rotated-password','rotated-password']);
    assert.ok(requests.every(item=>item.url==='https://west.example.com/api/method/login'));
  } finally {globalThis.fetch=previousFetch;}
});
