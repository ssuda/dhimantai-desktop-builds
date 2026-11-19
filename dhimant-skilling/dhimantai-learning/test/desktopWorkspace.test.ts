import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {bindLearningWorkspace} from '../webview/learningWorkspace';
import {courseSuggestions, lessonsCovered, resumeTopic} from '../src/catalogDiscovery';
import {certificateStatus, loadCertificateCourses} from '../src/certificateDashboard';
import {courseGradeHtml} from '../src/courseGradeHtml';
import {catalogClient} from '../src/catalogClient';
import {nextChapter} from '../src/courseProgress';
import type {CourseGrade, CourseCertificate} from '../src/courseworkProgress';
import type {CatalogCourse} from '../src/learnerCatalog';

const grade = (eligible = false):CourseGrade => ({course_id:'python',course_title:'Python',score:80,grade:'B',eligible,passed_count:1,required_count:2,
  exercise_score:80,project_score:null,policy:{description:'Complete independent activities.',scope:'Coursework'},blockers:['Complete the project'],topics:[],requirements:[]});
const course = (id:string, enrolled=true):CatalogCourse => ({id,title:id,summary:'',level:'Beginner',prerequisites:'',can_join:true,enrolled,category:'Programming',chapters:[]});
const certificate:CourseCertificate = {id:'issued-id',course_id:'python',course_title:'Python',recipient_name:'Learner',grade:'B',score:80,issued_at:'2026-11-14',revoked_at:null,policy_version:'coursework-v1'};

test('suggestions and resume topics use observed progress and never invent completion', () => {
  const c=course('python');
  assert.equal(lessonsCovered(c),false);
  assert.deepEqual(courseSuggestions([c,course('next',false)]),[]);
  c.chapters=[{id:'c1',name:'Lists',progress:{status:'in_progress',covered:1,total:2,topics:[{id:'a',title:'Indexing',status:'covered'},{id:'b',title:'Slicing',status:'in_progress'}]}}];
  assert.equal(resumeTopic(c,'c1'),'Slicing');
  assert.deepEqual(courseSuggestions([c,course('next',false),{...course('closed',false),can_join:false}]).map(s=>s.course.id),['next']);
  assert.equal(lessonsCovered(c),false);
  c.chapters[0].progress!.status='covered';assert.equal(lessonsCovered(c),true);
  const active = ['2026-11-12', '2026-11-14'].map((updated_at,i)=>({id:String(i),progress:{...c.chapters[0].progress!,status:'in_progress' as const,updated_at}}));
  assert.equal(nextChapter(active,()=>true)?.id,'1','resume the most recently active unfinished chapter');
});

test('catalog combines filters and search, preserves state within its owner, and excludes unknown completion', () => {
  let state:any;
  const markup=`<input id="search"><select id="filter-category"><option value="">All</option><option>Programming</option></select><select id="filter-level"><option value="">All</option><option>Beginner</option></select><select id="filter-status"><option value="">All</option><option value="enrolled">My courses</option><option value="covered">Covered</option></select><div id="results"><section><article class="course" data-course="python" data-category="Programming" data-level="Beginner" data-enrolled="true" data-covered="true"><h3>Python lists</h3></article><article class="course" data-course="java" data-category="Programming" data-level="Beginner" data-enrolled="true" data-covered="false"><h3>Java lists</h3></article><article class="course" data-project="demo"><h3>Demo lists</h3></article></section></div><p id="empty" hidden></p><p id="result-count"></p>`;
  const open=(scope:string)=>{const dom=new JSDOM(markup,{runScripts:'outside-only'});const w=dom.window;
    (w as any).acquireVsCodeApi=()=>({getState:()=>state,setState:(s:any)=>{state=s;},postMessage:()=>{}});
    w.eval(`(${catalogClient.toString()})(${JSON.stringify(scope)},'')`);return {dom,w,doc:w.document};};
  let p=open('alice');const select=(id:string,value:string)=>{const el=p.doc.getElementById(id) as HTMLInputElement;el.value=value;el.dispatchEvent(new p.w.Event(id==='search'?'input':'change'));};
  select('search','lists');select('filter-category','Programming');select('filter-level','Beginner');select('filter-status','covered');
  assert.equal(p.doc.querySelectorAll('.course:not([hidden])').length,1);
  assert.equal(p.doc.querySelector('.course:not([hidden])')!.getAttribute('data-course'),'python');
  select('search','missing');assert.equal(p.doc.getElementById('empty')!.hidden,false);
  p.dom.window.close();p=open('alice');assert.equal((p.doc.getElementById('filter-status') as HTMLSelectElement).value,'covered');
  p.dom.window.close();p=open('bob');assert.equal((p.doc.getElementById('filter-status') as HTMLSelectElement).value,'');
  assert.equal(p.doc.querySelectorAll('.course:not([hidden])').length,3);p.dom.window.close();
});

