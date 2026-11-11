/** Manual interaction in actual VS Code with production UI and controlled Instructor replies. */
import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { Api } from '../../src/api';
import type { Auth } from '../../src/auth';
import { EMAIL, PASSWORD } from './contractServer';

export async function run() {
  const extension = vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await extension.activate();
  await auth.signInWithPassword(EMAIL,PASSWORD);
  const create = vscode.window.createWebviewPanel, grant = Api.prototype.learningRoom;
  Api.prototype.learningRoom = async () => ({url:'wss://lk-prod.dhimant.ai',token:'fixture'});
  const events: any[] = [];
  let panel: vscode.WebviewPanel | undefined, finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const fixture = `
const api = acquireVsCodeApi(); window.acquireVsCodeApi = () => api;
const report = (event, value) => api.postMessage({type:'messageBarProbe',event,value});
const agent = {identity:'fixture',isAgent:true,trackPublications:new Map()};
let room;
const packet = data => room.handlers.DataReceived(new TextEncoder().encode(JSON.stringify({method:'display_on_screen',...data})),agent);
class Room {
  constructor() { room=this; this.handlers={}; this.remoteParticipants=new Map([[agent.identity,agent]]);
    this.localParticipant={registerRpcMethod(){},performRpc:async request => {
      if(request.method==='switch_mode') setTimeout(() => packet({content:'## Try a small Python example\\n\\nEdit and run this code in your course container. Ask Instructor below when you want help.\\n\\n'+String.fromCharCode(96).repeat(3)+'python\\nitems = [10, 20, 30]\\nprint(items[1])\\n'+String.fromCharCode(96).repeat(3)}),100);
      if(request.method==='on_editor_activity') report('observation',JSON.parse(request.payload));
      return 'ok';
    },sendText:async text => {
      report('message',text);
      setTimeout(() => !text.startsWith('TUTOR_NOTEBOOK_ANSWER')
        ? packet({content:'What will items[0] print? Explain why.',is_question_prompt:true,tutor_checkpoint_id:'index-check'})
        : text.startsWith('TUTOR_NOTEBOOK_ANSWER')
          ? packet({content:'The first element is 10 because Python indexes start at zero.',tutor_feedback:true})
          : packet({content:'Python indexes start at zero.'}),100);
    }};
  }
  on(name,handler){this.handlers[name]=handler;}
  async connect(){} async disconnect(){} async startAudio(){} registerTextStreamHandler(){}
}
window.LivekitClient={Room,RoomEvent:Object.fromEntries(['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'].map(x=>[x,x]))};
window.addEventListener('DOMContentLoaded',() => {
  const note=document.createElement('p'); note.textContent='UI verification · simulated Instructor replies';
  const done=document.createElement('button'); done.textContent='Finish UI verification'; done.type='button';
  done.onclick=()=>report('finish',{outsideCells:!document.getElementById('feed').contains(document.getElementById('composer')),
    inputCount:document.querySelectorAll('#message').length,
    extraQuestionBoxes:document.querySelectorAll('[placeholder="Ask about your logic, a line, or an error"]').length,
    visiblePair:document.getElementById('feed').innerText.includes('Why does Python start indexing at zero?') && document.getElementById('feed').innerText.includes('The first element is 10 because Python indexes start at zero.'),
    microphoneAbsent:!document.getElementById('audio-microphone'),
    speakerInBar:!!document.querySelector('#message-bar #sound'),
    attachmentsInBar:!!document.querySelector('#message-bar [aria-label="Add attachments"]'),
    noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth,
    liveSharing:document.getElementById('follow-code').checked});
  note.append(' ',done); document.querySelector('header').prepend(note);
  const pick=new MutationObserver(()=>{const lesson=document.querySelector('#lesson-list button:not(:disabled)');if(lesson){pick.disconnect();lesson.click();}});
  pick.observe(document.getElementById('lesson-list'),{childList:true});
});`;
  (vscode.window as any).createWebviewPanel = (...args:any[]) => {
    const view = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] !== 'dhimantai.learningRoom') return view;
    panel = view;
    view.webview.onDidReceiveMessage(message => {
      if (message?.type !== 'messageBarProbe') return;
      events.push(message); console.log('Message bar probe', JSON.stringify(message));
      if (message.event === 'finish') finish();
    });
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(view.webview),'html')!;
    Object.defineProperty(view.webview,'html',{get:()=>descriptor.get!.call(view.webview),set:html=>{
      const replacement = html.replace(/<script nonce="([^"]+)" src="[^"]*livekit-client\.umd\.js"><\/script>/,
        (_:string,nonce:string)=>`<script nonce="${nonce}">${fixture}</script>`);
      assert.notEqual(replacement,html); descriptor.set!.call(view.webview,replacement);
    }});
    return view;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await vscode.commands.executeCommand('dhimantai.openLearningRoom');
    await Promise.race([finished,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Finish UI verification in VS Code')),15*60000);})]);
    const ui = events.find(e=>e.event==='finish').value;
    assert.deepEqual(ui,{outsideCells:true,inputCount:1,extraQuestionBoxes:0,visiblePair:true,microphoneAbsent:true,speakerInBar:true,attachmentsInBar:true,noHorizontalOverflow:true,liveSharing:true});
    const messages = events.filter(e=>e.event==='message').map(e=>e.value as string);
    assert.ok(messages.some(text=>!text.startsWith('TUTOR_')),'send a plain question');
    // A question shares the selected cell through the observation sent just before it.
    const sequence = events.filter(e=>e.event==='message' || e.event==='observation');
    assert.ok(sequence.some((e,i)=>e.event==='message' && !e.value.startsWith('TUTOR_') && sequence.slice(0,i).reverse()
      .find(o=>o.event==='observation')?.value.source?.includes('items')),'include selected code with a question');
    assert.ok(messages.some(text=>text.startsWith('TUTOR_NOTEBOOK_ANSWER')),'answer the displayed Instructor question');
    assert.ok(events.some(e=>e.event==='observation' && e.value.notebook?.cells.some((c:any)=>c.kind==='code')),'public notebook context reaches the Instructor transport');
  } finally {
    clearTimeout(timer); (vscode.window as any).createWebviewPanel=create; Api.prototype.learningRoom=grant;
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({vscode:vscode.version,extension:extension.packageJSON.version,
      platform:process.platform,transport:'controlled fixture, not staging or live audio acceptance',events},null,2));
    panel?.dispose();
  }
}
