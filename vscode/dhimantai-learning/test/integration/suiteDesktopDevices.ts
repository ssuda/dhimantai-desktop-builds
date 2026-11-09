import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {connect} from './suiteStudy';

/** Native capture check. Launch only with fake devices. This does not certify
 * physical devices or permission prompts; Chromium may bypass consent for fakes. */
export async function run() {
  assert.equal(vscode.env.appName,'dhimantAI');
  const cdp = await connect();
  const panel = vscode.window.createWebviewPanel('dhimantai.deviceProbe','Desktop device permission check',vscode.ViewColumn.One,{enableScripts:true});
  const events: any[] = [];
  panel.webview.onDidReceiveMessage(message=>{events.push(message);console.log('Device probe:',JSON.stringify(message));});
  panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-device-probe'; media-src blob:; style-src 'unsafe-inline'"></head>
  <body><h1>Desktop permission check</h1><p>This launch uses synthetic microphone and camera devices. No physical devices are accessed.</p>
  <button id="start">Test microphone and camera</button><button id="stop">Stop test tracks</button><p id="status">Ready</p><video muted autoplay width="320"></video>
  <script nonce="device-probe">
  const host=acquireVsCodeApi(); let stream;
  document.querySelector('#start').onclick=async()=>{
    try {stream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});
      document.querySelector('video').srcObject=stream;
      document.querySelector('#status').textContent='Synthetic capture running';
      host.postMessage({event:'capture',tracks:stream.getTracks().map(t=>({kind:t.kind,state:t.readyState}))});
    } catch(e) {host.postMessage({event:'error',name:e.name,message:e.message});document.querySelector('#status').textContent=e.name+': '+e.message;}
  };
  document.querySelector('#stop').onclick=()=>{stream?.getTracks().forEach(t=>t.stop());host.postMessage({event:'stopped',states:stream?.getTracks().map(t=>t.readyState)});};
  </script></body></html>`;
  const ui = (expression: string) => cdp.webview(`d=>d.querySelector('#start')?(${expression})(d):null`);
  const until = async (read:()=>Promise<any>,label:string) => {
    const deadline=Date.now()+90000;
    do {const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,250));}while(Date.now()<deadline);
    throw new Error('Timed out: '+label);
  };
  let passed=false;
  try {
    await until(()=>ui('d=>!!d.querySelector("#start")'),'device test page');
    await ui('d=>{d.querySelector("#start").click();return true;}');
    await until(async()=>events.some(e=>e.event==='capture') || events.some(e=>e.event==='error'),'capture result');
    assert.equal(events.some(e=>e.event==='error'),false,JSON.stringify(events));
    assert.deepEqual(events.find(e=>e.event==='capture').tracks.map((t:any)=>t.kind).sort(),['audio','video']);
    await until(()=>ui('d=>d.querySelector("video").videoWidth>0'),'synthetic camera frames');
    await ui('d=>{d.querySelector("#stop").click();return true;}');
    await until(async()=>events.some(e=>e.event==='stopped'),'stopped tracks');
    assert.deepEqual(events.find(e=>e.event==='stopped').states,['ended','ended']);
    passed=true;
  } finally {
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed,synthetic:true,events},null,2));
    panel.dispose();cdp.close();
  }
}
