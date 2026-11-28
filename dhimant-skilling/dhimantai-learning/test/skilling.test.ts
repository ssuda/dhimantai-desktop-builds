import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { courseGradeHtml } from '../src/courseGradeHtml';
import { CourseGrade } from '../src/courseworkProgress';
import { SkillingPathway, previewUrl, previewPublishArgs, evidenceRequestId } from '../src/skilling';
import { loadProjectCurriculum, projectFiles, projectSnapshot, projectIdentity, checkArguments, publicProjectFile } from '../src/projectCore';
import { Api } from '../src/api';
import { supplementalPractice, practiceDocument, savedPractice } from '../src/practiceNotebook';

const data:SkillingPathway={current_week:'2026-11-09',topics:[{key:'c:loops',topic:'Loops',ready:true,
  challenges:[{id:'apply',title:'Apply loops',difficulty:'easy',prompt:'Predict, implement and test a boundary.'}],interview:['Explain a loop invariant.']}],weekly:[],
  pathway:{eligible:false,score:null,blockers:['Pass each readiness assessment.'],profile:{course_id:'python',title:'Python',role:'Junior Python Developer',level:'Entry level',certifiable:true,fingerprint:'v1',
    technology_stack:['Python'],prerequisites:[],recommended_next:[],outcomes:['Test boundaries.'],criteria:{fundamentals:'Explain fundamentals'},scope:'Independent assessment required.',project_theme:'Expense report'},
    milestones:[{id:'micro',title:'Micro',status:'not_started',unlocked:true,basis:{},submission_id:null,review:null},{id:'minor',title:'Minor',status:'locked',unlocked:false,basis:{},submission_id:null,review:null}]}};
const grade:CourseGrade={course_id:'python',course_title:'Python',score:100,grade:'A',eligible:false,passed_count:10,required_count:10,exercise_score:100,project_score:100,
  policy:{description:'Practice marks',scope:'Learner reports'},blockers:[],topics:[],requirements:[],readiness:data.pathway,coursework_ready:true};

function page(scope='owner:staging:python',saved?:unknown,html=courseGradeHtml('nonce',grade,[],'',[],false,false,data,scope)){
  let state=saved;const messages:any[]=[];
  const dom=new JSDOM(html,{url:'https://webview.test/',runScripts:'dangerously',beforeParse(window){
    (window as any).acquireVsCodeApi=()=>({getState:()=>state,setState:(v:unknown)=>{state=v;},postMessage:(v:unknown)=>messages.push(v)});
  }});
  return {dom,messages,state:()=>state};
}

test('a perfect practice grade cannot enable certificate issuance or locked projects',()=>{
  const p=page(),doc=p.dom.window.document;
  assert.equal((doc.querySelector('[data-action="claim"]') as HTMLButtonElement).disabled,true);
  const locked=doc.querySelector('[data-action="skillingProject"][data-id="minor"]') as HTMLButtonElement;
  locked.click();assert.equal(p.messages.length,0);
  (doc.querySelector('[data-action="skillingProject"][data-id="micro"]') as HTMLButtonElement).click();
  assert.equal(p.messages[0].id,'micro');assert.ok(p.messages[0].requestId);
  assert.match(doc.querySelector('#panel-Certificate')!.textContent!, /Pass each readiness assessment/);
  p.dom.window.close();
});

