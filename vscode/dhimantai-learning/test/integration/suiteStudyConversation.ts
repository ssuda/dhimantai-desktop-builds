/** Real EPUB/webview regression checks with controlled board and speech events. */
import * as assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';
import {Api} from '../../src/api';
import {EMAIL,PASSWORD} from './contractServer';
import {connect} from './suiteStudy';

const pause=(ms=100)=>new Promise(r=>setTimeout(r,ms));
export async function run(){
  const out=process.env.DHIMANTAI_UX_OUT||'/tmp/dhimantai-study-conversation';mkdirSync(out,{recursive:true});
  const {auth}=await vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!.activate();
  await auth.signInWithPassword(EMAIL,PASSWORD);
  const cdp=await connect(),originalGrant=Api.prototype.learningRoom;
  Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'local-fixture'});
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const until=async(expression:string,label:string)=>{for(let i=0;i<200;i++){const v=await ui(expression);if(v)return v;await pause();}throw new Error('Timed out: '+label);};
  const shot=async(name:string)=>writeFileSync(join(out,name+'.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  const publish=async(content:string,extra:object={})=>ui(`d=>{d.defaultView.__publish(${JSON.stringify({method:'display_on_screen',content,...extra})});return true;}`);
  const ask=async(text:string)=>{
    const previous=await ui(`d=>d.defaultView.__request`);
    await ui(`d=>{const f=d.querySelector('#question');f.value=${JSON.stringify(text)};f.dispatchEvent(new d.defaultView.Event('input'));d.querySelector('#send').click();return true;}`);
    await until(`d=>d.defaultView.__request!==${JSON.stringify(previous)}`,'new learner request');
  };
  try{
    await vscode.commands.executeCommand('dhimantai.openStudy','book-zen-assembly');
    await until(`d=>d.querySelector('#loading').style.display==='none'&&!d.querySelector('#crop').disabled`,'reader');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('notifications.clearAll');
    // Only transport/model output is controlled. The crop, upload, rendering,
    // scrolling and computed geometry run in the real extension webview.
    await ui(`d=>{const w=d.defaultView,peer={identity:'fixture',isAgent:true,trackPublications:new Map()};
      class Room {listeners=new Map();remoteParticipants=new Map([['fixture',peer]]);
        on(name,fn){this.listeners.set(name,fn);}async connect(){}async disconnect(){}registerTextStreamHandler(){}
        localParticipant={registerRpcMethod(){},performRpc:async r=>{if(r.method==='switch_mode')return 'ok';const p=JSON.parse(r.payload);
          if(r.method==='study_selection_image')return JSON.stringify({status:'ok',selection_request_id:p.selection_request_id,index:p.index,complete:p.index===p.total-1});
          w.__request=p.request_id;w.__room=this;return 'ok';}};
      }
      w.LivekitClient={...w.LivekitClient,Room};w.__publish=p=>w.__room.listeners.get(w.LivekitClient.RoomEvent.DataReceived)(new TextEncoder().encode(JSON.stringify({...p,study_request_id:w.__request})),peer);
      w.__state=state=>w.__room.listeners.get(w.LivekitClient.RoomEvent.ParticipantAttributesChanged)({'lk.agent.state':state},peer);
      d.querySelector('#crop').click();const overlay=d.querySelector('#crop-overlay');
      overlay.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight'}));overlay.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));return true;}`);
    await until(`d=>!d.querySelector('#crop-toolbar').hidden`,'crop preview');
    await ui(`d=>{d.querySelector('#explain-crop').click();return true;}`);
    await until(`d=>!!d.defaultView.__request`,'crop upload');
    await publish('### Step-by-step: Counting comparisons\n\n1. Inspect each value in order.\n2. Stop when the target is found.');
    await ask('Give me one Python practice question.');
    const question='## Your turn\n\nHow many comparisons does this search make?\n\n```python\nvalues = [8, 3, 5, 1]\ntarget = 5\nfor value in values:\n    if value == target:\n        break\n```\n\nExplain where it stops.';
    await publish(question);await publish(question);
    await ui(`d=>{d.defaultView.__state('speaking');return true;}`);
    const visible=await ui(`d=>{const q=d.querySelector('.study-your-turn'),p=d.querySelector('#study-content').getBoundingClientRect(),r=q.getBoundingClientRect();return {count:d.querySelectorAll('.study-your-turn').length,text:q.textContent,visible:r.top>=p.top&&r.bottom<=p.bottom,source:!d.querySelector('#crop-reference').hidden};}`);
    assert.equal(visible.count,1);assert.equal(visible.visible,true,'complete question is visible when speech begins');assert.equal(visible.source,true);
    assert.match(visible.text,/Your turn[\s\S]*values = \[8, 3, 5, 1\][\s\S]*Explain where it stops/);
    await shot('your-turn-dark');
    await ui(`d=>{d.defaultView.__state('listening');return true;}`);
    await ask('Three comparisons: 8, then 3, then 5.');
    await publish('### Feedback\n\nCorrect. The match is found on the third comparison, so the loop stops at `5`.');
    const measure=()=>ui(`d=>{const w=d.defaultView,blocks=Array.from(d.querySelectorAll('.study-exchange')),last=blocks.at(-1),previous=blocks.at(-2),question=last.querySelector('.study-question'),answer=last.querySelector('.study-answer-card');
      return {count:blocks.length,between:last.getBoundingClientRect().top-previous.getBoundingClientRect().bottom,
        within:answer.getBoundingClientRect().top-question.getBoundingClientRect().bottom,
        firstMargin:w.getComputedStyle(answer.firstElementChild).marginTop,lastMargin:w.getComputedStyle(answer.lastElementChild).marginBottom,
        retained:previous.textContent.includes('Your turn')&&previous.textContent.includes('target = 5'),width:d.documentElement.clientWidth,scroll:d.documentElement.scrollWidth};}`);
    const desktop=await measure();assert.equal(desktop.count,3);assert.equal(desktop.retained,true);assert.equal(desktop.within,16);assert.ok(desktop.between>=32);assert.equal(desktop.firstMargin,'0px');assert.equal(desktop.lastMargin,'0px');
    await ui(`d=>{d.querySelector('.study-your-turn').scrollIntoView({block:'start'});return true;}`);
    await shot('exchanges-dark');
    await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Light Modern',vscode.ConfigurationTarget.Global);await pause(300);await shot('exchanges-light');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:false});await pause(300);
    const narrow=await measure();assert.ok(narrow.scroll<=narrow.width);assert.equal(narrow.within,16);assert.ok(narrow.between>=32);
    await ui(`d=>{d.querySelector('.study-your-turn').scrollIntoView({block:'start'});return true;}`);await shot('exchanges-narrow');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,method:'Real VS Code crop and webview; controlled model output and speech state, no live audio acceptance.',desktop,narrow,visible,output:out},null,2));
  }catch(error){await shot('failure');writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error)},null,2));throw error;}
  finally{Api.prototype.learningRoom=originalGrant;cdp.close();}
}
