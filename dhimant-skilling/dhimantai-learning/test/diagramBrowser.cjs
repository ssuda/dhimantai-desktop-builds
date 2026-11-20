// Real Chromium acceptance with the packaged renderer and the notebook's actual CSP.
const assert = require('node:assert/strict');
const {readFileSync, mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {createServer} = require('node:http');
const {chromium} = require('playwright-core');
const {emptyNotebook, serializeNotebook, importNotebook} = require('../out/src/tutorNotebook');
const {notebookMessageBar} = require('../out/src/learningComposer');
const root = resolve(__dirname, '..');
const policy = readFileSync(resolve(root,'src/learningRoom.ts'),'utf8').match(/<meta http-equiv="Content-Security-Policy"[^\n]+/)[0]
  .replaceAll('${nonce}', 'test').replaceAll('${view.cspSource}', "'self'").replaceAll('${audioPolicy}', "'none'").replaceAll('${origin}', 'https://unused.invalid');
const html = `<!doctype html><html><head>${policy}<link rel="stylesheet" href="/room.css"><style>body{margin:0;font:14px system-ui,sans-serif}#feed{padding:20px}article{margin:0 auto 12px;padding:20px;max-width:720px}</style></head><body>
  <button id="wide" hidden></button><button id="latest" hidden></button><button id="tutor" hidden></button><button id="doubt_solver" hidden></button><button id="end" hidden></button><span id="status"></span>
  <input id="follow-code" type="checkbox" hidden><input id="stuck-hints" type="checkbox" hidden><small id="code-observer-status"></small>
  <main id="feed" data-diagram-renderer="/diagramEngines.js"></main><div hidden>${notebookMessageBar('Instructor', false, '<button type="button" id="sound"></button>')}</div>
  <script nonce="test">
  window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m)});
  window.peer={identity:'worker',isAgent:true,trackPublications:new Map()};window.rooms=[];
  class Room {
    listeners=new Map();remoteParticipants=new Map([['worker',peer]]);
    localParticipant={sendText:async()=>{},registerRpcMethod(){},performRpc:async()=>'ok'};
    constructor(){rooms.push(this)} on(name,fn){this.listeners.set(name,fn)} async connect(){} async disconnect(){} registerTextStreamHandler(){}
  }
  window.LivekitClient={Room,RoomEvent:new Proxy({},{get:(_,key)=>key})};
  window.violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push(e.violatedDirective));</script>
  <script src="/room.js"></script></body></html>`;
const workflow = 'graph TD\n  A["Purchase order (submit)<br/>promise to buy — no stock, no money"] --> B["Delivery / receipt<br/>widgets enter stock"]\n  B --> C["Supplier bill<br/>money is posted"]';
const source = '## Overview\n\nAn order is a commitment. Goods enter stock on receipt.\n\n```mermaid\n'+workflow+'\n```';
const output = process.env.DIAGRAM_ARTIFACTS || '/tmp/dhimantai-diagram-check';
const server = createServer((req,res) => {
  if (req.url === '/') { res.setHeader('Content-Type','text/html'); return res.end(html); }
  const name = req.url?.slice(1);
  if (['room.js','room.css','diagramEngines.js'].includes(name)) {
    res.setHeader('Content-Type', name.endsWith('css')?'text/css':'text/javascript'); return res.end(readFileSync(resolve(root,'media/learning-room',name)));
  }
  res.writeHead(404); res.end();
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({channel:'chrome',headless:true}); mkdirSync(output,{recursive:true});
  try {
    const page = await browser.newPage({viewport:{width:720,height:1000}}), errors=[], external=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{const url=route.request().url(); if(url.startsWith(origin)||url.startsWith('data:'))return route.continue();external.push(url);return route.abort();});
    await page.goto(origin);
    let revision = 0;
    const show = async (text, rawSvg = false) => {
      const id = 'overview-' + ++revision;
      const notebook = emptyNotebook(); notebook.cells=[{id,kind:'board',text}];
      const restored = importNotebook(new TextEncoder().encode(serializeNotebook(notebook)));
      await page.evaluate(({notebook,documentKey})=>window.postMessage({type:'restoreNotebook',documentKey,notebook},location.origin),
        {notebook:restored,documentKey:rawSvg?'apache-kafka/01-event-logs':'erpnext-supplier'});
      try {
        await page.waitForFunction(({id,rawSvg})=>{
          const cell = document.querySelector(`[data-cell-id="${id}"]`);
          if (rawSvg) return cell?.querySelector('img.board-diagram')?.naturalWidth > 0;
          const diagrams = [...(cell?.querySelectorAll('.text-diagram') ?? [])];
          return diagrams.length && diagrams.every(d=>['rendered','failed'].includes(d.dataset.diagramState));
        },{id,rawSvg},{timeout:10000});
      } catch(error) { throw new Error(JSON.stringify({errors,violations:await page.evaluate(()=>violations),feed:await page.locator('#feed').innerText()}),{cause:error}); }
    };
    const svg = async () => page.locator('#feed img.board-diagram').first().evaluate(image=>decodeURIComponent(image.src.slice(image.src.indexOf(',')+1)));
    await show(source);
    assert.equal(await page.locator('[data-diagram-state="rendered"]').count(),1,await page.locator('#feed').innerText());
    const rendered = await svg();
    const labels = rendered.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    assert.match(labels,/Purchase order/); assert.match(labels,/Delivery/); assert.match(labels,/Supplier bill/);
    assert.match(rendered,/marker-end="url\(#/); assert.doesNotMatch(rendered,/<foreignObject|<script|<style|<a\s/);
    assert.equal(await page.locator('#feed pre').count(),0);
    await page.waitForFunction(()=>document.querySelector('#feed img')?.naturalWidth>0);
    for(const width of [420,720]) {
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`No overflow at ${width}px`);
      await page.screenshot({path:resolve(output,`supplier-${width}.png`),fullPage:true});
    }
    await page.locator('#feed img').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('dialog[open] img').count(),1); await page.getByRole('button',{name:'Close',exact:true}).click();
    for(const variant of ['```\n'+workflow+'\n```',workflow, '```dot\ndigraph { A [label="Purchase order"]; B [label="Delivery / receipt"]; C [label="Supplier bill"]; A -> B -> C; }\n```']) {
      await show(variant); assert.equal(await page.locator('[data-diagram-state="rendered"]').count(),1,await page.locator('#feed').innerText());
      const text=(await svg()).replace(/<[^>]+>/g,' ').replace(/\s+/g,' '); assert.match(text,/Purchase order/);assert.match(text,/Supplier bill/);
      assert.equal(await page.locator('.conversation-preview').textContent(),'Diagram');
    }
    await show('```mermaid\nflowchart LR\n A{Received?} -->|Yes| B[Invoice]\n A -->|No| C[Wait]\n```');
    const branch = (await svg()).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    for(const label of ['Received?','Yes','No','Invoice','Wait']) assert.ok(branch.includes(label),label);
    await show('```mermaid\ngraph TD\n A["Purchase order"] --> broken[\n```\n\nThe purchase order is only a commitment.\n\n```mermaid\ngraph TD\n A-->B\n```');
    assert.equal(await page.locator('[data-diagram-state="failed"]').count(),1);
    assert.equal(await page.locator('[data-diagram-state="rendered"]').count(),1);
    assert.match(await page.locator('#feed').innerText(),/Purchase order.*The purchase order is only a commitment/s);
    await page.getByText('Diagram text',{exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:resolve(output,'fallback.png'),fullPage:true});
    await show('```mermaid\n%%{init:{"securityLevel":"loose","htmlLabels":true}}%%\ngraph TD\n A["Order"] --> B["Receipt"]\n click A "javascript:alert(1)"\n```');
    assert.equal(await page.locator('[data-diagram-state="rendered"]').count(),1);
    assert.doesNotMatch(await svg(),/javascript:|<a\s|onclick|<foreignObject/);
    // The same render path also handles a new Instructor packet, without reopening the notebook.
    await page.evaluate(()=>window.postMessage({type:'grant',attempt:0,url:'unused',token:'unused'},location.origin));
    await page.waitForFunction(()=>rooms[0]?.listeners.has('DataReceived'));
    await page.evaluate(content=>{
      const receive=rooms[0].listeners.get('DataReceived');
      const bytes=new TextEncoder().encode(JSON.stringify({method:'display_on_screen',content}));
      receive(bytes,{isAgent:false});receive(bytes,peer);
    },source);
    await page.waitForFunction(()=>document.querySelectorAll('#feed .text-diagram[data-diagram-state="rendered"]').length===2);
    assert.equal(await page.locator('#feed img.board-diagram').count(),2);
    await page.waitForFunction(()=>sent.some(message=>message.type==='notebookChanged'));
    const saved=await page.evaluate(()=>sent.filter(message=>message.type==='notebookChanged').at(-1).notebook);
    assert.equal(saved.cells.at(-1).text,source,'autosave retains portable Mermaid source');

    // Screenshot-based Chapter 1 reproduction. Read the actual sanitized image
    // in Chromium so the assertions include the font's ascent and descent.
    const kafka = readFileSync(resolve(__dirname,'fixtures/kafka-event-log.svg'),'utf8').trim();
    const lesson = '## What you will build\n\n' + kafka + '\n\nThe event log: publish once, read at your own pace.';
    await page.evaluate(content=>{
      const bytes = new TextEncoder().encode(JSON.stringify({method:'display_on_screen',content}));
      rooms[0].listeners.get('DataReceived')(bytes,peer);
    },lesson);
    const image = page.locator('img.board-diagram[alt*="Checkout and independent consumers"]').last();
    await image.waitFor();
    const liveSrc = await image.getAttribute('src');
    await page.waitForFunction(lesson=>sent.some(message=>message.type==='notebookChanged'
      && message.notebook.cells.some(cell=>cell.text===lesson)),lesson);
    await show(lesson,true);
    assert.equal(await image.getAttribute('src'),liveSrc,'restored and live diagrams render identically');
    const drawing = await browser.newPage();
    const checkTopicBox = async src => {
      await drawing.goto(src);
      const bounds = await drawing.evaluate(()=>{
        const box = id=>document.getElementById(id).getBoundingClientRect();
        const card = box('topic'), title = box('topic-name'), detail = box('topic-detail');
        return {top:title.y-card.y, between:detail.y-title.y-title.height,
          bottom:card.y+card.height-detail.y-detail.height,
          outgoing:document.getElementById('outgoing').getAttribute('d'),
          movedServices:[...document.querySelectorAll('text')]
            .filter(text=>/service|own pace/.test(text.textContent) && text.hasAttribute('transform')).length};
      });
      assert.ok(bounds.top>=3 && bounds.bottom>=3 && bounds.between>=1,JSON.stringify(bounds));
      assert.equal(bounds.outgoing,'M160 149V181 M160 184H16V324 M16 204H30 M16 264H30 M16 324H30');
      assert.equal(bounds.movedServices,0,'service labels and external caption keep their positions');
    };
    try {
      await checkTopicBox(liveSrc);
      for (const width of [320,1365]) {
        await page.setViewportSize({width,height:900});
        assert.ok(await image.evaluate(img=>img.getBoundingClientRect().right<=innerWidth));
        await page.screenshot({path:resolve(output,`kafka-${width}.png`),fullPage:true});
      }
      await image.screenshot({path:resolve(output,'kafka-diagram.png')});
      const multiline = kafka.replace(/<text id="topic-name".*?<\/text>\s*<text id="topic-detail".*?<\/text>/,
        '<text y="135"><tspan id="topic-name" x="160" dy="0">Topic: orders</tspan>' +
        '<tspan id="topic-detail" x="160" dy="19" font-size="14">append-only log</tspan></text>');
      await show('```svg\n'+multiline+'\n```',true);
      await checkTopicBox(await image.getAttribute('src'));
      const aligned = kafka.replace('y="135"','y="118"').replace('y="154"','y="137"');
      await show(aligned,true);
      await checkTopicBox(await image.getAttribute('src'));
      assert.equal(await drawing.locator('text[transform]').count(),0,'properly spaced diagram keeps its layout');
    } finally { await drawing.close(); }
    assert.deepEqual(await page.evaluate(()=>violations),[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log('Diagram browser acceptance passed: Kafka node labels (320/1365px), live and restored SVG, supplier workflow, Mermaid/DOT, fallback and CSP. Screenshots: '+output);
  } finally { await browser.close(); server.close(); }
})().catch(error=>{server.close();console.error(error);process.exitCode=1;});
