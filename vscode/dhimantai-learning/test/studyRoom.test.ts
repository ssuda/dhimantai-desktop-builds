import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {JSDOM} from 'jsdom';
import {studyHtml} from '../src/studyHtml';
const tick=()=>new Promise(r=>setTimeout(r,0));
function surface() {
  const dom=new JSDOM(studyHtml(path=>path,'https://webview.example','test'),{url:'https://webview.example',runScripts:'outside-only'});
  const w=dom.window,sent:any[]=[],rpcs:any[]=[],rooms:Room[]=[];
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  const dialog=w.document.querySelector('dialog')!;
  dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
  let nextReply='ok',deferNext=false,finishOld:((value:string)=>void)|undefined,readerDestroys=0;
  const peer={identity:'worker',isAgent:true,trackPublications:new Map()};
  class Room{
    listeners=new Map<string,Function>();remoteParticipants=new Map([['worker',peer]]);closed=false;
    localParticipant={registerRpcMethod(){},performRpc:async(r:any)=>{rpcs.push(r);if(deferNext){deferNext=false;return new Promise<string>(resolve=>{finishOld=resolve;});}const reply=nextReply;nextReply='ok';return reply;}};
    constructor(){rooms.push(this);}on(name:string,fn:Function){this.listeners.set(name,fn);}
    async connect(){}async disconnect(){this.closed=true;}registerTextStreamHandler(){}
  }
  const names=['DataReceived','ParticipantAttributesChanged','TrackPublished','TrackSubscribed','TrackUnsubscribed','Disconnected','ParticipantDisconnected'];
  w.LivekitClient={Room,RoomEvent:Object.fromEntries(names.map(n=>[n,n]))};w.TextDecoder=TextDecoder;
  w.acquireVsCodeApi=()=>({postMessage:(m:any)=>sent.push(m)});
  w.epubControls={destroy(){readerDestroys++;},nextPage(){},prevPage(){},setFontSize(){},goToCfi(){},clearSelection(){}};
  w.initReader=()=>{};w.JSZip=class{file(){}generateAsync(){return Promise.resolve(new ArrayBuffer(0));}};
  const post=(data:any)=>w.dispatchEvent(new w.MessageEvent('message',{data}));
  const el=(id:string)=>w.document.getElementById(id)!;
  const button=(id:string)=>el(id) as HTMLButtonElement;
  const chapter=(key='first')=>post({type:'chapter',documentKey:key,source:{id:'book:test',revision:'rev',course:'Test course',title:'Example',markdown:'# Example',reading:[]},signedIn:true,aiEnabled:true,stylesheet:'unused'});
  const publish=(packet:any,room=rooms.at(-1)!)=>room.listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify(packet)),peer);
  const request=()=>JSON.parse(rpcs.at(-1).payload).request_id;
  const grant=async(key='first')=>{post({type:'studyGrant',documentKey:key,requestId:sent.filter(m=>m.type==='studyConnect').at(-1).requestId,grant:{url:'unused',token:'unused'}});await tick();await tick();};
  const input=(text:string)=>{const field=el('question') as HTMLTextAreaElement;field.value=text;field.dispatchEvent(new w.Event('input'));return field;};
  w.eval(readFileSync(resolve(__dirname,'../../media/study/study.js'),'utf8'));chapter();
  return {w,dom,sent,rpcs,rooms,dialog,post,el,button,chapter,publish,request,grant,input,readerDestroys:()=>readerDestroys,
    defer:()=>{deferNext=true;},finish:(reply:string)=>finishOld!(reply),fail:()=>{nextReply='{"message":"Try again"}';}};
}

