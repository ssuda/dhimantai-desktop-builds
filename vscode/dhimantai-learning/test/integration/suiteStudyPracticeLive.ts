/** Live staging acceptance: authored questions, no transcripts or audio recordings. */
import * as assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';
import {connect} from './suiteStudy';

const pause=(ms=200)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read:()=>Promise<any>,test:(value:any)=>boolean,label:string,seconds=120) {
  const deadline=Date.now()+seconds*1000;
  while(Date.now()<deadline){const value=await read();if(test(value))return value;await pause();}
  throw new Error('Timed out: '+label);
}

export async function run() {
  const output=process.env.DHIMANTAI_UX_OUT!;
  const account=JSON.parse(readFileSync(process.env.DHIMANTAI_STUDY_LEARNER!,'utf8'));
  const extension=vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!;
  const {auth}=await extension.activate();
  assert.equal(vscode.workspace.getConfiguration('dhimantai').get('environment'),'staging');
  await auth.signInWithPassword(account.email,account.password);
  const cdp=await connect();
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const snapshot=()=>ui(`d=>({text:d.querySelector('#response').textContent,html:d.querySelector('#response').innerHTML,
    busy:d.querySelector('#question').disabled,
    draft:d.querySelector('#question').value,status:d.querySelector('#help-status').textContent,
    attachments:d.querySelectorAll('#attachments .attachment').length,
    events:d.defaultView.__practiceQa.events,topics:d.defaultView.__practiceQa.topics})`);
  const report:any={passed:false,environment:'staging',version:extension.packageJSON.version,
    method:'Real VS Code and live Study agent. Authored board content and live audio state only; no transcription or recording.',turns:[]};
  const save=()=>writeFileSync(join(output,'live-study.json'),JSON.stringify(report,null,2)+'\n');
  try {
    await vscode.commands.executeCommand('dhimantai.openStudy','book-zen-assembly');
    await until(()=>ui(`d=>d.querySelector('#loading').style.display==='none'&&!d.querySelector('#summary').disabled`),Boolean,'reader',40);
    await vscode.commands.executeCommand('notifications.clearAll');
    assert.equal(await ui(`d=>!!d.querySelector('#ask .composer-box #sound')&&!d.querySelector('.study-header #sound')`),true,'Sound is inside the input box');
    await ui(`d=>{const w=d.defaultView,lk=w.LivekitClient,q=w.__practiceQa={events:[],topics:[]};
      const on=lk.Room.prototype.on,stream=lk.Room.prototype.registerTextStreamHandler;
      lk.Room.prototype.registerTextStreamHandler=function(topic,handler){q.topics.push(topic);return stream.call(this,topic,handler);};
      lk.Room.prototype.on=function(...args){if(!this.__practiceQa){this.__practiceQa=true;q.room=this;
        on.call(this,lk.RoomEvent.DataReceived,bytes=>{try{const p=JSON.parse(new TextDecoder().decode(bytes));if(['display_on_screen','write_on_whiteboard'].includes(p.method))q.events.push({type:'board',time:Date.now(),request:p.study_request_id,content:p.content});}catch{}});
        on.call(this,lk.RoomEvent.ParticipantAttributesChanged,(changed,peer)=>{if(peer.isAgent&&changed['lk.agent.state']){
          const heading=Array.from(d.querySelectorAll('#response h2,#response h3')).find(h=>/Your turn|Practice/i.test(h.textContent));
          const rect=heading?.getBoundingClientRect(),pane=d.querySelector('#study-content').getBoundingClientRect();
          q.events.push({type:'state',time:Date.now(),state:changed['lk.agent.state'],visible:d.querySelector('#response').textContent,
            questionVisible:!!rect&&rect.top>=pane.top&&rect.bottom<=pane.bottom});}});
        on.call(this,lk.RoomEvent.TrackSubscribed,track=>{if(track.kind==='audio')q.audio=track;});
      }return on.apply(this,args);};return true;}`);
    assert.equal(await ui(`d=>d.querySelector('#sound').getAttribute('aria-pressed')`),'false','speaker starts muted');
    const ask=async(label:string,question:string,practice=false,file?:{name:string;type:string;data:string})=>{
      await ui(`d=>{d.defaultView.__practiceQa.events=[];d.querySelector('#open-study').click();return true;}`);
      if(file)await ui(`d=>{const w=d.defaultView,original=w.HTMLInputElement.prototype.click;
        w.HTMLInputElement.prototype.click=function(){if(this.type!=='file')return original.call(this);
          const bytes=Uint8Array.from(atob(${JSON.stringify(file.data)}),c=>c.charCodeAt(0));
          Object.defineProperty(this,'files',{value:[new w.File([bytes],${JSON.stringify(file.name)},{type:${JSON.stringify(file.type)}})]});
          this.dispatchEvent(new w.Event('change'));};
        try{d.querySelector('#attachment-menu summary').click();d.querySelector(${JSON.stringify(file.type==='application/pdf'?'#attach-pdfs':'#attach-images')}).click();}
        finally{w.HTMLInputElement.prototype.click=original;}return true;}`);
      if(file)assert.equal((await snapshot()).attachments,1,'selected file is visible before sending');
      await ui(`d=>{
        const f=d.querySelector('#question');f.value=${JSON.stringify(question)};f.dispatchEvent(new d.defaultView.Event('input'));
        d.querySelector('#ask').dispatchEvent(new d.defaultView.Event('submit',{cancelable:true}));return true;}`);
      const response=await until(snapshot,s=>s&&!s.busy&&s.text.trim().length>20,label);
      assert.equal(response.status,'Ready for your next question.');assert.equal(response.draft,'');
      assert.equal(response.attachments,0,'attachments clear only after the written response');
      assert.deepEqual(response.topics,[],'no speech transcription stream is registered');
      if(practice){
        assert.match(response.html,/<h[23][^>]*>[^<]*(?:Your turn|Practice)/i,'actual written practice activity');
        const activity=response.text.split(/Your turn|Practice/i).at(-1);
        assert.match(activity,/\?|\b(?:predict|calculate|explain|choose|identify|compare)\b/i,'answerable activity');
      }
      // Observe the live voice lifecycle with the existing Sound control.
      // Never save audio bytes or register a transcript consumer.
      await ui(`d=>{const s=d.querySelector('#sound');if(s.getAttribute('aria-pressed')==='false')s.click();return true;}`);
      const speaking=await until(snapshot,s=>s.events.some((e:any)=>e.type==='state'&&e.state==='speaking'),label+' live voice',60);
      const first=speaking.events.find((e:any)=>e.type==='state'&&e.state==='speaking');
      assert.ok(first.visible.trim().length>20,'written response is visible when live speech starts');
      if(practice)assert.match(first.visible,/Your turn|Practice/i,'question appears before live speech');
      if(practice)assert.equal(first.questionVisible,true,'the active question is inside the visible reading area before speech');
      await until(snapshot,s=>{const a=s.events;const i=a.findIndex((e:any)=>e.state==='speaking');return i>=0&&a.slice(i+1).some((e:any)=>['listening','idle'].includes(e.state));},label+' speech finished',120);
      const media=await ui(`async d=>{const q=d.defaultView.__practiceQa;const stats=q.audio?.getReceiverStats?await q.audio.getReceiverStats():null;
        return {audioElements:d.querySelectorAll('audio').length,stats,transcriptionTopics:q.topics};}`);
      assert.ok(media.audioElements>0&&media.stats?.bytesReceived>0,'live voice frames reach the reader');
      await ui(`d=>{const s=d.querySelector('#sound');if(s.getAttribute('aria-pressed')==='true')s.click();return true;}`);
      const final=await snapshot();report.turns.push({label,question,...final,media});save();
      if(practice)await ui(`d=>{const h=Array.from(d.querySelectorAll('#response h2,#response h3')).find(h=>/Your turn|Practice/i.test(h.textContent));h?.scrollIntoView({block:'center'});return true;}`);
      await vscode.commands.executeCommand('notifications.hideToasts');
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(output,label+'.png'),Buffer.from(shot.data,'base64'));
      console.log('Live Study passed: '+label);return final;
    };
    const first=await ask('explanation-and-practice','Explain counting comparisons versus measuring running time using Python. Use finding 9 in [2, 9, 6] as the worked example. Then ask exactly one practice question: how many comparisons find 5 in [8, 3, 5, 1] using linear search? Do not reveal the practice answer; wait for me.',true);
    const practice=first.text.split(/Your turn|Practice/i).at(-1);
    assert.doesNotMatch(practice,/\b(?:3|three) comparisons\b/i,'answer stays hidden before attempt');
    const hint=await ask('hint-before-attempt','Give me one hint for that practice question without giving the answer. Keep the question visible.');
    assert.doesNotMatch(hint.text,/\b(?:3|three) comparisons\b/i,'hint does not reveal the answer');
    assert.match(hint.text,/8.*3.*5.*1/s,'original question remains available during the hint');
    const answer=await ask('attempt-feedback','My answer is 3 comparisons: compare 8, then 3, then 5 and stop at the match. Is my reasoning correct?');
    assert.match(answer.text,/correct|right|exactly/i,'feedback evaluates the actual attempt');
    assert.match(answer.text,/3|three/i);
    await ask('repeat-practice','Explain why the same comparison count can have different measured times. Then give me one fresh prediction question about it, without its answer. Put the question on screen before asking it aloud.',true);
    const photo=await ask('photo-attachment','Solve the comparison-count question in my attached image. Use its list and target, not the earlier example.',false,
      {name:'study-question.png',type:'image/png',data:readFileSync(join(__dirname,'../../../test/fixtures/study-question.png')).toString('base64')});
    assert.match(photo.text,/\b(?:2|two)\b/i,'the attached image requires two comparisons');
    assert.match(photo.text,/4.*7.*9/s,'feedback uses the attached image list');
    const pdf=await ask('pdf-attachment','Solve the comparison-count question in my attached PDF. Use its list and target, not the earlier example.',false,
      {name:'study-worksheet.pdf',type:'application/pdf',data:readFileSync(join(__dirname,'../../../test/fixtures/study-worksheet.pdf')).toString('base64')});
    assert.match(pdf.text,/\b(?:4|four) comparisons\b|comparisons[^\n]{0,25}\b4\b/i,'the attached PDF requires four comparisons');
    assert.match(pdf.text,/6.*2.*9.*5/s,'feedback uses the attached PDF list');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:480,height:820,deviceScaleFactor:1,mobile:false});
    await pause(300);
    const narrow=await ui(`d=>{const box=d.querySelector('.composer-box').getBoundingClientRect(),sound=d.querySelector('#sound').getBoundingClientRect();return {height:box.height,width:d.documentElement.clientWidth,scroll:d.documentElement.scrollWidth,soundInside:sound.left>=box.left&&sound.right<=box.right&&sound.top>=box.top&&sound.bottom<=box.bottom,text:d.querySelector('#ask').textContent};}`);
    assert.ok(narrow.scroll<=narrow.width&&narrow.soundInside&&narrow.height<=66,'compact narrow input keeps icons inside without overflow');
    assert.doesNotMatch(narrow.text,/Ask about this chapter|mastery assessment/);
    writeFileSync(join(output,'narrow-sound-input.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await ui(`d=>{d.defaultView.__practiceQa.events=[];const f=d.querySelector('#question');f.value='Explain repeated timing runs with a worked Python example.';f.dispatchEvent(new d.defaultView.Event('input'));d.querySelector('#send').click();return true;}`);
    await until(snapshot,s=>s.events.some((e:any)=>e.state==='thinking'),'live request to stop',30);
    assert.equal(await ui(`d=>d.querySelector('#send').getAttribute('aria-label')`),'Stop response');
    await ui(`d=>{d.querySelector('#send').click();return true;}`);
    await until(()=>ui(`d=>d.defaultView.__practiceQa.room.state`),s=>s==='disconnected','stop disconnects live response',15);
    const stopped=await snapshot();await pause(500);
    assert.equal((await snapshot()).text,stopped.text,'stopped response does not add late cards');
    assert.equal(stopped.status,'Response stopped.');report.stop={passed:true,status:stopped.status};report.narrow=narrow;
    report.passed=true;report.completed_at=new Date().toISOString();save();
  }catch(error){report.error=String(error);report.snapshot=await snapshot().catch(()=>null);save();throw error;}
  finally{cdp.close();await auth.signOut();}
}
