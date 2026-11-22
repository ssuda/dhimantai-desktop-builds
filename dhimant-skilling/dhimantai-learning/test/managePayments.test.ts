import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {paymentsHtml,paymentsPage} from '../src/managePayments';
import {paymentReceipt,receiptCourses} from '../src/paymentReceipt';
import type {LearningPurchases} from '../src/api';
const purchase:LearningPurchases['purchases'][number]={id:'purchase-1',title:'Python <basics>',amount:49900,currency:'INR',
  course_ids:['python'],status:'paid',created_at:'2026-11-14T10:00:00Z',paid_at:'2026-11-14T10:02:00Z',razorpay_payment_id:'pay_example',offer_id:'python'};
test('payments separate paid status from expired access and escape course names',()=>{
  const dom=new JSDOM(paymentsHtml({payments_ready:true,purchases:[purchase]},[{id:'python',title:'Python <basics>',summary:'',level:'',prerequisites:'',
    can_join:true,enrolled:true,chapters:[],expired:true,access_until:'2026-11-14T00:00:00Z'}],true));
  try {
    assert.match(dom.window.document.body.textContent!,/Paid.*Access ended/s);
    assert.equal(dom.window.document.querySelector('basics'),null);
    assert.equal(dom.window.document.querySelector('[data-action="receipt"]')?.getAttribute('data-id'),'purchase-1');
  }finally{dom.window.close();}
});

test('receipt validity follows each purchased term, including refunds and older records', async () => {
  const course = {id:'python', title:'Python <basics>', access_days:60, access_until:'2028-01-31T12:00:00Z',
    summary:'', level:'', prerequisites:'', can_join:true, enrolled:true, chapters:[]};
  const bundle = {...purchase, course_ids:['python', 'sql', 'retired']};
  const rows = receiptCourses(bundle, [course, {...course, id:'sql', title:'SQL', access_days:30}]);
  assert.deepEqual(rows.map(row => row[0]), ['Python <basics>', 'SQL', 'retired']);
  assert.match(rows[0][1], /13 Jan 2027/);
  assert.match(rows[1][1], /14 Dec 2026/);
  assert.equal(rows[2][1], 'Validity unavailable');
  assert.deepEqual(receiptCourses({...purchase, status:'refunded'}, [course]), [[course.title, 'Ended by refund']]);
  assert.deepEqual(receiptCourses({...purchase, paid_at:null}, [course]), [[course.title, '60 days from payment']]);
  assert.deepEqual(receiptCourses(purchase, []), [[purchase.title, 'Validity unavailable']]);
  await assert.rejects(paymentReceipt({...purchase, status:'created'}, []), /after payment is confirmed/);
});

test('Download Receipt requests the selected purchase and downloads its PDF in the current account', () => {
  const scope = JSON.stringify(['staging', 'learner']);
  const dom = new JSDOM(paymentsPage({nonce:'fixture', scope, environment:'staging', account:'learner',
    billing:{payments_ready:true,purchases:[purchase]}, courses:[], message:'', loading:false}), {runScripts:'outside-only'});
  try {
    const win = dom.window, requests:unknown[] = [], downloads:string[] = [];
    (win as any).acquireVsCodeApi = () => ({getState:()=>undefined, setState:()=>{},
      postMessage:(request:unknown)=>requests.push(JSON.parse(JSON.stringify(request)))});
    win.URL.createObjectURL = (blob:Blob) => {
      assert.equal(blob.type, 'application/pdf');
      assert.equal(blob.size, 4);
      return 'blob:https://example.test/receipt';
    };
    win.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
    win.eval(win.document.querySelector('script')!.textContent!);
    win.document.querySelector<HTMLButtonElement>('[data-action="receipt"]')!.click();
    assert.deepEqual(requests, [{type:'receipt', id:purchase.id}]);
    for (const accountScope of ['other', scope]) {
      win.dispatchEvent(new win.MessageEvent('message', {data:{type:'receiptDownload', scope:accountScope,
        id:purchase.id, bytes:new win.Uint8Array([37,80,68,70]).buffer}}));
    }
    assert.deepEqual(downloads, ['dhimantAI-receipt-purchase-1.pdf']);
  } finally { dom.window.close(); }
});

test('summary, keyboard filters and checkout actions use the order and its verified attempts', () => {
  const purchases:LearningPurchases['purchases'] = [purchase,
    {...purchase,id:'new',status:'created',can_resume:true}, {...purchase,id:'retry',status:'created',attempt_state:'failed',can_resume:true},
    {...purchase,id:'processing',status:'created',attempt_state:'processing'}, {...purchase,id:'creating',status:'creating'},
    {...purchase,id:'refund',status:'refunded'}];
  let saved:any;
  const messages:unknown[] = [];
  function page(scope:string) {
    const html = paymentsPage({nonce:'fixture',scope,environment:'staging',account:'learner',
      billing:{payments_ready:true,purchases},courses:[],message:'',loading:false});
    const dom = new JSDOM(html,{runScripts:'outside-only'}), win=dom.window;
    (win as any).acquireVsCodeApi = () => ({getState:()=>saved, setState:(s:any)=>{saved=s;},
      postMessage:(m:unknown)=>{messages.push(JSON.parse(JSON.stringify(m)));}});
    win.eval(win.document.querySelector('script')!.textContent!);
    return dom;
  }
  let dom=page('learner');
  try {
    const doc=dom.window.document;
    assert.deepEqual([...doc.querySelectorAll('.summary dd')].map(dd=>dd.textContent), ['1','3','1','6']);
    assert.deepEqual([...doc.querySelectorAll('[data-action="resume"]')].map(b=>b.textContent), ['Complete Payment','Retry Payment']);
    assert.equal(doc.querySelectorAll('[data-action="receipt"]').length,2);
    doc.getElementById('tab-pending')!.click();
    assert.equal(doc.querySelectorAll('tr[data-group]:not([hidden])').length,3);
    doc.getElementById('tab-pending')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight'}));
    assert.equal(doc.activeElement?.id,'tab-failed');
    assert.equal(doc.querySelectorAll('tr[data-group]:not([hidden])').length,1);
    const retry=doc.querySelector<HTMLButtonElement>('[data-id="retry"]')!;
    retry.click();assert.equal(retry.disabled,true);assert.deepEqual(messages,[{type:'resume',id:'retry'}]);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:{type:'catalogStatus',busy:false,message:'Try again.'}}));
    assert.equal(retry.disabled,false);
    dom.window.close();dom=page('learner');
    assert.equal(dom.window.document.querySelector('[aria-selected=true]')?.id,'tab-failed');
    dom.window.close();dom=page('different learner');
    assert.equal(dom.window.document.querySelector('[aria-selected=true]')?.id,'tab-all');
  } finally {dom.window.close();}
});
