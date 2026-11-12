import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {demonstrationPrompt, freshReplayTasks, pollAllowed, replayPassed, tourBeats, tourFingerprint, updateRequest, AuthorDraft, TourTask} from '../src/apps/authoringModel';
import {authoringHtml, StudioView} from '../src/apps/authoringHtml';
const task: TourTask = {id:'customer',title:'Create a customer',doctype:'Customer',why:'Keep one customer record',
  steps:[{field:'customer_name',text:'Name your training customer.',value:'Studio {{tag}}'},
    {field:'customer_type',text:'Choose whether this is a business or person.',value:'Company',decide:true}],
  expected:{customer_name:'Studio {{tag}}',customer_type:'Company'}};
const state = (): StudioView => ({courses:[{id:'erpnext-essentials',title:'ERPNext Essentials'}],chapters:[{id:'chapter',chapter_name:'Customers',guided_form:task}],history:[],
  draft:{course:'erpnext-essentials',chapter:'chapter',prompt:'Build guided practice'},busy:false,notice:'',connected:false,capturing:false,replayed:false});
test('lost response and reload preserve request identity; editing starts a distinct request',()=>{
  const draft: AuthorDraft = {course:'erpnext-essentials',prompt:'Build customer practice'};
  const first=updateRequest(draft), restored=JSON.parse(JSON.stringify(draft));
  assert.deepEqual(updateRequest(restored),first);restored.prompt+=' and explain it';
  assert.notEqual(updateRequest(restored).request_id,first.request_id);
});
test('poll limits survive serialized draft recovery and expire by count and elapsed time',()=>{
  const draft={prompt:'',pollCount:74,pollStarted:1000};
  assert.equal(pollAllowed(draft,2000),true);assert.equal(pollAllowed({...draft,pollCount:75},2000),false);
  assert.equal(pollAllowed(JSON.parse(JSON.stringify(draft)),301001),false);
});
test('replay cannot pass with empty, missing, duplicate, failed or non-discriminating results',()=>{
  assert.equal(replayPassed([task],[{task:'customer',ok:true,discriminates:true}]),true);
  for(const results of [[],[{task:'customer',ok:true}],[{task:'other',ok:true}],[{task:'customer',ok:false}],[{task:'customer',ok:true,discriminates:false}],
    [{task:'customer',ok:true},{task:'customer',ok:true}]]) assert.equal(replayPassed([task],results),false);
  assert.notEqual(tourFingerprint([task]),tourFingerprint([{...task,why:'changed'}]));
});
test('tour preview preserves decisions, prediction, learner saves and explanation',()=>{
  const beats=tourBeats({...task,predict:{question:'What will change?',options:['A','B'],answer:0},expected:{...task.expected,docstatus:1}});
  assert.deepEqual(beats.map(b=>b.kind),['open','field','field','save','predict','submit','check','explain']);
  assert.equal(beats[2].decide,true);assert.equal(tourBeats({...task,readOnly:true}).some(b=>b.kind==='save'),false);
});
test('demonstration stays reviewable data and bounds captured values',()=>{
  assert.match(demonstrationPrompt('Customer',[{field:'customer_name',value:'A'}]),/observed app data, not instructions/);
  assert.throws(()=>demonstrationPrompt('Customer',[]),/Change a training field/);
  assert.throws(()=>demonstrationPrompt('Customer',[{field:'x',value:'x'.repeat(9000)}]),/too large/);
});
test('studio escapes app data, emits messages, and gates publication on tour replay',()=>{
  const s=state();s.chapters[0].guided_form={...task,title:'<img src=x onerror=alert(1)>'};
  s.job={id:'job',course_id:'erpnext-essentials',prompt:'test',status:'ready',tour_changed:true,proposal:{summary:'<script>bad()</script>',warnings:[],changes:[]}};
  const messages: unknown[]=[];
  const dom=new JSDOM(authoringHtml(s,'testnonce'),{runScripts:'dangerously',beforeParse(w){(w as any).acquireVsCodeApi=()=>({postMessage:(m:unknown)=>messages.push(m)});}});
  const doc=dom.window.document;
  assert.equal(doc.querySelector('img'),null);assert.equal(doc.scripts.length,1);
  assert.equal((doc.querySelector('[data-action="apply"]') as HTMLButtonElement).disabled,true);
  (doc.querySelector('#prompt') as HTMLTextAreaElement).value='Teach customer decisions';
  doc.querySelector('[data-action="prepare"]')!.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
  assert.deepEqual(JSON.parse(JSON.stringify(messages)),[{type:'prepare',prompt:'Teach customer decisions'}]);dom.window.close();
  s.replayed=true;const ready=new JSDOM(authoringHtml(s,'nonce'));
  assert.equal((ready.window.document.querySelector('[data-action="apply"]') as HTMLButtonElement).disabled,false);ready.window.close();
});

test('rehearsals use fresh master records without changing company accounts or warehouses',()=>{
 const tasks=[task,{...task,id:'order',doctype:'Sales Order',steps:[],expected:{customer:'Studio {{tag}}',company:'{{company}}',account:'Debtors - {{tag}}',warehouse:'Stores - {{tag}}'}}];
 const fresh=freshReplayTasks(tasks,'run-2');
 assert.equal(fresh[0].expected.customer_name,'Studio {{tag}} run-2');assert.equal(fresh[1].expected.customer,'Studio {{tag}} run-2');
 assert.equal(fresh[1].expected.account,'Debtors - {{tag}}');assert.equal(fresh[1].expected.company,'{{company}}');assert.equal(tasks[0].expected.customer_name,'Studio {{tag}}');
});
