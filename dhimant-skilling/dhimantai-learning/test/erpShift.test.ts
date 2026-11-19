import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {shiftTasks, shiftKey, shiftFinished, checkShiftHandover, BusinessShift} from '../src/erpShift';
import {demoKey} from '../src/erpDemo';
import {resolveTask} from '../src/apps/verifier';
import {BrowserLearning, browserObservation} from '../src/browserLearning';
import {validDemonstration} from '../src/browserDemonstration';
import {BrowserActionRelay} from '../webview/browserActions';

const media=join(__dirname,'../../media/browser');
const course=JSON.parse(readFileSync(join(media,'erpnext/course.json'),'utf8'));
const shift:BusinessShift=JSON.parse(readFileSync(join(media,'erpnext/shift.json'),'utf8'));
const source=readFileSync(join(media,'player/shift.js'),'utf8')+'\n'+readFileSync(join(media,'player/guide.js'),'utf8');
const tag='0123456789',learner=tag+'abcdef0123',user=`learner-${learner}@training.invalid`;
const tasks=shiftTasks(course.lessons,shift);
const records=Object.fromEntries(tasks.map(t=>[t.id,'RECORD-'+t.id]));
const entry=(id:string)=>({record:records[id],checkedAt:'2026-11-12T00:00:00Z',assisted:false,explained:true});
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));

test('the shift interprets published business evidence, keeps its real checks and shares one authored brief with Instructor',()=>{
  assert.deepEqual(JSON.parse(readFileSync(join(__dirname,'../../../../agent/course_projects/data/erpnext_shift.json'),'utf8')),shift);
  assert.deepEqual(tasks.map(t=>t.id),[...shift.prepared,...shift.live]);
  for(const id of shift.live) {
    const task=tasks.find(t=>t.id===id)!,original=course.lessons.find((t:any)=>t.id===id);
    assert.deepEqual(task.steps,original.steps);
    assert.deepEqual(task.expected,{...original.expected,...(['payables','receivables'].includes(id)?{update_stock:0}:{})});
    assert.equal(task.instructorChapter,original.instructorChapter);
    assert.equal(task.guidance,'goals');
    assert.doesNotMatch(task.scenario!,/Create|Submit|click/i);
  }
  const changed=structuredClone(course.lessons);
  changed.find((t:any)=>t.id==='stock').steps.find((s:any)=>s.field==='items').value[0].qty=3;
  assert.match(shiftTasks(changed,shift).find(t=>t.id==='stock')!.business!.documents[1].text,/3 units physically received/);
  assert.throws(()=>shiftTasks(course.lessons.filter((t:any)=>t.id!=='buying'),shift),/published purchasing/);
  assert.notEqual(shiftKey('staging','a'),demoKey('staging','a'));
  assert.notEqual(shiftKey('staging','a'),shiftKey('production','a'));
  assert.notEqual(shiftKey('staging','a'),shiftKey('staging','b'));
});