test('Study isolates drafts, clears accepted messages, retains failures and cancels old requests',async()=>{
  const s=surface(),{w,el,button,publish,request}=s;
  try{
    await tick();assert.equal(s.rooms.length,0);assert.equal(s.dialog.open,false);
    button('open-study').click();const field=s.input('unfinished question');button('close-study').click();const destroys=s.readerDestroys();
    button('summary').click();assert.equal(field.value,'');assert.equal(field.disabled,true);
    await s.grant();assert.equal(s.rpcs.at(-1).method,'study_quick_summary');
    publish({method:'display_on_screen',content:'Stale board',study_request_id:'old'});assert.equal(el('response').textContent,'');
    publish({method:'display_on_screen',content:'## First section\n\nUse $x^2$ and \\(\\frac{1}{2}\\).\n\n## Second section\n\n```python\nprint(1)\n```',study_request_id:request()});
    assert.equal(el('response').querySelectorAll('details.summary-section').length,2);assert.equal(el('response').querySelectorAll('.katex').length,2);assert.equal(el('response').querySelector('code')!.textContent,'print(1)\n');
    s.input('summary follow-up draft');el('study-content').scrollTop=123;
    button('close-study').click();button('open-study').click();assert.equal(field.value,'unfinished question');assert.equal(el('response').textContent,'');
    button('clear-question').click();assert.equal(field.value,'');assert.equal(button('send').disabled,true);
    s.input('What is an operator?');const sent=s.sent.length;
    field.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true}));field.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter'}));assert.equal(s.sent.length,sent);
    field.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',metaKey:true}));await s.grant();
    assert.equal(field.value,'What is an operator?');assert.equal(field.disabled,true);assert.equal(el('submitted-question').textContent,'What is an operator?');
    publish({method:'display_on_screen',content:'',study_request_id:request()});assert.equal(field.value,'What is an operator?');
    publish({method:'display_on_screen',content:'An operator works on values.',study_request_id:request()});assert.equal(field.value,'');assert.equal(field.disabled,false);assert.equal(button('send').disabled,true);
    s.input('Keep me if this fails');s.fail();button('send').click();await tick();assert.equal(field.value,'Keep me if this fails');assert.match(el('help-status').textContent!,/Try again/);
    button('close-study').click();button('summary').click();assert.equal(field.value,'summary follow-up draft');assert.equal(el('study-content').scrollTop,123);assert.equal(s.readerDestroys(),destroys);
    button('send').click();await s.grant();publish({method:'display_on_screen',content:'Follow-up',study_request_id:request()});
    s.input('Cancel this');s.defer();button('send').click();await tick();const cancelled=request(),oldRoom=s.rooms.at(-1)!;
    button('close-study').click();assert.equal(oldRoom.closed,true);button('summary').click();await s.grant();
    // A reopened cancelled summary has an empty response and starts again automatically.
    const successor=s.rooms.at(-1)!;s.post({type:'helpError',documentKey:'first',requestId:'retired-grant',message:'Old grant failure'});assert.doesNotMatch(el('help-status').textContent!,/Old grant failure/);s.finish('{"message":"Old failed request"}');await tick();assert.equal(successor.closed,false);
    publish({method:'display_on_screen',content:'Late cancelled response',study_request_id:cancelled},oldRoom);assert.equal(el('response').textContent,'');
    s.chapter('second');await tick();assert.equal(successor.closed,true);assert.equal(s.dialog.open,false);assert.equal(field.value,'');
    publish({method:'display_on_screen',content:'Previous chapter',study_request_id:request()},successor);assert.equal(el('response').textContent,'');
  }finally{s.dom.window.close();}
});

