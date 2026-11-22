import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {JSDOM} from 'jsdom';

const html = readFileSync(resolve(__dirname, '../../../../agent/course_projects/learning_checkout.html'), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const order = {
  key: 'rzp_test', order_id: 'order_test', name: 'dhimantAI', description: 'Software engineering bundle',
  amount: 49900, currency: 'INR', status: 'created',
  courses: [{title: 'Python', access_days: 60, access_until: null}, {title: 'SQL', access_days: 30, access_until: null}]
};
const paid = {
  ...order, status: 'paid', purchase_id: 'purchase-1', payment_id: 'pay_verified', paid_at: '2026-11-21T01:00:00Z',
  courses: [{title: 'Python', access_days: 60, access_until: '2027-01-20T01:00:00Z'},
            {title: 'SQL', access_days: 30, access_until: '2026-12-21T01:00:00Z'}]
};
const proof = {razorpay_order_id:'order_test', razorpay_payment_id:'pay_callback', razorpay_signature:'signature'};

async function checkout(details: object, verify?: () => Promise<object>, sdkLoads = true) {
  const dom = new JSDOM(html, {url:'https://api.example.test/learning-billing/checkout#ticket=opaque', runScripts:'outside-only'});
  const win = dom.window as any;
  const calls: {path: string; body: object}[] = [];
  const sdk = {options: undefined as any, onFailure: undefined as any};
  let blob: Blob;
  win.URL.createObjectURL = (value: Blob) => { blob = value; return 'blob:https://api.example.test/test'; };
  win.AbortSignal.timeout = () => undefined;
  win.Razorpay = class {
    constructor(options: object) { sdk.options = options; }
    on(event: string, callback: () => void) { if (event === 'payment.failed') sdk.onFailure = callback; }
    open() {}
  };
  win.fetch = async (path: string, init: RequestInit) => {
    calls.push({path, body: JSON.parse(String(init.body))});
    const data = path.endsWith('/details') ? details : await verify!();
    return {ok: !('error' in data), json: async () => data};
  };
  win.eval(win.document.querySelector('script:not([src])').textContent);
  await flush();
  const sdkScript = win.document.querySelector('script[src]');
  if (sdkScript) sdkScript.dispatchEvent(new win.Event(sdkLoads ? 'load' : 'error'));
  await flush();
  return {
    dom, calls, sdk, sdkScript, win, el: (id: string) => win.document.getElementById(id),
    receiptText: () => new Promise<string>(resolve => {
      const reader = new win.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blob);
    })
  };
}

test('checkout replaces the payment action with a verified, downloadable receipt', async () => {
  let settle!: (value: object) => void;
  const verification = new Promise<object>(resolve => { settle = resolve; });
  const {dom, win, el, calls, sdk, receiptText} = await checkout(order, () => verification);
  try {
    assert.equal(win.location.hash, '');
    assert.equal(el('heading').textContent, order.description);
    assert.equal(el('price').textContent, '₹499.00');
    assert.match(el('course-list').textContent, /SQL — 30 days from payment/);
    assert.equal(el('pay').hidden, false);
    assert.equal(el('pay').disabled, false);
    assert.equal(el('receipt').hidden, true);
    el('pay').click();
    assert.equal(sdk.options.order_id, 'order_test');
    const processing = sdk.options.handler(proof);
    assert.deepEqual(calls[1], {path:'/learning-billing/checkout/verify', body:{ticket:'opaque', ...proof}});
    assert.match(el('status').textContent, /verifying your payment/i);
    assert.equal(el('receipt').hidden, true);
    settle(paid);
    await processing;
    assert.equal(el('heading').textContent, 'Payment Successful');
    assert.equal(el('success-mark').hidden, false);
    assert.equal(el('payment-id').textContent, 'pay_verified');
    assert.match(el('payment-date').textContent, /Nov 2026/);
    assert.equal(el('paid-title').textContent, order.description);
    assert.equal(el('amount-label').textContent, 'Amount paid');
    assert.equal(el('transaction').hidden, false);
    assert.equal(el('bundle').open, true);
    assert.match(el('course-list').textContent, /Python — Until .*Jan 2027/);
    assert.match(el('course-list').textContent, /SQL — Until .*Dec 2026/);
    assert.match(el('purchase-help').textContent, /Manage Payments and select Refresh Status to activate your course access/);
    sdk.onFailure();
    sdk.options.modal.ondismiss();
    assert.equal(el('pay').hidden, true);
    assert.equal(el('pay').disabled, true);
    assert.equal(el('receipt').hidden, false);
    assert.equal(el('receipt').download, 'dhimantAI-receipt-purchase-1.txt');
    const receipt = await receiptText();
    for (const expected of ['Optficial Labs Pvt Ltd', order.description, '₹499.00', 'Payment status: Paid',
      'pay_verified', 'purchase-1', el('payment-date').textContent, 'Python — Until', 'SQL — Until']) {
      assert.ok(receipt.includes(expected), 'Missing receipt field: ' + expected);
    }
    assert.doesNotMatch(receipt, /opaque|signature|pay_callback/);
  } finally { dom.window.close(); }
});

