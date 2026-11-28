import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';

const bundle = buildSync({stdin:{contents:"export * from './webview/markdown'; export * from './webview/diagramBlocks';", resolveDir:resolve(__dirname,'../..')},
  bundle:true, write:false, format:'iife', globalName:'Board'}).outputFiles[0].text;
const workflow = 'graph TD\n  A["Purchase order (submit)<br/>promise to buy — no stock, no money"] --> B["Delivery / receipt<br/>widgets enter stock"]\n  B --> C["Supplier bill<br/>money is posted"]';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Instructor detects labelled, unlabelled, indented and bare diagrams without consuming the explanation', () => {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts:'outside-only'});
  try {
    const w = dom.window; w.eval(bundle); const root = w.document.querySelector('main')!;
    for (const source of ['```mermaid\n'+workflow+'\n```', '```\n'+workflow+'\n```', '```text\n'+workflow+'\n```', workflow,
      workflow.split('\n').map(line=>'    '+line).join('\n'), '```DOT\ndigraph { A -> B }\n```', 'digraph { A -> B }']) {
      root.innerHTML = w.Board.renderBoard(source+'\n\n**An order is a commitment.**');
      assert.equal(root.querySelectorAll('.text-diagram').length, 1, source);
      assert.equal(root.querySelector('strong')!.textContent, 'An order is a commitment.');
      assert.equal(w.Board.markdownPlainText(source), 'Diagram');
    }
    for (const source of ['```python\n'+workflow+'\n```', '```javascript\nconst graph = "TD";\n```', 'A journey starts with an order.', 'journey to the supplier', '```\nprint(2)\n```']) {
      root.innerHTML = w.Board.renderBoard(source);
      assert.equal(root.querySelector('.text-diagram'), null, source);
    }
  } finally { dom.window.close(); }
});

test('invalid diagrams keep readable labels and wrapped, inert source; the next valid diagram still renders', async () => {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts:'outside-only'});
  try {
    const w = dom.window; w.eval(bundle); const root = w.document.querySelector('main')!;
    const calls: string[] = [];
    w.DhimantDiagrams = {render:async (_:string, source:string) => {
      calls.push(source); if (source.includes('broken')) throw new Error('Parse failed');
      return '<img class="board-diagram" alt="Order to receipt" src="data:image/svg+xml,%3Csvg/%3E">';
    }};
    let prepared = 0; const stop = w.Board.bindDiagramBlocks(root, () => prepared++);
    root.innerHTML = w.Board.renderBoard('```mermaid\n'+workflow+'\nbroken <script>bad()</script>\n```\n\n```mermaid\ngraph TD\nA-->B\n```');
    await tick(); await tick();
    assert.equal(root.querySelectorAll('[data-diagram-state="failed"]').length, 1);
    assert.match(root.querySelector('ul')!.textContent!, /Purchase order.*promise to buy.*Supplier bill.*money is posted/);
    assert.equal(root.querySelector('.diagram-source')!.getAttribute('style')!.includes('pre-wrap'), true);
    assert.equal(root.querySelector('script'), null);
    assert.equal(root.querySelectorAll('img.board-diagram').length, 1); assert.equal(prepared, 1);
    assert.equal(calls.length, 2); stop();
  } finally { dom.window.close(); }
});

test('missing renderer falls back and late results cannot overwrite a restored notebook', async () => {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts:'outside-only'});
  try {
    const w = dom.window; w.eval(bundle); const root = w.document.querySelector('main')!;
    let stop = w.Board.bindDiagramBlocks(root, () => {});
    root.innerHTML = w.Board.renderBoard('```mermaid\n'+workflow+'\n```');
    await tick(); assert.match(root.textContent!, /Diagram could not be drawn/); stop();
    let finish!: (value:string) => void;
    w.DhimantDiagrams = {render:() => new Promise(resolve => { finish = resolve; })};
    stop = w.Board.bindDiagramBlocks(root, () => {});
    root.innerHTML = w.Board.renderBoard('```mermaid\n'+workflow+'\n```'); await tick();
    root.textContent = 'A different lesson';
    finish('<img class="board-diagram" alt="old lesson">'); await tick();
    assert.equal(root.textContent, 'A different lesson'); stop();
  } finally { dom.window.close(); }
});
