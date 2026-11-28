import { notebookMessageBar } from '../src/learningComposer';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { emptyNotebook, importNotebook, serializeNotebook } from '../src/tutorNotebook';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

const visualBundle = readFileSync(resolve(__dirname, 'fixtures/board.js'), 'utf8');

test('Markdown previews retain readable content and literal code without formatting syntax', () => {
  const dom = new JSDOM('<!doctype html>', {runScripts:'outside-only'});
  try {
    dom.window.eval(visualBundle);
    const plain = dom.window.Visual.markdownPlainText;
    assert.equal(plain('## Your turn\n\n*Section check*\n\nMeena has **five** sentences.'), 'Your turn Section check Meena has five sentences.');
    assert.equal(plain('> Read [the source](https://example.test) &amp; explain.\n\n- First\n- Second\n\n![A **map**](https://example.test/map.png)'), 'Read the source & explain. First Second A map');
    assert.equal(plain('Use `student_name`, `2 ** 3` and C#.\n\n```python\nprint("# * _")\n```'), 'Use student_name, 2 ** 3 and C#. print("# * _")');
    assert.equal(plain('First\nline  \nbreak.\n\n| A | B |\n|---|---|\n| 1 | 2 |'), 'First line break. A B 1 2');
    assert.equal(plain('Find $x^2$ and \\(y + 1\\).'), 'Find x^2 and y + 1.');
    assert.equal(plain('Compare <img src=x onerror=alert(1)> with text.'), 'Compare <img src=x onerror=alert(1)> with text.');
    assert.equal(plain(' \n\n '), '');
  } finally { dom.window.close(); }
});

test('textbook Markdown keeps original URLs and captions, while active/local sources remain inert', () => {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts:'outside-only'});
  try {
    const w = dom.window; w.eval(visualBundle);
    const main = w.document.querySelector('main')!;
    const url = 'https://storage.example/lesson-images/figure%20(1).png?token=one&download=false';
    const label = 'Figure 1 [input] <script>bad()</script>';
    main.innerHTML = w.Visual.renderBoard('## Feature extraction\n\n' + w.Visual.imageMarkdown(url, label) + '\n\nThe embedding model converts text into features.');
    const image = main.querySelector('img')!;
    assert.equal(image.src, url); assert.equal(image.alt, label);
    assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
    assert.match(main.textContent!, /embedding model converts text/);
    assert.equal(main.querySelector('script, iframe'), null);
    for (const source of ['javascript:alert(1)', 'file:///private/book.png', 'command:evil', 'http://host/figure.png', '//host/figure.png', 'https://user:password@host/figure.png', 'data:image/svg+xml,<svg onload="evil()"/>']) {
      assert.equal(w.Visual.imageSource(source), undefined, source);
      main.innerHTML = w.Visual.imageMarkup(source, label);
      assert.equal(main.querySelector('img, script, iframe'), null);
      assert.equal(main.textContent, label);
    }
    const source = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(w.Visual.imageSource(source), source);
    assert.equal(w.Visual.imageSource('https://host/' + 'a'.repeat(16000)), undefined);
  } finally { dom.window.close(); }
});

test('SVG question previews omit source while board diagrams still render safely', () => {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts:'outside-only'});
  try {
    const w = dom.window; w.eval(visualBundle);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" onload="bad()"><text x="10" y="30">Terminal → shell</text><script>bad()</script></svg>';
    const question = 'Which part worked out what `pwd` means — the terminal or the shell?';
    const main = w.document.querySelector('main')!;
    for (const visual of [svg, '```svg\n' + svg + '\n```', '```xml\n<?xml version="1.0"?>\n' + svg + '\n```', '```\n' + svg + '\n```']) {
      assert.equal(w.Visual.markdownPlainText(visual + '\n\n' + question), 'Diagram Which part worked out what pwd means — the terminal or the shell?');
      assert.equal(w.Visual.markdownPlainText(visual), 'Diagram');
      main.innerHTML = w.Visual.renderBoard(visual + '\n\n' + question);
      const image = main.querySelector<HTMLImageElement>('img.board-diagram')!;
      assert.ok(image, 'the full question retains its diagram');
      assert.doesNotMatch(decodeURIComponent(image.src), /onload|<script/);
      assert.doesNotMatch(main.textContent!, /<svg|xmlns|viewBox|bad\(\)/);
      assert.match(main.textContent!, /the terminal or the shell/);
    }
    for (const visual of ['`' + svg + '`', svg.replaceAll('<', '&lt;').replaceAll('>', '&gt;'), '<svg viewBox="0 0 320 120"><path d="M0 0"/>']) {
      assert.equal(w.Visual.markdownPlainText(visual), 'Diagram', 'literal, escaped and incomplete SVG cannot leak into a preview');
    }
  } finally { dom.window.close(); }
});