function fixture(finished=false,storage?:string,manualClock=false) {
  const dom=new JSDOM('<!doctype html><body><input id="qty"></body>',{url:'http://127.0.0.1:43210/desk',runScripts:'outside-only'});
  const w=dom.window as any,verified=Object.fromEntries((finished?tasks.map(t=>t.id):shift.prepared).map(id=>[id,entry(id)]));
  const published={...course,version:'shift-test',lessons:tasks,shift,finale:shift.finale,verified};
  const docs:any=Object.fromEntries(tasks.map(t=>[records[t.id],{...resolveTask(t.expected,tag,records),name:records[t.id]}]));
  docs[records.buying].per_received=80;
  docs[records.payables].outstanding_amount=400;docs[records.receivables].outstanding_amount=300;
  let fail=false,dirty=false,acceptHandover=true,connected=true,afterOpen:(()=>void)|undefined;
  let clock=Date.now(),poll:(()=>void)|undefined;
  if(manualClock){w.Date.now=()=>clock;w.setInterval=(fn:()=>void)=>{poll=fn;return 1;};w.clearInterval=()=>{};}
  const inputs:any[]=[];
  const listen=w.document.addEventListener.bind(w.document);
  w.document.addEventListener=(name:string,fn:any,options:any)=>{if(name==='input')inputs.push(fn);return listen(name,fn,options);};
  let current:any={form:finished?'Sales Invoice':'Purchase Receipt',id:records[finished?'receivables':'stock'],isNew:false,values:docs[records[finished?'receivables':'stock']]};
  const opened:any[]=[],filled:any[]=[],requests:any[]=[];
  w.sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:40000',token:'a'.repeat(64),learner}));
  if(storage)w.localStorage.setItem(`dhimantai-shift:shift-test:${user}`,storage);
  w.AbortSignal={timeout:()=>undefined};
  w.fetch=async(url:string,options:any)=>{
    const body=options?.body?JSON.parse(options.body):undefined;requests.push({url,body});
    return {ok:!url.endsWith('/handover')||acceptHandover,text:async()=>JSON.stringify(published),json:async()=>url.endsWith('/state')?{connected}:{ok:true}};
  };
  w.dhimantaiApp={ready:()=>true,user:()=>user,title:'ERPNext',today:()=> '2026-11-12',route:()=>current.form+'/'+(current.id||'new'),
    current:()=>({...current,dirty,final:current.values.docstatus===1}),label:(name:string)=>name==='items'?'Items':name,
    isFinal:(doc:any)=>doc?.docstatus===1,errors:()=>[],
    read:async(_form:string,id:string)=>{if(fail)throw new Error('offline');return docs[id];},
    openRecord:async(form:string,id:string)=>{opened.push({form,id});current={form,id,isNew:false,values:docs[id]};afterOpen?.();},
    create:async(form:string)=>{opened.push({create:form});current={form,id:null,isNew:true,values:{company:'Training '+tag,docstatus:0,items:[{qty:5}]}};dirty=true;},
    setValue:async(field:string,value:any)=>{filled.push({field,value});current.values[field]=value;},
    postings:async()=>({ledger:[{account:'Stock In Hand',debit:400,credit:0}],stock:[{item:'widget',change:4,balance:4}]}),
    evidence:async()=> '2 in Stores - '+tag+'.',
    books:async()=>{if(fail)throw new Error('offline');return [
      {account:'Stock In Hand',kind:'asset',balance:200},{account:'Debtors',kind:'asset',balance:300},
      {account:'Creditors',kind:'liability',balance:400},{account:'Sales',kind:'income',balance:300},{account:'Cost of Goods Sold',kind:'expense',balance:200}];}};
  w.eval(source);
  return {w,dom,docs,opened,filled,requests,setDirty:(v:boolean)=>dirty=v,setFail:(v:boolean)=>fail=v,setHandover:(v:boolean)=>acceptHandover=v,
    setConnected:(v:boolean)=>connected=v,afterOpen:(fn:()=>void)=>afterOpen=fn,studentInput:()=>inputs.forEach(fn=>fn({isTrusted:true})),
    poll:async(ms:number)=>{clock+=ms;poll?.();await tick();},
    setCurrent:(id:string)=>{const task=tasks.find(t=>t.id===id)!;current={form:task.doctype,id:records[id],isNew:false,values:docs[records[id]]};},
    stored:()=>w.localStorage.getItem(`dhimantai-shift:shift-test:${user}`),
    close:()=>{w.dhimantaiErpGuide?.dispose();dom.window.close();}};
}

