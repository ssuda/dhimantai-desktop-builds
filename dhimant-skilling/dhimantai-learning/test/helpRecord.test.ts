import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { byDifficulty, dueReviews, exportRecords, hardReady, nextExercise, nextLevel, ProblemRecord, progressText, record, REVIEW_DAYS, trend, trendText, validRecords } from '../src/helpRecord';
import { questionMarkdown } from '../src/practiceNotebook';

const open = (id: string) => ({type: 'open' as const, id, title: 'Reverse words', language: 'python'});

test('the help ladder climbs one rung per fresh try and restarts after a full graded pass', () => {
  let r: ProblemRecord[] = record([], open('a'), 0);
  const at = () => nextLevel(r.find(x => x.id === 'a'));
  assert.deepEqual(at(), {level: 1, waiting: false}, 'help starts with a question');
  r = record(r, {type: 'help', id: 'a', level: 1}, 1);
  assert.deepEqual(at(), {level: 1, waiting: true}, 'no stronger help until the learner tries again');
  r = record(r, {type: 'run', id: 'a'}, 2);
  assert.deepEqual(at(), {level: 2, waiting: false});
  for (const level of [2, 3, 4]) { r = record(r, {type: 'help', id: 'a', level}, 3); r = record(r, {type: 'run', id: 'a'}, 4); }
  assert.deepEqual(at(), {level: 4, waiting: false}, 'the top rung is a similar example, never the solution');
  r = record(r, {type: 'graded', id: 'a', passed: 1, total: 2}, 5);
  assert.equal(at().level, 4, 'a partial pass keeps the episode open');
  r = record(r, {type: 'samples', id: 'a', passed: 2, total: 2}, 5);
  assert.equal(r[0].solved, undefined, 'passing the published samples alone is not solving the problem');
  assert.equal(r[0].samplesPassed, 5);
  r = record(r, {type: 'graded', id: 'a', passed: 2, total: 2}, 6);
  assert.deepEqual(at(), {level: 1, waiting: false}, 'the next stuck moment starts small again');
  assert.deepEqual(r[0].solved, {at: 6, help: 4, maxLevel: 4});
  r = record(r, {type: 'help', id: 'a', level: 1}, 7);
  r = record(r, {type: 'graded', id: 'a', passed: 2, total: 2}, 8);
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
    r = record(r, {type: 'graded', id, passed: 1, total: 1}, start + 10 * minute);
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
  r = record(r, {type: 'graded', id: 'a', passed: 1, total: 1}, 90000);
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

test('a run of unchanged code after help does not unlock a stronger hint', () => {
  let r: ProblemRecord[] = record([], open('a'), 0);
  const at = () => nextLevel(r.find(x => x.id === 'a'));
  r = record(r, {type: 'help', id: 'a', level: 1}, 1);
  r = record(r, {type: 'run', id: 'a', edited: false}, 2);
  r = record(r, {type: 'run', id: 'a', edited: false}, 3);
  assert.deepEqual(at(), {level: 1, waiting: true}, 'rerunning the same code is not a new attempt');
  assert.equal(r[0].runs, 2, 'every run still counts as a run');
  r = record(r, {type: 'run', id: 'a', edited: true}, 4);
  assert.deepEqual(at(), {level: 2, waiting: false});
});

test('a first graded pass schedules reviews after 1, 3 and 7 days; an on-time review moves to the next', () => {
  const day = 86_400_000;
  let r: ProblemRecord[] = record([], open('a'), 0);
  r = record(r, {type: 'graded', id: 'a', passed: 3, total: 4}, 10);
  assert.equal(r[0].reviewDue, undefined, 'a partial pass schedules nothing');
  r = record(r, {type: 'graded', id: 'a', passed: 4, total: 4}, 100);
  assert.deepEqual(r[0].reviewDue, REVIEW_DAYS.map(d => 100 + d * day));
  assert.deepEqual(REVIEW_DAYS, [1, 3, 7]);
  assert.deepEqual(dueReviews(r, 100 + day - 1), [], 'nothing is due before a day has passed');
  assert.deepEqual(dueReviews(r, 100 + day).map(x => x.id), ['a']);
  r = record(r, {type: 'graded', id: 'a', passed: 4, total: 4}, 200);
  assert.equal(r[0].reviewDue!.length, 3, 'an early pass is not a review');
  r = record(r, {type: 'graded', id: 'a', passed: 4, total: 4}, 100 + day);
  assert.deepEqual(r[0].reviewDue, [100 + 3 * day, 100 + 7 * day]);
  assert.equal(r[0].solved!.at, 100, 'the first solve stays the one that counts');
  r = record(r, {type: 'samples', id: 'a', passed: 4, total: 4}, 100 + 3 * day);
  assert.equal(r[0].reviewDue!.length, 2, 'samples alone never complete a review');
});

test('a topic lists exercises easiest first, suggests Hard after two independent Mediums and names the next unsolved one', () => {
  const qs = [{id: 'h', title: 'Hard one', difficulty: 'Hard'}, {id: 'm1', title: 'Medium one', difficulty: 'medium'},
    {id: 'e', title: 'Easy one', difficulty: 'easy'}, {id: 'u', title: 'Unrated'}, {id: 'm2', title: 'Medium two', difficulty: 'Medium'}];
  assert.deepEqual(byDifficulty(qs).map(q => q.id), ['e', 'm1', 'u', 'm2', 'h'], 'authored order stands within a difficulty');
  let r: ProblemRecord[] = [];
  for (const id of ['e', 'm1', 'm2']) r = record(r, open(id), 0);
  r = record(r, {type: 'graded', id: 'e', passed: 1, total: 1}, 1);
  assert.equal(nextExercise(qs, r, 'e')?.id, 'm1');
  assert.equal(hardReady(qs, r), false);
  r = record(r, {type: 'graded', id: 'm1', passed: 1, total: 1}, 2);
  r = record(r, {type: 'ask', id: 'm2'}, 3);
  r = record(r, {type: 'graded', id: 'm2', passed: 1, total: 1}, 4);
  assert.equal(hardReady(qs, r), false, 'a Medium solved with help does not count');
  r = record(r, open('u'), 5);
  assert.equal(nextExercise(qs, r, 'm2')?.id, 'u');
  assert.equal(progressText(r), '3 solved · 2 without help');
  assert.equal(progressText([]), 'No problems solved yet');
  assert.equal(hardReady([...qs, {id: 'm9', title: 'M', difficulty: 'medium'}],
    record(record(r, open('m9'), 6), {type: 'graded', id: 'm9', passed: 1, total: 1}, 7)), true);
});