test('a lesson-locked Micro links to its course and lists the unavailable lessons', () => {
  const locked = structuredClone(data);
  const reason = 'Unlock 1 required lesson in Python Programming.';
  locked.pathway.lesson_access = {reason, lessons:['Loops <and> conditions']};
  locked.pathway.blockers.unshift(reason);
  Object.assign(locked.pathway.milestones[0], {unlocked:false, status:'locked', lock_reason:reason});
  const p = page('', undefined, courseGradeHtml('nonce', {...grade, readiness:locked.pathway}, [], '', []));
  const doc = p.dom.window.document;
  const start = doc.querySelector<HTMLButtonElement>('[data-action="skillingProject"][data-id="micro"]')!;
  assert.equal(start.disabled, true);
  assert.equal(start.textContent, 'Locked');
  assert.match(start.closest('li')!.textContent!, /Unlock 1 required lesson in Python/);
  assert.ok(doc.body.textContent!.includes('Loops <and> conditions'));
  assert.equal(doc.querySelector('#panel-Overview')!.textContent!.split(reason).length, 2);
  const lessons = doc.querySelector<HTMLButtonElement>('[data-action="nextCourse"][data-id="python"]')!;
  assert.equal(lessons.textContent, 'View course lessons');
  lessons.click();
  assert.equal(p.messages[0].type, 'nextCourse');
  assert.equal(p.messages[0].id, 'python');
  p.dom.window.close();

  // An older server can send the original contradictory state during rollout.
  delete locked.pathway.lesson_access;
  locked.pathway.milestones[0].status = 'not_started';
  locked.pathway.milestones[0].lock_reason = undefined;
  locked.pathway.blockers = ['Unlock the required course lessons before starting readiness assessments.'];
  const older = page('', undefined, courseGradeHtml('nonce', grade, [], '', [], false, false, locked));
  const legacyStart = older.dom.window.document.querySelector<HTMLButtonElement>('[data-action="skillingProject"][data-id="micro"]')!;
  assert.equal(legacyStart.disabled, true);
  assert.match(legacyStart.closest('li')!.textContent!, /Unlock the required course lessons/);
  assert.ok(older.dom.window.document.querySelector('[data-action="nextCourse"][data-id="python"]'));
  older.dom.window.close();
});

test('eligible and issued certificates reveal their corresponding claim or verified record',()=>{
  const eligible=page('',undefined,courseGradeHtml('nonce',{...grade,eligible:true},[],'',[]));
  const doc=eligible.dom.window.document;
  assert.equal(doc.querySelector('#panel-Certificate .locked'),null);
  doc.querySelector<HTMLButtonElement>('[data-action="claim"]')!.click();
  assert.equal(eligible.messages[0].type,'claim');
  eligible.dom.window.close();

  const certificate={id:'earned',course_id:'python',course_title:'Python',recipient_name:'A Learner',grade:'A',score:94,
    issued_at:'2026-11-15',revoked_at:null,policy_version:'v1'};
  const issued=page('',undefined,courseGradeHtml('nonce',{...grade,certificate_id:'earned'},[certificate],'',[]));
  assert.match(issued.dom.window.document.querySelector('.earned-paper')!.textContent!, /A Learner/);
  assert.equal(issued.dom.window.document.querySelector('[data-action="claim"]'),null);
  issued.dom.window.document.querySelector<HTMLButtonElement>('[data-action="certificate"]')!.click();
  assert.equal(issued.messages[0].id,'earned');
  issued.dom.window.close();
});

test('evidence drafts survive rerenders and retries but cannot cross account or service boundaries',()=>{
  const p=page(),input=p.dom.window.document.querySelector('[data-field="requirements"]') as HTMLTextAreaElement;
  input.value='Learner private project requirements';input.dispatchEvent(new p.dom.window.Event('input',{bubbles:true}));
  const state=p.state();p.dom.window.close();
  const restored=page('owner:staging:python',state);
  assert.equal((restored.dom.window.document.querySelector('[data-field="requirements"]') as HTMLTextAreaElement).value,input.value);
  restored.dom.window.close();
  for(const scope of ['other:staging:python','owner:production:python']){
    const switched=page(scope,state);assert.equal((switched.dom.window.document.querySelector('[data-field="requirements"]') as HTMLTextAreaElement).value,'');switched.dom.window.close();
  }
});

