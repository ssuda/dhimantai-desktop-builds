import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ErpVerifier} from '../src/erpVerifier';

const media=join(__dirname,'../../media/browser/erpnext');
const course=JSON.parse(readFileSync(join(media,'course.json'),'utf8'));
const task=(id:string)=>course.lessons.find((l:any)=>l.id===id);
const learner='0123456789abcdef0123', me=`learner-${learner}@training.invalid`;

function erpnext(records:Record<string,any>) {
  const calls:string[]=[];let sessions=0,expireNext=false;
  const request=(async(url:string,init:any={})=>{
    calls.push(url);
    if(url.endsWith('/api/method/login')){
      const body=new URLSearchParams(init.body);
      if(body.get('usr')!=='Administrator'||body.get('pwd')!=='admin-secret')return new Response('{}',{status:401});
      sessions++;return new Response('{}',{status:200,headers:{'set-cookie':`sid=session${sessions}; Path=/; HttpOnly`}});
    }
    if(init.headers?.Cookie!==`sid=session${sessions}`||expireNext){expireNext=false;return new Response('{}',{status:403});}
    const key=decodeURIComponent(url.split('/api/resource/')[1]);
    return records[key]?new Response(JSON.stringify({data:records[key]}),{status:200}):new Response('{}',{status:404});
  }) as typeof fetch;
  return {request,calls,expire:()=>{expireNext=true;},sessions:()=>sessions};
}
const payment=(over:any={})=>({name:'ACC-PAY-1',owner:me,company:'Training 0123456789',payment_type:'Pay',party:'Training Supplier 0123456789',
  paid_from:'Cash - 0123456789',paid_amount:400,docstatus:1,references:[{reference_doctype:'Purchase Invoice',reference_name:'ACC-PINV-1',allocated_amount:400}],...over});

test('the desktop counts a task only when it re-reads the learner’s own matching record and its consequence',async()=>{
  const records:Record<string,any>={'Payment Entry/ACC-PAY-1':payment(),'Purchase Invoice/ACC-PINV-1':{name:'ACC-PINV-1',outstanding_amount:0}};
  const fake=erpnext(records),verifier=new ErpVerifier('http://127.0.0.1:1',`admin-secret`,media,fake.request);
  assert.equal(await verifier.verify(task('pay-supplier'),'ACC-PAY-1',learner,{payables:'ACC-PINV-1'}),true);
  records['Purchase Invoice/ACC-PINV-1'].outstanding_amount=400;
  assert.equal(await verifier.verify(task('pay-supplier'),'ACC-PAY-1',learner,{payables:'ACC-PINV-1'}),false,'an unsettled invoice fails the follow-up check');
  records['Purchase Invoice/ACC-PINV-1'].outstanding_amount=0;
  records['Payment Entry/ACC-PAY-1']=payment({owner:'learner-ffffffffffffffffffff@training.invalid'});
  assert.equal(await verifier.verify(task('pay-supplier'),'ACC-PAY-1',learner,{payables:'ACC-PINV-1'}),false,'another login’s record is not this learner’s work');
  records['Payment Entry/ACC-PAY-1']=payment({paid_amount:300});
  assert.equal(await verifier.verify(task('pay-supplier'),'ACC-PAY-1',learner,{payables:'ACC-PINV-1'}),false);
  assert.equal(await verifier.verify(task('pay-supplier'),'ACC-PAY-404',learner,{payables:'ACC-PINV-1'}),false,'a claimed record must exist');
  assert.equal(await verifier.verify(task('pay-supplier'),'ACC-PAY-1',learner,{}),false,'a link to an unverified earlier task cannot pass');
});
test('the read-only company task inspects the prepared record, and an expired admin session is renewed once',async()=>{
  const records={'Company/Training 0123456789':{name:'Training 0123456789',owner:'Administrator',default_currency:'INR',
    default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'}};
  const fake=erpnext(records),verifier=new ErpVerifier('http://127.0.0.1:1','admin-secret',media,fake.request);
  assert.equal(await verifier.verify(task('company'),'Training 0123456789',learner,{}),true);
  fake.expire();
  assert.equal(await verifier.verify(task('company'),'Training 0123456789',learner,{}),true);
  assert.equal(fake.sessions(),2);
  const wrong=new ErpVerifier('http://127.0.0.1:1','not-the-password',media,erpnext(records).request);
  await assert.rejects(wrong.verify(task('company'),'Training 0123456789',learner,{}),/administrator login/);
});
