import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';
import type { CourseDataset } from '../src/dataLab';
import { emptyNotebook } from '../src/tutorNotebook';

const attack = '<img src=x onerror="window.pwned=1">';
const shop: CourseDataset = {id: 'sample:shop', title: 'Shop', source: 'sample',
  about: {title: 'Shop: Sahyadri Daily Needs', summary: 'Six branches.', gaps: ['There is no cost price.'], try: ['Which branch sold the most in May?'],
    tables: [{name: 'sales', description: 'One row per sale.', columns: {amount: 'Rupees'}}]},
  tables: [{name: 'branches', row_count: 6, columns: [{name: 'branch_id', type: 'integer'}, {name: 'branch_name', type: 'text'}], sample_rows: [[1, 'Pune']]},
    {name: 'sales', row_count: 900, columns: [{name: 'sale_id', type: 'integer'}, {name: 'amount', type: 'numeric'}], sample_rows: [[1, 10]]}]};
const school: CourseDataset = {id: 'sample:school', title: 'School', source: 'sample', about: {title: 'School', summary: 'Classes 8 to 10.'},
  tables: [{name: 'attendance', row_count: 9, columns: [{name: 'days_present', type: 'integer'}], sample_rows: []}]};

async function notebookRoom() {
  const dom = new JSDOM('<button id="wide"></button><button id="latest"></button><button id="tutor"></button><button id="doubt_solver"></button><button id="end" disabled></button><button id="sound"></button><span id="status"></span><small id="notebook-save-status"></small><input id="follow-code" type="checkbox" checked><input id="stuck-hints" type="checkbox"><small id="code-observer-status"></small><main id="feed"></main><form id="composer"><small id="composer-context" hidden></small><div id="attachments"></div><textarea id="message"></textarea><button id="send"></button><button type="button" id="teach-back" disabled></button><button id="video"></button><button type="button" id="import-data" hidden></button></form>',
    {runScripts: 'outside-only', url: 'https://webview.example', pretendToBeVisual: true});
  const w = dom.window, sent: any[] = [], chats: any[] = [];
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  const agent = {identity: 'worker', isAgent: true, trackPublications: new Map()};
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {sendText: async (text: string) => { chats.push(text); }, registerRpcMethod() {}, performRpc: async () => 'ok'};
    on(name: string, fn: Function) { this.listeners.set(name, fn); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const events = ['TrackPublished', 'TrackSubscribed', 'TrackUnsubscribed', 'DataReceived', 'ParticipantDisconnected', 'Disconnected', 'Reconnecting', 'Reconnected'];
  (w as any).LivekitClient = {Room, RoomEvent: Object.fromEntries(events.map(n => [n, n]))};
  (w as any).acquireVsCodeApi = () => ({postMessage: (m: any) => sent.push(JSON.parse(JSON.stringify(m)))});
  (w as any).TextDecoder = TextDecoder; (w as any).TextEncoder = TextEncoder;
  w.Range.prototype.getClientRects = () => [] as any;
  w.Range.prototype.getBoundingClientRect = () => ({left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0}) as any;
  const post = (data: object) => w.dispatchEvent(new w.MessageEvent('message', {data, origin: w.location.origin}));
  const tick = () => new Promise(r => setTimeout(r, 0));
  w.eval(readFileSync(resolve(__dirname, '../../media/learning-room/room.js'), 'utf8'));
  post({type: 'openTutor'});
  selectLesson(w, sent.at(-1).attempt);
  const attempt = sent.at(-1).attempt;
  return {w, sent, chats, post, tick, attempt, feed: w.document.getElementById('feed')!, field: w.document.querySelector<HTMLTextAreaElement>('#message')!,
    async start(notebook = emptyNotebook()) {
      post({type: 'restoreNotebook', attempt, documentKey: 'doc', notebook});
      post({type: 'grant', attempt, url: 'unused', token: 'unused', chapterId});
      await tick(); await tick();
    },
    async ask(text: string) {
      const field = w.document.querySelector<HTMLTextAreaElement>('#message')!;
      field.value = text; field.dispatchEvent(new w.Event('input'));
      w.document.getElementById('send')!.click();
      await tick();
    },
    saved: () => sent.filter(m => m.type === 'notebookChanged').at(-1)?.notebook};
}

test('with course data ready, a data question goes the data route; any other question goes to the live Instructor as before', async () => {
  const room = await notebookRoom();
  await room.start();
  await room.ask('What is a prompt?');
  assert.equal(room.chats.at(-1), 'What is a prompt?', 'without course data the composer behaves exactly as today');
  room.post({type: 'courseData', attempt: room.attempt, state: 'ready', datasets: [shop, school]});
  assert.match(room.w.document.getElementById('course-data-status')!.textContent!, /^Course data ready: shop, school$/);
  const info = room.feed.lastElementChild!;
  assert.match(info.textContent!, /Your data stays on this computer\. When you ask about it, only your question, the column names, up to 5 example rows per table and up to 50 result rows/);
  assert.match(info.textContent!, /There is no cost price/, 'the about cards are readable in the notebook');
  assert.equal(room.w.document.getElementById('import-data')!.hidden, false, 'an own file can be imported beside the samples');
  const count = room.feed.querySelectorAll('article').length;
  room.post({type: 'courseData', attempt: room.attempt, state: 'ready', datasets: [shop, school]});
  assert.equal(room.feed.querySelectorAll('article').length, count);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(room.saved().cells.filter((c: any) => c.packet?.data_part === 'info').length, 1, 'the privacy note and about cards are shown once');

  await room.ask('Tell me more about the lesson.');
  assert.equal(room.chats.at(-1), 'Tell me more about the lesson.', 'a question that does not mention the data stays a normal turn');
  room.field.value = 'Which branch sold the most?'; room.field.dispatchEvent(new room.w.Event('input'));
  assert.equal(room.w.document.getElementById('data-route')!.hidden, false, 'the composer says the question goes the data route');
  const chatsBefore = room.chats.length;
  room.w.document.getElementById('send')!.click(); await room.tick();
  const ask = room.sent.at(-1);
  assert.equal(ask.type, 'dataAsk');
  assert.equal(ask.question, 'Which branch sold the most?');
  assert.equal(ask.chapterId, chapterId);
  assert.equal(room.chats.length, chatsBefore, 'nothing went to the live session');

  room.field.value = 'Which branch sold the most?'; room.field.dispatchEvent(new room.w.Event('input'));
  room.post({type: 'dataReply', attempt: room.attempt, request: ask.request, datasets: ['sample:shop'], outcome: {kind: 'answer', dataset: 'sample:shop',
    steps: `Steps: add up ${attack} by branch.`, sql: `SELECT branch_name, '${attack}' FROM sales`, retried: false,
    result: {columns: ['branch_name', attack], rows: [['Pune', attack], [attack, 20], ['Nashik', null]], row_count: 3, truncated: false, milliseconds: 2},
    answer: {answer: attack, evidence: ['Pune ' + attack], caveats: [attack], check_question: 'Add up ' + attack}}});
  await room.tick();
  const cards = [...room.feed.querySelectorAll('article')].slice(-6);
  assert.deepEqual(cards.map(c => [...c.querySelector('[class*="data-"]')?.classList ?? []].find(k => k.startsWith('data-') && k !== 'data-cell') ?? 'message'),
    ['message', 'data-steps', 'data-sql', 'data-result', 'data-answer', 'data-check'], 'steps, then how I got this, result, answer, check it yourself');
  const sql = cards[2].querySelector('details')!;
  assert.equal(sql.open, false, 'the query is collapsed by default');
  assert.match(sql.querySelector('code')!.textContent!, /SELECT branch_name/);
  assert.match(cards[3].textContent!, /3 rows/);
  assert.equal(cards[3].querySelectorAll('tbody tr').length, 3);
  assert.equal(cards[3].querySelector('tr.evidence td')!.textContent, 'Pune', 'the evidence rows are highlighted');
  assert.equal(room.w.document.querySelectorAll('img').length, 0, 'no value becomes HTML');
  assert.equal((room.w as any).pwned, undefined);
  assert.ok(cards[3].textContent!.includes(attack) && cards[4].textContent!.includes(attack));
  assert.equal(room.field.value, '', 'the answered question leaves the composer');
  cards[4].querySelector<HTMLButtonElement>('[data-copy-evidence]')!.click();
  const copy = room.sent.at(-1);
  assert.equal(copy.type, 'dataCopy');
  assert.match(copy.text, /### Question\nWhich branch sold the most\?/);
  assert.match(copy.text, /### Check it yourself/);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(room.saved().dataset, 'sample:shop', 'the notebook remembers the data it used last');

  await room.ask('And by product in the sales table?');
  const next = room.sent.at(-1);
  assert.equal(next.last, 'sample:shop');
  assert.deepEqual(next.history, [{question: 'Which branch sold the most?', sql: `SELECT branch_name, '${attack}' FROM sales`}], 'history carries question and query pairs');
  room.post({type: 'dataReply', attempt: room.attempt, request: next.request, outcome: {kind: 'reply', content: 'What do you mean by **product**?'}});
  await room.tick();
  const reply = room.feed.lastElementChild!;
  assert.ok(reply.querySelector('strong'), 'a reply without a query is a normal Coach reply');
  assert.doesNotMatch(reply.textContent!, /did not run|cannot answer/);

  await room.ask('What profit did the shop make?');
  room.post({type: 'dataReply', attempt: room.attempt, request: room.sent.at(-1).request, outcome: {kind: 'cannot', text: 'The data cannot answer this. It needs a cost price for each product.'}});
  await room.tick();
  assert.match(room.feed.lastElementChild!.textContent!, /The data cannot answer this.*It needs a cost price/s);

  await room.ask('Which branch sold the most in the shop?');
  room.post({type: 'dataReply', attempt: room.attempt, request: room.sent.at(-1).request, outcome: {kind: 'sqlError', dataset: 'sample:shop', steps: '',
    sql: 'SELECT nope FROM sales', plain: 'The query uses a column called "nope", which this data does not have.', raw: 'column "nope" does not exist'}});
  await room.tick();
  assert.match(room.feed.lastElementChild!.textContent!, /column called "nope".*tried once more/s, 'after the retry the error is shown plainly');

  await room.ask('Which branch sold the most in the shop?');
  room.post({type: 'dataReply', attempt: room.attempt, request: room.sent.at(-1).request, quota: true, error: 'You have used today\'s Coach questions. The allowance resets tomorrow.'});
  await room.tick();
  assert.match(room.w.document.getElementById('status')!.textContent!, /allowance resets tomorrow/);
  assert.equal(room.field.value, 'Which branch sold the most in the shop?', 'the question stays in the composer');
  room.w.document.getElementById('send')!.click(); await room.tick();
  room.post({type: 'dataReply', attempt: room.attempt, request: room.sent.at(-1).request, accessEnded: true, error: 'Access ended · Buy again. Your course access has ended.'});
  await room.tick();
  const notice = room.w.document.getElementById('access-notice')!;
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent!, /Access ended · Buy again/);
  notice.querySelector('button')!.click();
  assert.equal(room.sent.at(-1).type, 'courseCatalog');
});

test('an imported file shows as a removable chip and is remembered by the notebook', async () => {
  const room = await notebookRoom();
  await room.start({...emptyNotebook(), dataImports: ['old_file']});
  room.post({type: 'courseData', attempt: room.attempt, state: 'ready', datasets: [shop]});
  const chips = () => [...room.w.document.querySelectorAll('#data-chips .attachment')].map(c => c.textContent);
  assert.deepEqual(chips(), ['Data: old_file ×'], 'a saved import comes back with the notebook');
  room.w.document.getElementById('import-data')!.click();
  assert.equal(room.sent.at(-1).type, 'dataImport');
  room.post({type: 'dataPreview', attempt: room.attempt, plan: {fileName: attack, table: 'fees', columns: [{name: 'amount', original: attack, type: 'integer'}],
    preview: [[attack]], total: 1, notes: [attack]}});
  const preview = room.w.document.querySelector('.data-preview')!;
  assert.ok(preview.textContent!.includes(attack));
  assert.equal(room.w.document.querySelectorAll('img').length, 0);
  [...preview.querySelectorAll('button')].find(b => b.textContent === 'Create table')!.click();
  assert.equal(room.sent.at(-1).type, 'dataConfirmImport');
  room.post({type: 'dataImported', attempt: room.attempt, dataset: {id: 'import:fees', title: 'fees.csv', source: 'import', about: {title: 'fees.csv', summary: ''},
    tables: [{name: 'fees', row_count: 1, columns: [{name: 'amount', type: 'integer'}], sample_rows: []}]}});
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(chips(), ['Data: old_file ×', 'Data: fees.csv ×']);
  assert.deepEqual(room.saved().dataImports, ['old_file', 'fees']);
  assert.equal(room.saved().dataset, 'import:fees');
  await room.ask('What is the total in fees?');
  assert.equal(room.sent.at(-1).type, 'dataAsk', 'a question naming the imported file goes the data route');
  assert.deepEqual(room.sent.at(-1).imports, ['old_file', 'fees']);
  room.post({type: 'dataReply', attempt: room.attempt, request: room.sent.at(-1).request, error: 'x'}); await room.tick();
  room.w.document.querySelector<HTMLButtonElement>('#data-chips button[aria-label="Stop using old_file in this notebook"]')!.click();
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(room.saved().dataImports, ['fees'], 'detaching is saved with the notebook');
  assert.deepEqual(chips(), ['Data: fees.csv ×']);
});
