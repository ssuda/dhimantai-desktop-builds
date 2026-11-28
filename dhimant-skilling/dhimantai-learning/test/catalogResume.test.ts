import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { nextChapter } from '../src/courseProgress';
import type { LearningOffer } from '../src/learnerCatalog';

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
function render(account: string | undefined, courses: any[], offers: LearningOffer[] = []) {
  const catalog: any = Object.create(CourseCatalog.prototype);
  Object.assign(catalog, {panel:{webview:{html:''}}, sequence:0, awaitingPayment:false, projects:[], studyCourses:new Set(), companions:[],
    environment:() => 'production', selection:{environment:'production', account, catalog:{individual:true, courses, offers}}});
  catalog.render(catalog.selection.catalog, '');
  return {catalog, document:new JSDOM(catalog.panel.webview.html, {runScripts:'outside-only'}).window.document};
}

test('Starting a chapter shows progress on the clicked card and ignores repeat clicks until the host settles', () => {
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
  assert.equal(start.textContent, 'Start chapter 1');
  assert.equal(start.disabled || other.disabled, false);
  win.close();
});

test('interleaved Essentials share one section and path selector, preserving order within each group', () => {
  const courses = [
    course('custom', false, [''], {category:'New category'}),
    course('engineering-git', false, ['']), course('java', false, ['']),
    course('engineering-sql-data', false, ['']), course('python', false, ['']),
    course('agents', false, [''], {category:'AI & Machine Learning'}),
  ];
  const {document} = render(undefined, courses);
  const win = document.defaultView!;
  (win as any).acquireVsCodeApi = () => ({postMessage() {}});
  win.eval(document.querySelector('script')!.textContent!);
  const chip = (category: string) => document.querySelector<HTMLButtonElement>(`.type-chip[data-browse-category="${category}"]`)!;
  assert.equal(document.querySelector<HTMLElement>('#catalog-explore')!.hidden, true);
  chip('Engineering Essentials').click();
  const visible = () => [...document.querySelectorAll<HTMLElement>('#results [data-course]')].map(el => el.dataset.course);
  assert.deepEqual(visible(), ['engineering-git','engineering-sql-data']);
  document.querySelector<HTMLButtonElement>('[data-path="engineering-sql-data"]')!.click();
  assert.deepEqual(visible(), ['engineering-sql-data']);
  chip('Software Engineering').click();
  assert.deepEqual(visible(), ['java','python']);
  chip('type:project').click();
  assert.equal(document.querySelector('#results [data-course]'), null);
  assert.ok(document.querySelector('#results [data-project]'));
  win.close();
});

test('Explore pages all courses including resumed ones and restores filters and page size', () => {
  const courses = Array.from({length:31}, (_, i) => course(String(i), i < 3, ['in_progress'], {is_free:i < 26}));
  let state: unknown;
  const open = () => {
    const {document} = render('learner', courses);
    const win = document.defaultView!;
    (win as any).acquireVsCodeApi = () => ({postMessage() {}, getState:() => state, setState:(s: unknown) => {state = s;}});
    win.eval(document.querySelector('script')!.textContent!);
    return {win, document, more:document.querySelector<HTMLButtonElement>('#more-results')!};
  };
  const first = open();
  first.document.querySelector<HTMLButtonElement>('[data-browse-price=free]')!.click();
  assert.equal(first.document.querySelector('#result-count')!.textContent, 'Showing 24 of 26 results');
  assert.equal(first.document.querySelector('#results [data-course="0"]')?.getAttribute('data-enrolled'), 'true');
  first.more.click();
  assert.equal(first.document.querySelectorAll('#results .course').length, 26);
  first.win.close();
  const restored = open();
  assert.equal(restored.document.querySelector<HTMLElement>('#catalog-explore')!.hidden, false);
  assert.equal(restored.document.querySelectorAll('#results .course').length, 26);
  assert.equal(restored.more.hidden, true);
  restored.win.close();
});

