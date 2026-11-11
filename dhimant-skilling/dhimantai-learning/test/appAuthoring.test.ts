import {test} from 'node:test';
import * as assert from 'node:assert/strict';
const Module=require('node:module');
const load=Module._load;
Module._load=function(request:string,...rest:unknown[]){return request==='vscode'?{}:load.call(this,request,...rest);};
const {authorCourse}=require('../src/apps/authoring') as typeof import('../src/apps/authoring');
Module._load=load;

const form={form:'sale.order',label:'sale.order',fields:[],actions:[]};
const lesson=(id:string)=>({id,form:'sale.order',expected:{},steps:[]});
function steps(replays:any[][],answers:any=[{question:'Who?',answer:'New staff'}]) {
  const drafts:any[]=[],log:string[]=[];let replayed=0;
  return {drafts,log,steps:{
    discover:async(names:string[])=>names.map(()=>form),
    interview:async()=>['Who?'],
    ask:async()=>answers===null?undefined:answers,
    draft:async(_g:string,_f:unknown,_a:unknown,revise?:any)=>{drafts.push(revise);return {title:'Sales',lessons:[lesson('order')]};},
    replay:async()=>replays[Math.min(replayed++,replays.length-1)],
    report:(m:string)=>log.push(m)}};
}
test('a course is returned only after every task passed in the application, revising from what failed',async()=>{
  const run=steps([[{task:'order',ok:false,reason:'date_order differs'}],[{task:'order',ok:true,record:'7',discriminates:false}],[{task:'order',ok:true,record:'8',discriminates:true}]]);
  const result=await authorCourse('Teach quoting to shop staff.',['sale.order'],run.steps);
  assert.equal(result?.results[0].record,'8');
  assert.equal(run.drafts.length,3);
  assert.match(run.drafts[1].problems[0],/replay failed: date_order differs/);
  assert.match(run.drafts[2].problems[0],/wrong value in a decide=true field still passes/);
  assert.ok(run.log.some(m=>/Discovered 1 forms/.test(m)));
});
test('authoring stops clearly when a draft keeps failing, and quietly when the teacher cancels the interview',async()=>{
  const failing=steps([[{task:'order',ok:false,reason:'No button Confirm'}]]);
  await assert.rejects(authorCourse('Teach quoting to shop staff.',['sale.order'],failing.steps),/still fails in the application after two revisions/);
  assert.equal(failing.drafts.length,3);
  const cancelled=steps([[{task:'order',ok:true}]],null);
  assert.equal(await authorCourse('Teach quoting to shop staff.',['sale.order'],cancelled.steps),undefined);
  assert.equal(cancelled.drafts.length,0);
});
