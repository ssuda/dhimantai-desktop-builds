import * as assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD } from './contractServer';
const pause = (ms=100) => new Promise(resolve => setTimeout(resolve,ms));
async function until(read: () => Promise<any>, test: (value:any) => boolean, label:string) {
  for(let i=0;i<120;i++){const value=await read();if(test(value))return value;await pause();}
  throw new Error('Timed out: '+label);
}
export async function connect() {
  const pages = await (await fetch(`http://127.0.0.1:${process.env.DHIMANTAI_CDP_PORT ?? '9339'}/json`)).json() as any[];
  const page = pages.find(page => page.type === 'page' && /workbench/.test(page.url));
  assert.ok(page, 'real VS Code workbench is available');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  let id = 0;
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timeout: ' + method)); }, 10000);
    pending.set(requestId, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
    socket.send(JSON.stringify({id: requestId, method, params, sessionId}));
  });
  const evaluate = async (expression: string, sessionId?: string) => {
    const response = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const sessions = new Map<string, string>();
  const webview = async (expression: string) => {
    const targets = (await send('Target.getTargets')).targetInfos as any[];
    for (const target of targets.filter(target => ['iframe', 'page'].includes(target.type) && /vscode-webview/.test(target.url))) {
      try {
        let session = sessions.get(target.targetId);
        if (!session) {
          session = (await send('Target.attachToTarget', {targetId: target.targetId, flatten: true})).sessionId as string;
          sessions.set(target.targetId, session);
        }
        // The outer VS Code webview frame contains a same-origin active content frame.
        const wrapped = `(() => { const d = document.getElementById('active-frame')?.contentDocument || document;
          return (${expression})(d); })()`;
        const result = await evaluate(wrapped, session);
        if (result !== null && result !== undefined) return result;
      } catch (error) {
        if (!/No target|Session with given|Cannot find context|Inspected target navigated/.test(String(error))) throw error;
        sessions.delete(target.targetId);
      }
    }
    return null;
  };
  return {send, evaluate, webview, close: () => socket.close()};
}

