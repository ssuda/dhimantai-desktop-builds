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

test('Start free shows progress on the clicked card and ignores repeat clicks until the host settles', () => {
  const {document} = render('learner', [course('java', false, ['']), course('python', false, [''])]);
  const win = document.defaultView!;
  const messages: any[] = [];
  (win as any).acquireVsCodeApi = () => ({postMessage:(message: any) => messages.push(message)});
  win.eval(document.querySelector('script')!.textContent!);
  const start = document.querySelector<HTMLButtonElement>('[data-course="java"] [data-action="join"]')!;
  const other = document.querySelector<HTMLButtonElement>('[data-course="python"] [data-action="join"]')!;
  start.click();
  win.dispatchEvent(new win.MessageEvent('message', {data:{type:'catalogStatus', message:'Refreshing…', busy:false}}));
  start.click(); other.click();
  assert.equal(start.textContent, 'Starting course…');
  assert.equal(start.getAttribute('aria-busy'), 'true');
  assert.deepEqual(messages.map(m => m.id), ['java']);
  win.dispatchEvent(new win.MessageEvent('message', {data:{type:'courseStartState'}}));
  assert.equal(start.textContent, 'Start free');
  assert.equal(start.disabled || other.disabled, false);
  win.close();
});

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

test('the companion course keeps its lessons while reading project launches are paused', async () => {
  const {document, catalog} = render('learner', [course('engineering-code-reading', true, [''])]);
  assert.ok(document.querySelector('[data-course="engineering-code-reading"] [data-action="practice"]'));
  assert.equal(document.querySelector('[data-action="capstone"]'), null);
  assert.deepEqual([...document.querySelectorAll('[data-project]')].map(card => card.getAttribute('data-project')), ['course-agent', 'shelf']);
  const before = executed.length;
  for (const id of ['shelf-reading', 'rich-reading']) await catalog.handle({type:'project', id});
  await catalog.handle({type:'capstone', id:'engineering-code-reading'});
  assert.equal(executed.length, before);
  document.defaultView!.close();
});

test('one saved shelf workspace can be reopened or started under another eligible course', async t => {
  const {catalog} = render('learner', []);
  t.after(() => { delete (vscode as any).window; });
  catalog.projects = [{projectId:'shelf', root:'/courses/algorithms/shelf-capstone', title:'Shelf', status:'In progress'}];
  for (const choice of [0, 1]) {
    (vscode as any).window = {showQuickPick: async (items: {label:string}[]) => {
      assert.match(items[1].label, /another course/);
      return items[choice];
    }};
    await catalog.handle({type:'project', id:'shelf'});
    assert.deepEqual(executed.at(-1), choice === 0
      ? ['dhimantai.openSavedProject', catalog.projects[0].root] : ['dhimantai.startCapstone', 'shelf']);
  }
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
  assert.equal(visitor.querySelector<HTMLButtonElement>('section.intro button[data-action="signUp"]')?.dataset.id,'new');
  assert.ok(visitor.querySelector('main details.how'), 'access and runtime policy stays one click away');
  assert.match(visitor.querySelector('details.how')!.textContent!, /Search commands/);
});

test('starter goals offer only courses whose first chapter a new learner can open', () => {
  const courses = [course('data-science-python',false,['']),
    course('c-programming',false,[''],{expired:true}),
    course('ai-at-work',false,[''],{chapters:[{id:'locked',name:'Locked',free:false},{id:'free',name:'Later',free:true}]})];
  const {document} = render(undefined,courses);
  const intro = document.querySelector('.intro')!;
  assert.deepEqual([...intro.querySelectorAll<HTMLButtonElement>('button')].map(b => b.dataset.id), ['data-science-python']);
  assert.match(intro.textContent!,/Predict a result from a small sales table/);
  assert.match(intro.textContent!,/Python basics/);
  assert.equal(render('learner',[...courses,course('owned',true,['not_started'])]).document.querySelector('.intro'),null);
});

test('signed-in learners have a visible sign-out action in the catalog', async () => {
  const {catalog, document} = render('learner', []);
  assert.ok(document.querySelector('header [data-action="signOut"]'));
  await catalog.handle({type:'signOut'});
  assert.deepEqual(executed.at(-1), ['dhimantai.signOut']);
  assert.equal(render(undefined, []).document.querySelector('[data-action="signOut"]'), null);
});

test('unavailable progress is never shown as zero completion or a locked next chapter', () => {
  const {document} = render('learner', [course('unknown', true, ['', ''])]);
  const resume = document.querySelector('.resume-card')!;
  assert.match(resume.textContent!, /Progress unavailable/);
  assert.doesNotMatch(resume.textContent!, /0 of 2|Unlock the next/);
  assert.equal(resume.querySelector('progress'), null);
  assert.equal(document.querySelector('[data-course="unknown"] progress'), null);
  document.defaultView!.close();
});

