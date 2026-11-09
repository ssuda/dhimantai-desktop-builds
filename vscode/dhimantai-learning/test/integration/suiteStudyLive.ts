import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Auth } from '../../src/auth';
import type { CompanionCourse } from '../../src/studyContent';
import { ENVIRONMENTS } from '../../src/environments';
import { connect } from './suiteStudy';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read:()=>Promise<any>,test:(value:any)=>boolean,label:string,seconds=20) {
  const deadline=Date.now()+seconds*1000;
  while(Date.now()<deadline){const value=await read();if(test(value))return value;await pause(200);}
  throw new Error('Timed out: '+label);
}
const normalize=(value:string)=>value.normalize('NFKC').replace(/^[A-D][).]\s*/,'').replace(/−/g,'-').replace(/\s+/g,' ').trim().toLowerCase();

export async function run() {
  const output=process.env.DHIMANTAI_UX_OUT!;
  const account=JSON.parse(readFileSync(process.env.DHIMANTAI_STUDY_LEARNER!,'utf8'));
  const extension=vscode.extensions.getExtension<{auth:Auth}>('optficial.dhimantai-learning')!;
  const {auth}=await extension.activate();
  const env=ENVIRONMENTS.staging;
  assert.equal(vscode.workspace.getConfiguration('dhimantai').get('environment'),'staging');
  await auth.signInWithPassword(account.email,account.password);
  const cdp=await connect();
  const ui=(expression:string)=>cdp.webview(`d=>{if(!d.querySelector('#reading'))return null;return (${expression})(d);}`);
  const snapshot=()=>ui(`d=>({title:d.querySelector('#title').textContent,text:d.querySelector('#viewer iframe')?.contentDocument?.body?.textContent,
    help:d.querySelector('#response').textContent,status:d.querySelector('#help-status').textContent,
    busy:d.querySelector('#summary').disabled,ready:d.querySelector('#loading').style.display==='none',links:d.querySelectorAll('#reading-links button').length,
    quiz:d.querySelector('#questions progress')?.max||0,loading:d.querySelector('#loading-text').textContent,course:d.querySelector('#course').textContent,chapter:d.querySelector('#chapter').value,
    reader:d.querySelector('#viewer iframe')?{state:d.querySelector('#viewer iframe').contentDocument?.readyState,visibility:d.querySelector('#viewer iframe').style.visibility,
      sheets:Array.from(d.querySelector('#viewer iframe').contentDocument?.querySelectorAll('link[rel="stylesheet"]')||[]).map(l=>({href:l.href,loaded:!!l.sheet})),
      resources:d.querySelector('#viewer iframe').contentWindow.performance.getEntriesByType('resource').map(e=>({name:e.name,duration:e.duration}))}:null})`);
  const courses=JSON.parse(readFileSync(join(extension.extensionPath,'media/study/book_companions.json'),'utf8')).courses as CompanionCourse[];
  const report:any={environment:'staging',extension_version:extension.packageJSON.version,verified_at:new Date().toISOString(),
    passed:false,source_checks:0,courses:[],method:'Downloaded VSIX in real VS Code; shared StudyModeAgent via LiveKit/WebRTC RPC and data in the real reader; no mocked replies.'};
  const save=()=>writeFileSync(join(output,'live-study.json'),JSON.stringify(report,null,2)+'\n');
  try {
    assert.equal(courses.length,7);
    const headers={Authorization:'Bearer '+await auth.accessToken(),'Content-Type':'application/json'};
    const request=async(id:string,body?:object,authenticated=true)=>fetch(env.apiUrl+'/notebook-coach/study/'+encodeURIComponent(id),
      {method:body?'POST':'GET',headers:authenticated?headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(55000)});
    for(const course of courses) for(const chapter of course.chapters){
      const response=await request(chapter.id);assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'no-store');
      const source:any=await response.json();assert.equal(source.markdown,chapter.markdown);assert.equal(source.revision,chapter.revision);report.source_checks++;
    }
    const first=courses[0].chapters[0];
    assert.equal((await request(first.id,{action:'summary',revision:first.revision},false)).status,401);
    assert.equal((await request(first.id,{action:'summary',revision:first.revision})).status,410);
    report.access_checks=['unauthenticated help rejected','retired independent HTTP teaching path rejected'];save();
    const selected=process.env.DHIMANTAI_STUDY_COURSES?.split(',').filter(Boolean);
    if(selected)assert.ok(selected.every(id=>courses.some(c=>c.id===id)));
    for(const course of courses.filter(c=>!selected||selected.includes(c.id))){
      const chapter=course.chapters[0],result:any={id:course.id,title:course.title,chapter:chapter.id,actions:[]};report.courses.push(result);
      await vscode.commands.executeCommand('dhimantai.openStudy',course.id);
      await until(snapshot,s=>s?.title===chapter.title && s.text?.includes(chapter.title) && s.ready && !s.busy,'open '+course.id,40);
      assert.equal((await snapshot()).links,course.reading.length);
      assert.deepEqual((await snapshot()).reader.sheets,[],'chapter styles do not require VS Code resource requests');
      await pause(400); // Let EPUB's initial relocation finish before a real selection.
      // Observe real SDK calls and packets without replacing any replies or connection.
      await ui(`d=>{const w=d.defaultView,lk=w.LivekitClient;
        if(w.__studyQa)return true;const q=w.__studyQa={calls:[],packets:[],room:null};
        const on=lk.Room.prototype.on;
        lk.Room.prototype.on=function(...args){if(this.localParticipant&&q.room!==this){q.room=this;
          const rpc=this.localParticipant.performRpc.bind(this.localParticipant);
          this.localParticipant.performRpc=async arg=>{const call={method:arg.method,payload:JSON.parse(arg.payload)};q.calls.push(call);try{call.reply=await rpc(arg);return call.reply;}catch(e){call.error=e.message;throw e;}};
          on.call(this,lk.RoomEvent.DataReceived,bytes=>{try{q.packets.push(JSON.parse(new TextDecoder().decode(bytes)));}catch{}});}
          return on.apply(this,args);};return true;}`);
      const reviewQuestions:Record<string,string>={
        'book-sicp':'Can the unchanged fold function in this chapter accumulate a list of partial sums by changing only the initial value and combiner? Explain whether changing the accumulator type changes the traversal.',
        'book-paip':"Is the Python expression {'?x': 'Ada', '?x': 'Lin'} syntactically invalid, or does it produce a dictionary? Explain why that behavior is different from this chapter’s repeated-variable agreement check."
      };
      const review=process.env.DHIMANTAI_STUDY_QUIZ_REVIEW==='1';
      const actions=review?['quiz',...(reviewQuestions[course.id]?['ask']:[])]:process.env.DHIMANTAI_STUDY_ACTIONS?.split(',').filter(Boolean)||['explain','summary','ask','quiz'];
      assert.ok(actions.length&&actions.every(a=>['explain','crop','summary','ask','quiz'].includes(a)));
      for(const action of actions){
        const started=Date.now();
        await ui(`d=>{if(d.querySelector('#study-dialog').open)d.querySelector('#close-study').click();return true;}`);
        await ui(`d=>{d.defaultView.__studyQa.packets=[];d.defaultView.__studyQa.calls=[];return true;}`);
        if(action==='crop'){
          await ui(`d=>{d.querySelector('#crop').click();const o=d.querySelector('#crop-overlay');o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'ArrowRight'}));for(let i=0;i<25;i++)o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'ArrowLeft'}));for(let i=0;i<50;i++)o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true}));o.dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'Enter'}));return true;}`);
          await until(()=>ui(`d=>!d.querySelector('#crop-toolbar').hidden`),v=>v===true,'real crop preview');
          const crop=await ui(`d=>d.querySelector('#crop-preview').src`);
          writeFileSync(join(output,course.id+'-crop.png'),Buffer.from(crop.split(',')[1],'base64'));
          await ui(`d=>{d.querySelector('#explain-crop').click();return true;}`);
        }else if(action==='explain'){
          await ui(`d=>{const f=d.querySelector('#viewer iframe').contentDocument;const p=Array.from(f.querySelectorAll('h2')).find(h=>h.textContent==='The idea').nextElementSibling;
            const r=f.createRange();r.selectNodeContents(p);const s=f.defaultView.getSelection();s.removeAllRanges();s.addRange(r);f.dispatchEvent(new f.defaultView.Event('selectionchange'));return true;}`);
          await until(()=>ui(`d=>!d.querySelector('#explain').disabled`),v=>v===true,'select source');
          await ui(`d=>{d.querySelector('#explain').click();return true;}`);
        }else if(action==='ask'){
          const question=review?reviewQuestions[course.id]:'How could I check my understanding of the main idea using this chapter’s worked example? Give one prediction to make before running it.';
          await ui(`d=>{d.querySelector('#open-study').click();d.querySelector('#question').value=${JSON.stringify(question)};d.querySelector('#ask').dispatchEvent(new Event('submit',{cancelable:true}));return true;}`);
        }else await ui(`d=>{d.querySelector('#${action}').click();return true;}`);
        const rendered=await until(snapshot,s=>s && !s.busy,course.id+' '+action,125);
        assert.ok(rendered.help?.trim().length>=20,course.id+' '+action+': '+rendered.status);
        assert.equal(rendered.quiz,action==='quiz'?3:0);
        const observed=await ui(`d=>({calls:d.defaultView.__studyQa.calls,packets:d.defaultView.__studyQa.packets})`);
        report.last_observation={action,rendered,observed};save();
        assert.equal(rendered.status,'Ready for your next question.');
        const method={explain:'explain_selection',crop:'explain_selection',summary:'study_quick_summary',ask:'study_question',quiz:'study_quiz_me'}[action as 'explain'];
        const call=observed.calls.find((c:any)=>c.method===method);assert.ok(call,method+' reached LiveKit');
        assert.equal(call.reply,'ok');assert.equal(call.payload.source_id,chapter.id);assert.equal(call.payload.revision,chapter.revision);
        if(action==='crop'){
          const chunks=observed.calls.filter((c:any)=>c.method==='study_selection_image');assert.ok(chunks.length>0);
          const expected=await ui(`d=>d.querySelector('#crop-reference-image').src`);
          assert.equal(chunks.map((c:any)=>c.payload.data).join(''),expected,'AI receives the exact displayed crop');
          assert.equal(call.payload.is_cropped_snippet,true);assert.equal(call.payload.selection_image_request_id,call.payload.request_id);
          assert.equal(call.payload.selected_text,undefined,'crop does not substitute extracted chapter text');
          for(const [i,chunk] of chunks.entries()){
            const ack=JSON.parse(chunk.reply);assert.equal(ack.status,'ok');assert.equal(ack.index,i);
            assert.equal(ack.complete,i===chunks.length-1);assert.equal(ack.selection_request_id,call.payload.request_id);
            // Keep transport evidence without duplicating image bytes in the report.
            chunk.payload.data_bytes=chunk.payload.data.length;delete chunk.payload.data;
          }
          assert.ok(observed.packets.some((p:any)=>p.method==='display_on_screen'&&p.study_request_id===call.payload.request_id));
        }
        if(action==='quiz'){
          const batch=observed.packets.find((p:any)=>p.method==='on_viva_questions'&&p.study_request_id===call.payload.request_id);
          assert.ok(batch,'quiz delivered by shared Study agent');assert.equal(batch.questions.length,3);
          for(const q of batch.questions){assert.equal(q.options.length,4);assert.equal(new Set(q.options.map(normalize)).size,4);
            assert.match(q.correct_option,/^[A-D]$/);assert.ok(q.explanation?.trim());}
        }
        if(action==='quiz'){
          assert.equal(await ui(`d=>d.querySelectorAll('#questions .quiz-feedback').length`),0,'no feedback before attempt');
          await ui(`d=>{for(let i=0;i<3;i++){d.querySelector('#questions .quiz-option').click();d.querySelector('.quiz-navigation button:last-child').click();}d.querySelector('.quiz-result button').click();return true;}`);
          assert.equal(await ui(`d=>d.querySelectorAll('#questions .quiz-feedback').length`),3);
        }
        if(course===courses[0]&&action==='explain'){
          const rejected=await ui(`async d=>{const q=d.defaultView.__studyQa,room=q.room;
            const peer=Array.from(room.remoteParticipants.values()).find(p=>p.isAgent);
            const source=${JSON.stringify({source_id:chapter.id,revision:chapter.revision})};
            const results=[];
            for(const change of [{revision:'stale'},{selected_text:'Fabricated passage absent from this chapter.'},{page_text:'Client supplied replacement'}]){
              const payload={...source,request_id:crypto.randomUUID(),selection_request_id:crypto.randomUUID(),selected_text:'Count Work Before Measuring Time',...change};
              results.push(JSON.parse(await room.localParticipant.performRpc({destinationIdentity:peer.identity,method:'explain_selection',payload:JSON.stringify(payload),responseTimeout:5000})));}
            return results;}`);
          assert.equal(rejected.length,3);for(const rejection of rejected)assert.equal(rejection.status,'error');
          report.access_checks.push('LiveKit rejects stale revision, fabricated selection and client-supplied chapter');
        }
        result.actions.push({action,seconds:(Date.now()-started)/1000,text:rendered.help,calls:observed.calls,packets:observed.packets});save();
        console.log('Live Study passed: '+course.id+' / '+action);
      }
      await ui(`d=>{d.querySelector('#questions').scrollIntoView({block:'start'});return true;}`);
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(output,course.id+'.png'),Buffer.from(shot.data,'base64'));
      result.passed=true;save();
    }
    delete report.last_observation;report.passed=true;save();
  }catch(error){report.error=error instanceof Error?error.message:'Live acceptance failed';report.failure_snapshot=await snapshot().catch(()=>null);save();throw error;}
  finally{cdp.close();await auth.signOut();}
}
