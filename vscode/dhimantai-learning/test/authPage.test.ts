import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { authPageHtml } from '../src/authPageHtml';

for (const mode of ['signIn', 'signUp'] as const) {
  test(`${mode} reveals each password independently and remasks on submit and error`, () => {
    const dom = new JSDOM(authPageHtml(mode, 'test-nonce', 'production'), {runScripts:'outside-only'});
    const sent: any[] = [], win = dom.window, doc = win.document;
    (win as any).acquireVsCodeApi = () => ({postMessage:(message: any) => sent.push(message)});
    try {
      for (const script of doc.querySelectorAll('script')) win.eval(script.textContent!);
      const fields = mode === 'signUp' ? ['password','confirmation'] : ['password'];
      for (const id of fields) {
        const input = doc.getElementById(id) as HTMLInputElement;
        const toggle = doc.querySelector<HTMLButtonElement>(`button[aria-controls="${id}"]`)!;
        input.value = 'local test password'; input.setSelectionRange(3, 7);
        assert.equal(input.type, 'password');
        assert.equal(toggle.type, 'button', 'eye clicks must not submit the form');
        toggle.click();
        assert.equal(input.type, 'text');
        assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 7);
        assert.equal(toggle.getAttribute('aria-pressed'), 'true');
        assert.match(toggle.getAttribute('aria-label')!, /^Hide /);
        toggle.click();
        assert.equal(input.type, 'password');
        assert.equal(input.value, 'local test password');
        assert.equal(sent.length, 0);
      }
      (doc.getElementById('email') as HTMLInputElement).value = 'learner@example.test';
      if (mode === 'signUp') (doc.getElementById('name') as HTMLInputElement).value = 'Test Learner';
      doc.querySelector<HTMLButtonElement>('.reveal')!.click();
      doc.querySelector('form')!.dispatchEvent(new win.Event('submit', {cancelable:true}));
      assert.equal(sent.length, 1);
      assert.equal(sent[0].password, 'local test password');
      assert.equal((doc.getElementById('password') as HTMLInputElement).type, 'password');
      assert.equal(doc.querySelectorAll('.reveal svg').length, fields.length, 'busy text must not replace the eye icons');
      win.dispatchEvent(new win.MessageEvent('message', {data:{type:'error', message:'Try again.'}}));
      for (const id of fields) {
        const input = doc.getElementById(id) as HTMLInputElement;
        assert.equal(input.type, 'password'); assert.equal(input.value, '');
        assert.equal(doc.querySelector(`button[aria-controls="${id}"]`)!.getAttribute('aria-pressed'), 'false');
      }
    } finally { dom.window.close(); }
  });
}