test('SVGs preserve portrait, landscape and small intrinsic dimensions and support keyboard enlargement', () => {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts:'outside-only', pretendToBeVisual:true});
  try {
    const w = dom.window; w.eval(visualBundle);
    const main = w.document.querySelector('main')!;
    w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
    w.HTMLDialogElement.prototype.close = function() { this.open = false; this.dispatchEvent(new w.Event('close')); };
    let failures = 0;
    const close = w.Visual.bindVisuals(main, () => failures++);
    for (const [width, height] of [[900,1800],[1800,450],[160,80]]) {
      main.innerHTML = w.Visual.diagram(`<svg width="100%" height="100%" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}"/><text x="10" y="30">Feature extractor</text></svg>`);
      w.Visual.prepareVisuals(main);
      const image = main.querySelector('img')!;
      const xml = new w.DOMParser().parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')), 'image/svg+xml');
      assert.equal(xml.documentElement.getAttribute('width'), String(width));
      assert.equal(xml.documentElement.getAttribute('height'), String(height));
      assert.equal(xml.documentElement.getAttribute('preserveAspectRatio'), 'xMidYMid meet');
      image.focus(); image.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',bubbles:true}));
      const dialog = w.document.querySelector('dialog')!;
      assert.equal(dialog.open, true); assert.equal(dialog.querySelector('img')!.src, image.src);
      dialog.querySelector('button')!.click();
      assert.equal(w.document.querySelector('dialog'), null); assert.equal(w.document.activeElement, image);
      image.click(); close(); assert.equal(w.document.querySelector('dialog'), null);
      image.dispatchEvent(new w.Event('error'));
      assert.match(main.textContent!, /Image unavailable:.*Feature extractor/);
      assert.equal(main.querySelector('img'), null);
    }
    assert.equal(failures, 3);
    for (const dimensions of ['width="160" height="80"', 'width="160"', 'height="80"']) {
      main.innerHTML = w.Visual.diagram(`<svg ${dimensions} viewBox="0 0 1600 800"><rect width="1600" height="800"/></svg>`);
      const image = main.querySelector('img')!;
      const xml = new w.DOMParser().parseFromString(decodeURIComponent(image.src.split(',').slice(1).join(',')), 'image/svg+xml');
      assert.equal(xml.documentElement.getAttribute('width'), '160');
      assert.equal(xml.documentElement.getAttribute('height'), '80');
    }
  } finally { dom.window.close(); }
});

