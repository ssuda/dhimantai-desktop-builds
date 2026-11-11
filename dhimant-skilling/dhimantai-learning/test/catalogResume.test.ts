import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { nextChapter } from '../src/courseProgress';

// Course Catalog runs against a recording VS Code API boundary.
const Module = require('node:module');
const executed: unknown[][] = [];
const vscode = {env: {appName: 'dhimantAI'}, commands: {executeCommand: async (...args: unknown[]) => { executed.push(args); }}};
const load = Module._load;
Module._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
const { CourseCatalog } = require('../src/courseCatalog') as typeof import('../src/courseCatalog');
Module._load = load;

const coverage = (status: any) => ({status, covered:0, total:3, topics:[]});
const course = (id: string, enrolled: boolean, statuses: string[], extra: object = {}) => ({id, title:'Course ' + id, summary:'About ' + id,
  level:'Beginner', prerequisites:'', can_join:true, enrolled, unlocked:true, category:'Software Engineering',
  chapters:statuses.map((status, i) => ({id:`${id}-${i}`, name:`${id} chapter ${i}`, free:i === 0, ...(status ? {progress:coverage(status)} : {})})), ...extra});
function render(account: string | undefined, courses: any[]) {
  const catalog: any = Object.create(CourseCatalog.prototype);
  Object.assign(catalog, {panel:{webview:{html:''}}, sequence:0, awaitingPayment:false, projects:[], studyCourses:new Set(), companions:[],
    environment:() => 'production', selection:{environment:'production', account, catalog:{individual:true, courses, offers:[]}}});
  catalog.render(catalog.selection.catalog, '');
  return {catalog, document:new JSDOM(catalog.panel.webview.html, {runScripts:'outside-only'}).window.document};
}

test('catalog sections and cards follow database order, including new categories and interleaved essentials', () => {
  const groups = [
    [course('custom', false, [''], {category:'New category'})],
    [course('engineering-git', false, ['']), course('java', false, ['']), course('engineering-terminal', false, [''])],
    [course('agents', false, [''], {category:'AI & Machine Learning'}),
      course('llm', false, [''], {category:'AI & Machine Learning'})],
  ];
  for (const ordered of [groups, [...groups].reverse()]) {
    const courses = ordered.flat();
    const {document} = render(undefined, courses);
    assert.deepEqual([...document.querySelectorAll('#results > .category:not(.projects) > h2')].map(h => h.textContent),
      ordered.map(group => group[0].category));
    assert.deepEqual([...document.querySelectorAll('#results [data-course]')].map(card => card.getAttribute('data-course')),
      courses.map(c => c.id));
    assert.ok(document.querySelector('.essentials [data-course="engineering-git"]'), 'essentials retain their existing presentation');
    const window = document.defaultView!;
    (window as any).acquireVsCodeApi = () => ({postMessage: () => {}});
    window.eval(document.querySelector('script')!.textContent!);
    document.querySelector<HTMLButtonElement>('.essentials button[data-path]:not([data-path=""])')!.click();
    assert.ok([...document.querySelectorAll<HTMLElement>('.essentials .course')].every(c => !c.hidden),
      'a path in one essentials group does not hide another group');
    const search = document.querySelector<HTMLInputElement>('#search')!;
    search.dispatchEvent(new window.Event('input'));
    assert.ok([...document.querySelectorAll<HTMLElement>('.essentials .course')].every(c => c.style.order === ''),
      'search restores database order after a suggested path');
    window.close();
  }
});

test('the next chapter is the one in progress, else the first open uncovered one, and never invented', () => {
  const open = () => true;
  const chapters = [{id:'a', progress:coverage('covered')}, {id:'b', progress:coverage('not_started')}, {id:'c', progress:coverage('in_progress')}];
  assert.equal(nextChapter(chapters, open)?.id, 'c');
  assert.equal(nextChapter(chapters, ch => ch.id !== 'c')?.id, 'b', 'a locked chapter is skipped');
  assert.equal(nextChapter([{id:'a', progress:coverage('covered')}], open), undefined, 'a finished course has no next chapter');
  const unstarted: {id: string; progress?: undefined}[] = [{id:'a'}, {id:'b'}];
  assert.equal(nextChapter(unstarted, open), undefined, 'without saved progress nothing is recommended');
});