test('Study quiz provides answer states, navigation, score, review and local retry',async()=>{
  const s=surface(),{el,button,publish}=s;
  const click=(selector:string)=>(el('questions').querySelector(selector) as HTMLButtonElement).click();
  let now=1000;s.w.performance.now=()=>now;
  try{
    button('quiz').click();await s.grant();const request=s.request();
    publish({method:'display_on_screen',content:'Preparing questions',study_request_id:request});assert.equal(button('summary').disabled,true);
    publish({method:'on_viva_questions',study_request_id:request,questions:[1,2,3].map(i=>({question_text:'Question '+i,options:['$1$','$2$','$3$','$4$'],correct_option:'B',explanation:'Because of the source.'}))});
    assert.equal(el('questions').querySelectorAll('fieldset').length,1);assert.equal(el('questions').querySelectorAll('button .katex').length,4);assert.equal(el('questions').querySelector('.quiz-feedback'),null);
    click('.quiz-option');assert.ok(el('questions').querySelector('.incorrect.selected'));assert.ok(el('questions').querySelector('.correct:not(.selected)'));assert.match(el('questions').textContent!,/correct answer is B/);
    publish({method:'on_viva_questions',study_request_id:request,questions:[1,2,3].map(i=>({question_text:'Duplicate '+i,options:['1','2','3','4'],correct_option:'B',explanation:'Duplicate'}))});assert.ok(el('questions').querySelector('.incorrect.selected'),'duplicate packets preserve answers');
    click('.quiz-navigation button:last-child');assert.match(el('questions').textContent!,/Question 2 of 3/);assert.equal(el('questions').querySelector('.quiz-feedback'),null);
    click('.quiz-option:nth-of-type(2)');click('.quiz-navigation button:first-child');assert.ok(el('questions').querySelector('.incorrect.selected'));
    button('close-study').click();button('open-study').click();assert.equal(el('questions').children.length,0);
    button('close-study').click();button('quiz').click();assert.ok(el('questions').querySelector('.incorrect.selected'));
    click('.quiz-navigation button:last-child');click('.quiz-navigation button:last-child');
    assert.equal((el('questions').querySelector('.quiz-navigation button:last-child') as HTMLButtonElement).disabled,true);
    click('.quiz-option:nth-of-type(2)');assert.equal(el('questions').querySelector('.quiz-result'),null,'last answer keeps its explanation until Finish quiz');
    assert.match(el('questions').querySelector('.quiz-feedback')!.textContent!,/Because of the source/);
    now=126000;click('.quiz-navigation button:last-child');
    assert.equal(el('questions').querySelector('fieldset'),null,'results replace the questions');
    assert.deepEqual(Array.from(el('questions').querySelectorAll('dd'),e=>e.textContent),['2 / 3','67%','2 min 5 sec']);
    assert.equal(s.w.document.activeElement,el('questions').querySelector('.quiz-result h3'));
    click('.quiz-result button');assert.equal(el('questions').querySelectorAll('fieldset').length,3);assert.equal(el('questions').querySelectorAll('.quiz-feedback').length,3);
    now=300000;click('.quiz-review-actions button');assert.match(el('questions').textContent!,/2 min 5 sec/,'review does not change completion time');
    click('.quiz-result button:last-child');assert.equal(s.dialog.open,false);assert.equal(s.w.document.activeElement,button('quiz'));
    button('quiz').click();assert.ok(el('questions').querySelector('.quiz-result'),'reopening retains results');
    click('.quiz-result button');click('.quiz-review-actions button:last-child');assert.equal(el('questions').querySelector('progress')!.value,0);assert.equal(el('questions').querySelector('.quiz-feedback'),null);
    // Skipping to the end cannot complete an unanswered quiz.
    click('.quiz-navigation button:last-child');click('.quiz-option:nth-of-type(2)');click('.quiz-navigation button:last-child');click('.quiz-option:nth-of-type(2)');
    assert.equal((el('questions').querySelector('.quiz-navigation button:last-child') as HTMLButtonElement).disabled,true);
    click('.quiz-navigation button:first-child');click('.quiz-navigation button:first-child');click('.quiz-option:nth-of-type(2)');
    click('.quiz-navigation button:last-child');click('.quiz-navigation button:last-child');now=304000;click('.quiz-navigation button:last-child');
    assert.deepEqual(Array.from(el('questions').querySelectorAll('dd'),e=>e.textContent),['3 / 3','100%','4 sec'],'retry starts a fresh score and timer');
    assert.equal(s.rpcs.filter(r=>r.method==='study_quiz_me').length,1);assert.deepEqual(s.sent.map(m=>m.type),['ready','studyConnect']);
    s.chapter('new');await tick();assert.equal(el('questions').querySelector('.quiz-result'),null,'chapter changes clear results');
  }finally{s.dom.window.close();}
});

