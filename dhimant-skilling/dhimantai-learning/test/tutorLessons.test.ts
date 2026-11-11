import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { emptyNotebook } from '../src/tutorNotebook';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

test('lesson chooser handles empty/offline catalogs and isolates drafts, stale restores and account changes', async () => {
  const dom = new JSDOM('<!doctype html>' + lessonPicker +
    ['wide','latest','tutor','doubt_solver','end','sound','send','teach-back','video'].map(id => `<button id="${id}" ${id === 'end' ? 'disabled' : ''}></button>`).join('') +
    '<span id="status"></span><input id="follow-code"><input id="stuck-hints"><small id="code-observer-status"></small><main id="feed"></main><form id="composer"><textarea id="message"></textarea></form>',
    {runScripts:'outside-only', url:'https://webview.example'});
  const w = dom.window, sent: any[] = [];
  w.LivekitClient = {RoomEvent:{}};
  w.acquireVsCodeApi = () => ({postMessage:(message: any) => sent.push(message)});
  const post = (data: any) => w.dispatchEvent(new w.MessageEvent('message', {origin:w.location.origin,data}));
  const field = w.document.getElementById('message') as HTMLTextAreaElement;
  const feed = w.document.getElementById('feed')!;
  const button = (id: string) => w.document.getElementById(id) as HTMLButtonElement;
  try {
    w.eval(readFileSync(resolve(__dirname,'../../media/learning-room/room.js'),'utf8'));
    post({type:'openTutor'});
    let attempt = sent.at(-1).attempt;
    post({type:'tutorLessons',attempt,courses:[]});
    assert.match(w.document.getElementById('lesson-list')!.textContent!, /No lessons available/);
    assert.equal(w.document.getElementById('composer')!.hidden,true);
    assert.equal(sent.some(message => message.type === 'join'),false);
    post({type:'tutorLessons',attempt,courses:[],error:'Course service unavailable'});
    assert.match(w.document.getElementById('status')!.textContent!,/unavailable/);
    button('tutor').click();
    assert.equal(sent.at(-1).type,'tutorLessons');
    selectLesson(w,sent.at(-1).attempt);
    attempt = sent.at(-1).attempt;
    assert.equal(sent.at(-1).chapterId,chapterId);
    const tutor = {...emptyNotebook(),textDraft:'Instructor draft',cells:[{id:'tutor-note',kind:'note',text:'Instructor-only note'}]};
    post({type:'restoreNotebook',attempt,documentKey:'tutor-key',notebook:tutor});
    field.value = 'Latest unsent Instructor draft'; field.dispatchEvent(new w.Event('input'));
    button('doubt_solver').click();
    assert.equal(sent.at(-1).type, 'openOtherMode', 'the menu opens Doubt Solver in its own tab');
    assert.equal(field.value,'Latest unsent Instructor draft','and leaves this lesson as it was');
    post({type:'openTutor',mode:'doubt_solver'});
    const doubtAttempt = sent.at(-1).attempt;
    const saved = sent.filter(message => message.type === 'notebookChanged').at(-1);
    assert.equal(saved.documentKey,'tutor-key');
    assert.equal(saved.notebook.textDraft,'Latest unsent Instructor draft');
    assert.equal(field.value,''); assert.equal(feed.textContent,'');
    post({type:'restoreNotebook',attempt,documentKey:'stale',notebook:tutor});
    post({type:'tutorLessons',attempt,courses:[{name:'Stale course',chapters:[]}]});
    assert.equal(field.value,''); assert.equal(feed.textContent,'');
    assert.equal(w.document.getElementById('tutor-lessons')!.hidden,true);
    const doubt = {...emptyNotebook(),textDraft:'Doubt draft',cells:[{id:'doubt-note',kind:'note',text:'Doubt-only note'}]};
    post({type:'restoreNotebook',attempt:doubtAttempt,documentKey:'doubt-key',notebook:doubt});
    post({type:'openTutor'});
    assert.equal(field.value,''); assert.equal(feed.textContent,'');
    assert.equal(sent.at(-1).type,'tutorLessons','returning to Instructor always opens lesson selection');
    selectLesson(w,sent.at(-1).attempt);
    post({type:'restoreNotebook',attempt:sent.at(-1).attempt,documentKey:'new-tutor-key',notebook:saved.notebook});
    assert.equal(field.value,'Latest unsent Instructor draft');
    assert.equal(feed.querySelector<HTMLTextAreaElement>('textarea')!.value,'Instructor-only note');
    assert.doesNotMatch(feed.textContent!,/Doubt/);
    await new Promise(resolve => setTimeout(resolve,300));
    assert.equal(sent.filter(message => message.type === 'notebookChanged').at(-1).documentKey,'doubt-key',
      'a previous autosave timer cannot write the new document');
    post({type:'signedOut'});
    assert.equal(field.value,''); assert.equal(feed.textContent,'');
    assert.equal(w.document.querySelectorAll('#lesson-course option').length,0);
    assert.equal(w.document.getElementById('composer')!.hidden,true);
  } finally { w.close(); }
});