test('the shift has no panel or page controls and adapts to checked mistakes without treating edits or network failures as misconceptions',async()=>{
  const f=fixture();try {
    await tick();const guide=f.w.dhimantaiErpGuide;
    assert.equal(guide.current().id,'stock');
    assert.equal(f.w.document.querySelector('#dhimantai-guide'),null);
    assert.equal(f.w.document.querySelectorAll('button,aside,section').length,0);
    assert.equal(guide.headless,true);
    f.setDirty(true);assert.match(await guide.openTask('delivery'),/current edit/);assert.equal(guide.current().id,'stock');
    f.setDirty(false);assert.match(await guide.openTask('delivery'),/earlier situation/);assert.equal(f.opened.length,0);
    await guide.openTask('stock');
    const q=guide.question();await guide.answerQuestion(q.id,q.options[1]);
    f.docs[records.stock].docstatus=0;f.docs[records.stock].items[0].qty=5;
    f.setDirty(true);await guide.continueTask('stock');assert.equal(guide.snapshot().shift.failures,0);
    f.setDirty(false);f.setFail(true);await assert.rejects(guide.continueTask('stock'));assert.equal(guide.snapshot().shift.failures,0);
    f.setFail(false);await guide.continueTask('stock');
    assert.equal(guide.snapshot().shift.support,'evidence');assert.match(guide.status(),/warehouse’s count/);
    await guide.continueTask('stock');assert.equal(guide.snapshot().shift.support,'navigation');assert.match(guide.status(),/Look at: Items/);
    f.docs[records.stock].items[0].qty=4;await guide.continueTask('stock');
    assert.match(guide.status(),/draft matches/);assert.equal(JSON.parse(f.stored()).done.stock,undefined);
    f.docs[records.stock].docstatus=1;await guide.continueTask('stock');assert.equal(guide.snapshot().shift.support,'brief');
    const explain=guide.question();assert.match(explain.context,/stock change 4/);
    await guide.answerQuestion(explain.id,'Four arrived and one is still due. The receipt matches the warehouse count and keeps the purchase order linked.');
    assert.deepEqual(Array.from(guide.snapshot().shift.completed),['stock']);
    await guide.continueTask('stock');assert.equal(guide.current().id,'payables');assert.equal(guide.snapshot().shift.support,'brief');
  }finally{f.close();}
});

test('structured demonstrations return control, preserve decision fields, reject stale snapshots and never replay a claimed action',async()=>{
  const f=fixture();try {
    await tick();const g=f.w.dhimantaiErpGuide;
    const command=(action:string,id='a'.repeat(32))=>({id,task:g.current().id,snapshot:g.snapshot().shift.snapshot,action,expiresAt:Date.now()+8000});
    const stale=command('prepare_draft');f.setDirty(true);
    assert.equal((await g.demonstrate(stale)).status,'rejected');f.setDirty(false);
    const draft=command('prepare_draft','b'.repeat(32));
    assert.equal((await g.demonstrate(draft)).status,'completed');
    assert.deepEqual(f.opened,[{form:'Purchase Order',id:records.buying},{create:'Purchase Receipt'}]);
    assert.equal((await g.demonstrate(draft)).status,'completed');assert.equal(f.opened.length,2,'same action id never repeats navigation or creation');
    assert.equal((await g.demonstrate(command('fill_routine','c'.repeat(32)))).status,'completed');
    assert.ok(f.filled.every(s=>s.field!=='items'),'business quantities are never filled by the agent');
    assert.equal(f.w.dhimantaiApp.current().values.items[0].qty,5,'the inherited order quantity is left for the learner to correct');
    assert.equal(f.requests.filter(r=>r.url.endsWith('/progress')).length,0,'demonstration does not award progress');
    assert.match(g.status(),/Your turn/);
    assert.equal((await g.demonstrate(command('submit','d'.repeat(32)))).status,'rejected');
    assert.equal((await g.demonstrate({...command('open_source','e'.repeat(32)),expiresAt:Date.now()-1})).status,'rejected');
  }finally{f.close();}
});

test('student input or a disconnected Instructor stops a demonstration before its next mutation',async()=>{
  for(const reason of ['student','disconnect']) {
    const f=fixture();try {
      await tick();const g=f.w.dhimantaiErpGuide;
      f.afterOpen(()=>reason==='student'?f.studentInput():f.setConnected(false));
      const command={id:'f'.repeat(32),task:'stock',snapshot:g.snapshot().shift.snapshot,action:'prepare_draft',expiresAt:Date.now()+8000};
      const result=await g.demonstrate(command);
      assert.equal(result.status,reason==='student'?'interrupted':'failed');
      assert.equal(f.opened.length,1,'never creates a draft after the student took control or Instructor disconnected');
      await g.demonstrate(command);assert.equal(f.opened.length,1,'a claimed interrupted action never repeats');
    }finally{f.close();}
  }
});