test('Study course changes replace chapters and selection explanations show their source',async()=>{
  const s=surface(),{el,button,publish}=s;
  try{
    s.post({type:'catalog',selected:'book:test',notice:'',courses:[{id:'a',title:'A long course name',chapters:[{id:'book:test',title:'Example'}]},{id:'b',title:'Another course',chapters:[{id:'b:1',title:'New chapter'}]}]});
    button('course').click();assert.equal(s.sent.at(-1).type,'chooseCourse');
    s.post({type:'chapter',documentKey:'new',courseId:'b',source:{id:'b:1',revision:'r',course:'Another course',title:'New chapter',markdown:'# New',reading:[]},signedIn:true,aiEnabled:true});
    assert.equal((el('chapter') as HTMLSelectElement).value,'b:1');assert.equal((el('chapter') as HTMLSelectElement).options.length,1);assert.match(button('course').textContent!,/Another course/);assert.match(el('study-context').textContent!,/New chapter/);
    s.w.DhimantStudyBridge({event:'text_selected',text:'The original textbook passage.'});button('explain').click();await s.grant('new');
    assert.equal(el('text-reference').hidden,false);assert.equal(el('text-reference-content').textContent,'The original textbook passage.');
    publish({method:'display_on_screen',content:'## Explanation\n\nLook at each value.',study_request_id:s.request()});assert.match(el('response').textContent!,/Explanation/);assert.equal(el('crop-reference').hidden,true);
    s.w.DhimantStudyBridge({event:'page_changed',pageIndex:3,totalPages:12,cfi:'epubcfi(/6/2)'});assert.equal(el('page').textContent,'Page 3 of 12');
  }finally{s.dom.window.close();}
});

test('Ask Study keeps an authored practice question beside its explanation without transcription',async()=>{
  const s=surface(),{el,button,publish}=s;
  try {
    button('open-study').click();s.input('Explain comparisons, then ask one practice question.');
    button('send').click();await s.grant();const request=s.request();
    const explanation={method:'display_on_screen',content:'## Count comparisons\n\nInspect each value once.',study_request_id:request};
    publish(explanation);
    publish({method:'write_on_whiteboard',content:'## Your turn\n\nHow many comparisons find 5 in [8, 3, 5, 1]?',study_request_id:request});
    publish(explanation);
    assert.equal(el('response').querySelectorAll('.study-answer-card').length,2);
    assert.match(el('response').textContent!,/Inspect each value once/);
    assert.match(el('response').textContent!,/How many comparisons/);
    publish({method:'agent_text',content:'A speech transcript must not appear.',study_request_id:request});
    assert.doesNotMatch(el('response').textContent!,/transcript/);
    button('close-study').click();button('open-study').click();
    assert.match(el('response').textContent!,/How many comparisons/);
    s.input('Three comparisons.');button('send').click();await tick();
    publish({method:'display_on_screen',content:'Stale question',study_request_id:request});
    assert.doesNotMatch(el('response').textContent!,/Stale question/);
  } finally {s.dom.window.close();}
});

test('Study retains a draft when delivery fails after server acceptance',async()=>{
  const s=surface();
  try {
    s.button('open-study').click();const field=s.input('Explain this and give me a practice question.');
    s.button('send').click();await s.grant();
    assert.equal(field.value,'Explain this and give me a practice question.');
    s.rooms.at(-1)!.listeners.get('Disconnected')!();await tick();
    assert.equal(field.value,'Explain this and give me a practice question.');
    assert.equal(field.disabled,false);
    assert.match(s.el('help-status').textContent!,/disconnected/i);
  } finally {s.dom.window.close();}
});

test('the compact composer uses speaker and send icons, and Stop cancels the current request',async()=>{
  const s=surface();
  try {
    s.button('open-study').click();
    assert.doesNotMatch(s.el('ask').textContent!,/Ask about this chapter|mastery assessment/);
    assert.equal(s.el('sound').tagName,'BUTTON');
    assert.equal(s.el('sound').getAttribute('aria-pressed'),'false');
    s.button('sound').click();assert.equal(s.el('sound').getAttribute('aria-label'),'Mute speaker');
    const field=s.input('Keep this cancelled question.');s.button('send').click();await s.grant();
    assert.equal(s.el('send').getAttribute('aria-label'),'Stop response');
    assert.equal(s.button('send').disabled,false);
    const request=s.request(),room=s.rooms.at(-1)!;
    s.button('send').click();await tick();
    assert.equal(room.closed,true);
    assert.equal(field.value,'Keep this cancelled question.');
    assert.equal(field.disabled,false);
    assert.equal(s.el('send').getAttribute('aria-label'),'Send message');
    s.publish({method:'display_on_screen',content:'Late answer',study_request_id:request},room);
    assert.equal(s.el('response').textContent,'');
  } finally {s.dom.window.close();}
});
