import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CourseworkOutbox, exerciseResult, projectResult, CourseGrade } from '../src/courseworkProgress';
import { courseGradeHtml } from '../src/courseGradeHtml';
import { helpSinceAssessment, record } from '../src/helpRecord';
import type { TestReport } from '../src/api';
import type { ProjectSubmission } from '../src/projectResults';

const report: TestReport = {assessment_revision:'rev',suite_version:1,passed:1,total:1,all_passed:true,public:{passed:0,total:0},
  cases:[{id:'hidden',visibility:'hidden',verdict:'passed',label:'Passed',expected:'private',stderr:'private'}]};

test('assessment summary strips source, output and hidden data; unversioned work is not synced', () => {
  const value = exerciseResult(report,'request','a'.repeat(64),'reported')!;
  assert.deepEqual(value.cases,[{id:'hidden',verdict:'passed'}]);
  assert.ok(!JSON.stringify(value).includes('private'));
  assert.equal(exerciseResult({...report,assessment_revision:undefined},'r','a','unknown'),undefined);
});

test('durable outbox survives failures, isolates accounts and retries explicitly with same request', async () => {
  const data = new Map<string,unknown>();
  const state = {keys:()=>[...data.keys()],get:<T>(k:string)=>data.get(k) as T,update:async(k:string,v:unknown)=>{if(v===undefined)data.delete(k);else data.set(k,v);}};
  const outbox = new CourseworkOutbox(state), result = exerciseResult(report,'r1','a'.repeat(64),'none_reported')!;
  const value = {kind:'exercise' as const,id:'q',result};
  let calls = 0;
  await assert.rejects(outbox.send('staging','owner',value,async()=>{calls++;throw new Error('Offline');}));
  assert.equal(calls,1); assert.equal(outbox.pending('staging','owner').length,1);
  assert.equal(outbox.pending('production','owner').length,0); assert.equal(outbox.pending('staging','other').length,0);
  const reopened = new CourseworkOutbox(state);
  await reopened.retry('staging','owner',async(v)=>{calls++;assert.equal(v.result.request_id,'r1');});
  assert.equal(calls,2); assert.equal(reopened.pending('staging','owner').length,0);
});

test('a failed pending result does not prevent other results syncing or cause automatic retry', async () => {
  const data = new Map<string,unknown>();
  const outbox = new CourseworkOutbox({keys:()=>[...data.keys()],get:<T>(k:string)=>data.get(k) as T,update:async(k,v)=>{if(v===undefined)data.delete(k);else data.set(k,v);}});
  for (const id of ['stale','current']) await assert.rejects(outbox.send('e','u',{kind:'exercise',id,result:exerciseResult(report,id,'a'.repeat(64),'unknown')!},async()=>{throw new Error('offline');}));
  let calls=0;
  await assert.rejects(outbox.retry('e','u',async v=>{calls++;if(v.id==='stale')throw new Error('Assessment changed');}),/remain pending/);
  assert.equal(calls,2); assert.deepEqual(outbox.pending('e','u').map(v=>v.id),['stale']);
});

test('later independent attempts are possible without erasing prior help records', () => {
  let rows = record([],{type:'open',id:'q',title:'Q',language:'python'});
  rows = record(rows,{type:'help',id:'q',level:2});
  assert.equal(helpSinceAssessment(rows[0]),true);
  rows = record(rows,{type:'graded',id:'q',passed:2,total:5});
  assert.equal(helpSinceAssessment(rows[0]),false);
  assert.equal(rows[0].ladder[1],1);
  rows = record(rows,{type:'ask',id:'q'});
  assert.equal(helpSinceAssessment(rows[0]),true);
});

test('project marks use full authored checks and retain help disclosure', () => {
  const sub = {id:'id',curriculumVersion:2,digest:'b'.repeat(64),assistance:{coachTurns:2,otherHelp:'none_reported'},
    runs:[{step:'final',status:'passed',output:'private'}]} as ProjectSubmission;
  const assessment = {kind:'project' as const,id:'shelf',version:2,revision:'r',gradable:true,steps:['final']};
  assert.equal(projectResult(sub,assessment)!.help,'reported');
  assert.ok(!JSON.stringify(projectResult(sub,assessment)).includes('private'));
  assert.throws(()=>projectResult(sub,{...assessment,version:3}),/requirements changed/);
  assert.throws(()=>projectResult(sub,{...assessment,steps:['another']}),/requirements changed/);
  assert.equal(projectResult(sub,{...assessment,gradable:false}),undefined);
});

test('course screen gates claiming, preserves historical grades, escapes text and has no exam action', () => {
  const grade: CourseGrade = {course_id:'python',course_title:'<script>Python',score:84,grade:'B',eligible:false,passed_count:1,required_count:2,
    exercise_score:90,project_score:80,policy:{description:'No final exam.',scope:'Unproctored.'},blockers:[],
    topics:[{topic:'Loops',score:50,independent:1,required_independent:2,ready:false}],requirements:[]};
  let html=courseGradeHtml('nonce',grade,[],'Offline',1);
  assert.match(html,/data-action="claim"[^>]*disabled/); assert.ok(!html.includes('<script>Python'));
  assert.match(html,/Sync pending results/); assert.match(html,/Keep practising/); assert.ok(!html.includes('Start final exam'));
  html=courseGradeHtml('nonce',{...grade,eligible:true,certificate_id:'c'},[{id:'c',course_id:'python',course_title:'Python',recipient_name:'Learner',
    grade:'C',score:75,issued_at:'2026-11-10',revoked_at:null,policy_version:'coursework-v1'}],'',0);
  assert.match(html,/Grade C · 75\/100/); assert.ok(!html.includes('data-action="claim"'));
});