test('a catalog sample requires an available public first chapter and keeps the course entry action', () => {
  const id = 'algorithms-python';
  for (const [account, extra, action] of [
    [undefined, {}, 'signUp'],
    ['learner', {}, 'join'],
    ['learner', {enrolled:true}, 'practice'],
    ['learner', {expired:true, enrolled:true}, null],
    [undefined, {can_join:false}, null],
    [undefined, {chapters:[{id:'paid', name:'Paid chapter', free:false}]}, null],
    [undefined, {is_free:true, chapters:[]}, null],
  ] as const) {
    const {document} = render(account, [course(id, false, [''], extra)]);
    assert.equal(document.querySelector('dialog footer button')?.getAttribute('data-action') ?? null, action);
    assert.equal(!!document.querySelector('#filter-status option[value=preview]'), !!action);
    document.defaultView!.close();
  }
});

test('course outlines distinguish free, unlocked, preview-only and expired access', () => {
  const {document} = render('learner', [
    course('free', true, ['', ''], {is_free:true, unlocked:false}),
    course('paid', true, ['', ''], {unlocked:true}),
    course('preview', true, ['', ''], {unlocked:false}),
    course('expired', true, ['', ''], {is_free:true, unlocked:false, expired:true}),
  ]);
  const labels = (id:string) => [...document.querySelectorAll(`[data-course="${id}"] ol li > small`)].map(el => el.textContent);
  assert.ok(labels('free').every(text => text?.endsWith(' · Free')));
  assert.ok(labels('paid')[1]?.endsWith(' · Unlocked'));
  assert.ok(labels('preview')[0]?.endsWith(' · Free'));
  assert.ok(labels('preview')[1]?.endsWith(' · Locked'));
  assert.ok(labels('expired').every(text => text?.endsWith(' · Locked')));
  document.defaultView!.close();
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
  assert.match(card.querySelector('.actions button')!.textContent!, /Continue guided tour/);
});

test('search ranks titles across categories, excludes incidental Python mentions and restores browsing order', () => {
  const {document} = render(undefined, [
    course('llm', false, [''], {title:'Build an LLM', category:'AI', summary:'Tools include Python.', prerequisites:'Python programming',
      chapters:[{id:'intro', name:'Python setup'}]}),
    course('science', false, [''], {title:'Data Science with Python', category:'AI'}),
    course('algorithms', false, [''], {title:'Algorithms with Python'}),
    course('python', false, [''], {title:'Python Programming'}),
    course('cpp', false, [''], {title:'C++ Programming'}),
    course('c', false, [''], {title:'C Programming'}),
  ]);
  const window = document.defaultView!;
  const messages: unknown[] = [];
  (window as any).acquireVsCodeApi = () => ({postMessage: (message: unknown) => messages.push(structuredClone(message))});
  window.eval(document.querySelector('script')!.textContent!);
  const input = document.querySelector<HTMLInputElement>('#search')!;
  const visible = () => [...document.querySelectorAll<HTMLElement>('#results .course:not([hidden])')];
  const ids = () => visible().map(card => card.dataset.course ?? card.dataset.project ?? card.dataset.browserCourse);
  const search = (query: string) => { input.value = query; input.dispatchEvent(new window.Event('input')); };
  const original = ids();
  search('  pYThOn  ');
  assert.deepEqual(ids(), ['python', 'science', 'algorithms']);
  assert.match(document.querySelector('#result-count')!.textContent!, /^3 matching/);
  visible()[0].querySelector<HTMLButtonElement>('[data-action="signUp"]')!.click();
  assert.deepEqual(messages.pop(), {type:'signUp', id:'python'});
  const category = document.querySelector<HTMLSelectElement>('#filter-category')!;
  category.value = 'AI';
  category.dispatchEvent(new window.Event('change'));
  assert.deepEqual(ids(), ['science']);
  category.value = '';
  category.dispatchEvent(new window.Event('change'));
  search('programming pyth');
  assert.deepEqual(ids(), ['python']);
  search('C++');
  assert.deepEqual(ids(), ['cpp']);
  search('regression test');
  assert.deepEqual(ids(), ['shelf']);
  search('ERPNext');
  assert.deepEqual(ids(), ['erpnext-essentials']);
  search('no matching title');
  assert.deepEqual(ids(), []);
  assert.equal(document.querySelector<HTMLElement>('#empty')!.hidden, false);
  search('');
  assert.deepEqual(ids(), original);
  assert.ok(document.querySelector('.category [data-course="python"]'));
  window.close();
});
