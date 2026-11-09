import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

test('runtime setup distinguishes file runs, notebook availability and kernel verification', () => {
  const dom = new JSDOM('<select id="runtime"><option value=""></option><option value="local"></option><option value="colab"></option><option value="podman"></option><option value="terminal"></option><option value="setup"></option></select><button id="new-notebook"></button><p id="runtime-target"></p><p id="runtime-status"></p>', {runScripts: 'outside-only'});
  try {
    const win = dom.window, sent: any[] = [];
    win.eval(readFileSync(resolve(__dirname, '../../media/notebookRuntime.js'), 'utf8'));
    win.installNotebookRuntime({postMessage: (m: any) => sent.push(m)});
    const post = (state: object) => win.dispatchEvent(new win.MessageEvent('message', {data: {type: 'runtimeState', ...state}}));
    const select = win.document.getElementById('runtime') as HTMLSelectElement;
    post({});
    assert.equal(select.disabled, true);
    assert.match(win.document.body.textContent!, /Source files use Run code/);
    post({podman: true});
    select.value = 'terminal'; select.dispatchEvent(new win.Event('change'));
    assert.equal(sent.at(-1).runtime, 'terminal', 'the dropdown opens a course terminal without a notebook');
    post({uri: 'file:///test.ipynb', name: 'test.ipynb', colab: true, podman: false});
    assert.equal(select.disabled, false);
    assert.match(win.document.body.textContent!, /readiness is not verified/);
    assert.equal((select.querySelector('[value="podman"]') as HTMLOptionElement).disabled, true);
    select.value = 'local'; select.dispatchEvent(new win.Event('change'));
    assert.equal(sent.at(-1).runtime, 'local');
    assert.equal(sent.at(-1).uri, 'file:///test.ipynb');
    assert.equal(select.value, '', 'a selected action is not evidence of a connected kernel');
    post({uri: 'file:///test.ipynb', busy: true, status: 'Opening the Python kernel picker…'});
    assert.equal(select.disabled, true);
    assert.match(win.document.body.textContent!, /Opening the Python kernel picker/);
  } finally { dom.window.close(); }
});
