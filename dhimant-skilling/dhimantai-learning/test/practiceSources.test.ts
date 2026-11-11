import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

test('Practice shows only populated permitted sources, with retry on failure and no stale account results', async () => {
  let owner='learner', failure=false, switchAccount=false;
  const requested:string[]=[];
  const questions:any[]=[];
  const api={practiceQuestions:async(_chapter:string,pool:string)=>{
    requested.push(pool);if(switchAccount)owner='other';if(failure)throw new Error('Offline');return {questions:[...questions]};
  }};
  const exports:any={};
  runInNewContext(readFileSync(resolve(__dirname,'../src/practiceBrowser.js'),'utf8'),{exports,require:(id:string)=>
    id==='./api'?{Api:class{constructor(){return api;}},ApiError:class extends Error{}}
    :id==='vscode'?{EventEmitter:class{event=()=>{};fire(){};dispose(){}}}
    :id==='./helpRecord'?{onRecordsChanged:()=>({dispose(){}})}:{}});
  const browser=new exports.PracticeBrowser({session:async()=>({user:{id:owner}})},()=> 'staging',()=>({}));
  const node={kind:'chapter',chapter:{id:'chapter',name:'Chapter'},account:'learner',environment:'staging',languages:[],course:'Python',pools:['textbook']};
  let children=await browser.getChildren(node);
  assert.equal(children.length,1);assert.equal(children[0].kind,'generate');
  assert.deepEqual(requested,['textbook'],'individual learners never request the institute pool');
  questions.push({id:'q1',title:'Question',topic:'Lists',language:'python'});
  children=await browser.getChildren(node);assert.equal(children[0].pool,'textbook');
  const count=requested.length,topics=await browser.getChildren(children[0]);
  assert.equal(topics[0].name,'Lists');assert.equal(requested.length,count,'source expansion reuses the verified chapter results');
  children=await browser.getChildren({...node,pools:['textbook','institution']});
  assert.deepEqual(Array.from(children.filter((n:any)=>n.kind==='pool'),(n:any)=>n.pool),['textbook','institution']);
  failure=true;children=await browser.getChildren(node);assert.equal(children[0].kind,'notice');assert.match(children[0].label,/could not be loaded/);
  assert.equal(children[0].command,'dhimantai.refreshPractice');
  failure=false;switchAccount=true;children=await browser.getChildren(node);
  assert.ok(children.every((n:any)=>n.kind==='notice'),'old account content is discarded');
  switchAccount=false;owner='learner';const before=requested.length;
  children=await browser.getChildren({...node,chapter:{...node.chapter,locked:true}});
  assert.equal(children.length,0);assert.equal(requested.length,before,'locked chapters never load their questions');
});
