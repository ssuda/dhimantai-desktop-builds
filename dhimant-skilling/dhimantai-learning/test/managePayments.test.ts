import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {paymentReceipt,paymentsHtml} from '../src/managePayments';
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
  assert.match(paymentReceipt(purchase),/Optficial Labs Pvt Ltd.*₹499.*pay_example/s);
  assert.throws(()=>paymentReceipt({...purchase,status:'created'}),/after payment is confirmed/);
  assert.match(paymentReceipt({...purchase,status:'refunded'}),/Refunded/);
});
