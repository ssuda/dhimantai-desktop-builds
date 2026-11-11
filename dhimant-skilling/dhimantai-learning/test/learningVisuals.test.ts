import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildSync } from 'esbuild';
import { emptyNotebook, importNotebook, serializeNotebook } from '../src/tutorNotebook';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

const visualBundle = buildSync({stdin:{contents:"export * from './webview/visual'; export * from './webview/markdown'; export * from './webview/diagram';", resolveDir:resolve(__dirname,'../..')},
  bundle:true, write:false, format:'iife', globalName:'Visual', loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}}).outputFiles[0].text;

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
  const dom = new JSDOM('<!doctype html><button id="wide"></button><button id="latest"></button><button id="tutor"></button><button id="doubt_solver"></button><button id="end"></button><button id="sound"></button><span id="status"></span><input id="follow-code" type="checkbox"><input id="stuck-hints" type="checkbox"><small id="code-observer-status"></small><main id="feed"></main><form id="composer"><textarea id="message"></textarea><button id="send"></button><button id="teach-back"></button><button id="video"></button></form>',
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
