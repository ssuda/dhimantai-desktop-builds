import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { exportRecords, nextLevel, ProblemRecord, record, trend, trendText, validRecords } from '../src/helpRecord';
import { questionMarkdown } from '../src/practiceNotebook';

const open = (id: string) => ({type: 'open' as const, id, title: 'Reverse words', language: 'python'});

test('the help ladder climbs one rung per fresh try and restarts when the samples pass', () => {
  let r: ProblemRecord[] = record([], open('a'), 0);
  const at = () => nextLevel(r.find(x => x.id === 'a'));
  assert.deepEqual(at(), {level: 1, waiting: false}, 'help starts with a question');
  r = record(r, {type: 'help', id: 'a', level: 1}, 1);
  assert.deepEqual(at(), {level: 1, waiting: true}, 'no stronger help until the learner tries again');
  r = record(r, {type: 'run', id: 'a'}, 2);
  assert.deepEqual(at(), {level: 2, waiting: false});
  for (const level of [2, 3, 4]) { r = record(r, {type: 'help', id: 'a', level}, 3); r = record(r, {type: 'run', id: 'a'}, 4); }
  assert.deepEqual(at(), {level: 4, waiting: false}, 'the top rung is a similar example, never the solution');
  r = record(r, {type: 'samples', id: 'a', passed: 1, total: 2}, 5);
  assert.equal(at().level, 4, 'a partial pass keeps the episode open');
  r = record(r, {type: 'samples', id: 'a', passed: 2, total: 2}, 6);
  assert.deepEqual(at(), {level: 1, waiting: false}, 'the next stuck moment starts small again');
  assert.deepEqual(r[0].solved, {at: 6, help: 4, maxLevel: 4});
  r = record(r, {type: 'help', id: 'a', level: 1}, 7);
  r = record(r, {type: 'samples', id: 'a', passed: 2, total: 2}, 8);
  assert.equal(r[0].solved!.at, 6, 'the first solve is the one that counts');
  assert.equal(record([], {type: 'run', id: 'unknown'}).length, 0, 'events for unopened problems are ignored');
});

test('the trend counts recent problems solved without any help', () => {
  let r: ProblemRecord[] = [];
  const minute = 60000;
  for (const [id, helped] of [['p1', true], ['p2', false], ['p3', true], ['p4', false], ['p5', false], ['p6', false]] as const) {
    const start = r.length * 100 * minute;
    r = record(r, open(id), start);
    if (helped) r = record(r, {type: 'ask', id}, start + minute);
    r = record(r, {type: 'run', id}, start + 2 * minute);
    r = record(r, {type: 'samples', id, passed: 1, total: 1}, start + 10 * minute);
  }
  const t = trend(r);
  assert.equal(t.solved, 5, 'only the last five solved problems');
  assert.equal(t.independent, 4);
  assert.deepEqual(t.levels, [0, 0, 0, 0, 0], 'free questions are help, but not ladder rungs');
  assert.equal(t.medianMinutesToSolve, 10);
  assert.equal(trendText(t), 'Last 5 solved: 4 without help.');
  assert.match(trendText(trend([])), /start your record/);
});

test('an exported record holds counts and times only, and stored data is validated', () => {
  let r = record([], open('a'), 0);
  r = record(r, {type: 'run', id: 'a'}, 30000);
  r = record(r, {type: 'help', id: 'a', level: 2}, 40000);
  r = record(r, {type: 'samples', id: 'a', passed: 1, total: 1}, 90000);
  const out = exportRecords(r);
  assert.equal(out.format, 'dhimantai-practice-record/1');
  assert.deepEqual(out.problems[0].solved, {secondsToSolve: 90, helpBeforeSolve: 1, highestLevel: 2, independent: false});
  assert.equal(out.problems[0].secondsToFirstRun, 30);
  assert.deepEqual(Object.keys(out.problems[0]).sort(), ['id','ladder','language','opened','otherAsks','runs','secondsToFirstRun','solved','title']);
  assert.deepEqual(validRecords([null, {id: 1}, ...r, 'x']), r);
  assert.deepEqual(validRecords('nope'), []);
});

test('a Practice task reads as a heading with literal examples, without changing the question text', () => {
  const question = 'Reverse words\n\nRead words and print them reversed.\n\nExample input\n\nred green\n\nExpected output\n\ngreen red';
  assert.equal(questionMarkdown(question, 'Reverse words'),
    '### Reverse words\n\nRead words and print them reversed.\n\n**Example input**\n\n```text\nred green\n```\n\n**Expected output**\n\n```text\ngreen red\n```');
  assert.equal(questionMarkdown('Plain brief with no examples.', 'Other'), 'Plain brief with no examples.');
  assert.doesNotMatch(questionMarkdown('T\n\nInput\n\n```js\nx\n```', 'T'), /```text/, 'an existing fence is kept');
});
