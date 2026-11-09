import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CodeAction, CodeResult, RoomCodeSession, validCodeAction } from '../src/roomCode';
import { runLocally } from '../src/localRunner';

const message: CodeAction = {type: 'codeAction', attempt: 1, snippet: 'code-1', revision: 0, request: 1,
  language: 'python', source: 'print(input().upper())', stdin: 'hello\n', question: 'Print the input in uppercase.', action: 'run', message: ''};
const feedback = {guidance: 'Try another input.', prompt: 'What happens with spaces?', line: null};
const execution = {status: 'exited', exit_code: 0, stdout: 'HELLO\n', stderr: '', truncated: false, command: 'python3 main.py', duration_seconds: .1};

test('embedded Practice Run and Check execute the edited buffer and bind Instructor evidence to its input', async () => {
  const bodies: any[] = [], results: CodeResult[] = [];
  const session = new RoomCodeSession({current: async () => true, aiEnabled: () => true,
    run: s => runLocally(s.language, {source: s.source, stdin: s.stdin, argv: [], files: []}),
    coach: async body => { bodies.push(body); return feedback; }});
  await session.handle(message, result => results.push(result));
  assert.equal(results.at(-1)?.execution?.stdout, 'HELLO\n');
  assert.equal(bodies.length, 0, 'Run itself does not request coaching or submit an answer');
  await session.handle({...message, action: 'check', request: 2, revision: 1, source: 'print(input().lower())'}, r => results.push(r));
  assert.equal(results.at(-2)?.execution?.stdout, 'hello\n');
  assert.equal(bodies[0].source, 'print(input().lower())');
  assert.equal(bodies[0].stage, 'review');
  assert.equal(bodies[0].observed_run.output, 'hello\n');
  assert.equal(bodies[0].observed_run.prediction, undefined, 'a skipped prediction is not invented');
  await session.handle({...message, action: 'check', request: 3, revision: 2, prediction: 'HELLO'}, r => results.push(r));
  assert.equal(bodies[1].observed_run.prediction, 'HELLO', 'Check compares the run with the learner prediction');
  assert.equal(validCodeAction({...message, prediction: 'x'.repeat(601)}), false);
  assert.match(bodies[0].question, /Standard input.*hello/s);
  assert.deepEqual(results.at(-1)?.feedback, feedback);
  session.change({...message, revision: 3, source: 'print("new")'});
  await session.handle({...message, revision: 3, source: 'print("new")', request: 4, action: 'coach'}, () => {});
  assert.equal(bodies[2].observed_run, undefined, 'editing removes earlier output from coaching');
});

test('editing while Check runs discards its result and prevents a stale review', async () => {
  let finish!: (value: typeof execution) => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const results: CodeResult[] = [];
  const session = new RoomCodeSession({current: async () => true, aiEnabled: () => true,
    run: (_snapshot,pending) => new Promise(resolve => { signal=pending;finish = resolve; }), coach: async () => { calls++; return feedback; }});
  const pending = session.handle({...message, action: 'check'}, r => results.push(r));
  await new Promise(resolve => setImmediate(resolve));
  session.change({...message, revision: 1, stdin: 'new input'});
  assert.equal(signal?.aborted,true,'editing interrupts the old program before its Stop control disappears');
  finish(execution); await pending;
  assert.equal(calls, 0); assert.deepEqual(results, []);
});

test('old replies, wrong accounts, AI-disabled requests and unsupported payloads cannot act', async () => {
  let live = true, ai = true, runs = 0, finish!: (value: typeof feedback) => void;
  const results: CodeResult[] = [];
  const session = new RoomCodeSession({current: async () => live, aiEnabled: () => ai,
    run: async () => { runs++; return execution; }, coach: () => new Promise(resolve => { finish = resolve; })});
  const pending = session.handle({...message, action: 'coach'}, r => results.push(r));
  await new Promise(resolve => setImmediate(resolve));
  session.clear(); finish(feedback); await pending;
  assert.equal(results.length, 0);
  live = false;
  await session.handle(message, r => results.push(r));
  assert.equal(runs, 0);
  live = true; ai = false;
  await session.handle({...message, action: 'check'}, r => results.push(r));
  assert.match(results.at(-1)?.error ?? '', /AI assistance is off/);
  assert.equal(runs, 0);
  await session.handle(message, r => results.push(r));
  assert.equal(runs, 1, 'AI off still permits explicit local runs');
  assert.equal(validCodeAction({...message, language: '__proto__'}), false);
  assert.equal(validCodeAction({...message, source: 'x'.repeat(12001)}), false);
  assert.equal(validCodeAction({...message, action: 'submit'}), false);
});

test('typing cancels an automatic Instructor request so a new Run does not wait for it', async () => {
  let signal: AbortSignal | undefined, finish!: (value: typeof feedback) => void;
  const results: CodeResult[] = [];
  const session = new RoomCodeSession({current: async () => true, aiEnabled: () => true,
    run: async () => execution, coach: (_body, pending) => { signal = pending; return new Promise(resolve => { finish = resolve; }); }});
  const pending = session.handle({...message, action: 'observe'}, r => results.push(r));
  await new Promise(resolve => setImmediate(resolve));
  session.change({...message, revision: 1, source: 'print("new")'});
  assert.equal(signal?.aborted, true);
  await session.handle({...message, revision: 1, source: 'print("new")', request: 2}, r => results.push(r));
  assert.equal(results.length, 1);
  assert.ok(results[0].execution);
  finish(feedback); await pending;
  assert.equal(results.length, 1, 'the old guidance is discarded');
});
