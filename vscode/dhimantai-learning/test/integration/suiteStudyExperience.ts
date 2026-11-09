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
  const out=process.env.DHIMANTAI_UX_OUT||'/tmp/dhimantai-study-experience';mkdirSync(out,{recursive:true});
  const {auth}=await vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!.activate();
  await auth.signInWithPassword(EMAIL,PASSWORD);const cdp=await connect();
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const until=async(read:()=>Promise<any>,label:string)=>{for(let i=0;i<300;i++){const value=await read();if(value)return value;await pause();}throw new Error('Timed out: '+label);};
  const click=async(id:string)=>ui(`d=>{d.querySelector('#${id}').click();return true;}`);
  const shot=async(name:string)=>writeFileSync(join(out,name+'.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  const originalGrant=Api.prototype.learningRoom;
  Api.prototype.learningRoom=async()=>({url:'wss://lk-prod.dhimant.ai',token:'local-fixture'});
  try{
    await vscode.commands.executeCommand('dhimantai.openStudy','book-zen-assembly');
    await until(()=>ui(`d=>d.querySelector('#loading').style.display==='none'&&!d.querySelector('#summary').disabled`),'reader');
    await click('course');
    await until(()=>cdp.evaluate(`!!document.querySelector('.quick-input-widget input')`),'native course picker');
    await cdp.send('Input.insertText',{text:'Thinking Forth'});await pause(200);await shot('search-courses');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await until(()=>ui(`d=>d.querySelector('#course').textContent.includes('Thinking Forth')&&d.querySelector('#loading').style.display==='none'`),'course switch');
    const before=await ui(`d=>{d.defaultView.__book=d.querySelector('#viewer iframe');return d.querySelector('#page').textContent;}`);
    // Controlled responses exercise the actual webview, transport handlers and renderer.
    // No production AI or teaching-quality claim is made from these fixtures.
    await ui(`d=>{const w=d.defaultView,peer={identity:'fixture',isAgent:true,trackPublications:new Map()};
      class Room {listeners=new Map();remoteParticipants=new Map([['fixture',peer]]);closed=false;
        on(name,fn){this.listeners.set(name,fn);}async connect(){}async disconnect(){this.closed=true;}registerTextStreamHandler(){}
        localParticipant={registerRpcMethod(){},performRpc:async r=>{if(r.method==='switch_mode')return 'ok';const p=JSON.parse(r.payload);w.__request=p.request_id;w.__room=this;return 'ok';}};
      }
      w.LivekitClient={...w.LivekitClient,Room};w.__publish=packet=>w.__room.listeners.get(w.LivekitClient.RoomEvent.DataReceived)(new TextEncoder().encode(JSON.stringify({...packet,study_request_id:w.__request})),peer);return true;}`);
    const grant=()=>until(()=>ui(`d=>!!d.defaultView.__room&&!d.defaultView.__room.closed`),'fixture room');
    await click('quiz');await grant();
    await ui(`d=>{d.defaultView.__publish({method:'on_viva_questions',questions:[1,2,3].map(i=>({question_text:'Practice fixture '+i+': How many comparisons are needed for four values?',options:['One comparison','Three comparisons','Four comparisons','Eight comparisons'],correct_option:'B',explanation:'Compare adjacent values in three steps: 8 and 3, 3 and 5, then 5 and 1.'}))});return true;}`);
    await shot('quiz-unanswered');
    await ui(`d=>{d.querySelector('.quiz-option').click();return true;}`);await shot('quiz-feedback-dark');
    assert.equal(await ui(`d=>!!d.querySelector('.quiz-option.incorrect.selected')&&!!d.querySelector('.quiz-option.correct')`),true);
    await click('close-study');assert.equal(await ui(`d=>d.querySelector('#viewer iframe')===d.defaultView.__book`),true);assert.equal(await ui(`d=>d.querySelector('#page').textContent`),before);
    await click('quiz');
    await ui(`d=>{d.querySelector('.quiz-navigation button:last-child').click();d.querySelector('.quiz-option:nth-of-type(2)').click();d.querySelector('.quiz-navigation button:last-child').click();d.querySelector('.quiz-option:nth-of-type(2)').click();d.querySelector('.quiz-navigation button:last-child').click();return true;}`);
    assert.deepEqual(await ui(`d=>Array.from(d.querySelectorAll('.quiz-metrics dd'),e=>e.textContent).slice(0,2)`),['2 / 3','67%']);
    assert.equal(await ui(`d=>d.querySelectorAll('#questions fieldset').length`),0);await shot('quiz-results-dark');
    await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Light Modern',vscode.ConfigurationTarget.Global);await pause(300);await shot('quiz-results-light');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:480,height:900,deviceScaleFactor:1,mobile:false});await pause(300);
    const layout=await ui(`d=>({width:d.documentElement.clientWidth,scroll:d.documentElement.scrollWidth,composer:d.querySelector('#ask').getBoundingClientRect().toJSON(),height:d.documentElement.clientHeight,content:d.querySelector('#study-content').getBoundingClientRect().toJSON()})`);
    assert.ok(layout.scroll<=layout.width&&layout.composer.bottom<=layout.height+1&&layout.content.height>100,JSON.stringify(layout));await shot('quiz-narrow');
    assert.equal(await ui(`d=>{const r=d.querySelector('.quiz-result').getBoundingClientRect();return r.left>=0&&r.right<=d.documentElement.clientWidth;}`),true,'results fit a narrow editor');
    const narrowPage=await ui(`d=>{d.defaultView.__book=d.querySelector('#viewer iframe');return d.querySelector('#page').textContent;}`);
    await ui(`d=>{d.querySelector('.quiz-result button').click();return true;}`);
    assert.equal(await ui(`d=>d.querySelectorAll('.quiz-feedback').length`),3);
    await ui(`d=>{d.querySelector('.quiz-review-actions button').click();d.querySelector('.quiz-result button:last-child').click();return true;}`);
    assert.equal(await ui(`d=>d.querySelector('#study-dialog').open`),false,'Finish quiz returns to Study');
    assert.equal(await ui(`d=>d.querySelector('#viewer iframe')===d.defaultView.__book`),true);
    assert.equal(await ui(`d=>d.querySelector('#page').textContent`),narrowPage);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await click('close-study');
    await click('summary');await grant();
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="720" height="230"><text x="30" y="40" font-size="28" fill="#171717">Counting comparisons by hand</text><text x="30" y="100" font-size="22">Inputs</text><rect x="140" y="65" width="70" height="60" fill="#bfdbfe"/><text x="165" y="104" font-size="24">8</text><rect x="240" y="65" width="70" height="60" fill="#bfdbfe"/><text x="265" y="104" font-size="24">3</text><rect x="340" y="65" width="70" height="60" fill="#bfdbfe"/><text x="365" y="104" font-size="24">5</text><rect x="440" y="65" width="70" height="60" fill="#bfdbfe"/><text x="465" y="104" font-size="24">1</text><text x="30" y="190" font-size="22">Comparisons</text><circle cx="225" cy="185" r="25" fill="#fed7aa"/><text x="219" y="193" font-size="22">1</text><circle cx="325" cy="185" r="25" fill="#fed7aa"/><text x="319" y="193" font-size="22">2</text><circle cx="425" cy="185" r="25" fill="#fed7aa"/><text x="419" y="193" font-size="22">3</text></svg>';
    await ui(`d=>{d.defaultView.__publish({method:'display_on_screen',content:${JSON.stringify('## Counting comparisons\n\nControlled visual fixture. For $n$ values, count $n-1$ adjacent comparisons.\n\n'+svg+'\n\n## Try the steps\n\n1. Compare the first pair.\n2. Move to the next pair.\n\n```python\nfor i in range(len(values) - 1):\n    print(values[i], values[i + 1])\n```\n\n'+Array.from({length:15},(_,i)=>`${i+1}. Explain a comparison in your own words.`).join('\n'))}});return true;}`);
    await shot('summary-light');await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Dark Modern',vscode.ConfigurationTarget.Global);await pause(300);await shot('summary-dark');
    assert.equal(await ui(`d=>d.querySelectorAll('.summary-section').length`),2);
    const diagram=await ui(`async d=>{const img=d.querySelector('.board-diagram');await img.decode();return {background:d.defaultView.getComputedStyle(img).backgroundColor,width:img.clientWidth,height:img.clientHeight,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight};}`);
    assert.equal(diagram.background,'rgb(255, 255, 255)');assert.equal(diagram.naturalWidth/diagram.naturalHeight,720/230);
    await ui(`d=>{d.querySelector('#study-content').scrollTop=250;return true;}`);await click('close-study');await click('open-study');await click('close-study');await click('summary');
    assert.equal(await ui(`d=>d.querySelector('#study-content').scrollTop`),250,'returning to summary preserves its scroll');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,checks:['native course search and chapter replacement','real webview quiz states','light/dark rendering','narrow composer visibility','reader identity and position retained','collapsible math/code summary','SVG light canvas and aspect ratio'],layout,diagram,output:out},null,2));
  }catch(error){await shot('failure');writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error),state:await ui(`d=>({help:d.querySelector('#help-status').textContent,loading:d.querySelector('#loading-text').textContent,loadingStyle:d.querySelector('#loading').style.display,title:d.querySelector('#title').textContent,summaryDisabled:d.querySelector('#summary').disabled,frames:d.querySelectorAll('#viewer iframe').length})`)},null,2));throw error;}finally{Api.prototype.learningRoom=originalGrant;cdp.close();}
}