test('persistent connection failures back off and stop after three attempts, including a page reload',async()=>{
  const f=fixture(false,undefined,true);let storage;
  try {
    await tick();let calls=0;
    f.w.fetch=async()=>{calls++;throw new Error('offline');};
    await f.poll(1000);assert.equal(calls,1);
    await f.poll(1000);assert.equal(calls,1,'does not retry before the backoff');
    await f.poll(1000);assert.equal(calls,2);
    await f.poll(4000);assert.equal(calls,3);
    await f.poll(60000);assert.equal(calls,3,'the polling timer cannot restart the budget');
    storage=f.stored();assert.equal(JSON.parse(storage).transport.failures,3);
  }finally{f.close();}
  const reopened=fixture(false,storage,true);try {
    await tick();await reopened.poll(60000);
    assert.equal(reopened.requests.filter(r=>r.url.endsWith('/state')||r.url.endsWith('/observe')).length,0,
      'reloading the same connection cannot restart an exhausted automatic budget');
  }finally{reopened.close();}
});

test('the Instructor relay ignores acknowledgements from another connection attempt and releases control on close',async()=>{
  const messages:any[]=[],relay=new BrowserActionRelay(m=>messages.push(m));
  const command={id:'e'.repeat(32),task:'stock',snapshot:'b'.repeat(32),action:'prepare_draft' as const};
  const pending=relay.run(command,2);let settled=false;void pending.then(()=>settled=true);
  relay.receive(command.id,1,{status:'completed',message:'Old result'});await tick();assert.equal(settled,false);
  assert.equal((await relay.run({...command,id:'d'.repeat(32)},2)).status,'rejected');
  relay.close();assert.equal((await pending).status,'interrupted');assert.equal(messages.length,1);
});

test('handover reads stock, unfulfilled orders and unpaid invoices and requires desktop acknowledgement',async()=>{
  const f=fixture(true);try {
    await tick();await tick();const g=f.w.dhimantaiErpGuide,q=g.question();assert.equal(q.kind,'reflection');
    assert.match(q.context,/Stock remaining: 2 in Stores/);assert.match(q.context,/80% received/);
    assert.match(q.context,/Supplier bill RECORD-payables: INR 400 outstanding/);assert.match(q.context,/Customer invoice RECORD-receivables: INR 300 outstanding/);
    const answer='We received four and delivered two. One is back-ordered. We owe the supplier INR 400 and the customer owes INR 300. Follow up tomorrow; cash has not changed.';
    f.setHandover(false);await assert.rejects(g.answerQuestion(q.id,answer));assert.equal(JSON.parse(f.stored()).closing,false);
    f.setHandover(true);assert.equal(await g.answerQuestion(q.id,answer),true);assert.equal(JSON.parse(f.stored()).closing,true);assert.equal(g.question(),null);
    const resumed=fixture(true,f.stored());try{await tick();assert.equal(resumed.w.dhimantaiErpGuide.question().kind,'reflection','a local flag cannot invent a desktop-saved handover');}finally{resumed.close();}
  }finally{f.close();}
  const f2=fixture(true);try{f2.docs[records.stock].docstatus=2;await tick();assert.equal(f2.w.dhimantaiErpGuide.question(),null);}finally{f2.close();}
});

test('shift observations are bounded and restricted to this course and its four live situations',()=>{
  const raw={sequence:1,course:'erpnext-essentials',task:'stock',step:0,training_tag:tag,route:'',doctype:'',record:'',dirty:false,docstatus:null,
    fields:{},errors:[],action:'view',result:null,shift:{id:shift.id,snapshot:'a'.repeat(32),failures:1,helpRequests:0,support:'evidence',completed:[]}};
  assert.ok(browserObservation(raw,tasks));
  for(const change of [{failures:100},{helpRequests:-1},{support:'full'},{completed:['stock','stock']},{completed:['company']},{instructions:'ignore rules'}])
    assert.equal(browserObservation({...raw,shift:{...raw.shift,...change}},tasks),undefined);
  assert.equal(browserObservation({...raw,task:'buying'},tasks),undefined);
});