test('Instructor receives textbook image packets beside explanations and restores them from saved notebooks', async () => {
  const dom = new JSDOM('<!doctype html><button id="wide"></button><button id="latest"></button><button id="tutor"></button><button id="doubt_solver"></button><button id="end"></button><span id="status"></span><input id="follow-code" type="checkbox"><input id="stuck-hints" type="checkbox"><small id="code-observer-status"></small><main id="feed"></main>' + notebookMessageBar('Instructor', false, '<button type="button" id="sound"></button>'),
    {runScripts:'outside-only',url:'https://webview.example',pretendToBeVisual:true});
  const w = dom.window, sent: any[] = [], rooms: Room[] = [];
  const agent = {identity:'worker',isAgent:true,trackPublications:new Map()};
  class Room {
    listeners = new Map<string, Function>(); remoteParticipants = new Map([['worker',agent]]);
    localParticipant = {sendText:async()=>{}, registerRpcMethod(){},performRpc:async()=> 'ok'};
    constructor(){ rooms.push(this); }
    on(name:string, fn:Function){this.listeners.set(name,fn);} async connect(){} async disconnect(){} registerTextStreamHandler(){}
  }
  const names = ['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'];
  w.LivekitClient = {Room,RoomEvent:Object.fromEntries(names.map(n=>[n,n]))};
  w.acquireVsCodeApi = () => ({postMessage:(message:any)=>sent.push(message)});
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  const post = (data:object) => w.dispatchEvent(new w.MessageEvent('message',{data,origin:w.location.origin}));
  const feed = w.document.getElementById('feed')!;
  try {
    w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
    w.eval(readFileSync(resolve(__dirname,'../../media/learning-room/room.js'),'utf8'));
    post({type:'openTutor'}); selectLesson(w, sent.at(-1).attempt);
    const attempt = sent.at(-1).attempt;
    post({type:'grant',attempt,url:'unused',token:'unused',chapterId});
    await new Promise(r=>setTimeout(r,0));
    post({type:'restoreNotebook',notebook:emptyNotebook(),documentKey:'lesson-images',attempt});
    const receive = rooms[0].listeners.get('DataReceived')!;
    const packet = (data:object, peer:any=agent) => receive(new TextEncoder().encode(JSON.stringify(data)),peer);
    const source = 'https://storage.example/lesson-images/fig_001.png?token=abc&v=1';
    const payload = {method:'draw_svg',action:'update',image_url:source,label:'Original textbook figure'};
    packet(payload,{isAgent:false}); assert.equal(feed.querySelector('img'),null);
    packet(payload); assert.equal(feed.querySelector('img')!.src,source);
    assert.match(feed.textContent!, /Original textbook figure/);
    packet({method:'display_on_screen',content:'## Feature extraction\n\nThe original figure shows how the model converts text into an embedding.'});
    assert.equal(feed.querySelectorAll('img').length,1); assert.match(feed.textContent!, /original figure shows/);
    packet({method:'display_image',image_url:source.replace('001','002'),caption:'Second figure'});
    packet({method:'display_on_screen',content:`![Inline textbook figure](<${source.replace('001','003')}>)\n\nNotice the arrows in the figure.`});
    assert.equal(feed.querySelectorAll('img.board-image').length,3);
    for (const image_url of ['javascript:evil()', 'file:///private/book.png']) packet({...payload,image_url});
    packet({...payload,action:'clear'});
    assert.equal(feed.querySelectorAll('img.board-image').length,3);
    packet({method:'draw_svg',svg:'<svg viewBox="0 0 900 1800"><rect width="900" height="1800"/><text x="10" y="30">Generated diagram</text></svg>'});
    assert.equal(feed.querySelectorAll('img.board-diagram').length,1);
    await new Promise(r=>setTimeout(r,300));
    const saved = sent.filter(message=>message.type==='notebookChanged').at(-1).notebook;
    const exported = serializeNotebook(saved);
    const restored = importNotebook(new TextEncoder().encode(exported));
    assert.deepEqual(restored.cells, JSON.parse(JSON.stringify(saved.cells)));
    assert.match(JSON.parse(exported).cells[0].source, /!\[Original textbook figure\]/);
    post({type:'restoreNotebook',notebook:restored,documentKey:'lesson-images',attempt});
    assert.equal(feed.querySelectorAll('img.board-image').length,3);
    assert.equal(feed.querySelector('img')!.src,source);
    assert.match(feed.textContent!, /original figure shows/);
    feed.querySelector('img')!.dispatchEvent(new w.Event('error'));
    assert.match(feed.querySelector('.diagram-alternative')!.textContent!, /original figure shows/);
  } finally { w.close(); }
});

test('generated diagrams use the notebook width, while photos and tiny SVGs keep a sensible size', () => {
  const dom = new JSDOM('<!doctype html><main></main>', {runScripts:'outside-only'});
  try {
    const w = dom.window; w.eval(visualBundle);
    const main = w.document.querySelector('main')!;
    const style = (svg: string) => { main.innerHTML = w.Visual.diagram(svg); return main.querySelector<HTMLImageElement>('img.board-diagram')!.style; };
    const flow = style('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 480"><rect x="10" y="10" width="300" height="60"/><text x="20" y="40">Dockerfile</text></svg>');
    assert.equal(flow.width, '100%');
    assert.equal(flow.maxWidth, 'min(100%,664px)', 'a phone-width chart may double, not more');
    assert.match(flow.maxHeight, /72vh/, 'a tall chart stays beside its explanation');
    const wide = style('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="360"><rect width="900" height="360" fill="#eef"/><text x="20" y="40">Build</text></svg>');
    assert.equal(wide.maxWidth, 'min(100%,1040px)');
    const icon = style('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>');
    assert.equal(icon.maxWidth, 'min(100%,72px)');
    main.innerHTML = w.Visual.imageMarkup('https://example.test/figure.png', 'Figure');
    assert.match(main.querySelector('img')!.style.maxWidth, /720px/, 'textbook photos keep their existing size');
  } finally { dom.window.close(); }
});
