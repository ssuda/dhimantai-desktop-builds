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
const loadDeskRecord = async ({args}: {args: {doctype:string; name:string}}) => ({docs:[args]});
function fixture(user='learner-0123456789abcdef0123@training.invalid', published?:any, stored?:any) {
  const dom=new JSDOM('<!doctype html><body><input id="currency"></body>',{url:'http://127.0.0.1:43210/desk',runScripts:'outside-only'});
  const w=dom.window as any, doc={doctype:'Company',name:'Training 0123456789',default_currency:'INR'};
  let saved:any={...doc}, dirty=false, fail=false, fills=0;
  w.frappe={session:{user},ui:{form:{}},datetime:{get_today:()=> '2026-11-11'},call:loadDeskRecord,set_route:async()=>{},new_doc:async()=>{}};
  w.cur_frm={doctype:'Company',doc,fields_dict:{default_currency:{wrapper:w.document.querySelector('input')}},
    is_new:()=>false,is_dirty:()=>dirty,set_value:async()=>{fills++;}};
  if(published)w.sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:40000',token:'a'.repeat(64),learner:'0123456789abcdef0123'}));
  w.fetch=async(path:string)=>path.includes('course.json')||path.endsWith('/course')?{ok:true,text:async()=>JSON.stringify(published??course)}:{ok:!fail,json:async()=>({data:saved})};
  w.AbortSignal={timeout:()=>undefined};
  if(stored)w.localStorage.setItem(`dhimantai-browser:${course.id}:v${published?.version??course.version}:${user}`,JSON.stringify(stored));
  w.eval(source);
  return {w,dom,setSaved:(v:any)=>saved=v,setDirty:(v:boolean)=>dirty=v,setFail:(v:boolean)=>fail=v,fills:()=>fills};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
test('opening new and saved forms from the course asks Frappe to select a sidebar containing the destination',async()=>{
  const f=fixture(),w=f.w,routes:any[]=[];
  try {
    await tick();
    w.frappe.route_flags={custom_flag:true};
    w.frappe.model={with_doctype:async()=>{},get_new_doc:(doctype:string)=>({name:'new-'+doctype})};
    w.frappe.set_route=async(...args:any[])=>{
      routes.push({args,jump:w.frappe.route_flags.jump,custom:w.frappe.route_flags.custom_flag});
      w.cur_frm={...w.cur_frm,doctype:args[1],doc:{name:args[2]}};
      w.frappe.route_flags={}; // Frappe consumes flags once per navigation.
    };
    await w.dhimantaiApp.openNew('Item');
    assert.deepEqual(routes[0],{args:['Form','Item','new-Item'],jump:true,custom:true});
    await w.dhimantaiApp.openRecord('Purchase Order','PUR-ORD-1');
    assert.deepEqual(routes[1],{args:['Form','Purchase Order','PUR-ORD-1'],jump:true,custom:undefined});
  } finally {f.dom.window.close();}
});
test('restart reopens the pending saved supplier for observation without resubmitting or completing it',async()=>{
  const published=JSON.parse(JSON.stringify(course)),record='Training Supplier 0123456789';
  const checkedAt='2026-11-14T03:00:00Z';
  published.verified={company:{record:'Training 0123456789',explained:true},
    customer:{record:'Training Customer 0123456789',explained:true},
    supplier:{record,checkedAt,assisted:false,explained:false}};
  const f=fixture(undefined,published),w=f.w,opened:any[]=[],observed:any[]=[],focused:any[]=[];
  try {
    w.cur_frm=undefined;
    w.frappe.set_route=async(...route:any[])=>{
      opened.push(route);
      w.cur_frm={doctype:'Supplier',doc:{name:record,supplier_name:record,supplier_type:'Company',supplier_group:'All Supplier Groups'},
        is_new:()=>false,is_dirty:()=>false};
    };
    w.frappe.get_route=()=>['Form','Supplier',record];
    w.addEventListener('dhimantai-erp-focus',(e:any)=>focused.push(e.detail));
    await tick();
    const guide=w.dhimantaiErpGuide;
    assert.deepEqual(opened,[['Form','Supplier',record]]);
    assert.equal(guide.current().id,'supplier');
    assert.equal(guide.question().id,'supplier:explanation:'+checkedAt);
    assert.equal(focused.length,0,'reopen never submits or focuses an answer automatically');
    const read=w.fetch;
    w.fetch=async(url:string,options:any)=>{
      if(!url.startsWith('http://127.0.0.1:40000'))return read(url,options);
      if(url.endsWith('/observe'))observed.push(JSON.parse(options.body));
      return {ok:true,json:async()=>({ok:true})};
    };
    w.eval(readFileSync(join(player,'live.js'),'utf8'));await tick();
    assert.equal(observed[0].record,record);
    assert.equal(observed[0].fields.supplier_name,record,'Instructor receives the reopened form, not only the question text');
    assert.equal(guide.question().kind,'explanation');
    assert.equal(f.fills(),0);
    // Explicit handoff also reopens the checked record after browsing elsewhere.
    w.cur_frm={doctype:'Customer',doc:{name:'another'},is_new:()=>false,is_dirty:()=>true};
    await guide.root.querySelector('#open').onclick();
    assert.equal(opened.length,1,'an unsaved different form is never replaced');
    assert.equal(focused.length,0);
    w.cur_frm.is_dirty=()=>false;
    await guide.root.querySelector('#open').onclick();
    assert.equal(opened.length,2);assert.equal(focused[0].id,guide.question().id);
  }finally{f.dom.window.close();}
});
test('field guidance follows unfinished fields and clears on completion, panel close and navigation',async()=>{
  const published=JSON.parse(JSON.stringify(course));
  published.lessons[0].steps=published.lessons[0].steps.slice(0,2);
  const f=fixture(undefined,published),w=f.w;
  try {
    const currency=w.document.querySelector('#currency'),account=w.document.createElement('input');
    w.document.body.append(account);
    for(const field of [currency,account])field.getBoundingClientRect=()=>({left:100,top:200,width:300,height:40});
    w.cur_frm.fields_dict.default_receivable_account={wrapper:account};
    w.cur_frm.doc.default_currency='USD';
    await tick();
    const root=w.dhimantaiErpGuide.root;
    const refresh=()=>w.dispatchEvent(new w.Event('scroll'));
    const marked=()=>[...w.document.querySelectorAll('.dhimantai-guide-field')];
    assert.deepEqual(marked(),[currency],'only the unfinished field receives guidance');
    assert.equal(w.document.querySelector('body > div[style*="position: fixed"]'),null,'no floating box above application dialogs');
    w.cur_frm.doc.default_currency='INR';refresh();
    assert.deepEqual(marked(),[account],'the previous field loses its highlight');
    w.cur_frm.doc.default_receivable_account='Debtors - 0123456789';refresh();
    assert.deepEqual(marked(),[],'matching fields have no remaining highlight');
    w.cur_frm.doc.default_currency='USD';refresh();
    assert.deepEqual(marked(),[currency]);
    root.querySelector('#toggle').click();assert.deepEqual(marked(),[]);
    root.querySelector('#show-task').click();assert.deepEqual(marked(),[currency]);
    currency.remove();refresh();
    assert.equal(currency.classList.contains('dhimantai-guide-field'),false,'detached fields are cleaned up');
    w.document.body.append(currency);refresh();assert.deepEqual(marked(),[currency]);
    w.cur_frm.doctype='Purchase Receipt';refresh();
    assert.deepEqual(marked(),[],'navigating away clears the previous form');
  } finally {f.dom.window.close();}
});
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
  await f.w.dhimantaiErpGuide.continueTask('company');
  assert.equal(check.hidden,false,'the next action stays visible after a check');
  assert.equal(check.textContent,'Check saved work','the saved-record check remains available while explanation is pending');
  assert.equal(root.querySelector('#open').textContent,'Open answer box');
  assert.match(root.querySelector('#verification-status').textContent,/Saved work verified.*Explanation pending/);
  const guide=f.w.dhimantaiErpGuide,q=guide.question();
  assert.equal(root.querySelector('#explain').hidden,true,'the answer box is never shown in the browser');
  assert.match(q.question,/receivable and the payable/);
  assert.match(await guide.continueTask('company'),/Answer the current question/);
  assert.equal(root.querySelector('#lesson').value,'0','Continue cannot skip a pending question');
  assert.equal(await guide.answerQuestion(q.id,'Too short'),false);
  assert.equal(await guide.answerQuestion('old-task','A sufficiently long but stale explanation.'),false);
  assert.equal(await guide.answerQuestion(q.id,'Receivable is money customers owe us; payable is what we owe suppliers. Billing a customer grows receivable.'),true);
  assert.equal(guide.question(),null);assert.equal(check.hidden,false);assert.equal(check.textContent,'Next task');
  assert.equal(JSON.parse(f.w.localStorage.getItem(f.w.localStorage.key(0))).done.company.explained,true);
  const opened:string[]=[];f.w.dhimantaiApp.openNew=async(name:string)=>{opened.push(name);};
  check.click();await tick();assert.equal(root.querySelector('#lesson').value,'1');
  assert.deepEqual(opened,['Customer'],'Continue opens the next practical form');
  assert.match(await guide.continueTask('company'),/task changed/);
  assert.equal(root.querySelector('#lesson').value,'1','a stale Continue cannot skip another task');
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
  assert.match(root.querySelector('#steps [aria-current="step"]').textContent,/Customer Group/);
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
  const published={...course,verified:Object.fromEntries(course.lessons.slice(0,4).map((task:any)=>[task.id,
    {record:task.id+'-saved',checkedAt:'2026-11-11T00:00:00Z',assisted:false,explained:true}]))};
  const f=fixture(undefined,published,{lesson:3,done:published.verified});await tick();const root=f.w.document.querySelector('#dhimantai-guide').shadowRoot;
  assert.equal(root.querySelector('#lesson').value,'4');
  assert.equal([...root.querySelectorAll('#lesson option')].filter((option:any)=>option.textContent.startsWith('✓')).length,4);
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
  x.frappe={session:{user:'learner-0123456789abcdef0123@training.invalid'},ui:{form:{}},datetime:{get_today:()=> '2026-11-11'},call:loadDeskRecord,set_route:async(...args:any[])=>{opened.push(args);}};
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
  assert.match(root.querySelector('#status').textContent,/Saved work verified\. The supplier’s bill shows nothing outstanding\./);
  assert.equal(root.querySelector('#check').textContent,'Check saved work');
  assert.equal(root.querySelector('#open').textContent,'Open answer box');
  assert.equal(root.querySelector('#result').hidden,true,'verification never invents a late prediction');
  assert.equal(root.querySelector('#task-sequence [aria-current]').textContent,'Explain');
  assert.match(root.querySelector('#body').textContent,/Complete both the saved-record check and your explanation/);
  assert.equal(root.querySelector('#explain').hidden,true);
  assert.equal(x.dhimantaiErpGuide.question().kind,'explanation');
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
  callbacks.get(900)!();await tick();assert.equal(requests.filter(r=>r.url.endsWith('/observe')).at(-1).body.fields.default_currency,'USD');
  w.cur_frm.doc.name='Training someone-else';callbacks.get(900)!();await tick();assert.deepEqual(requests.filter(r=>r.url.endsWith('/observe')).at(-1).body.fields,{});
  const follow=root.querySelector('#follow-browser');follow.checked=false;follow.dispatchEvent(new w.Event('change'));await tick();
  assert.equal(requests.at(-1).body.clear,true);
  const count=requests.length;w.cur_frm.doc.default_currency='EUR';callbacks.get(900)!();await tick();assert.equal(requests.length,count);
  assert.ok(requests.every(r=>r.url.endsWith('/observe')||r.url.endsWith('/question')),'passive edits do not ask the Instructor or invoke a model');
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
  assert.equal(requests.filter(r=>r.url.endsWith('/progress')).at(-1).body.explained,false,'a check retains evidence without completing the explanation');
  const box=root.querySelector('#explanation');box.value='Receivable is what customers owe us, payable is what we owe suppliers.';
  box.dispatchEvent(new w.Event('input'));root.querySelector('#send-explanation').click();await tick();await tick();
  const progress=requests.filter(r=>r.url.endsWith('/progress')).at(-1);
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
  w.frappe.set_route=async(...args:any[])=>{
    routes.push(args);w.cur_frm={...w.cur_frm,doctype:args[1],doc:{name:args[2]}};
  };
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
test('Task 07 retries the verified receipt from a cached Desk error page at the same URL',async()=>{
  const receipt='MAT-PRE-2026-00001',doctype='Purchase Receipt',route=['Form',doctype,receipt];
  const receiptForm={doctype,doc:{name:receipt},fields_dict:{},is_dirty:()=>false,is_new:()=>false};
  const f=lessonFixture(6,receiptForm,undefined,{stock:receipt,buying:'PUR-ORD-1'});
  try {
    const w=f.x,desk=w.frappe,page=w.document.createElement('div');
    page.innerHTML='<div class="message-page"></div>';w.document.body.append(page);
    desk.container={page};desk.get_route=()=>route;desk.get_route_str=()=>route.join('/');
    desk.pages={[route.join('/')]:page};desk.after_ajax=async()=>{};
    const calls:string[]=[],routes:any[]=[];
    desk.call=async (request:any)=>{
      calls.push(request.method);
      assert.equal(request.type,'GET');assert.deepEqual({...request.args},{doctype,name:receipt});
      return loadDeskRecord(request);
    };
    desk.set_route=async(...args:any[])=>routes.push(args); // Desk leaves the current URL alone.
    desk.router={render:()=>{
      assert.equal(desk.pages[route.join('/')],undefined);
      desk.container.page={frm:receiptForm};
    }};
    await tick();
    assert.equal(w.dhimantaiApp.current(),undefined);
    assert.equal(w.dhimantaiApp.route(),'','an error page cannot tell Instructor that the receipt is open');
    const open=f.root().querySelector('#open');
    assert.equal(open.textContent,'Open Purchase Receipt');assert.equal(open.hidden,false);
    await open.onclick();
    assert.deepEqual(calls,['frappe.desk.form.load.getdoc']);assert.deepEqual(routes,[route]);
    assert.equal(w.dhimantaiApp.current().id,receipt);assert.equal(w.dhimantaiApp.route(),route.join('/'));
  } finally { f.dom.window.close(); }
});
test('unavailable Task 07 receipt links keep the learner on the current page and preserve the saved check',async()=>{
  const receipt='MAT-PRE-2026-00001',order='PUR-ORD-00001';
  const f=lessonFixture(6,{doctype:'Purchase Order',doc:{name:order},is_dirty:()=>false,is_new:()=>false},
    undefined,{stock:receipt,buying:order});
  try {
    await tick();
    const desk=f.x.frappe,root=f.root(),before=f.x.localStorage.getItem(f.key);
    let routes=0;
    desk.set_route=async()=>{routes++;};
    desk.call=async()=>({message:[]}); // Desk returns HTTP 200 for a missing document.
    await root.querySelector('#open').onclick();
    assert.match(root.querySelector('#status').textContent,/could not find Purchase Receipt MAT-PRE-2026-00001.*6\. Receive what arrived/);
    desk.call=async()=>{throw {status:403};};
    await root.querySelector(`#trail [title="Open ${receipt}"]`).onclick();
    assert.match(root.querySelector('#status').textContent,/session could not access Purchase Receipt MAT-PRE-2026-00001/);
    assert.equal(routes,0);assert.equal(f.x.localStorage.getItem(f.key),before);
  } finally { f.dom.window.close(); }
});
test('Task 06 can replace a stale receipt link only after the new receipt and its order pass their checks',async()=>{
  const tag='0123456789',order='PUR-ORD-1',old='MAT-PRE-1',name='MAT-PRE-2';
  const receipt={name,docstatus:1,company:'Training '+tag,supplier:'Training Supplier '+tag,
    items:[{item_code:'TRAINING-WIDGET-'+tag,qty:4,warehouse:'Stores - '+tag,purchase_order:order}]};
  let received=0;
  const f=lessonFixture(5,{doctype:'Purchase Receipt',doc:receipt,is_dirty:()=>false,is_new:()=>false},
    url=>url.includes('Purchase%20Order')?{per_received:received}:receipt,{buying:order,stock:old});
  try {
    await tick();
    const check=f.root().querySelector('#check'), saved=()=>JSON.parse(f.x.localStorage.getItem(f.key)).done.stock;
    assert.equal(check.textContent,'Check saved work');
    check.click();await tick();
    assert.equal(saved().record,old);
    assert.match(f.root().querySelector('#status').textContent,/80% received/);
    received=80;check.click();await tick();
    assert.equal(saved().record,name);assert.equal(saved().explained,false);
    assert.equal(f.x.dhimantaiErpGuide.question().kind,'explanation');
  } finally { f.dom.window.close(); }
});
test('with situation-only guidance the bar shows no fields, values, highlights or example help, and never says the form matches',async()=>{
  const doc:any={company:'Training 0123456789',customer:'Training Customer 0123456789',delivery_date:'2026-11-11',docstatus:0,
    items:[{item_code:'TRAINING-WIDGET-0123456789',qty:2,rate:150,delivery_date:'2026-11-11'}]};
  const f=lessonFixture(8,{doctype:'Sales Order',doc,fields_dict:{customer:{wrapper:null}},is_new:()=>true,is_dirty:()=>true});await tick();
  const root=f.root();
  assert.equal(root.querySelector('#steps').hidden,true);assert.equal(root.querySelector('#fill').hidden,true);
  assert.equal(root.querySelector('#count').textContent,'Task 9 of 18');
  assert.equal(root.querySelector('#field-details').hidden,true);
  assert.match(root.querySelector('#now').textContent,/phones: they want 2 widgets.*Save and Submit when you think it is right/);
  assert.doesNotMatch(root.querySelector('#now').textContent,/Every field matches/);
  assert.equal(root.querySelector('#predict').hidden,true);
  assert.equal(f.x.dhimantaiErpGuide.question().kind,'prediction','the prediction is ready in Instructor before Submit');
  f.dom.window.close();
});
test('a prediction locked in before Submit is shown next to ERPNext’s real stock after the check',async()=>{
  const doc:any={name:'PUR-ORD-9',company:'Training 0123456789',supplier:'Training Supplier 0123456789',schedule_date:'2026-11-11',docstatus:0,
    items:[{item_code:'TRAINING-WIDGET-0123456789',qty:5,rate:100,schedule_date:'2026-11-11'}]};
  let dirty=false;const asked:string[]=[];
  const f=lessonFixture(4,{doctype:'Purchase Order',doc,fields_dict:{},is_new:()=>false,is_dirty:()=>dirty},url=>{asked.push(decodeURIComponent(url));return url.includes('/Bin')?[{actual_qty:0}]:doc;});await tick();
  const root=f.root();
  const guide=f.x.dhimantaiErpGuide,q=guide.question();
  assert.equal(root.querySelector('#predict').hidden,true);
  assert.equal(q.question,'After you submit this order, how many widgets will be in Stores?');
  assert.equal(await guide.answerQuestion(q.id,'not an option'),false);
  assert.equal(await guide.answerQuestion(q.id,q.options[0]),true);
  assert.equal(JSON.parse(f.x.localStorage.getItem(f.key)).predictions.buying.early,true);
  doc.docstatus=1;root.querySelector('#check').click();await tick();await tick();await tick();
  assert.ok(asked.some(u=>u.includes('/api/resource/Bin')&&u.includes('Stores - 0123456789')));
  assert.match(root.querySelector('#result').textContent,/Your prediction was right\. You predicted “0”\. ERPNext shows: 0 in Stores - 0123456789\./);
  assert.equal(root.querySelector('#explain').hidden,true);
  assert.equal(f.x.dhimantaiErpGuide.question().kind,'explanation');
  f.dom.window.close();
});
test('the final challenge gives no field hints: a failed check says how many things differ, and naming them is recorded as help',async()=>{
  const doc:any={name:'CUST-9',customer_name:'Training Retail 0123456789',customer_type:'Company',customer_group:'Commercial',territory:'India'};
  const f=lessonFixture(13,{doctype:'Customer',doc,fields_dict:{},is_new:()=>false,is_dirty:()=>false},()=>doc);await tick();
  const root=f.root();
  assert.equal(root.querySelector('#count').textContent,'Task 14 of 18');assert.equal(root.querySelector('#steps').hidden,true);
  assert.equal(root.querySelector('#open').hidden,true,'the learner is already in the task');
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
test('a verified document shows its ledger evidence and explanation without reopening a skipped prediction',async()=>{
  const t='0123456789',doc:any={name:'MAT-PRE-1',company:'Training '+t,supplier:'Training Supplier '+t,docstatus:1,
    items:[{item_code:'TRAINING-WIDGET-'+t,qty:4,rate:100,warehouse:'Stores - '+t,purchase_order:'PUR-ORD-1'}]};
  const asked:string[]=[];
  const f=lessonFixture(5,{doctype:'Purchase Receipt',doc,fields_dict:{},is_new:()=>false,is_dirty:()=>false},url=>{
    const u=decodeURIComponent(url);asked.push(u);
    if(u.includes('/GL Entry'))return[{account:'Stock In Hand - '+t,debit:400,credit:0},{account:'Stock Received But Not Billed - '+t,debit:0,credit:400}];
    if(u.includes('/Stock Ledger Entry'))return[{item_code:'TRAINING-WIDGET-'+t,warehouse:'Stores - '+t,actual_qty:4,qty_after_transaction:4,stock_value_difference:400}];
    if(u.includes('/Bin'))return[{actual_qty:4}];
    return u.includes('Purchase Order')?{name:'PUR-ORD-1',per_received:80}:doc;
  },{buying:'PUR-ORD-1'});await tick();
  const root=f.root();
  assert.match(root.querySelector('#trail').textContent,/Document flow: Purchase Order PUR-ORD-1 → Purchase Receipt \(this task\)/);
  root.querySelector('#check').click();for(let i=0;i<6;i++)await tick();
  assert.equal(f.x.dhimantaiErpGuide.question().kind,'explanation');
  const posted=root.querySelector('#posted');
  assert.equal(posted.hidden,false);
  assert.ok(asked.some(u=>u.includes('["voucher_no","=","MAT-PRE-1"]')&&u.includes('["voucher_type","=","Purchase Receipt"]')));
  assert.match(posted.textContent,/What ERPNext recorded for MAT-PRE-1/);
  assert.match(posted.textContent,/Stock In Hand400/);assert.match(posted.textContent,/Total · balanced400400/);
  assert.match(posted.textContent,/Stores \+4, now 4 \(stock value \+400\)/);
  assert.match(posted.textContent,/Stock Received But Not Billed: a clearing account/);
  assert.match(root.querySelector('#trail').textContent,/Purchase Receipt MAT-PRE-1/);
  // The Instructor checks the explanation against these entries.
  const sent:any[]=[];f.x.addEventListener('dhimantai-erp-explained',(e:any)=>sent.push(e.detail));
  root.querySelector('#explanation').value='The receipt put 400 of stock on the shelf and owes it to a clearing account until the bill comes.';
  root.querySelector('#explanation').dispatchEvent(new f.x.Event('input'));root.querySelector('#send-explanation').click();
  assert.equal(sent[0].recorded,'Stock In Hand debit 400; Stock Received But Not Billed credit 400; stock TRAINING-WIDGET-0123456789 in Stores +4 (now 4)');
  f.dom.window.close();
});
test('a commitment says that nothing was posted',async()=>{
  const t='0123456789',doc:any={name:'PUR-ORD-1',company:'Training '+t,supplier:'Training Supplier '+t,schedule_date:'2026-11-11',docstatus:1,
    items:[{item_code:'TRAINING-WIDGET-'+t,qty:5,rate:100,schedule_date:'2026-11-11'}]};
  const f=lessonFixture(4,{doctype:'Purchase Order',doc,fields_dict:{},is_new:()=>false,is_dirty:()=>false},url=>/GL%20Entry|Stock%20Ledger|\/Bin/.test(url)?[]:doc);await tick();
  const root=f.root();
  root.querySelector('#check').click();for(let i=0;i<6;i++)await tick();
  assert.equal(f.x.dhimantaiErpGuide.question().kind,'explanation');
  assert.match(root.querySelector('#posted').textContent,/Nothing was posted.*A submitted Purchase Order is a commitment/);
  f.dom.window.close();
});
test('the finished course closes the books from the general ledger and asks the learner to explain profit and cash',async()=>{
  const t='0123456789',done=Object.fromEntries(course.lessons.map((l:any)=>[l.id,'REC-'+l.id]));
  const last=course.lessons.length-1, asked:string[]=[];
  const f=lessonFixture(last,{doctype:'Payment Entry',doc:{name:'REC-retail-payment'},fields_dict:{},is_new:()=>false,is_dirty:()=>false},url=>{
    const u=decodeURIComponent(url);asked.push(u);
    if(u.includes('/api/resource/Account'))return[{name:'Sales - '+t,root_type:'Income'},{name:'Cost of Goods Sold - '+t,root_type:'Expense'},{name:'Cash - '+t,root_type:'Asset'},
      {name:'Debtors - '+t,root_type:'Asset'},{name:'Creditors - '+t,root_type:'Liability'},{name:'Stock In Hand - '+t,root_type:'Asset'}];
    if(u.includes('/GL Entry'))return[{account:'Sales - '+t,debit:0,credit:620},{account:'Debtors - '+t,debit:620,credit:300},{account:'Cost of Goods Sold - '+t,debit:400,credit:0},
      {account:'Stock In Hand - '+t,debit:400,credit:400},{account:'Cash - '+t,debit:300,credit:400},{account:'Creditors - '+t,debit:400,credit:400}];
    return {};
  },done);for(let i=0;i<8;i++)await tick();
  const root=f.root(),finale=root.querySelector('#finale');
  assert.equal(finale.hidden,false);
  assert.ok(asked.some(u=>u.includes('/GL Entry')&&u.includes('["company","=","Training 0123456789"]')));
  assert.match(finale.textContent,/Profit: INR 220 = income 620 − expenses 400/);
  assert.match(finale.textContent,/The books balance: assets 220 = liabilities 0 \+ equity 0 \+ profit 220/);
  // Asha has not paid yet in this ledger: cash (-100) differs from profit by what she owes.
  assert.match(finale.textContent,/Cash is INR -100 while profit is INR 220\. The difference sits in Debtors \(320\)/);
  assert.deepEqual([...finale.querySelectorAll('#reports button')].map((b:any)=>b.textContent),['Open Profit and Loss in ERPNext','Open General Ledger in ERPNext']);
  const sent:any[]=[];f.x.addEventListener('dhimantai-erp-explained',(e:any)=>sent.push(e.detail));
  const guide=f.x.dhimantaiErpGuide,q=guide.question();
  assert.equal(q.kind,'reflection');assert.match(q.context,/Sales \(income\) 620/);
  assert.equal(root.querySelector('#reflection').parentElement.hidden,true);
  assert.equal(await guide.answerQuestion(q.id,'Too short'),false);
  assert.equal(await guide.answerQuestion(q.id,'We sold for 620 what cost us 400, so profit is 220, but Asha still owes 320, so cash is lower than profit.'),true);
  assert.equal(guide.question(),null);
  assert.equal(sent[0].task,'close-the-books');assert.match(sent[0].recorded,/Sales \(income\) 620/);assert.match(sent[0].recorded,/Debtors \(asset\) 320/);
  f.dom.window.close();
});

test('a restored explanation reconnects its host question while ERP is hidden',async(t)=>{
  const f=fixture(undefined,course);t.after(()=>f.dom.window.close());await tick();
  const w=f.w,guide=w.dhimantaiErpGuide,callbacks=new Map<number,Function>(),published:any[]=[];
  Object.defineProperty(w.document,'hidden',{value:true});
  w.setInterval=(fn:Function,ms:number)=>{callbacks.set(ms,fn);return ms;};
  w.frappe.get_route=()=>['Form','Company',w.cur_frm.doc.name];
  const company={name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'};
  Object.assign(w.cur_frm.doc,company);f.setSaved(company);
  await guide.continueTask('company');
  const question=guide.question(),read=w.fetch;
  let questionId:string|null=null,answer:any;
  w.fetch=async(url:string,options:any)=>{
    if(!url.startsWith('http://127.0.0.1:40000'))return read(url,options);
    if(url.endsWith('/state'))return {ok:true,json:async()=>({connected:true,questionId,answer})};
    if(url.endsWith('/question')){const q=JSON.parse(options.body).question;questionId=q?.id??null;published.push(q);}
    return {ok:true,json:async()=>({ok:true})};
  };
  w.eval(readFileSync(join(player,'live.js'),'utf8'));await tick();await tick();
  assert.equal(questionId,question.id,'startup publishes the restored question before visibility polling');
  questionId=null; // Late pagehide or host reconnect cleared its accepted question.
  await callbacks.get(3000)!();
  assert.equal(questionId,question.id,'state reconciliation restores the exact pending question');
  assert.equal(guide.question().id,question.id,'reconciliation never advances or answers the task');
  const count=published.length;
  await callbacks.get(3000)!();assert.equal(published.length,count,'a synchronized question is not resent');
  answer={id:questionId,answer:'Receivables are what customers owe us; invoices increase the amount owed.'};
  await callbacks.get(3000)!();await tick();
  assert.equal(guide.question(),null,'the instructor acknowledgement completes the pending task');
});

test('Instructor answers and Continue complete the browser round trip without a second chat or a skipped task',async(t)=>{
  const f=fixture(undefined,course);t.after(()=>f.dom.window.close());await tick();
  const w=f.w,guide=w.dhimantaiErpGuide,callbacks=new Map<number,Function>(),requests:any[]=[];
  Object.defineProperty(w.document,'hidden',{value:false});
  w.setInterval=(fn:Function,ms:number)=>{callbacks.set(ms,fn);return ms;};
  w.frappe.get_route=()=>['Form','Company',w.cur_frm.doc.name];
  const company={name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'};
  Object.assign(w.cur_frm.doc,company);f.setSaved(company);
  const read=w.fetch;let state:any={connected:true,detail:'Connected'};
  w.fetch=async(url:string,options:any)=>{
    if(!url.startsWith('http://127.0.0.1:40000'))return read(url,options);
    if(url.endsWith('/state'))return {ok:true,json:async()=>state};
    requests.push({url,body:options.body&&JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true})};
  };
  w.eval(readFileSync(join(player,'live.js'),'utf8'));await tick();
  await guide.continueTask('company');callbacks.get(900)!();await tick();await tick();
  const question=requests.find(r=>r.url.endsWith('/question')&&r.body.question)?.body.question;
  assert.equal(question.kind,'explanation');
  const root=guide.root;
  assert.equal(root.querySelector('#check').textContent,'Check saved work');
  assert.equal(root.querySelector('#open').hidden,false);
  const pendingId=guide.question().id;
  root.querySelector('#check').click();await tick();await tick();
  assert.equal(guide.question().id,pendingId,'recheck preserves the question that owns the explanation draft');
  root.querySelector('#open').click();await tick();await tick();
  assert.equal(requests.filter(r=>r.url.endsWith('/focus')).length,1);
  assert.equal(requests.find(r=>r.url.endsWith('/focus')).body.id,question.id);
  assert.equal(requests.some(r=>r.url.endsWith('/help')),false,'opening the reply box never sends a generic help request');
  const handoff=root.querySelector('#status').textContent;
  await callbacks.get(3000)!();
  assert.equal(root.querySelector('#status').textContent,handoff,'connection polling does not erase the next-step message');
  assert.ok(root.querySelector('#follow-browser').closest('details'),'sharing settings stay under About this task');
  state={...state,answer:{id:question.id,answer:'Receivables are what customers owe us; an invoice increases the amount owed.'}};
  await callbacks.get(3000)!();await tick();
  assert.equal(requests.filter(r=>r.url.endsWith('/progress')).at(-1).body.explained,true);
  assert.equal(requests.some(r=>r.url.endsWith('/help')),false,'Instructor already received this answer through chat');
  const opened:string[]=[];w.dhimantaiApp.openNew=async(name:string)=>{opened.push(name);};
  state={...state,taskAction:{id:'continue-1',task:'company'}};
  await callbacks.get(3000)!();await tick();
  assert.deepEqual(opened,['Customer']);assert.equal(guide.current().id,'customer');
  assert.ok(requests.some(r=>r.url.endsWith('/continue-result')&&r.body.id==='continue-1'));
  await callbacks.get(3000)!();assert.deepEqual(opened,['Customer'],'a repeated command cannot advance twice');
  const reopened:string[]=[];w.dhimantaiApp.openRecord=async(name:string)=>{reopened.push(name);};
  state={connected:true,taskAction:{id:'choose-2',task:'company',kind:'open'}};
  await callbacks.get(3000)!();await tick();
  assert.equal(guide.current().id,'company');assert.deepEqual(reopened,['Company']);
  assert.ok(requests.some(r=>r.url.endsWith('/continue-result') && r.body.id==='choose-2'));
  await callbacks.get(3000)!();assert.deepEqual(reopened,['Company'],'a repeated navigation command does not reopen a task');
});

test('skipping a chapter preserves incomplete tasks, protects unsaved forms and explains dependencies',async(t)=>{
  const f=fixture(undefined,course);t.after(()=>f.dom.window.close());await tick();
  const guide=f.w.dhimantaiErpGuide,opened:string[]=[];
  f.w.dhimantaiApp.openNew=async(name:string)=>{opened.push(name);};
  f.setDirty(true);
  assert.match(await guide.openTask('customer'),/Save or discard/);
  assert.equal(guide.current().id,'company');assert.deepEqual(opened,[]);
  f.setDirty(false);await guide.openTask('customer');
  assert.equal(guide.current().id,'customer');assert.deepEqual(opened,['Customer']);
  const state=JSON.parse(f.w.localStorage.getItem(f.w.localStorage.key(0)));
  assert.deepEqual(state.done,{},'navigation never marks the skipped task complete');
  assert.equal(state.lesson,1);
  assert.match(await guide.openTask('stock'),/needs an earlier record/);
  assert.match(guide.root.querySelector('#now').textContent,/Finish.*Order from your supplier.*first/);
  assert.deepEqual(opened,['Customer'],'a missing prerequisite is not silently created');
});

test('disconnected ERPNext reuses Ask Instructor for reconnect without changing saved work',async()=>{
  const f=fixture(undefined,course);await tick();
  const w=f.w,guide=w.dhimantaiErpGuide,callbacks=new Map<number,Function>(),requests:any[]=[];
  try {
    Object.defineProperty(w.document,'hidden',{value:false});
    w.setInterval=(fn:Function,ms:number)=>{callbacks.set(ms,fn);return ms;};
    const company={name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'};
    Object.assign(w.cur_frm.doc,company);f.setSaved(company);
    const read=w.fetch;
    w.fetch=async(url:string,options:any)=>{
      if(!url.startsWith('http://127.0.0.1:40000'))return read(url,options);
      if(url.endsWith('/state'))return {ok:true,json:async()=>({connected:false,detail:'Browser observation is unavailable.'})};
      requests.push({url,body:options?.body&&JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true})};
    };
    w.eval(readFileSync(join(player,'live.js'),'utf8'));await tick();
    await guide.continueTask('company');await callbacks.get(3000)!();
    const q=guide.question(),saved=w.localStorage.getItem(w.localStorage.key(0)),root=guide.root;
    const retry=root.querySelector('#ask-instructor');
    assert.equal(retry.textContent,'Reconnect Instructor');assert.equal(retry.disabled,false);
    assert.equal(root.querySelector('#check').disabled,false);
    assert.match(root.querySelector('#verification-status').textContent,/Saved work verified.*Explanation pending/);
    retry.click();await tick();await tick();
    assert.equal(requests.filter(r=>r.url.endsWith('/reconnect')).length,1);
    assert.equal(requests.some(r=>r.url.endsWith('/help')),false);
    assert.equal(w.localStorage.getItem(w.localStorage.key(0)),saved);
    assert.equal(guide.question().id,q.id);
    assert.equal(f.fills(),0);
  }finally{f.dom.window.close();}
});

test('slow saved-check persistence cannot overwrite a later explanation acknowledgement',async()=>{
  const f=fixture(undefined,course);await tick();
  const w=f.w,guide=w.dhimantaiErpGuide,progress:any[]=[];let release:()=>void=()=>{};
  try {
    const company={name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'};
    Object.assign(w.cur_frm.doc,company);f.setSaved(company);
    const read=w.fetch;
    w.fetch=async(url:string,options:any)=>{
      if(!url.startsWith('http://127.0.0.1:40000'))return read(url,options);
      if(url.endsWith('/progress')) {
        progress.push(JSON.parse(options.body));
        if(progress.length===1)await new Promise<void>(resolve=>{release=resolve;});
      }
      return {ok:true,json:async()=>({ok:true,connected:true})};
    };
    w.eval(readFileSync(join(player,'live.js'),'utf8'));await tick();
    await guide.continueTask('company');await tick();
    await guide.answerQuestion(guide.question().id,'Receivables are what customers owe; payables are what we owe suppliers.');await tick();
    assert.equal(progress.length,1);assert.equal(progress[0].explained,false);
    release();await tick();
    assert.equal(progress.length,2);assert.equal(progress[1].explained,true);
    assert.equal(progress[1].checkedAt,progress[0].checkedAt);
  }finally{release();f.dom.window.close();}
});
