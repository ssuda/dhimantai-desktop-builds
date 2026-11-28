import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import type { Chapter, Course } from '../src/api';
import { sidebarResume } from '../src/learningSidebarHtml';

const chapter = (id: string, updated: string, locked=false): Chapter => ({id,name:id,locked,
  progress:{status:'in_progress',updated_at:updated,total:3,covered:1,topics:[]}});

test('Resume prefers the open course and chapter, then the most recent accessible course',()=>{
  const courses: Course[] = [
    {name:'Python',chapters:[chapter('old','2026-11-18'),chapter('new','2026-11-20')]},
    {name:'Java',chapters:[chapter('loops','2026-11-21'),chapter('paid','2026-11-22',true)]},
    {name:'Ended',chapters:[{...chapter('expired','2026-11-23'),expired:true}]},
  ];
  assert.equal(sidebarResume(courses,{course:'Python',lesson:'old'})?.chapter,'old');
  assert.equal(sidebarResume(courses,{course:'Python'})?.chapter,'new');
  assert.equal(sidebarResume(courses,{course:'Java',lesson:'paid'})?.chapter,'loops');
  assert.equal(sidebarResume(courses,{course:'Ended'})?.course,'Java');
  assert.equal(sidebarResume(courses,{})?.chapter,'loops');
  assert.equal(sidebarResume(courses.slice(2),{}),undefined);
  assert.equal(sidebarResume([{name:'Offline',chapters:[{id:'first',name:'First'}]}],{})?.covered,undefined);
});