test('a returning learner resumes from the top of Course Catalog in one click; a visitor sees how to start', async () => {
  const {catalog, document} = render('learner', [course('new', false, ['', '', '']), course('py', true, ['covered', 'in_progress', 'not_started'])]);
  const resume = document.querySelector('section.resume')!;
  assert.ok(resume, 'Continue learning comes first');
  assert.ok(resume.compareDocumentPosition(document.querySelector('#results')!) & 4, 'it precedes the catalog');
  assert.match(resume.textContent!, /Pick up: py chapter 1/);
  assert.match(resume.textContent!, /1 of 3 chapters covered/);
  assert.equal(resume.querySelector('progress')!.getAttribute('value'), '1');
  const button = resume.querySelector<HTMLButtonElement>('button[data-action="practice"]')!;
  assert.equal(button.dataset.id, 'py');
  await catalog.handle({type:'practice', id:'py'});
  assert.deepEqual(executed.at(-1), ['dhimantai.openLearningRoom', 'Course py', 'py-1'], 'Continue opens that exact chapter');
  assert.equal(document.querySelector('.course[data-course="py"] s'), null, 'covered chapters are checked, not struck through');
  assert.deepEqual([...document.querySelectorAll('.course[data-course] h3')].map(h => h.textContent), ['Course new', 'Course py']);
  assert.equal(document.querySelectorAll('.course h2').length, 0, 'card titles sit below their section heading');

  const visitor = render(undefined, [course('new', false, ['', ''])]).document;
  assert.equal(visitor.querySelector('section.resume'), null);
  assert.match(visitor.querySelector('section.intro')!.textContent!, /free first chapter/);
  assert.ok(visitor.querySelector('section.intro button[data-action="signUp"]'));
  assert.ok(visitor.querySelector('main details.how'), 'access and runtime policy stays one click away');
  assert.match(visitor.querySelector('details.how')!.textContent!, /Search commands/);
});

test('signed-in learners have a visible sign-out action in the catalog', async () => {
  const {catalog, document} = render('learner', []);
  assert.ok(document.querySelector('header [data-action="signOut"]'));
  await catalog.handle({type:'signOut'});
  assert.deepEqual(executed.at(-1), ['dhimantai.signOut']);
  assert.equal(render(undefined, []).document.querySelector('[data-action="signOut"]'), null);
});

test('ERPNext resumes in the browser with the Instructor and shows checked tasks apart from chapter coverage', () => {
  const erp = course('erpnext-essentials', true, ['covered', 'in_progress', 'not_started']);
  const without = render('learner', [erp]);
  assert.equal(without.document.querySelector('.resume-card button')?.getAttribute('data-action'), 'browserCourse',
    'Continue learning opens ERPNext beside the Instructor, not the Instructor alone');
  assert.equal(without.document.querySelector('[data-browser-course] progress'), null, 'no checked tasks: no practice bar');
  const {catalog} = render('learner', [erp]);
  catalog.browserProgress = (environment: string, account: string) => environment === 'production' && account === 'learner' ? 3 : 0;
  catalog.render(catalog.selection.catalog, '');
  const document = new JSDOM(catalog.panel.webview.html).window.document;
  const card = document.querySelector('[data-browser-course="erpnext-essentials"]')!;
  assert.equal(card.querySelector('progress')?.getAttribute('value'), '3');
  assert.match(card.textContent!, /3 of 18 tasks done: saved work checked in ERPNext and explained/);
  assert.match(card.querySelector('.actions button')!.textContent!, /Continue course/);
});