test('a bundle shows its full membership and savings only when standalone prices are comparable', () => {
  const courseIds = ['a','b','c','d'];
  const courses = courseIds.map(id => course(id, false, ['']));
  const single = courseIds.map(id => ({id, course_ids:[id], title:id, owned:false, amount:10000, currency:'INR'}));
  const pack = {...single[0], id:'pack', course_ids:courseIds, amount:30000};
  for (const prices of [single, single.slice(1), [{...single[0], currency:'USD'}, ...single.slice(1)]]) {
    const {document} = render(undefined, courses, [...prices, pack]);
    const card = document.querySelector('[data-bundle="pack"]')!;
    assert.equal(card.querySelector('.price')!.textContent, '₹300');
    assert.equal(card.querySelector('.save')?.textContent, prices === single ? 'Save ₹100' : undefined);
    assert.equal(card.querySelector('details .members li')!.textContent, 'Course d');
    document.defaultView!.close();
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
  assert.deepEqual([...document.querySelectorAll('[data-project]')].map(card => card.getAttribute('data-project')), ['course-agent', 'shelf', 'market-checkout', 'field-dispatch','parcel-pickup','museum-entry','workshop-enrolment','trail-log','print-batches','ferry-fares','meter-blocks','festival-desk','orchard-deliveries']);
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
  assert.match(resume.textContent!, /Chapter 2 · py chapter 1/);
  assert.equal(resume.querySelector('button')!.textContent, 'Resume chapter 2');
  assert.equal(resume.querySelector('progress')!.getAttribute('value'), '1');
  const button = resume.querySelector<HTMLButtonElement>('button[data-action="practice"]')!;
  assert.equal(button.dataset.id, 'py');
  await catalog.handle({type:'practice', id:'py'});
  assert.deepEqual(executed.at(-1), ['dhimantai.openLearningRoom', 'Course py', 'py-1'], 'Continue opens that exact chapter');
  assert.equal(document.querySelector('.course[data-course="py"] s'), null, 'covered chapters are checked, not struck through');
  assert.deepEqual([...document.querySelectorAll('.course[data-course] h3')].map(h => h.textContent), ['Course new', 'Course py']);
  assert.equal(document.querySelectorAll('.course h2').length, 0, 'card titles sit below their section heading');

  const visitor = render(undefined, [course('new', false, ['', ''])]).document;
  assert.equal(visitor.querySelector('#home-title')?.textContent, 'Choose your first lesson');
  assert.equal(visitor.querySelector('section.resume'), null);
  assert.match(visitor.querySelector('section.intro')!.textContent!, /Start chapter 1/);
  assert.equal(visitor.querySelector<HTMLButtonElement>('section.intro button[data-action="signUp"]')?.dataset.id,'new');
  assert.ok(visitor.querySelector('.catalog-help [aria-controls=course-guide]'), 'access and runtime policy stays one click away');
  assert.match(visitor.querySelector('#guide-learning')!.textContent!, /Find a Command/);
});

test('starter goals offer only courses whose first chapter a new learner can open', () => {
  const courses = [course('data-science-python',false,['']),
    course('c-programming',false,[''],{expired:true}),
    course('ai-at-work',false,[''],{unlocked:false,chapters:[{id:'locked',name:'Locked',free:false},{id:'free',name:'Later',free:true}]})];
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
    assert.equal(document.querySelector('dialog.course-preview footer button')?.getAttribute('data-action') ?? null, action);
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
  assert.match(card.querySelector('.actions button')!.textContent!, /Resume guided tour/);
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
  assert.ok(document.querySelector('#results [data-course="python"]'));
  window.close();
});

test('catalog types share one result count, query, difficulty and learning status filter', () => {
  const offer = (id: string, ids: string[], owned = false) => ({id, title:id, course_ids:ids, amount:1000, currency:'INR', owned});
  const {document} = render('learner', [
    course('python', false, [''], {title:'Python', category:'Programming'}),
    course('sql', true, ['covered'], {title:'SQL', level:'Advanced'}),
  ], [offer('Python price', ['python']), offer('Data pack', ['python','sql'], true), offer('Other pack', ['sql','missing'])]);
  const win = document.defaultView!;
  (win as any).acquireVsCodeApi = () => ({postMessage() {}});
  win.eval(document.querySelector('script')!.textContent!);
  const select = (id: string, value: string) => {
    const control = document.querySelector<HTMLSelectElement>('#filter-' + id)!;
    control.value = value;
    assert.equal(control.value, value);
    control.dispatchEvent(new win.Event('change'));
  };
  const search = (value: string) => {
    const input = document.querySelector<HTMLInputElement>('#search')!;
    input.value = value;
    input.dispatchEvent(new win.Event('input'));
  };
  const check = (ids: string[], noun: string) => {
    const cards = [...document.querySelectorAll<HTMLElement>('#results .course:not([hidden])')];
    assert.deepEqual(cards.map(({dataset:d}) => d.course ?? d.project ?? d.browserCourse ?? d.bundle), ids);
    assert.ok(cards.every(card => !card.closest('[hidden]')));
    assert.equal(document.querySelector('#result-count')!.textContent, ids.length + ' matching ' + noun);
    assert.equal(document.querySelector<HTMLElement>('#empty')!.hidden, ids.length > 0);
  };
  const all = ['python','sql','erpnext-essentials','course-agent','shelf','market-checkout','field-dispatch','parcel-pickup','museum-entry','workshop-enrolment','trail-log','print-batches','ferry-fares','meter-blocks','festival-desk','orchard-deliveries','Data pack','Other pack'];
  document.querySelector<HTMLButtonElement>('[data-view=explore]')!.click();
  check(all, 'results');
  select('category', 'type:course');
  check(['python','sql','erpnext-essentials'], 'courses');
  select('category', 'Programming');
  check(['python'], 'course');
  select('category', 'type:project');
  check(['course-agent','shelf','market-checkout','field-dispatch','parcel-pickup','museum-entry','workshop-enrolment','trail-log','print-batches','ferry-fares','meter-blocks','festival-desk','orchard-deliveries'], 'projects');
  select('level', 'Intermediate');
  select('status', 'available');
  check(['course-agent','field-dispatch','parcel-pickup','museum-entry','workshop-enrolment','trail-log','print-batches','ferry-fares','meter-blocks','festival-desk','orchard-deliveries'], 'projects');
  select('category', 'type:bundle');
  check([], 'bundles');
  select('level', 'Advanced');
  check(['Data pack','Other pack'], 'bundles');
  select('status', 'enrolled');
  check(['Data pack'], 'bundle');
  search('Python');
  check(['Data pack'], 'bundle');
  select('status', 'covered');
  check([], 'bundles');
  search('');
  select('status', '');
  select('level', '');
  select('category', '');
  check(all, 'results');
  assert.equal(document.querySelectorAll('#results [data-bundle]').length, 2);
  win.close();
});

test('the course guide uses actual access periods and selects only accessible course containers', async () => {
  const active = course('python', true, [''], {access_days:30, access_until:'2027-02-18T12:00:00Z'});
  const {catalog, document} = render('learner', [active, course('java', false, [''], {access_days:90})]);
  assert.match(document.querySelector('.access-facts')!.textContent!, /30–90 days/);
  assert.match(document.querySelector('#guide-access details')!.textContent!, /Course python.*18 Feb 2027/);
  document.defaultView!.close();
  const same = render(undefined, [active]).document;
  assert.match(same.querySelector('.access-facts')!.textContent!, /30 days/);
  same.defaultView!.close();

  catalog.auth = {session:async () => ({user:{id:'learner'}})};
  catalog.selection.lessons = [
    {name:'Python', chapters:[{id:'first'}]},
    {name:'Expired', chapters:[{expired:true}]},
    {name:'ERPNext Essentials', chapters:[{id:'first'}]},
  ];
  const events: any[] = [];
  catalog.panel.webview.postMessage = (message: any) => events.push(message);
  catalog.preparedCourses = () => new Set(['Python','Expired','Another account']);
  await catalog.handle({type:'getPreparedCourses'});
  assert.deepEqual(events.pop(), {type:'preparedCourses', names:['Python']});
  catalog.render(catalog.selection.catalog);
  const dom = new JSDOM(catalog.panel.webview.html, {runScripts:'outside-only'});
  const w = dom.window, doc = w.document;
  const sent: any[] = [];
  (w as any).acquireVsCodeApi = () => ({postMessage:(m: any) => sent.push(m)});
  w.eval(doc.querySelector('script')!.textContent!);
  assert.deepEqual([...doc.querySelectorAll('#guide-course option')].map(x => x.textContent), ['Python']);
  const setup = doc.querySelector<HTMLButtonElement>('[data-action=setupCourse]')!;
  setup.click();
  assert.deepEqual([sent[0].type,sent[0].id], ['setupCourse','Python']);

  const original = vscode.commands.executeCommand;
  let finish!: (result?: any) => void;
  const commands: unknown[][] = [];
  vscode.commands.executeCommand = (...args) => {
    commands.push(args);
    return new Promise(resolve => { finish = resolve; });
  };
  try {
    await catalog.handle({type:'setupCourse', id:'Expired'});
    const pending = catalog.handle(sent[0]);
    await catalog.handle(sent[0]);
    assert.deepEqual(commands, [['dhimantai.setupCourse','Python']]);
    assert.ok(events.at(-1).busy);
    w.dispatchEvent(new w.MessageEvent('message', {data:events.at(-1)}));
    assert.equal(setup.disabled, true);
    finish({fsPath:'/test/course'});
    await pending;
    assert.match(events.at(-1).message, /Setup completed for Python/);
    const cancelled = catalog.handle(sent[0]);
    await Promise.resolve();
    finish(); await cancelled;
    assert.match(events.at(-1).message, /did not finish/);
    w.dispatchEvent(new w.MessageEvent('message', {data:events.at(-1)}));
    assert.equal(setup.disabled, false);
  } finally { vscode.commands.executeCommand = original; w.close(); }
});

test('guide actions return a signed-in learner to setup and provide an email fallback for support', async () => {
  const {catalog, document} = render(undefined, []);
  assert.equal(document.querySelector('#guide-code button')?.getAttribute('data-action'), 'signInForSetup');
  document.defaultView!.close();
  const refreshes: boolean[][] = [];
  catalog.auth = {session:async () => ({user:{id:'learner'}})};
  catalog.refresh = async (...args: boolean[]) => { refreshes.push(args); };
  await catalog.handle({type:'signInForSetup'});
  assert.deepEqual(executed.at(-1), ['dhimantai.signIn', 'production']);
  assert.deepEqual(refreshes, [[false,true]]);
  catalog.auth.session = async () => undefined;
  await catalog.handle({type:'signInForSetup'});
  assert.equal(refreshes.length, 1, 'cancelling sign-in keeps the current guide open');

  let link: string | undefined, fallback: string | undefined;
  const host = vscode as any;
  host.Uri = {parse:(url: string) => url};
  host.env.openExternal = async (url: string) => { link = url; return false; };
  catalog.panel.webview.postMessage = (m: any) => { fallback = m.message; };
  try {
    await catalog.handle({type:'support'});
    assert.equal(link, 'mailto:contact@optficial.ai?subject=dhimantAI%20Course%20Support');
    assert.match(fallback!, /contact@optficial.ai/);
  } finally { delete host.env.openExternal; delete host.Uri; }
});

test('free shelves, price filters and direct chapter actions agree across Home and Explore', async () => {
  const free = course('free', false, ['', ''], {is_free:true});
  const partial = course('partial', true, ['covered', 'in_progress', 'not_started'], {unlocked:false});
  const paid = course('paid', true, ['', ''], {unlocked:true});
  const expired = course('expired', true, ['in_progress'], {expired:true, is_free:true});
  const {catalog, document} = render('learner', [free, partial, paid, expired]);
  catalog.selection.lessons = [{name:'Paid syllabus', chapters:paid.chapters}];
  const win = document.defaultView!;
  const messages: any[] = [];
  (win as any).acquireVsCodeApi = () => ({postMessage:(m:any) => messages.push(m)});
  win.eval(document.querySelector('script')!.textContent!);
  assert.deepEqual([...document.querySelectorAll<HTMLElement>('#free-shelf [data-home-course]')].map(c => c.dataset.homeCourse), ['free']);
  const click = (selector:string) => document.querySelector<HTMLButtonElement>(selector)!.click();
  click('[data-browse-price=free]');
  assert.equal(document.querySelector('#results')!.children.length, 2, 'expired free courses are still classified by price in Explore');
  assert.equal(document.querySelector<HTMLButtonElement>('#results [data-course=expired] .actions button')!.disabled, true);
  click('#active-filters button');
  const action = (id:string) => document.querySelector<HTMLButtonElement>(`#results [data-course="${id}"] .actions button`)!;
  assert.equal(action('partial').textContent, 'Review chapter 1', 'a locked in-progress chapter is skipped');
  action('partial').click(); await catalog.handle(messages.pop());
  assert.deepEqual(executed.at(-1), ['dhimantai.openLearningRoom','Course partial','partial-0']);
  action('paid').click(); await catalog.handle(messages.pop());
  assert.deepEqual(executed.at(-1), ['dhimantai.openLearningRoom','Paid syllabus','paid-0'], 'missing coverage still opens a specific chapter');
  win.dispatchEvent(new win.MessageEvent('message',{data:{type:'focusCourse',id:'paid'}}));
  assert.equal(document.querySelector<HTMLDetailsElement>('#results [data-course=paid] [data-course-outline]')!.open,true);
  win.close();
});
