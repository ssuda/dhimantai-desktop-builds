import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const html = readFileSync(resolve(__dirname, '../../../../agent/course_projects/learning_checkout.html'), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

for (const outcome of [
  {state:'paid', message:/^Payment confirmed\.$/, nextStep:/Refresh purchases to activate your purchased courses/},
  {state:'created', message:/payment confirmation is pending/i, nextStep:/Refresh purchases to check your payment status/},
]) test(`checkout waits for verification and shows the desktop refresh step for a ${outcome.state} order`, async () => {
  const dom = new JSDOM(html, {url:'https://api.example.test/learning-billing/checkout#ticket=opaque',runScripts:'outside-only'});
  const win = dom.window as any, calls: {path: string; body: any}[] = [];
  let options: any;
  let finishVerification!: (result: {status: string}) => void;
  const verification = new Promise<{status: string}>(resolve => { finishVerification = resolve; });
  win.AbortSignal.timeout = () => undefined;
  win.Razorpay = class { constructor(opts: any) { options = opts; } on() {} open() {} };
  win.fetch = async (path: string, init: any) => {
    calls.push({path,body:JSON.parse(init.body)});
    return {ok:true,json:async()=>path.endsWith('/details')
      ? {key:'rzp_test',order_id:'order_test',amount:49900,currency:'INR',description:'Python',status:'created'}
      : verification};
  };
  try {
    win.eval(win.document.querySelector('script:not([src])').textContent);
    await flush();
    assert.equal(win.location.hash, '');
    assert.equal(win.document.getElementById('price').textContent, '₹499.00');
    assert.equal(win.document.getElementById('pay').disabled, false);
    win.document.getElementById('pay').click();
    assert.equal(options.order_id, 'order_test');
    const status = win.document.getElementById('status');
    assert.doesNotMatch(status.textContent, /payment confirmed|courses are unlocked/i);
    const proof = {razorpay_order_id:'order_test',razorpay_payment_id:'pay_test',razorpay_signature:'signature'};
    const verifying = options.handler(proof);
    assert.deepEqual(calls[1], {path:'/learning-billing/checkout/verify',body:{ticket:'opaque', ...proof}});
    assert.match(status.textContent, /verifying your payment/i);
    finishVerification({status:outcome.state});
    await verifying;
    const help = win.document.getElementById('purchase-help');
    assert.equal(help.hidden, false);
    assert.match(status.textContent, outcome.message);
    assert.match(help.textContent, outcome.nextStep);
    options.modal.ondismiss();
    assert.equal(win.document.getElementById('pay').disabled, true);
  } finally { dom.window.close(); }
});

test('expired and unready orders keep payment disabled and explain why', async () => {
  for (const expired of [true, false]) {
    const dom = new JSDOM(html, {url:'https://api.example.test/learning-billing/checkout#ticket=opaque',runScripts:'outside-only'});
    const win = dom.window as any;
    win.AbortSignal.timeout = () => undefined;
    win.fetch = async () => ({ok:!expired,json:async()=>expired ? {error:'Checkout expired.'}
      : {description:'Python',amount:49900,currency:'INR',status:'creating'}});
    try {
      win.eval(win.document.querySelector('script:not([src])').textContent);
      await flush();
      assert.equal(win.document.getElementById('pay').disabled, true);
      assert.match(win.document.getElementById('status').textContent, expired ? /checkout expired/i : /checkout is not ready/i);
    } finally { dom.window.close(); }
  }
});
