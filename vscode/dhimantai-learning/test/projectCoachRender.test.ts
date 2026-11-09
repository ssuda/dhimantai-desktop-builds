import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function panel() {
  // Use the actual renderer's HTML, so missing controls fail this test.
  const source = readFileSync(join(__dirname, '../../src/projectCoach.ts'), 'utf8');
  const html = source.slice(source.indexOf('<body>'), source.indexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, {runScripts: 'outside-only'}), sent: any[] = [];
  (dom.window as any).acquireVsCodeApi = () => ({postMessage: (m: unknown) => sent.push(m)});
  dom.window.eval(readFileSync(join(__dirname, '../../media/coachMarkdown.js'), 'utf8'));
  dom.window.eval(readFileSync(join(__dirname, '../../media/projectCoach.js'), 'utf8'));
  const state = {type: 'state', scope: 'owner:project', conversationId: 'first', revision: 1,
    title: 'Project', steps: ['One'], step: 0, current: {files: [], expected: ''}, runtime: 'course', courseAvailable: true,
    check: {state: 'not_run'}, sharedFiles: [], omitted: [], ai: true, messages: []};
  const post = (changes = {}) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {data: {...state, ...changes}}));
  return {dom, doc: dom.window.document, post, sent};
}

test('project refresh preserves message nodes, reading position and a draft while appending replies', () => {
  const {dom, doc, post} = panel();
  try {
    const messages = [{role: 'learner', text: 'Why?'}, {role: 'tutor', text: '**Inspect** the tool result.'}];
    post({messages});
    const row = doc.querySelector('.coach'), content = doc.getElementById('projectContent')!;
    Object.defineProperties(content, {scrollHeight: {value: 2000}, clientHeight: {value: 300}});
    content.scrollTop = 400;
    const draft = doc.getElementById('message') as HTMLTextAreaElement;
    draft.value = 'My next question';
    post({messages, revision: 2});
    assert.equal(doc.querySelector('.coach'), row);
    assert.equal(content.scrollTop, 400);
    post({messages: [...messages, {role: 'tutor', text: 'A delayed reply.'}], revision: 3});
    assert.equal(content.scrollTop, 400, 'new replies do not drag someone away from earlier messages');
    assert.equal(draft.value, 'My next question');
    assert.equal(row?.querySelector('strong')?.textContent, 'Coach');
  } finally { dom.window.close(); }
});

test('New chat clears immediately, ignores pending old state, and keeps the new chat empty', () => {
  const {dom, doc, post, sent} = panel();
  try {
    post({messages: [{role: 'tutor', text: 'Previous conversation'}]});
    (doc.getElementById('newChat') as HTMLButtonElement).click();
    assert.equal(doc.getElementById('conversation')!.textContent, '');
    assert.equal(sent.at(-1).conversationId, 'first');
    post({messages: [{role: 'tutor', text: 'Late old reply'}]});
    assert.equal(doc.getElementById('conversation')!.textContent, '');
    post({conversationId: 'second', revision: 2});
    assert.equal((doc.getElementById('newChat') as HTMLButtonElement).disabled, false);
    post({messages: [{role: 'tutor', text: 'Stale queued state'}]});
    assert.equal(doc.getElementById('conversation')!.textContent, '');
    assert.equal(doc.getElementById('emptyChat')!.hidden, false);
    post({conversationId: 'second', revision: 2, finalStep: true, handoffMode: 'teacher', handoffStatus: 'Awaiting teacher review'});
    assert.equal(doc.getElementById('handoff')!.hidden, false);
    assert.match(doc.getElementById('finish')!.textContent!, /Submit project/);
  } finally { dom.window.close(); }
});

test('final submission and optional GitHub actions are explicit and disabled while checking', () => {
  const {dom, doc, post, sent} = panel();
  try {
    post({submissionStep: true, completion: 'Needs work · final check did not pass'});
    assert.equal(doc.getElementById('submission')!.hidden, false);
    assert.match(doc.getElementById('completion')!.textContent!, /Needs work/);
    (doc.getElementById('externalHelp') as HTMLSelectElement).value = 'reported';
    (doc.getElementById('submitProject') as HTMLButtonElement).click();
    assert.equal(sent.at(-1).type, 'submitProject'); assert.equal(sent.at(-1).help, 'reported');
    const actions = doc.getElementById('projectActions') as HTMLSelectElement;
    actions.value = 'publish'; actions.dispatchEvent(new dom.window.Event('change'));
    assert.equal(sent.at(-1).action, 'publish'); assert.equal(actions.value, '');
    post({busy: true, submissionStep: true});
    assert.equal((doc.getElementById('submitProject') as HTMLButtonElement).disabled, true);
    assert.equal(actions.disabled, true);
    post({submissionStep: false}); assert.equal(doc.getElementById('submission')!.hidden, true);
  } finally { dom.window.close(); }
});