export async function run() {
  const out=process.env.DHIMANTAI_UX_OUT || '/tmp/dhimantai-study-ui'; mkdirSync(out,{recursive:true});
  const ext=vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!;
  const {auth}=await ext.activate();
  await auth.signInWithPassword(EMAIL,PASSWORD);
  const cdp=await connect();
  const ui=(expression:string)=>cdp.webview(`d => {if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const snapshot=()=>ui(`d=>({title:d.querySelector('#title').textContent,page:d.querySelector('#page').textContent,
    text:d.querySelector('#viewer iframe')?.contentDocument?.body?.textContent,
    ready:d.querySelector('#loading').style.display==='none',error:d.querySelector('#loading-text').textContent,help:d.querySelector('#response').textContent,
    notice:d.querySelector('#notice').textContent,status:d.querySelector('#help-status').textContent,course:d.querySelector('#course').textContent})`);
  try {
    await vscode.commands.executeCommand('dhimantai.openStudy','book-zen-assembly');
    const opened=await until(snapshot,s=>s?.text?.includes('Count Work Before Measuring Time'),'real EPUB chapter');
    assert.match(opened.course,/Zen/);
    assert.equal(await ui(`d=>d.querySelector('#viewer iframe').contentDocument.querySelectorAll('link[rel="stylesheet"]').length`),0,'reader does not wait for VS Code stylesheet requests');
    assert.equal(await ui(`d=>Array.from(d.querySelector('#viewer iframe').contentDocument.querySelectorAll('style')).some(s=>s.textContent.includes('data:font/woff2;base64,'))`),true,'math fonts travel with the EPUB');
    const layout=await ui(`d=>({aside:!!d.querySelector('aside'),overlay:d.querySelector('#study-dialog').open,readerWidth:d.querySelector('#reading').getBoundingClientRect().width,viewport:d.documentElement.clientWidth})`);
    assert.ok(!layout.aside&&!layout.overlay&&Math.abs(layout.readerWidth-layout.viewport)<2,'book fills the editor without a right panel: '+JSON.stringify(layout));
    await ui(`d=>{d.defaultView.__readerBefore=d.querySelector('#viewer iframe');d.querySelector('#open-study').click();return true;}`);
    assert.equal(await ui(`d=>d.querySelector('#study-dialog').open&&d.activeElement.id==='question'`),true,'Ask opens a focused modal Study view');
    writeFileSync(join(out,'study-overlay.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await ui(`d=>{d.querySelector('#close-study').click();return true;}`);
    assert.equal(await ui(`d=>!d.querySelector('#study-dialog').open&&d.querySelector('#viewer iframe')===d.defaultView.__readerBefore`),true,'back to book keeps the EPUB mounted');
    await ui(`d=>{const f=d.querySelector('#viewer iframe').contentDocument;const r=f.createRange();r.selectNodeContents(f.querySelector('h1'));const selection=f.defaultView.getSelection();selection.removeAllRanges();selection.addRange(r);f.dispatchEvent(new f.defaultView.Event('selectionchange'));return true;}`);
    await until(()=>ui(`d=>!d.querySelector('#explain').disabled`),v=>v===true,'actual EPUB text selection');
    assert.equal(await ui(`d=>!d.querySelector('#selection-toolbar').hidden`),true,'selection actions appear on the book');
    writeFileSync(join(out,'study-selection.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await ui(`d=>{d.querySelector('#dismiss-selection').click();return true;}`);
    assert.equal(await ui(`d=>d.querySelector('#selection-toolbar').hidden`),true,'selection toolbar is dismissible');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:480,height:820,deviceScaleFactor:1,mobile:false});
    await pause(500);
    const narrow=await ui(`d=>({width:d.documentElement.clientWidth,scroll:d.documentElement.scrollWidth,reader:d.querySelector('#reading').getBoundingClientRect().width,toolbarBottom:d.querySelector('.reader-toolbar').getBoundingClientRect().bottom,height:d.documentElement.clientHeight})`);
    assert.ok(narrow.scroll<=narrow.width&&Math.abs(narrow.reader-narrow.width)<2&&narrow.toolbarBottom<=narrow.height+1,'narrow editor keeps full-width reading and reachable controls: '+JSON.stringify(narrow));
    writeFileSync(join(out,'study-narrow.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await cdp.send('Emulation.clearDeviceMetricsOverride');await pause(500);
    await ui(`d=>{d.querySelector('#next').click();return true;}`);
    await until(snapshot,s=>s?.page && s.page!==opened.page,'page navigation');
    await pause(500);
    const page=(await snapshot()).page;
    await ui(`d=>{d.querySelector('#open-study').click();return true;}`);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(()=>ui(`d=>!d.querySelector('#study-dialog').open`),v=>v===true,'Escape returns to the book');
    assert.equal((await snapshot()).page,page,'closing Study preserves the current reading page');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('dhimantai.openStudy','book-zen-assembly');
    await until(snapshot,s=>s?.page===page && s.text?.includes('Count Work'),'saved reading position');
    await ui(`d=>{const c=d.querySelector('#chapter');c.selectedIndex=1;c.dispatchEvent(new Event('change'));return true;}`);
    await until(snapshot,s=>s?.text?.includes('Preserve the Machine Contract'),'second chapter');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(out,'study-reader.png'),Buffer.from(shot.data,'base64'));
    await auth.signOut();
    await until(snapshot,s=>!s?.text && s?.notice.includes('Sign in'),'sign out removes the authorized book');
    assert.equal(await ui(`d=>d.querySelector('#summary').disabled`),true,'signed-out reader cannot request help');
    assert.equal(await ui(`d=>d.querySelector('#sign-in').hidden`),false);
    assert.equal((await snapshot()).help,'','account change removes prior response');
    await auth.signInWithPassword(EMAIL,PASSWORD);
    const companions=JSON.parse(readFileSync(join(ext.extensionPath,'media/study/book_companions.json'),'utf8')).courses;
    for(let round=0;round<3;round++)for(const course of companions){
      await vscode.commands.executeCommand('dhimantai.openStudy',course.id);
      await until(snapshot,s=>s?.ready && s.title===course.chapters[0].title && s.text?.includes(course.chapters[0].title),'repeat reader transition '+course.id);
      await pause(400);
    }
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,checks:['full-width book without side panel','narrow editor without horizontal overflow','on-demand focused Study overlay','Back to book preserves EPUB','Escape preserves reading position','floating dismissible selection action','real EPUB render','actual text selection','sign out removes the book','pagination','resume','21 repeated EPUB transitions'],screenshot:join(out,'study-reader.png')},null,2));
  } catch(error) {
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error),snapshot:await snapshot()},null,2));throw error;
  } finally {cdp.close();}
}