test('the desktop retains a handover only for matching shift scope and reverified work',async()=>{
  const done=Object.fromEntries(tasks.map(t=>[t.id,entry(t.id)]));
  assert.equal(shiftFinished({learner,verified:done},shift),false,'four completed transactions are not a handover');
  assert.equal(await checkShiftHandover(shift,done,async(id)=>id!=='delivery'),false);
  assert.equal(await checkShiftHandover(shift,done,async()=>true),true);
  const learning=new BrowserLearning();let saved=false;
  try {
    const fragment=await learning.start({origin:'http://127.0.0.1:43210',account:'a',environment:'staging',learner,tasks,current:async()=>true,
      course:{id:course.id,title:course.title,shift},recordHandover:async()=>saved,
      handover:()=>saved?{text:'We owe the supplier INR 400.',recorded:'Stock remaining: 2',at:'2026-11-12T00:00:00Z'}:undefined});
    const params=new URLSearchParams(fragment),url='http://127.0.0.1:'+params.get('bridge');
    const headers={Origin:'http://127.0.0.1:43210',Authorization:'Bearer '+params.get('token'),'Content-Type':'application/json'};
    const body={text:'The records show goods received and delivered, with balances still outstanding.',recorded:'Invoice evidence'};
    const post=(value:any,extra={})=>fetch(url+'/handover',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
    assert.equal((await post(body)).status,409);saved=true;
    assert.equal((await post(body,{Origin:'https://another.example'})).status,403);
    assert.equal((await post({...body,text:'too short'})).status,400);
    assert.equal((await post(body)).status,200);
    assert.equal(((await (await fetch(url+'/course',{headers})).json()) as any).shift.id,shift.id);
    const observed={sequence:1,course:course.id,task:'receivables',step:0,training_tag:tag,route:'',doctype:'',record:'',dirty:false,docstatus:null,fields:{},errors:[],action:'view',result:null,
      shift:{id:shift.id,snapshot:'b'.repeat(32),failures:0,helpRequests:0,support:'brief',completed:shift.live}};
    assert.equal((await fetch(url+'/observe',{method:'POST',headers,body:JSON.stringify(observed)})).status,200);
    assert.match(learning.latest('a','staging')!.brief!.text,/We owe the supplier INR 400/,'review reopens the saved handover in Instructor');
    assert.match(learning.latest('a','staging')!.brief!.id,/:handover:/);
  }finally{await learning.stop();}
});

test('demonstrations are scoped to the current snapshot, deduplicated, and acknowledged once',async()=>{
  const learning=new BrowserLearning(),measured:any[]=[];
  try {
    const fragment=await learning.start({origin:'http://127.0.0.1:43210',account:'a',environment:'staging',learner,tasks,current:async()=>true,
      course:{id:course.id,title:course.title,shift},recordAction:(command,result)=>measured.push({command,result})});
    const params=new URLSearchParams(fragment),url='http://127.0.0.1:'+params.get('bridge');
    const headers={Origin:'http://127.0.0.1:43210',Authorization:'Bearer '+params.get('token'),'Content-Type':'application/json'};
    const post=(path:string,body:any)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(body)});
    const observed={sequence:1,course:course.id,task:'stock',step:0,training_tag:tag,route:'',doctype:'',record:'',dirty:false,docstatus:null,fields:{},errors:[],action:'view',result:null,
      shift:{id:shift.id,snapshot:'b'.repeat(32),failures:0,helpRequests:0,support:'brief',completed:[]}};
    assert.equal((await post('/observe',observed)).status,200);
    learning.setConnection('a','staging',true,'');
    const command={id:'c'.repeat(32),task:'stock',snapshot:'b'.repeat(32),action:'prepare_draft'};
    assert.equal(validDemonstration({...command,value:4}),false);
    assert.equal((await learning.demonstrate('b','staging',command)).status,'rejected');
    assert.equal((await learning.demonstrate('a','staging',{...command,snapshot:'d'.repeat(32)})).status,'rejected');
    const first=learning.demonstrate('a','staging',command),duplicate=learning.demonstrate('a','staging',command);
    await tick();
    const pending=(await (await fetch(url+'/state',{headers})).json()) as any;
    assert.equal(pending.demonstration.id,command.id);
    assert.equal(await learning.continueTask('a','staging','stock'),false,'student Continue cannot race an in-flight demonstration');
    assert.equal((await post('/demonstration-result',{id:command.id,status:'completed',message:'Your turn.',duration_ms:10})).status,200);
    assert.equal((await first).status,'completed');assert.deepEqual(await duplicate,await first);
    assert.equal(measured.length,1);
    assert.equal((await (await fetch(url+'/state',{headers})).json() as any).demonstration,undefined);
    assert.equal((await post('/demonstration-result',{id:command.id,status:'completed',message:'Your turn.'})).status,200);
    assert.equal(measured.length,1,'a late acknowledgement does not count the action twice');
  }finally{await learning.stop();}
});