test('previously paid checkout displays single-course validity without loading Razorpay', async () => {
  const {dom, el, sdkScript} = await checkout({...paid, courses:[paid.courses[0]]});
  try {
    assert.equal(sdkScript, null);
    assert.equal(el('pay').hidden, true);
    assert.equal(el('bundle').hidden, true);
    assert.equal(el('receipt').hidden, false);
    assert.match(el('access').textContent, /Python/);
    assert.match(el('validity').textContent, /Until .*Jan 2027/);
  } finally { dom.window.close(); }
});

test('unsettled and refunded purchases never offer a receipt or another payment', async () => {
  for (const state of ['created', 'processing', 'refunded', 'verification outage']) {
    const verify = async () => state === 'verification outage' ? {error:'Unavailable'} : {status:state};
    const {dom, el, sdk} = await checkout(state === 'processing' ? {...order, status:state} : order, verify);
    try {
      if (state !== 'processing') {
        el('pay').click();
        await sdk.options.handler(proof);
        sdk.options.modal.ondismiss();
      }
      assert.equal(el('pay').disabled, true);
      assert.equal(el('pay').hidden, true);
      assert.equal(el('receipt').hidden, true);
      assert.equal(el('transaction').hidden, true);
      if (state === 'refunded') {
        assert.match(el('status').textContent, /refunded/i);
        assert.equal(el('purchase-help').hidden, true);
      } else {
        assert.match(el('status').textContent, /pending|could not confirm/i);
        assert.match(el('purchase-help').textContent, /Refresh Status to check your payment status/);
      }
    } finally { dom.window.close(); }
  }
});

test('dismissal and a failed attempt allow the original checkout to be retried', async () => {
  const {dom, el, calls, sdk} = await checkout(order);
  try {
    el('pay').click();
    sdk.options.modal.ondismiss();
    assert.equal(el('pay').disabled, false);
    el('pay').click();
    sdk.onFailure();
    assert.match(el('status').textContent, /retry this same order/);
    assert.equal(el('pay').disabled, false);
    assert.equal(el('receipt').hidden, true);
    assert.equal(calls.length, 1);
  } finally { dom.window.close(); }
});

test('expired tickets, unready orders and unavailable Razorpay explain the problem', async () => {
  for (const [details, message] of [
    [{error:'Checkout expired.'}, /checkout expired/i], [{...order, status:'creating'}, /checkout is not ready/i],
    [order, /Razorpay did not load/i]
  ] as const) {
    const {dom, el} = await checkout(details, undefined, false);
    try {
      assert.equal(el('pay').disabled, true);
      assert.equal(el('receipt').hidden, true);
      assert.match(el('status').textContent, message);
    } finally { dom.window.close(); }
  }
});
