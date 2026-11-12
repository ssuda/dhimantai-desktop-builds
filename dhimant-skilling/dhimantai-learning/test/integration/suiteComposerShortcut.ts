/** Real desktop key dispatch through the production composer and VS Code webview. */
import * as assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildSync} from 'esbuild';
import * as vscode from 'vscode';
import {learningComposer} from '../../src/learningComposer';
import {connect} from './suiteStudy';

export async function run() {
  const panel=vscode.window.createWebviewPanel('dhimantai.composerShortcut','Composer keyboard check',vscode.ViewColumn.One,{enableScripts:true});
  const source=buildSync({stdin:{resolveDir:resolve(__dirname,'../../..'),contents:`
    import {bindComposer} from './webview/composer';
    const field=document.getElementById('message'), form=document.getElementById('composer');
    window.probe={sent:[],forwarded:0};
    window.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey)window.probe.forwarded++;});
    document.getElementById('send').disabled=false;
    bindComposer(form,field,()=>{window.probe.sent.push(field.value);field.value='';});
  `},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
  panel.webview.html=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-keyboard-check';"></head><body>${learningComposer('Instructor',false,'')}<script nonce="keyboard-check">${source}</script></body></html>`;
  const cdp=await connect();
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.defaultView.probe)return null;return (${expression})(d);}`);
  const pause=()=>new Promise(r=>setTimeout(r,100));
  const until=async(expression:string)=>{for(let i=0;i<100;i++){const result=await ui(expression);if(result)return result;await pause();}throw new Error('Composer did not receive desktop keyboard input.');};
  const key=async(modifiers=0)=>{
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers,...(modifiers&7?{}:{text:'\r'})});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers});
    await pause();
  };
  try {
    await until('d=>!!d.querySelector("#message")');
    await ui(`d=>{const f=d.querySelector('#message');f.value='First line';f.focus();f.setSelectionRange(f.value.length,f.value.length);return true;}`);
    await key();
    assert.equal(await ui('d=>d.querySelector("#message").value'),'First line\n','Enter inserts a line');
    assert.deepEqual(await ui('d=>d.defaultView.probe.sent'),[]);
    await key(8); // Shift
    await key(2); // Control
    await key(4); // Meta / Command
    assert.deepEqual(await ui('d=>d.defaultView.probe.sent'),[],'no Enter shortcut sends');
    const draft=await ui('d=>d.querySelector("#message").value');
    await ui(`d=>{d.querySelector('#send').click();return true;}`);
    await until('d=>d.defaultView.probe.sent.length===1');
    const result=await ui('d=>d.defaultView.probe');
    assert.deepEqual(result.sent,[draft]);
    assert.equal(result.forwarded,0,'editing keys never reach the workbench forwarding listener');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,vscode:vscode.version,platform:process.platform,...result},null,2));
  } finally {cdp.close();panel.dispose();}
}
