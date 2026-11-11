import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { erpServices, sandboxKey, sandboxPort, ERP_IMAGES } from '../src/browserSandbox';
import { machineSetup } from '../src/podman';

const media=join(__dirname,'../../media/browser/erpnext');
const player=join(__dirname,'../../media/browser/player');
// Pages load the application adapter first, then the app-neutral player.
const source=readFileSync(join(__dirname,'../../media/browser/apps/frappe.js'),'utf8')+'\n'+readFileSync(join(player,'guide.js'),'utf8');
const course=JSON.parse(readFileSync(join(media,'course.json'),'utf8'));
const {equal,dependencies}=require(join(player,'guide.js'));
test('ERPNext exposes only the frontend on loopback and preserves one shared stack with bounded services',()=>{
  const services=erpServices('localhost/training:version');
  assert.equal(services.length,8);
  assert.deepEqual(services.filter(s=>s.args?.includes('--publish')).map(s=>s.id),['frontend']);
  assert.deepEqual(services.find(s=>s.id==='frontend')?.args,['--publish','127.0.0.1::8080']);
  assert.ok(services.every(s=>s.memory));
  assert.ok(Object.values(ERP_IMAGES).every(image=>/@sha256:[a-f0-9]{64}$/.test(image)));
  assert.equal(sandboxPort('127.0.0.1:41923'),41923);
  for(const address of ['0.0.0.0:8080','127.0.0.1:0','127.0.0.1:99999','[::]:8080'])assert.throws(()=>sandboxPort(address));
  assert.equal(sandboxKey('same-profile:production'),sandboxKey('same-profile:production'));
  assert.notEqual(sandboxKey('account-a'),sandboxKey('account-b'));
});
test('ERPNext can provision an adequately sized new VM without stopping an existing runtime',()=>{
  const fresh=machineSetup([],8192);assert.equal(fresh[0][fresh[0].indexOf('--memory')+1],'8192');
  assert.deepEqual(machineSetup([{Name:'my-running-courses',Running:true}],8192),[]);
  assert.deepEqual(machineSetup([{Name:'my-stopped-courses',Running:false}],8192),[['machine','start','my-stopped-courses']]);
});
test('saved-record checks reject wrong parties, extra rows, unsent drafts and incorrect quantities',()=>{
  const expected={company:'Training a',docstatus:1,items:[{item_code:'widget',qty:5}]};
  assert.ok(equal({...expected,name:'STE-1',owner:'learner'},expected));
  assert.ok(!equal({...expected,company:'Training b'},expected));
  assert.ok(!equal({...expected,docstatus:0},expected));
  assert.ok(!equal({...expected,items:[{item_code:'widget',qty:4}]},expected));
  assert.ok(!equal({...expected,items:[...expected.items,...expected.items]},expected));
  for(const value of [null,undefined,'']) assert.ok(!equal(value,0));
});
function fixture(user='learner-0123456789abcdef0123@training.invalid', published?:any) {
  const dom=new JSDOM('<!doctype html><body><input id="currency"></body>',{url:'http://127.0.0.1:43210/desk',runScripts:'outside-only'});
  const w=dom.window as any, doc={doctype:'Company',name:'Training 0123456789',default_currency:'INR'};
  let saved:any={...doc}, dirty=false, fail=false, fills=0;
  w.frappe={session:{user},ui:{form:{}},datetime:{get_today:()=> '2026-11-11'},set_route:async()=>{},new_doc:async()=>{}};
  w.cur_frm={doctype:'Company',doc,fields_dict:{default_currency:{wrapper:w.document.querySelector('input')}},
    is_new:()=>false,is_dirty:()=>dirty,set_value:async()=>{fills++;}};
  if(published)w.sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:40000',token:'a'.repeat(64),learner:'0123456789abcdef0123'}));
  w.fetch=async(path:string)=>path.includes('course.json')||path.endsWith('/course')?{ok:true,text:async()=>JSON.stringify(published??course)}:{ok:!fail,json:async()=>({data:saved})};
  w.AbortSignal={timeout:()=>undefined};
  w.eval(source);
  return {w,dom,setSaved:(v:any)=>saved=v,setDirty:(v:boolean)=>dirty=v,setFail:(v:boolean)=>fail=v,fills:()=>fills};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
test('connected guide renders the published task definition instead of the bundled copy',async()=>{
  const updated=JSON.parse(JSON.stringify(course));updated.version='revision-2';
  updated.lessons[0].steps[0].text='Published course update: inspect the currency.';
  const f=fixture(undefined,updated);await tick();
  assert.equal(f.w.dhimantaiErpGuide.current().steps[0].text,'Published course update: inspect the currency.');
  f.dom.window.close();
});
test('guide verifies saved API data, not unsaved form values, and scopes progress to the ERPNext login',async()=>{
  const f=fixture();await tick();
  const root=f.w.document.querySelector('#dhimantai-guide').shadowRoot;
  f.setDirty(true);root.querySelector('#check').click();await tick();
  assert.match(root.querySelector('#status').textContent,/Save your changes/);
  f.setDirty(false);f.setFail(true);root.querySelector('#check').click();await tick();
  assert.match(root.querySelector('#status').textContent,/Could not verify/);f.setFail(false);
  f.setDirty(false);f.setSaved({name:'Training other',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'});
  root.querySelector('#check').click();await tick();
  assert.match(root.querySelector('#status').textContent,/does not match/);
  f.setSaved({name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'});
  root.querySelector('#check').click();await tick();
  assert.match(root.querySelector('#status').textContent,/Saved work verified/);
  const key=f.w.localStorage.key(0);
  assert.match(key,/learner-0123456789abcdef0123@training.invalid/);
  assert.equal(JSON.parse(f.w.localStorage.getItem(key)).done.company.record,'Training 0123456789');
  assert.equal(f.fills(),0,'checking never edits the ERPNext document');f.dom.window.close();
});
test('guide does not activate for Administrator or unrelated ERPNext accounts',async()=>{
  const f=fixture('Administrator');await tick();assert.equal(f.w.document.querySelector('#dhimantai-guide'),null);f.dom.window.close();
});
test('Next task appears only after the saved record is verified',async()=>{
  const f=fixture();await tick();const root=f.w.document.querySelector('#dhimantai-guide').shadowRoot;
  const check=root.querySelector('#check');
  assert.equal(root.querySelector('#next'),null,'no manual step gate: the step follows the form');
  assert.equal(check.textContent,'Check saved work');
  const company={name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'};
  f.setSaved({...company,default_currency:'USD'});
  check.click();await tick();assert.equal(root.querySelector('#lesson').value,'0');
  assert.match(root.querySelector('#status').textContent,/differs in: default currency/i);
  assert.equal(check.textContent,'Check saved work');
  f.setSaved(company);
  check.click();await tick();
  assert.equal(check.hidden,true,'a matching record is not the end: the learner explains it first');
  const explain=root.querySelector('#explain'),box=root.querySelector('#explanation'),send=root.querySelector('#send-explanation');
  assert.equal(explain.hidden,false);assert.match(root.querySelector('#question').textContent,/receivable and the payable/);
  box.value='Too short';box.dispatchEvent(new f.w.Event('input'));assert.equal(send.disabled,true);
  box.value='Receivable is money customers owe us; payable is what we owe suppliers. Billing a customer grows receivable.';
  box.dispatchEvent(new f.w.Event('input'));assert.equal(send.disabled,false);
  send.click();await tick();
  assert.equal(explain.hidden,true);assert.equal(check.hidden,false);assert.equal(check.textContent,'Next task');
  assert.equal(JSON.parse(f.w.localStorage.getItem(f.w.localStorage.key(0))).done.company.explained,true);
  check.click();await tick();assert.equal(root.querySelector('#lesson').value,'1');
  assert.equal(check.textContent,'Check saved work');
  assert.equal(JSON.parse(f.w.localStorage.getItem(f.w.localStorage.key(0))).done.company.record,'Training 0123456789');
  f.dom.window.close();
});
test('example help fills an ERPNext-prefilled matching item once and preserves unrelated rows',async()=>{
  for(const item of ['TRAINING-WIDGET-0123456789','MY-OWN-ITEM']) {
    const f=fixture();await tick();const w=f.w,root=w.document.querySelector('#dhimantai-guide').shadowRoot;
    const row={doctype:'Purchase Order Item',name:'row-1',item_code:item,qty:1,rate:0};let writes=0;
    w.cur_frm={doctype:'Purchase Order',doc:{company:'Training 0123456789',supplier:'Training Supplier 0123456789',schedule_date:'2026-11-11',items:[row]},
      is_new:()=>true,is_dirty:()=>true,fields_dict:{},clear_table:()=>{throw new Error('Must preserve the existing row');},add_child:()=>{throw new Error('Must not duplicate the row');},refresh_field(){},dirty(){}};
    w.frappe.model={set_value:async(_doctype:string,_name:string,field:string,value:any)=>{writes++;await tick();(row as any)[field]=value;}};
    root.querySelector('#lesson').value='4';root.querySelector('#lesson').dispatchEvent(new w.Event('change'));
    assert.equal(w.dhimantaiErpGuide.step(),3,'company, supplier and date already match, so the item rows are next');
    root.querySelector('#fill').click();root.querySelector('#fill').click();
    await new Promise(resolve=>setTimeout(resolve,80));
    if(item.startsWith('TRAINING')){assert.equal(row.qty,5);assert.equal(row.rate,100);assert.equal(writes,3,'only values that differ are written; the matching item code is kept');}
    else{assert.equal(writes,0);assert.equal(row.qty,1);assert.match(root.querySelector('#status').textContent,/unrelated rows/);}
    f.dom.window.close();
  }
});
test('navigating to another task discards an in-flight completion check',async()=>{
  const f=fixture();await tick();const root=f.w.document.querySelector('#dhimantai-guide').shadowRoot;
  let resolve!:Function;f.w.fetch=()=>new Promise(r=>{resolve=r;});
  root.querySelector('#check').click();root.querySelector('#lesson').value='1';root.querySelector('#lesson').dispatchEvent(new f.w.Event('change'));
  resolve({ok:true,json:async()=>({data:{name:'Training 0123456789',default_currency:'INR'}})});await tick();
  const key=f.w.localStorage.key(0);assert.equal(JSON.parse(f.w.localStorage.getItem(key)).done.company,undefined);
  f.dom.window.close();
});
test('the current step is the first field that does not yet hold the task value, and the bar follows typing',async()=>{
  const f=fixture();await tick();const w=f.w,root=w.document.querySelector('#dhimantai-guide').shadowRoot;
  const doc:any={customer_name:'Training Customer 0123456789',customer_type:'Company'};
  w.cur_frm={doctype:'Customer',doc,is_new:()=>true,is_dirty:()=>true,fields_dict:{customer_group:{df:{label:'Customer Group'}}}};
  root.querySelector('#lesson').value='1';root.querySelector('#lesson').dispatchEvent(new w.Event('change'));
  assert.equal(w.dhimantaiErpGuide.step(),2);
  assert.match(root.querySelector('[aria-current="step"]').textContent,/Customer Group/);
  assert.match(root.querySelector('#now').textContent,/Customer Group: Choose the group/);
  assert.doesNotMatch(root.querySelector('#now').textContent,/Commercial/,'a decision step does not give away its value');
  root.querySelector('#reveal').click();
  assert.match(root.querySelector('#now').textContent,/Commercial/);
  assert.equal(JSON.parse(w.localStorage.getItem(w.localStorage.key(0))).assisted.customer,true,'revealing the value is recorded as help');
  assert.equal([...root.querySelectorAll('#steps button')].filter((b:any)=>b.textContent.startsWith('✓')).length,2);
  doc.customer_group='Commercial';doc.territory='India';
  assert.equal(w.dhimantaiErpGuide.step(),3);
  root.querySelector('#lesson').dispatchEvent(new w.Event('change'));
  assert.match(root.querySelector('#now').textContent,/Every field matches. Save in ERPNext/);
  assert.equal(root.querySelector('#fill').hidden,true);
  f.dom.window.close();
});
test('dhimantAI-held verified tasks restore progress and start at the first unverified task',async()=>{
  const published={...course,verified:{company:{record:'Training 0123456789',checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true}}};
  const f=fixture(undefined,published);await tick();const root=f.w.document.querySelector('#dhimantai-guide').shadowRoot;
  assert.equal(root.querySelector('#lesson').value,'1');
  assert.match(root.querySelector('#lesson option').textContent,/^✓ 1\./);
  f.dom.window.close();
});
test('the course is one business story: masters, buy-to-pay, sell-to-collect, then a recipe',()=>{
  const ids=course.lessons.map((l:any)=>l.id);
  assert.deepEqual(ids,['company','customer','supplier','item','buying','stock','payables','pay-supplier','selling','delivery','receivables','collect','manufacturing',
    'retail-customer','retail-order','retail-delivery','retail-invoice','retail-payment']);
  const byId=Object.fromEntries(course.lessons.map((l:any)=>[l.id,l]));
  assert.deepEqual(course.lessons.filter((l:any)=>l.source).map((l:any)=>[l.id,l.source.task]),
    [['stock','buying'],['payables','stock'],['pay-supplier','payables'],['delivery','selling'],['receivables','delivery'],['collect','receivables'],
     ['retail-delivery','retail-order'],['retail-invoice','retail-delivery'],['retail-payment','retail-invoice']]);
  assert.deepEqual(course.lessons.map((l:any)=>l.guidance??'full'),[...Array(8).fill('full'),...Array(5).fill('goals'),...Array(5).fill('none')],'help fades, then a challenge');
  for(const lesson of course.lessons) {
    assert.ok(lesson.steps.length && lesson.scenario && lesson.explain, lesson.id);
    for(const dep of dependencies(lesson))assert.ok(ids.indexOf(dep)<ids.indexOf(lesson.id),`${lesson.id} depends only on earlier tasks`);
    if(!lesson.readOnly && !['Customer','Supplier','Item'].includes(lesson.doctype))assert.equal(lesson.expected.docstatus,1,`${lesson.id} is submitted, so it really changes stock or the ledger`);
  }
  assert.equal(byId.stock.expected.items[0].qty,4,'the short delivery is a decision, not the copied order quantity');
  assert.equal(byId.payables.expected.items[0].qty,4,'the bill follows the receipt');
  assert.ok(byId['pay-supplier'].also.some((a:any)=>a.expected.outstanding_amount===0));
});
test('a task created from an earlier record waits for it, opens it, and links to it',async()=>{
  const f=fixture();await tick();const w=f.w,root=w.document.querySelector('#dhimantai-guide').shadowRoot;
  const routes:any[]=[];w.frappe.set_route=async(...args:any[])=>{routes.push(args);};
  root.querySelector('#lesson').value='5';root.querySelector('#lesson').dispatchEvent(new w.Event('change'));
  assert.match(root.querySelector('#now').textContent,/Finish “5\. Order from your supplier” first/);
  assert.equal(root.querySelector('#open').disabled,true);
  const key=w.localStorage.key(0),state=JSON.parse(w.localStorage.getItem(key));
  state.done.buying={record:'PUR-ORD-1',checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true};state.lesson=5;
  w.localStorage.setItem(key,JSON.stringify(state));f.dom.window.close();
  const g=fixture();await tick();const r=g.w.document.querySelector('#dhimantai-guide').shadowRoot;const opened:any[]=[];
  g.w.frappe.set_route=async(...args:any[])=>{opened.push(args);};
  g.w.localStorage.setItem(g.w.localStorage.key(0),JSON.stringify(state));g.dom.window.close();
  // Reload with the saved state, as the learner reopening ERPNext would.
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1:43210/desk',runScripts:'outside-only'});const x=dom.window as any;
  x.localStorage.setItem(key,JSON.stringify(state));
  x.frappe={session:{user:'learner-0123456789abcdef0123@training.invalid'},ui:{form:{}},datetime:{get_today:()=> '2026-11-11'},set_route:async(...args:any[])=>{opened.push(args);}};
  x.cur_frm={doctype:'Purchase Order',doc:{name:'PUR-ORD-1'},fields_dict:{},is_new:()=>false,is_dirty:()=>false};
  x.fetch=async()=>({ok:true,text:async()=>JSON.stringify(course)});x.AbortSignal={timeout:()=>undefined};x.eval(source);await tick();
  const root2=x.document.querySelector('#dhimantai-guide').shadowRoot;
  assert.equal(root2.querySelector('#open').textContent,'Open Purchase Order');
  assert.match(root2.querySelector('#now').textContent,/On this Purchase Order, choose Create → Purchase Receipt/);
  root2.querySelector('#open').click();await tick();assert.deepEqual(opened.at(-1),['Form','Purchase Order','PUR-ORD-1']);
  assert.equal(x.dhimantaiErpGuide.current().expected.items[0].purchase_order,'PUR-ORD-1','the link check uses the learner\'s own order');
  dom.window.close();
});
test('a payment counts only when the invoice it settles is no longer outstanding',async()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1:43210/desk',runScripts:'outside-only'});const x=dom.window as any;
  const user='learner-0123456789abcdef0123@training.invalid',key=`dhimantai-browser:erpnext-essentials:v${course.version}:${user}`;
  const done=(record:string)=>({record,checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true});
  x.localStorage.setItem(key,JSON.stringify({lesson:7,done:{payables:done('ACC-PINV-1')}}));
  const pe:any={name:'ACC-PAY-1',company:'Training 0123456789',payment_type:'Pay',party:'Training Supplier 0123456789',paid_from:'Cash - 0123456789',paid_amount:400,docstatus:1,
    references:[{reference_doctype:'Purchase Invoice',reference_name:'ACC-PINV-1',allocated_amount:400}]};
  let outstanding=400;
  x.frappe={session:{user},ui:{form:{}},datetime:{get_today:()=> '2026-11-11'},set_route:async()=>{}};
  x.cur_frm={doctype:'Payment Entry',doc:pe,fields_dict:{},is_new:()=>false,is_dirty:()=>false};
  x.fetch=async(url:string)=>url.includes('course.json')?{ok:true,text:async()=>JSON.stringify(course)}
    :{ok:true,json:async()=>({data:url.includes('Purchase%20Invoice')?{name:'ACC-PINV-1',outstanding_amount:outstanding}:pe})};
  x.AbortSignal={timeout:()=>undefined};x.eval(source);await tick();
  const root=x.document.querySelector('#dhimantai-guide').shadowRoot;
  root.querySelector('#check').click();await tick();await tick();
  assert.match(root.querySelector('#status').textContent,/not true yet: The supplier’s bill shows nothing outstanding/);
  outstanding=0;root.querySelector('#check').click();await tick();await tick();
  assert.match(root.querySelector('#status').textContent,/Saved work verified\. The supplier’s bill shows nothing outstanding\. Before explaining, make your prediction/);
  assert.equal(root.querySelector('#explain').hidden,true,'a skipped prediction comes before the explanation');
  assert.match(root.querySelector('#predict-note').textContent,/finished before predicting/);
  root.querySelector('input[name="prediction"][value="1"]').click();root.querySelector('#lock-prediction').click();await tick();await tick();
  assert.match(root.querySelector('#result').textContent,/Not what you predicted\. You predicted “Cash goes down; Creditors goes up” \(after submitting\)\. The answer is “Cash goes down; Creditors goes down”/);
  assert.equal(root.querySelector('#explain').hidden,false);
  dom.window.close();
});
test('live observation sends current authored form fields, excludes passwords and other companies, and supports pause',async(t)=>{
  const f=fixture();await tick();const w=f.w,root=w.document.querySelector('#dhimantai-guide').shadowRoot;
  t.after(()=>f.dom.window.close());
  Object.defineProperty(w.document,'hidden',{value:false});
  const callbacks=new Map<number,Function>(),requests:any[]=[];
  w.setInterval=(fn:Function,ms:number)=>{callbacks.set(ms,fn);return ms;};
  w.frappe.get_route=()=>['Form','Company',w.cur_frm.doc.name];
  w.cur_frm.doc.password='never send this';w.cur_frm.doc.docstatus=0;
  w.sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:12345',token:'a'.repeat(64),learner:'0123456789abcdef0123'}));
  w.fetch=async(url:string,options:any)=>{
    if(url.endsWith('/state'))return {ok:true,json:async()=>({connected:true,detail:'Instructor is following this ERPNext task.'})};
    requests.push({url,body:options.body&&JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true})};
  };
  w.eval(readFileSync(join(player,'live.js'),'utf8'));await tick();
  assert.deepEqual(requests[0].body.fields,{default_currency:'INR',default_receivable_account:null,default_payable_account:null});
  assert.ok(!JSON.stringify(requests).includes('never send this'));
  w.cur_frm.doc.default_currency='USD';w.document.dispatchEvent(new w.Event('input'));
  callbacks.get(900)!();await tick();assert.equal(requests.at(-1).body.fields.default_currency,'USD');
  w.cur_frm.doc.name='Training someone-else';callbacks.get(900)!();await tick();assert.deepEqual(requests.at(-1).body.fields,{});
  const follow=root.querySelector('#follow-browser');follow.checked=false;follow.dispatchEvent(new w.Event('change'));await tick();
  assert.equal(requests.at(-1).body.clear,true);
  const count=requests.length;w.cur_frm.doc.default_currency='EUR';callbacks.get(900)!();await tick();assert.equal(requests.length,count);
  assert.ok(requests.every(r=>r.url.endsWith('/observe')),'passive edits do not ask the Instructor or invoke a model');
  f.dom.window.close();
});
test('a failed check or ERPNext error offers help but never asks the Instructor in the learner\'s name',async(t)=>{
  const f=fixture();await tick();const w=f.w,root=w.document.querySelector('#dhimantai-guide').shadowRoot;
  t.after(()=>f.dom.window.close());
  Object.defineProperty(w.document,'hidden',{value:false});
  const callbacks=new Map<number,Function>(),requests:any[]=[];
  w.setInterval=(fn:Function,ms:number)=>{callbacks.set(ms,fn);return ms;};
  w.frappe.get_route=()=>['Form','Company',w.cur_frm.doc.name];w.cur_frm.doc.docstatus=0;
  w.sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:12345',token:'a'.repeat(64),learner:'0123456789abcdef0123'}));
  w.fetch=async(url:string,options:any)=>{
    if(url.endsWith('/state'))return {ok:true,json:async()=>({connected:true,detail:'Instructor is following this ERPNext task.'})};
    if(url.includes('/api/resource/'))return {ok:true,json:async()=>({data:{name:'Training 0123456789',default_currency:'USD'}})};
    requests.push({url,body:options?.body&&JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true})};
  };
  w.eval(readFileSync(join(player,'live.js'),'utf8'));await tick();
  callbacks.get(3000)!();await tick();
  root.querySelector('#check').click();await tick();await tick();
  const err=w.document.createElement('div');err.className='alert-danger';err.textContent='Customer Group is mandatory';
  err.getClientRects=()=>[{}];w.document.body.append(err);callbacks.get(900)!();await tick();
  assert.ok(!requests.some(r=>r.url.endsWith('/help')),'no automatic help request');
  const ask=root.querySelector('#ask-instructor');assert.equal(ask.textContent,'Ask Instructor about this');
  ask.click();await tick();await tick();
  assert.equal(requests.filter(r=>r.url.endsWith('/help')).length,1);
  assert.match(requests.find(r=>r.url.endsWith('/help')).body.message,/ERPNext reported a problem/);
  w.fetch=async(url:string,options:any)=>{
    if(url.includes('/api/resource/'))return {ok:true,json:async()=>({data:{name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'}})};
    requests.push({url,body:options?.body&&JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true,connected:true})};
  };
  w.cur_frm.doc.default_currency='INR';w.cur_frm.doc.default_receivable_account='Debtors - 0123456789';w.cur_frm.doc.default_payable_account='Creditors - 0123456789';
  root.querySelector('#check').click();await tick();await tick();
  assert.ok(!requests.some(r=>r.url.endsWith('/progress')),'a check alone does not complete the task');
  const box=root.querySelector('#explanation');box.value='Receivable is what customers owe us, payable is what we owe suppliers.';
  box.dispatchEvent(new w.Event('input'));root.querySelector('#send-explanation').click();await tick();await tick();
  const progress=requests.find(r=>r.url.endsWith('/progress'));
  assert.equal(progress.body.task,'company');assert.equal(progress.body.record,'Training 0123456789');assert.equal(progress.body.explained,true);
  const explanation=requests.filter(r=>r.url.endsWith('/help')).at(-1).body.message;
  assert.match(explanation,/My answer: Receivable is what customers owe us/);assert.match(explanation,/Question: In your own words/);
});
test('launch signs the learner in through dhimantAI, removes the secret from the address and falls back to the sign-in page',async()=>{
  for(const bridgeOk of [true,false]) {
    const token='b'.repeat(64);
    const dom=new JSDOM('<!doctype html><p id="status"></p>',{url:`http://127.0.0.1:43210/assets/frappe/dhimantai/launch.html#learner=0123456789abcdef0123&bridge=40000&token=${token}`,runScripts:'outside-only'});
    const w=dom.window as any,calls:any[]=[],replaced:string[]=[];
    w.AbortSignal={timeout:()=>undefined};
    w.fetch=async(url:string,options:any)=>{calls.push({url,options});
      if(url.endsWith('/signin'))return bridgeOk?{ok:true,json:async()=>({usr:'learner-0123456789abcdef0123@training.invalid',pwd:'pw'})}:{ok:false};
      return {ok:true};};
    // jsdom cannot navigate; observe the page's navigation target instead.
    w.go=(url:string)=>replaced.push(url);
    w.eval(readFileSync(join(media,'launch.js'),'utf8').replaceAll('location.replace(','go('));await tick();
    assert.equal(w.location.hash,'','launch token leaves the address bar');
    assert.equal(calls[0].url,'http://127.0.0.1:40000/signin');assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);
    if(bridgeOk){assert.equal(calls[1].url,'/api/method/login');assert.match(String(calls[1].options.body),/usr=learner/);assert.deepEqual(replaced,['/desk']);}
    else assert.deepEqual(replaced,['/login?redirect-to=/desk']);
    dom.window.close();
  }
});
test('reopening a master-data task opens the learner\'s existing record instead of creating a duplicate',async()=>{
  const f=fixture();await tick();const w=f.w,root=w.document.querySelector('#dhimantai-guide').shadowRoot;
  const routes:any[]=[],asked:string[]=[];
  w.frappe.set_route=async(...args:any[])=>{routes.push(args);};
  w.fetch=async(url:string)=>{asked.push(url);return {ok:true,json:async()=>({data:[{name:'CUST-0001'}]})};};
  w.cur_frm={doctype:'Company',doc:{},fields_dict:{},is_new:()=>false,is_dirty:()=>false};
  root.querySelector('#lesson').value='1';root.querySelector('#lesson').dispatchEvent(new w.Event('change'));
  root.querySelector('#open').click();await tick();
  assert.match(decodeURIComponent(asked[0]),/\/api\/resource\/Customer\?filters=\[\["customer_name","=","Training Customer 0123456789"\]\]/);
  assert.deepEqual(routes.at(-1),['Form','Customer','CUST-0001']);
  assert.match(root.querySelector('#status').textContent,/created this record before/);
  f.dom.window.close();
});

function lessonFixture(index:number, frm:any, fetcher?:(url:string)=>any, done:Record<string,string>={}) {
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1:43210/desk',runScripts:'outside-only'});const x=dom.window as any;
  const user='learner-0123456789abcdef0123@training.invalid',key=`dhimantai-browser:erpnext-essentials:v${course.version}:${user}`;
  x.localStorage.setItem(key,JSON.stringify({lesson:index,done:Object.fromEntries(Object.entries(done).map(([id,record])=>[id,{record,checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true}]))}));
  x.frappe={session:{user},ui:{form:{}},datetime:{get_today:()=> '2026-11-11'},set_route:async()=>{}};
  x.cur_frm=frm;x.AbortSignal={timeout:()=>undefined};
  x.fetch=async(url:string)=>url.includes('course.json')?{ok:true,text:async()=>JSON.stringify(course)}:{ok:true,json:async()=>({data:fetcher?.(url)})};
  x.eval(source);
  return {x,dom,key,root:()=>x.document.querySelector('#dhimantai-guide').shadowRoot};
}
test('with situation-only guidance the bar shows no fields, values, highlights or example help, and never says the form matches',async()=>{
  const doc:any={company:'Training 0123456789',customer:'Training Customer 0123456789',delivery_date:'2026-11-11',docstatus:0,
    items:[{item_code:'TRAINING-WIDGET-0123456789',qty:2,rate:150,delivery_date:'2026-11-11'}]};
  const f=lessonFixture(8,{doctype:'Sales Order',doc,fields_dict:{customer:{wrapper:null}},is_new:()=>true,is_dirty:()=>true});await tick();
  const root=f.root();
  assert.equal(root.querySelector('#steps').hidden,true);assert.equal(root.querySelector('#fill').hidden,true);
  assert.equal(root.querySelector('#count').textContent,'Situation only');
  assert.match(root.querySelector('#now').textContent,/phones: they want 2 widgets.*Save and Submit when you think it is right/);
  assert.doesNotMatch(root.querySelector('#now').textContent,/Every field matches/);
  assert.equal(root.querySelector('#predict').hidden,false,'the prediction is asked before Submit');
  f.dom.window.close();
});
test('a prediction locked in before Submit is shown next to ERPNext’s real stock after the check',async()=>{
  const doc:any={name:'PUR-ORD-9',company:'Training 0123456789',supplier:'Training Supplier 0123456789',schedule_date:'2026-11-11',docstatus:0,
    items:[{item_code:'TRAINING-WIDGET-0123456789',qty:5,rate:100,schedule_date:'2026-11-11'}]};
  let dirty=false;const asked:string[]=[];
  const f=lessonFixture(4,{doctype:'Purchase Order',doc,fields_dict:{},is_new:()=>false,is_dirty:()=>dirty},url=>{asked.push(decodeURIComponent(url));return url.includes('/Bin')?[{actual_qty:0}]:doc;});await tick();
  const root=f.root();
  assert.equal(root.querySelector('#predict').hidden,false);assert.equal(root.querySelector('#predict-question').textContent,'After you submit this order, how many widgets will be in Stores?');
  assert.equal(root.querySelector('#lock-prediction').disabled,true);
  root.querySelector('input[name="prediction"][value="0"]').click();assert.equal(root.querySelector('#lock-prediction').disabled,false);
  root.querySelector('#lock-prediction').click();await tick();
  assert.equal(root.querySelector('#predict').hidden,true);
  assert.equal(JSON.parse(f.x.localStorage.getItem(f.key)).predictions.buying.early,true);
  doc.docstatus=1;root.querySelector('#check').click();await tick();await tick();await tick();
  assert.ok(asked.some(u=>u.includes('/api/resource/Bin')&&u.includes('Stores - 0123456789')));
  assert.match(root.querySelector('#result').textContent,/Your prediction was right\. You predicted “0”\. ERPNext shows: 0 in Stores - 0123456789\./);
  assert.equal(root.querySelector('#explain').hidden,false);
  f.dom.window.close();
});
test('the final challenge gives no field hints: a failed check says how many things differ, and naming them is recorded as help',async()=>{
  const doc:any={name:'CUST-9',customer_name:'Training Retail 0123456789',customer_type:'Company',customer_group:'Commercial',territory:'India'};
  const f=lessonFixture(13,{doctype:'Customer',doc,fields_dict:{},is_new:()=>false,is_dirty:()=>false},()=>doc);await tick();
  const root=f.root();
  assert.equal(root.querySelector('#count').textContent,'Challenge · no hints');assert.equal(root.querySelector('#steps').hidden,true);
  assert.equal(root.querySelector('#open').textContent,'Reopen task');
  root.querySelector('#check').click();await tick();await tick();
  const status=root.querySelector('#status');
  assert.match(status.textContent,/does not meet the brief yet \(2 differences\)/);assert.doesNotMatch(status.textContent,/Customer group/i);
  status.querySelector('button').click();
  assert.match(status.textContent,/differs in: Customer type, Customer group/);
  assert.equal(JSON.parse(f.x.localStorage.getItem(f.key)).assisted['retail-customer'],true);
  f.dom.window.close();
});
test('a challenge task created from an earlier record opens it without naming the Create menu path',async()=>{
  const f=lessonFixture(15,{doctype:'Sales Order',doc:{name:'SAL-ORD-7'},fields_dict:{},is_new:()=>false,is_dirty:()=>false},undefined,{'retail-order':'SAL-ORD-7'});await tick();
  const root=f.root();
  assert.equal(root.querySelector('#open').textContent,'Open task');
  assert.doesNotMatch(root.querySelector('#now').textContent,/Create →/);
  assert.match(root.querySelector('#now').textContent,/Send Asha her 2 widgets/);
  f.dom.window.close();
});