test('course and review content cannot inject script, and current attempt answers use stable ids',()=>{
  const malicious=structuredClone(data);malicious.pathway.profile!.role='<img src=x onerror="window.pwned=true">';
  malicious.weekly=[{id:'attempt',week_start:'2026-11-09',submission_id:null,questions:[{id:'q',topic:'Loops',topic_key:'c:loops',prompt:'Explain <script>window.pwned=true</script>'}]}];
  const html=courseGradeHtml('nonce',grade,[],'',[],false,false,malicious,'owner:</script><script>window.pwned=true</script>');
  const p=page('',undefined,html),doc=p.dom.window.document;
  assert.equal((p.dom.window as any).pwned,undefined);assert.equal(doc.querySelector('img'),null);
  const input=doc.querySelector('[data-field="answer:attempt:q"]') as HTMLTextAreaElement;input.value='Boundary explanation';
  (doc.querySelector('[data-action="weeklySubmit"]') as HTMLButtonElement).click();
  assert.equal(p.messages[0].fields['answer:attempt:q'],'Boundary explanation');
  p.dom.window.close();
});

test('preview accepts only a single explicitly loopback-bound runtime port',()=>{
  assert.equal(previewUrl('127.0.0.1:12345\n'),'http://127.0.0.1:12345/');
  for(const v of ['0.0.0.0:8000','192.168.1.1:8000','http://example.com','127.0.0.1:0','127.0.0.1:65536','127.0.0.1:8000\n0.0.0.0:8000'])assert.throws(()=>previewUrl(v));
  assert.ok(previewPublishArgs.filter(x=>x!=='--publish').every(v=>v.startsWith('127.0.0.1::')));
});

test('submission retries stay idempotent while changed files or prerequisite reviews get a new request',()=>{
  const scope='00000000-0000-4000-8000-000000000001',evidence={basis:{previous_review:'one'},files:[{path:'main.py',text:'print(1)'}]};
  const id=evidenceRequestId(scope,evidence);
  assert.equal(id,evidenceRequestId(scope,structuredClone(evidence)));
  assert.notEqual(id,evidenceRequestId(scope,{...evidence,files:[{path:'main.py',text:'print(2)'}]}));
  assert.notEqual(id,evidenceRequestId(scope,{...evidence,basis:{previous_review:'two'}}));
  assert.match(id,/^[0-9a-f-]{14}5[0-9a-f-]{21}$/);
});

test('supplementary tasks reuse saved Practice notebooks without claiming validated tests or grading credit',()=>{
  for (const [course, language] of [['Java Programming', 'java'], ['Laravel equipment desk', 'bash']]) {
    const practice = supplementalPractice({assessment:'practice_only', title:'Boundary cases',
      question:'Implement and explain failure handling.', course, language}, 'generated-'+'b'.repeat(24), 'learner');
    assert.equal(practice.language, language);
    assert.equal(practice.course, course);
    assert.deepEqual(practice.tests, []);
    assert.deepEqual(savedPractice(practiceDocument(practice), 'learner'), practice);
  }
});

test('older unfinished mocks remain resumable without mixing their answers or assistance',()=>{
  const learning=structuredClone(data);
  learning.weekly=[{id:'current',week_start:learning.current_week,submission_id:'submitted',questions:[]},
    {id:'older',week_start:'2026-11-02',submission_id:null,questions:[{id:'q',topic:'Loops',topic_key:'c:loops',prompt:'Explain boundary cases.'}]}];
  const p=page('',undefined,courseGradeHtml('nonce',grade,[],'',[],false,false,learning)),doc=p.dom.window.document;
  assert.equal((doc.querySelector('[data-action="weeklyStart"]') as HTMLButtonElement).disabled,true);
  assert.ok(doc.querySelector('[data-field="answer:older:q"]'));
  assert.ok(doc.querySelector('[data-field="weeklyAssistance:older"]'));
  assert.equal(doc.querySelectorAll('[data-action="weeklySubmit"]').length,1);
  assert.equal(doc.querySelector('[data-action="authoredChallenge"]'),null);
  p.dom.window.close();
});

