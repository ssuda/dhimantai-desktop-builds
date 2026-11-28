/** Real desktop key dispatch through the production composer and VS Code webview. */
import * as assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildSync} from 'esbuild';
import * as vscode from 'vscode';
import {notebookMessageBar} from '../../src/learningComposer';
import {connect, submitNotebookMessage} from './suiteNotebookCoachHistory';
import {EMAIL, PASSWORD} from './contractServer';
import type {Auth} from '../../src/auth';

export async function run() {
  const panel=vscode.window.createWebviewPanel('dhimantai.composerShortcut','Composer keyboard check',vscode.ViewColumn.One,{enableScripts:true});
  const source=buildSync({stdin:{resolveDir:resolve(__dirname,'../../..'),contents:`
    import {bindComposer} from './webview/composer';
    const field=document.getElementById('message'), form=document.getElementById('composer');
    window.probe={sent:[],forwarded:0};
    window.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey)window.probe.forwarded++;});
    bindComposer(form,message=>{window.probe.sent.push(message.text);field.value='';}).setAvailable(true);
  `},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
  panel.webview.html=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-keyboard-check';"></head><body>${notebookMessageBar('Instructor',false,'')}<script nonce="keyboard-check">${source}</script></body></html>`;
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
    const {auth} = await vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!.activate();
    await auth.signInWithPassword(EMAIL, PASSWORD);
    const code = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print(42)', 'python');
    const notebook = await vscode.workspace.openNotebookDocument('jupyter-notebook', new vscode.NotebookData([code]));
    await vscode.window.showNotebookDocument(notebook);
    const request = vscode.commands.executeCommand('dhimantai.notebook.ask');
    await submitNotebookMessage(cdp, 'Explain this diagram.', true);
    await request;
    const state = await (await fetch(process.env.DHIMANTAI_TEST_SERVER + '/__state')).json() as any;
    assert.equal(state.coach.length,1, JSON.stringify(notebook.getCells().map(c => c.document.getText())));
    assert.equal(state.coach[0].source,'print(42)');
    assert.equal(state.coach[0].message,'Explain this diagram.');
    assert.equal(state.coach[0].attachments[0].name,'error.png');
    assert.ok(notebook.getCells().some(cell => cell.document.getText().includes('Check which name this line reads.')));
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,vscode:vscode.version,platform:process.platform,...result},null,2));
  } finally {cdp.close();panel.dispose();}
}
