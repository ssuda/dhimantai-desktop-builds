import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function panel() {
  const ids = ['question', 'turn-status', 'cell', 'run-status', 'run-hint', 'kernel-help', 'conversation', 'empty-chat'];
  const buttons = ['ask', 'save-prediction', 'wrap-settings', 'new-chat'];
  const dom = new JSDOM('<!doctype html>' + ids.map(id => `<div id="${id}"></div>`).join('') +
    buttons.map(id => `<button id="${id}"></button>`).join('') + '<textarea id="message"></textarea><textarea id="prediction"></textarea>', {runScripts: 'outside-only'});
  const sent: any[] = [];
  (dom.window as any).acquireVsCodeApi = () => ({postMessage(message: unknown) { sent.push(message); }});
  dom.window.eval(readFileSync(join(__dirname, '../../media/coachMarkdown.js'), 'utf8'));
  dom.window.eval(readFileSync(join(__dirname, '../../media/notebookCoach.js'), 'utf8'));
  const post = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {data}));
  const doc = dom.window.document;
  return {dom, post, sent, doc};
}

test('Instructor appends prompts and rich replies, preserving earlier DOM across runs, errors and follow-ups', () => {
  const {dom, post, doc} = panel();
  const prompt = {id: '1', role: 'learner', text: 'Explain <script> and **parameters**', context: 'Cell 5'};
  const answer = {id: '2', role: 'tutor', text: '### Parameters\n\n**Name** receives `value`.\n\n| Step | Value |\n|---|---|\n| 1 | Dennis Moore |', context: 'Cell 5, line 1 · print("**literal** <tag>")'};
  const update = (messages: object[], extra = {}) => post({conversationId: 'chat', revision: 1, messages, ...extra});
  try {
    update([prompt], {busy: true});
    assert.equal(doc.querySelector('.learner .bubble')?.textContent, prompt.text);
    assert.equal(doc.querySelector('.learner .bubble')?.children.length, 0);
    update([prompt, answer]);
    const first = doc.querySelector('.coach');
    assert.equal(first?.querySelector('h3')?.textContent, 'Parameters');
    assert.equal(first?.querySelectorAll('table td').length, 2);
    assert.equal(first?.querySelector('.message-context')?.textContent, answer.context);
    assert.equal(first?.querySelector('.message-context')?.children.length, 0);
    update([prompt, answer, {id: '3', role: 'learner', text: 'Why twice?'}, {id: '4', role: 'status', text: 'Request failed <tag>'}], {revision: 2});
    assert.equal(doc.querySelector('.coach'), first, 'earlier explanations are not replaced on refresh');
    assert.equal(doc.querySelectorAll('article').length, 4);
    assert.match(doc.querySelector('.status')!.textContent!, /Request failed <tag>/);
    update([prompt, answer], {revision: 3, runHint: 'NameError: **missing** <tag>', question: null, cell: 'null'});
    assert.equal(doc.querySelectorAll('article').length, 2);
    assert.equal(doc.getElementById('run-hint')!.children.length, 0);
    assert.match(doc.body.textContent!, /Select a code cell/);
    assert.equal(doc.querySelector('script, a, iframe'), null);
    post({conversationId: 'new', revision: 4, messages: []});
    assert.equal(doc.querySelectorAll('article').length, 0);
    assert.equal(doc.getElementById('empty-chat')!.hidden, false);
  } finally { dom.window.close(); }
});

test('Instructor sends conversational prompts with Enter, retains drafts during edits, and prevents duplicate sends', () => {
  const {dom, post, sent, doc} = panel();
  const box = doc.getElementById('message') as HTMLTextAreaElement;
  const key = (options = {}) => box.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true, ...options}));
  try {
    post({conversationId: 'chat', revision: 1, messages: [], busy: false});
    assert.equal((doc.getElementById('ask') as HTMLButtonElement).disabled, true);
    box.value = 'Explain the function';
    box.dispatchEvent(new dom.window.Event('input'));
    post({conversationId: 'chat', revision: 2, messages: [], busy: false});
    assert.equal(box.value, 'Explain the function');
    key({shiftKey: true}); key({isComposing: true});
    assert.equal(sent.length, 1, 'Shift+Enter and IME do not send');
    key(); key();
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), {type: 'ask', revision: 2, message: 'Explain the function'});
    assert.equal(sent.length, 2);
    post({type: 'accepted', revision: 1, message: box.value});
    assert.equal(box.value, 'Explain the function', 'stale acknowledgements do not clear the draft');
    post({type: 'accepted', revision: 2, message: box.value});
    assert.equal(box.value, '');
    box.value = 'New draft';
    post({type: 'accepted', revision: 2, message: 'Old draft'});
    assert.equal(box.value, 'New draft');
  } finally { dom.window.close(); }
});