test('explicit readiness submissions reach the API while retired code storage remains blocked',async()=>{
  const original=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=(async(url:string|URL|Request)=>{calls.push(String(url));return new Response('{}',{status:200});}) as typeof fetch;
  try{
    const api=new Api({accessToken:async()=> 'token',session:async()=>({user:{id:'owner'},access_token:'token'})} as any,
      ()=>({apiUrl:'https://api.test'} as any),'owner');
    await api.submitSkilling('python',{kind:'micro'});
    await api.submitSkillingWeekly('00000000-0000-0000-0000-000000000001',{q:'answer'},'independent');
    assert.equal(calls.length,2);
    await assert.rejects((api as any).request('POST','/course-projects/project/submit',{}),/retired/);
    assert.equal(calls.length,2);
  }finally{globalThis.fetch=original;}
});

test('custom Coach uses installed steps, bounded public source and the matching course language',async()=>{
  const root=await mkdtemp(join(tmpdir(),'skilling-project-'));
  try{
    await mkdir(join(root,'src'));await mkdir(join(root,'tests'));
    await writeFile(join(root,'.dhimantai-project.json'),JSON.stringify({id:'skilling-project',version:1}));
    await writeFile(join(root,'.dhimantai-skilling.json'),JSON.stringify({course_id:'java-programming',title:'My inventory project',requirements:'Reserve stock atomically and reject invalid quantities.',language:'java',steps:[{check:'evil command'}]}));
    for(const name of ['README.md','EXPLANATION.md','src/README.md','tests/README.md','src/Main.java'])await writeFile(join(root,name),'public evidence');
    await writeFile(join(root,'src/credentials.json'),'private sentinel');
    const curriculum=await loadProjectCurriculum(resolve('media'),'skilling-project',root);
    assert.equal(await projectIdentity(root),'skilling-project');assert.equal(curriculum.courseId,'java-programming');assert.equal(curriculum.language,'java');
    assert.ok(curriculum.steps.every(s=>s.check==='guided:inspect'));
    const files=await projectFiles(root,curriculum);assert.ok(files.includes('src/Main.java'));assert.ok(!files.includes('src/credentials.json'));
    const snapshot=await projectSnapshot(root,curriculum,['src/Main.java']);assert.ok(!JSON.stringify(snapshot).includes('private sentinel'));
    assert.ok(checkArguments(curriculum.steps[0]).includes('-c'));
    await symlink(join(root,'README.md'),join(root,'src/linked.py'));
    assert.ok(!(await projectFiles(root,curriculum)).includes('src/linked.py'));
    await assert.rejects(publicProjectFile(root,'src/linked.py'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a guided project shares its own security and deployment files, never secrets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'skilling-deploy-'));
  try{
    await mkdir(join(root,'src/auth'),{recursive:true});await mkdir(join(root,'tests'));await mkdir(join(root,'.github/workflows'),{recursive:true});
    await writeFile(join(root,'.dhimantai-project.json'),JSON.stringify({id:'skilling-project',version:1}));
    await writeFile(join(root,'.dhimantai-skilling.json'),JSON.stringify({course_id:'software-engineering',title:'Orders',requirements:'Take orders.',language:'python'}));
    for(const name of ['README.md','EXPLANATION.md','src/README.md','tests/README.md','src/auth/tokens.py','Dockerfile','requirements.txt','docker-compose.yml','Makefile','.github/workflows/ci.yml'])
      await writeFile(join(root,name),'public evidence');
    for(const name of ['.env','secrets.json','src/auth/keys.json','.github/workflows/notes.txt'])await writeFile(join(root,name),'private sentinel');
    const curriculum=await loadProjectCurriculum(resolve('media'),'skilling-project',root);
    const files=await projectFiles(root,curriculum);
    for(const name of ['src/auth/tokens.py','Dockerfile','requirements.txt','docker-compose.yml','Makefile','.github/workflows/ci.yml'])assert.ok(files.includes(name),name);
    for(const name of ['.env','secrets.json','src/auth/keys.json','.github/workflows/notes.txt'])assert.ok(!files.includes(name),name);
    assert.ok(!files.includes('pyproject.toml'),'absent files are not listed as missing evidence');
  }finally{await rm(root,{recursive:true,force:true});}
});
