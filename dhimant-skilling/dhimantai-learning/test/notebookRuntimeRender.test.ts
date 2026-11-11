import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

test('runtime setup distinguishes file runs, notebook availability and kernel verification', () => {
  const dom = new JSDOM('<select id="runtime"><option value=""></option><option value="colab"></option><option value="podman"></option><option value="terminal"></option><option value="setup"></option></select><button id="new-notebook"></button><p id="runtime-target"></p><p id="runtime-status"></p>', {runScripts: 'outside-only'});
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
    assert.equal(select.querySelector('[value="local"]'), null);
    select.value = 'colab'; select.dispatchEvent(new win.Event('change'));
    assert.equal(sent.at(-1).runtime, 'colab');
    assert.equal(sent.at(-1).uri, 'file:///test.ipynb');
    assert.equal(select.value, '', 'a selected action is not evidence of a connected kernel');
    post({uri: 'file:///test.ipynb', busy: true, status: 'Opening Google Colab runtime setup…'});
    assert.equal(select.disabled, true);
    assert.match(win.document.body.textContent!, /Opening Google Colab runtime setup/);
  } finally { dom.window.close(); }
});

test('the existing runtime picker offers lab machines and clears stale machines on course change',()=>{
  const dom=new JSDOM('<select id="runtime"><option value=""></option><option value="colab"></option><option value="podman"></option><option value="terminal"></option><option value="setup"></option></select><button id="new-notebook"></button><p id="runtime-target"></p><p id="runtime-status"></p>',{runScripts:'outside-only'});
  try{
    const win=dom.window,sent:any[]=[];
    win.eval(readFileSync(resolve(__dirname,'../../media/notebookRuntime.js'),'utf8'));
    win.installNotebookRuntime({postMessage:(value:any)=>sent.push(value)});
    const post=(state:object)=>win.dispatchEvent(new win.MessageEvent('message',{data:{type:'runtimeState',podman:true,...state}}));
    post({uri:'file:///lab.ipynb',name:'Replication',machines:{machines:['primary','replica-1'],selected:'primary'}});
    const select=win.document.getElementById('runtime') as HTMLSelectElement;
    assert.equal(select.querySelectorAll('[data-machine]').length,2);
    select.value='machine:replica-1';select.dispatchEvent(new win.Event('change'));
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))),{type:'runtime',uri:'file:///lab.ipynb',runtime:'machine:replica-1'});
    post({uri:'file:///other.ipynb',name:'Other course'});
    assert.equal(select.querySelectorAll('[data-machine]').length,0);
  }finally{dom.window.close();}
});

test('student Jupyter action needs a notebook and preserves its target URI', () => {
  const dom = new JSDOM('<select id="runtime"><option value=""></option><option value="colab"></option><option value="jupyter"></option><option value="podman"></option></select><button id="new-notebook"></button><p id="runtime-target"></p><p id="runtime-status"></p>', {runScripts:'outside-only'});
  try {
    const win = dom.window, sent:any[] = [];
    win.eval(readFileSync(resolve(__dirname, '../../media/notebookRuntime.js'), 'utf8'));
    win.installNotebookRuntime({postMessage:(m:any)=>sent.push(m)});
    const select = win.document.getElementById('runtime') as HTMLSelectElement;
    const jupyter = select.querySelector('[value="jupyter"]') as HTMLOptionElement;
    const post = (state:object)=>win.dispatchEvent(new win.MessageEvent('message', {data:{type:'runtimeState',podman:true,...state}}));
    post({}); assert.equal(jupyter.disabled, true);
    post({uri:'file:///gpu.ipynb',name:'gpu.ipynb',colab:true}); assert.equal(jupyter.disabled, false);
    select.value='jupyter'; select.dispatchEvent(new win.Event('change'));
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), {type:'runtime',runtime:'jupyter',uri:'file:///gpu.ipynb'});
    assert.equal(select.value, '');
    post({}); assert.equal(jupyter.disabled, true);
  } finally { dom.window.close(); }
});
