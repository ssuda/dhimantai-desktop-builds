import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const html = readFileSync(resolve(__dirname, '../../../../agent/course_projects/learning_checkout.html'), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('checkout page verifies the provider response before announcing unlocked access', async () => {
  const dom = new JSDOM(html, {url:'https://api.example.test/learning-billing/checkout#ticket=opaque',runScripts:'outside-only'});
  const win = dom.window as any, calls: {path: string; body: any}[] = [];
  let options: any;
  win.AbortSignal.timeout = () => undefined;
  win.Razorpay = class { constructor(opts: any) { options = opts; } on() {} open() {} };
  win.fetch = async (path: string, init: any) => {
    calls.push({path,body:JSON.parse(init.body)});
    return {ok:true,json:async()=>path.endsWith('/details')
      ? {key:'rzp_test',order_id:'order_test',amount:49900,currency:'INR',description:'Python',status:'created'}
      : {status:'paid'}};
  };
  try {
    win.eval(win.document.querySelector('script:not([src])').textContent);
    await flush();
    assert.equal(win.location.hash, '');
    assert.equal(win.document.getElementById('price').textContent, '₹499.00');
    assert.equal(win.document.getElementById('pay').disabled, false);
    win.document.getElementById('pay').click();
    assert.equal(options.order_id, 'order_test');
    assert.doesNotMatch(win.document.getElementById('status').textContent, /unlocked/);
    await options.handler({razorpay_order_id:'order_test',razorpay_payment_id:'pay_test',razorpay_signature:'signature'});
    assert.equal(calls[1].body.ticket, 'opaque');
    assert.equal(calls[1].body.razorpay_signature, 'signature');
    assert.match(win.document.getElementById('status').textContent, /courses are unlocked/);
    options.modal.ondismiss();
    assert.equal(win.document.getElementById('pay').disabled, true);
  } finally { dom.window.close(); }
});

test('expired checkout and pending capture never claim paid access', async () => {
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
      assert.doesNotMatch(win.document.getElementById('status').textContent, /unlocked/);
    } finally { dom.window.close(); }
  }
});
