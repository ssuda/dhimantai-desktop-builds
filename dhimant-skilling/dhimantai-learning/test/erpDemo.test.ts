import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {demoFinished, demoTasks, ERP_DEMO, prepareDemo} from '../src/erpDemo';

const player=join(__dirname,'../../media/browser/player');
const source=readFileSync(join(__dirname,'../../media/browser/apps/frappe.js'),'utf8')+'\n'+readFileSync(join(player,'guide.js'),'utf8');
const course=JSON.parse(readFileSync(join(__dirname,'../../media/browser/erpnext/course.json'),'utf8'));

test('the demo chapter is the published lessons, prepared tasks first and renumbered, opening on the first live task',()=>{
  const tasks=demoTasks(course.lessons);
  assert.deepEqual(tasks.map(t=>t.id),[...ERP_DEMO.prepared,...ERP_DEMO.live]);
  assert.deepEqual(tasks.map(t=>t.title),['1. Create a customer (prepared)','2. Create a supplier (prepared)','3. Create a stock item (prepared)',
    '4. Order from your supplier (prepared)','5. Take a customer order (prepared)','6. Receive what arrived','7. Record the supplier’s bill',
    '8. Deliver the order','9. Bill the customer']);
  // Same definitions as the course, so the Instructor chapters, checks and predictions are the published ones.
  const stock=tasks.find(t=>t.id==='stock')!;
  assert.deepEqual({...stock,title:undefined},{...course.lessons.find((l:any)=>l.id==='stock'),title:undefined});
  assert.throws(()=>demoTasks(course.lessons.filter((l:any)=>l.id!=='delivery')),/needs these published tasks: delivery/);
});

test('preparing the demo creates the parties, item and submitted orders as the learner, and resumes after an interruption',async()=>{
  const tasks=demoTasks(course.lessons), created:any[]=[], saved:Record<string,any>={};
  let fail='Sales Order';
  const server={insert:async(form:string,values:any)=>{
    if(form===fail)throw new Error('ERPNext did not accept the Sales Order');
    created.push({form,values});return form==='Purchase Order'?'PUR-ORD-1':form==='Sales Order'?'SAL-ORD-1':values[Object.keys(values)[0]];
  }};
  const store=async(task:string,entry:any)=>{saved[task]=entry;};
  await assert.rejects(prepareDemo(server,tasks,'0123456789','2026-11-12',{},store),/Sales Order/);
  assert.deepEqual(Object.keys(saved),['customer','supplier','item','buying']);
  fail='';
  await prepareDemo(server,tasks,'0123456789','2026-11-12',{...saved},store);
  assert.deepEqual(created.map(c=>c.form),['Customer','Supplier','Item','Purchase Order','Sales Order'],'nothing is created twice');
  const order=created.find(c=>c.form==='Purchase Order').values;
  assert.deepEqual(order,{company:'Training 0123456789',supplier:'Training Supplier 0123456789',schedule_date:'2026-11-12',
    items:[{item_code:'TRAINING-WIDGET-0123456789',qty:5,rate:100,schedule_date:'2026-11-12'}],docstatus:1});
  assert.equal(created.find(c=>c.form==='Customer').values.docstatus,undefined,'master data is saved, not submitted');
  assert.equal(created.find(c=>c.form==='Sales Order').values.customer,'Training Customer 0123456789');
  assert.ok(Object.values(saved).every((e:any)=>e.explained&&!e.assisted));
  assert.equal(saved.buying.record,'PUR-ORD-1');
  assert.equal(demoFinished({learner:'x',verified:saved}),false);
  assert.equal(demoFinished({learner:'x',verified:{...saved,...Object.fromEntries(ERP_DEMO.live.map(id=>[id,{...saved.item}]))}}),true);
});

test('the finished demo closes the books with profit but no cash, under the demo’s own title',async()=>{
  const learner='0123456789abcdef0123',t=learner.slice(0,10),user=`learner-${learner}@training.invalid`,tasks=demoTasks(course.lessons);
  const published={...course,version:'demo',lessons:tasks,finale:ERP_DEMO.finale,
    verified:Object.fromEntries(tasks.map(l=>[l.id,{record:'REC-'+l.id,checkedAt:'2026-11-12T00:00:00Z',assisted:false,explained:true}]))};
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1:43210/desk',runScripts:'outside-only'}),x=dom.window as any;
  x.sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:40000',token:'a'.repeat(64),learner}));
  x.localStorage.setItem(`dhimantai-browser:erpnext-essentials:vdemo:${user}`,JSON.stringify({lesson:tasks.length-1}));
  x.frappe={session:{user},ui:{form:{}},datetime:{get_today:()=>'2026-11-12'},set_route:async()=>{}};
  x.cur_frm={doctype:'Sales Invoice',doc:{name:'REC-receivables'},fields_dict:{},is_new:()=>false,is_dirty:()=>false};x.AbortSignal={timeout:()=>undefined};
  x.fetch=async(url:string)=>{
    if(url.endsWith('/course'))return {ok:true,text:async()=>JSON.stringify(published)};
    const u=decodeURIComponent(url);
    const data=u.includes('/api/resource/Account')?[{name:'Sales - '+t,root_type:'Income'},{name:'Cost of Goods Sold - '+t,root_type:'Expense'},
      {name:'Debtors - '+t,root_type:'Asset'},{name:'Creditors - '+t,root_type:'Liability'},{name:'Stock In Hand - '+t,root_type:'Asset'},
      {name:'Stock Received But Not Billed - '+t,root_type:'Liability'}]
      : u.includes('/GL Entry')?[{account:'Stock In Hand - '+t,debit:400,credit:200},{account:'Stock Received But Not Billed - '+t,debit:400,credit:400},
        {account:'Creditors - '+t,debit:0,credit:400},{account:'Cost of Goods Sold - '+t,debit:200,credit:0},{account:'Debtors - '+t,debit:300,credit:0},{account:'Sales - '+t,debit:0,credit:300}]:{};
    return {ok:true,json:async()=>({data})};
  };
  x.eval(source);
  for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,10));
  const finale=x.document.querySelector('#dhimantai-guide').shadowRoot.querySelector('#finale');
  assert.equal(finale.hidden,false);
  assert.match(finale.textContent,/^You received, billed, delivered and invoiced in Training 0123456789\./);
  assert.match(finale.textContent,/Profit: INR 100 = income 300 − expenses 200/);
  assert.match(finale.textContent,/The books balance: assets 500 = liabilities 400 \+ equity 0 \+ profit 100/);
  assert.match(finale.textContent,/Cash is INR 0 while profit is INR 100\. The difference sits in Stock In Hand \(200\), Creditors \(400\), Debtors \(300\)/);
  dom.window.close();
});