test('certificate dashboard distinguishes unknown, revoked, eligible and earned results', () => {
  assert.equal(certificateStatus({id:'python',title:'Python'},[]),'unavailable');
  assert.equal(certificateStatus({id:'python',title:'Python',grade:grade(true)},[]),'eligible');
  assert.equal(certificateStatus({id:'python',title:'Python'},[certificate]),'completed');
  assert.equal(certificateStatus({id:'python',title:'Python'},[{...certificate,revoked_at:'today'}]),'unavailable');
  const html=courseGradeHtml('nonce',undefined,[certificate],'',0,false,true,undefined,'alice',[
    {id:'pending',title:'<script>Pending',grade:grade()}, {id:'eligible',title:'Ready',grade:grade(true)}, {id:'unknown',title:'Unknown',error:'Offline'}]);
  let state:any;const dom=new JSDOM(html,{runScripts:'outside-only'}),w=dom.window,doc=w.document;
  (w as any).acquireVsCodeApi=()=>({getState:()=>state,setState:(s:any)=>{state=s;},postMessage:()=>{}});
  w.eval(doc.querySelector('script')!.textContent!);
  doc.querySelector<HTMLButtonElement>('[data-filter="eligible"]')!.click();
  assert.equal(doc.querySelectorAll('[data-certificate-status]:not([hidden])').length,1);
  assert.match(doc.querySelector('[data-certificate-status]:not([hidden])')!.textContent!,/Ready/);
  assert.equal(doc.querySelectorAll('script').length,1);assert.match(doc.body.textContent!,/Complete the project/);
  assert.match(doc.body.textContent!,/Print → Save as PDF/);assert.match(doc.body.textContent!,/Certificate issued/);
  dom.window.close();
});

test('certificate grade loading bounds concurrency, tolerates failures and stops obsolete loads', async () => {
  let current=0,max=0,calls=0,active=true;
  const rows=await loadCertificateCourses(Array.from({length:11},(_,i)=>course(String(i))),async id=>{
    calls++;current++;max=Math.max(max,current);await new Promise(r=>setTimeout(r,1));current--;
    if(id==='1')throw new Error('Offline');return grade();
  });
  assert.equal(calls,11);assert.equal(max,4);assert.equal(rows[1].grade,undefined);assert.match(rows[1].error!,/Refresh/);
  calls=0;await loadCertificateCourses(Array.from({length:12},(_,i)=>course(String(i))),async()=>{calls++;active=false;return grade();},()=>active);
  assert.equal(calls,1);
});

test('the single-column notebook preserves drafts, keyboard focus and chapter navigation', async () => {
  const dom=new JSDOM(`<select id="workspace-mode"></select><section id="tutor-lessons"><div id="lesson-list"><div class="lesson-outline"><button>First</button></div><div class="lesson-outline"><button aria-pressed="true">Second</button></div></div></section><div id="learning-document"><textarea id="code">print(1)</textarea><button id="previous-chapter"></button><footer id="message-bar"><textarea id="message">unfinished question</textarea></footer></div>`,{url:'https://workspace.test'});
  const w=dom.window,doc=w.document;bindLearningWorkspace(doc);
  const input=doc.getElementById('message') as HTMLTextAreaElement,code=doc.getElementById('code');
  doc.dispatchEvent(new w.KeyboardEvent('keydown',{key:'a',altKey:true,shiftKey:true,bubbles:true}));
  assert.equal(doc.activeElement,input);assert.equal(input.value,'unfinished question');assert.equal(doc.getElementById('code'),code);
  let clicked=false;doc.querySelector<HTMLButtonElement>('.lesson-outline button')!.onclick=()=>{clicked=true;};
  doc.getElementById('previous-chapter')!.click();assert.equal(clicked,true);
  doc.getElementById('tutor-lessons')!.hidden=true;await new Promise(r=>setTimeout(r,0));
  assert.equal(doc.getElementById('previous-chapter')!.hidden,true);
  dom.window.close();
});
