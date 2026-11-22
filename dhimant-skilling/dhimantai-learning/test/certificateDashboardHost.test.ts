import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

function fixture() {
  let owner='alice', listener=()=>{}, fail=false, release:(()=>void)|undefined, delay=false;
  const executed:any[]=[],copies:string[]=[],apiOwners:string[]=[];
  const disposable={dispose(){}};
  const panel={webview:{html:'',onDidReceiveMessage:()=>disposable},reveal(){},onDidDispose:()=>disposable,dispose(){}};
  const grade=(id:string)=>({course_id:id,course_title:'Python',eligible:true,passed_count:2,required_count:2,requirements:[],topics:[],blockers:[],policy:{description:'All coursework passed',scope:'Coursework'}});
  const auth={session:async()=>({user:{id:owner}}),accessToken:async()=>owner,onDidChange:(fn:()=>void)=>{listener=fn;return disposable;}};
  const vscode={window:{createWebviewPanel:()=>panel,showErrorMessage:async()=>{}},ViewColumn:{One:1},workspace:{onDidChangeConfiguration:()=>disposable},
    commands:{registerCommand:()=>disposable,executeCommand:async(...args:any[])=>{executed.push(args);}},env:{clipboard:{writeText:async(text:string)=>{copies.push(text);}},openExternal:async()=>{}},Uri:{parse:(url:string)=>url}};
  class Api {
    user:string;constructor(_a:unknown,_b:unknown,account:string){this.user=account;apiOwners.push(account);}
    async courseGrade(id:string){if(delay){delay=false;await new Promise<void>(done=>{release=done;});}if(fail)throw new Error('Offline');return {gradebook:grade(id)};}
    async courseCertificates(){return {certificates:[{id:this.user+'-credential',course_id:'earned',course_title:this.user+' credential',recipient_name:this.user,score:90,grade:'A',issued_at:'2026-11-14',revoked_at:null}]};}
  }
  const file=resolve(__dirname,'../src/courseGradeView.js'),realRequire=createRequire(file),exports:any={};
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(id:string)=>id==='vscode'?vscode:id==='./api'?{Api}:id==='./helpRecord'?{onRecordsChanged:()=>disposable}:id==='./skillingActions'?{skillingAction:async()=>{}}
    :id==='./learnerCatalog'?{learnerRpc:async()=>({individual:true,courses:[{id:'python',title:'Python',enrolled:true,chapters:[]}]})}:realRequire(id)});
  const view:any=new exports.CourseGradeView({},auth,()=> 'staging',()=>({apiUrl:'https://api.example'}),{pending:()=>[]});
  return {view,panel,executed,copies,apiOwners,delay:()=>{delay=true;},release:()=>release?.(),switchOwner:(next:string)=>{owner=next;listener();},fail:()=>{fail=true;}};
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setTimeout(done,0));};

test('certificate library uses actual grades, validates navigation and copies only loaded active credentials',async()=>{
  const f=fixture();await f.view.open('__certificates__');
  assert.match(f.panel.webview.html,/Eligible to claim <strong>1<\/strong>/);assert.match(f.panel.webview.html,/alice credential/);
  await f.view.handle({type:'copy',id:'other-credential'});assert.equal(f.copies.length,0);
  await f.view.handle({type:'copy',id:'alice-credential'});assert.equal(f.copies[0],'https://api.example/course-projects/certificates/alice-credential/verify');
  assert.match(f.panel.webview.html,/Verification link copied/);
  await f.view.handle({type:'courseRequirements',id:'foreign'});assert.equal(f.view.course,'');
  await f.view.handle({type:'catalog'});assert.deepEqual(f.executed.at(-1),['dhimantai.courseCatalog']);
});

test('late certificate requirements cannot repopulate a replaced account',async()=>{
  const f=fixture();f.delay();const opening=f.view.open('__certificates__');await flush();
  f.switchOwner('bob');await flush();
  assert.match(f.panel.webview.html,/bob credential/);assert.doesNotMatch(f.panel.webview.html,/alice credential/);
  f.release();await opening;
  assert.match(f.panel.webview.html,/bob credential/);assert.doesNotMatch(f.panel.webview.html,/alice credential/);
  await f.view.handle({type:'copy',id:'alice-credential'});assert.equal(f.copies.length,0);
});

test('unavailable gradebooks retain earned certificates and do not claim false eligibility',async()=>{
  const f=fixture();f.fail();await f.view.open('__certificates__');
  assert.match(f.panel.webview.html,/alice credential/);assert.match(f.panel.webview.html,/Status unavailable/);
  assert.match(f.panel.webview.html,/Eligible to claim <strong>0<\/strong>/);assert.match(f.panel.webview.html,/Requirements could not be loaded/);
});