test('sharing details distinguish supplied excerpts from a partial path-only map', () => {
  const {dom, doc, post} = panel();
  try {
    post({sharedFiles: ['rich/console.py:1651–1680 (excerpt)'], omitted: ['tests/test_console.py'], omittedCount: 40,
      structure: {files: ['rich/console.py', 'tests/test_console.py'], total_files: 41, truncated: true}});
    const shared = doc.getElementById('shared')!.textContent!;
    assert.match(shared, /rich\/console.py:1651–1680/);
    assert.match(shared, /Content not included \(40 files\)/);
    assert.match(shared, /Project map \(41 public files, partial list\)/);
    assert.match(shared, /more files omitted/);
  } finally { dom.window.close(); }
});

test('milestone navigation shows completion honestly and preserves separate drafts', () => {
  const {dom, doc, post, sent} = panel();
  const button = (id: string) => doc.getElementById(id) as HTMLButtonElement;
  const note = doc.getElementById('note') as HTMLTextAreaElement;
  const completed = doc.getElementById('completed') as HTMLInputElement;
  const steps = ['1. Map', '2. Trace'];
  const milestones = [{status: 'in_progress'}, {status: 'not_started'}];
  try {
    post({steps, milestones, check: {state: 'current', status: 'passed'}});
    assert.equal(button('previous').disabled, true);
    assert.match(doc.getElementById('progressText')!.textContent!, /0\/2 marked complete/);
    assert.equal(completed.checked, false, 'a passing command does not complete a milestone');
    note.value = 'Map draft'; completed.checked = true;
    button('next').click();
    assert.equal(sent.at(-1).index, 1);
    assert.equal(button('next').disabled, true, 'ignore repeated navigation until host responds');
    post({steps, milestones, step: 1, revision: 2});
    assert.equal(note.value, '');
    assert.equal(completed.checked, false);
    assert.equal(button('next').disabled, true, 'last step has no next milestone');
    note.value = 'Trace draft';
    button('previous').click();
    post({steps, milestones, revision: 3});
    assert.equal(note.value, 'Map draft');
    assert.equal(completed.checked, true);
    button('checkpoint').click();
    assert.equal(sent.at(-1).completed, true);
    const checkpoint = {at: '2026-11-09T00:00:00Z', note: 'Map evidence', completed: true, assistance: 2, externalHelp: 'reported'};
    post({steps, milestones: [{status: 'complete'}, {status: 'in_progress'}], checkpoint, revision: 4});
    assert.match(doc.getElementById('progressText')!.textContent!, /1\/2 marked complete/);
    assert.equal((doc.getElementById('progress') as HTMLProgressElement).value, 1);
    assert.match((doc.getElementById('step') as HTMLSelectElement).options[0].text, /self-reported/);
    post({steps, milestones: [{status: 'review'}, {status: 'in_progress'}], checkpoint, revision: 5});
    assert.match(doc.getElementById('progressText')!.textContent!, /0\/2 marked complete · 1 to review/);
    assert.equal(completed.checked, false, 'changed evidence requires an explicit new completion choice');
    assert.equal(note.value, 'Map evidence');
    post({scope: 'another-account', steps, milestones, revision: 6});
    assert.equal(note.value, '', 'drafts do not cross accounts or projects');
    assert.equal(completed.checked, false);
  } finally { dom.window.close(); }
});

test('milestone references expose anchors and help progresses without losing the expected outcome', () => {
  const {dom, doc, post, sent} = panel();
  try {
    post({hintLevel: 1, current: {files: ['shelf/report.py'], anchors: {'shelf/report.py': 'def by_decade('}, expected: 'Groups by decade.'}});
    const file = doc.querySelector('#files button') as HTMLButtonElement;
    assert.match(file.getAttribute('aria-label')!, /by_decade/);
    file.click(); assert.equal(sent.at(-1).path, 'shelf/report.py');
    assert.equal(doc.getElementById('expected')!.textContent, 'Groups by decade.');
    assert.equal(doc.getElementById('hint')!.textContent, 'Try a smaller step');
    post({hintLevel: 2, signedIn: true});
    assert.equal(doc.getElementById('hint')!.textContent, 'Ask Coach for help');
    post({hintLevel: 2, signedIn: true, ai: false});
    assert.equal(doc.getElementById('hint')!.textContent, 'Review next step');
    assert.equal((doc.getElementById('hint') as HTMLButtonElement).disabled, false);
  } finally { dom.window.close(); }
});
