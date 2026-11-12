import {test} from 'node:test';
import * as assert from 'node:assert/strict';
const Module=require('node:module'), original=Module._load;
let apiHandler:(path:string,body?:any)=>Promise<any>;
class FakeApi {courseAuthoring(path='',body?:unknown){return apiHandler(path,body);}}
const apiMock={Api:FakeApi};
const disposable={dispose(){}};
const vscode={commands:{registerCommand:()=>disposable},workspace:{onDidChangeConfiguration:()=>disposable},ViewColumn:{One:1},
  window:{createWebviewPanel:()=>({webview:{html:'',onDidReceiveMessage:()=>disposable},onDidDispose:()=>disposable,reveal(){},dispose(){}})}};
Module._load=function(request:string,...rest:unknown[]){return request==='vscode'?vscode:request==='../api'?apiMock:request==='./authoringBrowser'?{AuthoringBrowser:class{}}:original.call(this,request,...rest);};
const {AuthoringStudio}=require('../src/apps/authoringStudio');Module._load=original;
const job={id:'job',course_id:'erpnext-essentials',status:'ready',prompt:'Teach a new workflow',chapters:[],proposal:{summary:'New workflow',warnings:[],changes:[]}};
function setup(saved?:unknown){
  const store=new Map<string,any>();if(saved)store.set('authoring.draft.staging.teacher',saved);
  let user='teacher';let authChange:(s:any)=>void=()=>{};
  const auth={session:async()=>user?{user:{id:user}}:undefined,onDidChange:(f:any)=>{authChange=f;return disposable;}};
  const context={globalState:{get:(k:string)=>store.get(k),update:async(k:string,v:any)=>{store.set(k,v);}}};
  const studio=new AuthoringStudio(context,auth,()=> 'staging',()=>({apiUrl:'http://test'})) as any;
  const calls:any[]=[];
  apiHandler=async(path,body)=>{calls.push({path,body});if(!path)return {courses:[{id:'erpnext-essentials',title:'ERPNext'},{id:'sql',title:'SQL'}],updates:[job]};
    if(path.startsWith('/courses/')&&!path.endsWith('/updates'))return {chapters:[]};return {update:job};};
  return {studio,store,calls,signOut:()=>{user='';authChange(undefined);}};
}
test('a lost prepare response retries the same saved request without publishing',async()=>{
  const {studio,calls}=setup();await studio.open();await studio.handle({type:'course',id:'erpnext-essentials'});
  const base=apiHandler;let lost=true;apiHandler=async(path,body)=>{const value=await base(path,body);if(path.endsWith('/updates')&&lost){lost=false;throw new Error('Connection lost');}return value;};
  await studio.handle({type:'prepare',prompt:'Teach a new workflow'});assert.match(studio.state.notice,/Connection lost/);
  await studio.handle({type:'prepare',prompt:'Teach a new workflow'});
  const writes=calls.filter(c=>c.body);assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);
  assert.ok(!calls.some(c=>c.path.endsWith('/apply')));studio.dispose();
});
test('reopening an exhausted job does not reset polling budget',async()=>{
  const {studio}=setup({course:'erpnext-essentials',prompt:'Teach',jobId:'job',polls:{job:{count:75,started:Date.now()}}});
  const base=apiHandler;apiHandler=async(path,body)=>path==='/updates/job'?{update:{...job,status:'running'}}:base(path,body);
  await studio.open();assert.equal(studio.state.draft.pollCount,75);assert.equal(studio.timer,undefined);assert.match(studio.state.notice,/Refresh this saved update/);studio.dispose();
});
test('late job reads cannot switch back to an earlier course',async()=>{
  const {studio}=setup();await studio.open();await studio.handle({type:'course',id:'erpnext-essentials'});
  const base=apiHandler;let finish!:(v:any)=>void;apiHandler=async(path,body)=>path==='/updates/job'?new Promise(r=>{finish=r;}):base(path,body);
  const pending=studio.loadJob('job');await studio.handle({type:'course',id:'sql'});finish({update:job});await pending;
  assert.equal(studio.state.draft.course,'sql');assert.equal(studio.state.job,undefined);studio.dispose();
});
test('sign-out clears content and ignores an in-flight saved-job response',async()=>{
  const {studio,signOut}=setup();await studio.open();let finish!:(v:any)=>void;
  apiHandler=async()=>new Promise(r=>{finish=r;});const pending=studio.loadJob('job');signOut();finish({update:job});await pending;
  assert.equal(studio.state.job,undefined);assert.equal(studio.panel,undefined);studio.dispose();
});
test('a forged publish message cannot bypass the rehearsal requirement',async()=>{
  const {studio,calls}=setup();await studio.open();studio.state.job={...job,tour_changed:true};
  await studio.handle({type:'apply'});assert.match(studio.state.notice,/replay/);assert.ok(!calls.some(c=>c.path.endsWith('/apply')));studio.dispose();
});
