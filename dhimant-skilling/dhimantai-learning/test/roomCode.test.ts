import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cellLanguageMismatch, CodeAction, CodeResult, RoomCodeSession, validCodeAction } from '../src/roomCode';
import { runLocally } from '../src/localRunner';
import { NotebookCells } from '../src/notebookCells';

const message: CodeAction = {type: 'codeAction', attempt: 1, snippet: 'code-1', revision: 0, request: 1,
  language: 'python', source: 'print(input().upper())', stdin: 'hello\n', question: 'Print the input in uppercase.', action: 'run', message: ''};
const feedback = {guidance: 'Try another input.', prompt: 'What happens with spaces?', line: null};
const execution = {status: 'exited', exit_code: 0, stdout: 'HELLO\n', stderr: '', truncated: false, command: 'python3 main.py', duration_seconds: .1};

test('only confirmed preparation failures tell the notebook that code did not run', async () => {
  const results:CodeResult[]=[];
  const cells=new NotebookCells(()=>{throw new Error('Must not fall back to host tools');},async()=>{
    throw new Error('Podman cannot apply the course resource limits.');
  });
  let preparation=true;
  const session=new RoomCodeSession({current:async()=>true,aiEnabled:()=>true,
    run:(snapshot,signal,event)=>{
      if(preparation)return cells.run(snapshot.language,snapshot.source,snapshot.stdin,{signal,event});
      throw new Error('Connection lost after dispatch; result unknown.');
    },coach:async()=>feedback});
  try {
    await session.handle(message,result=>results.push(result));
    assert.equal(results.at(-1)?.failureStage,'preparing');
    assert.match(results.at(-1)?.error??'',/Podman cannot apply/);
    assert.equal(results.some(result=>result.execution),false);
    preparation=false;
    await session.handle({...message,request:2},result=>results.push(result));
    assert.equal(results.at(-1)?.failureStage,undefined,'unknown outcomes must not claim non-execution');
  } finally {await cells.close();}
});

test('C/Java mismatch detection ignores comments, strings, file-writing cells and ambiguous code', () => {
  const c = '#include <stdio.h>\nint main() { printf("hello"); return 0; }';
  const java = 'class Main { public static void main(String[] args) { System.out.println("hello"); } }';
  assert.equal(cellLanguageMismatch('java', c), 'c');
  assert.equal(cellLanguageMismatch('c', java), 'java');
  assert.equal(cellLanguageMismatch('c', c), undefined);
  assert.equal(cellLanguageMismatch('java', java), undefined);
  for (const source of ['// ' + c.split('\n')[0], '/*\n' + c + '\n*/', 'String example = """\n' + c + '\n""";', 'String example = "#include <stdio.h>";', '%%writefile main.c\n' + c, 'int sum = 0;']) {
    assert.equal(cellLanguageMismatch('java', source), undefined, source);
  }
  assert.equal(cellLanguageMismatch('c', '/* ' + java + ' */'), undefined);
  assert.equal(cellLanguageMismatch('python', 'example = """\n' + c + '\n"""'), undefined);
  assert.equal(cellLanguageMismatch('bash', 'cat >main.c <<EOF\n' + c + '\nEOF'), undefined);
});

test('the host rejects mismatched Run and Check before choosing a compiler, while help remains available', async () => {
  const results: CodeResult[] = []; let runs = 0, reviews = 0;
  const session = new RoomCodeSession({current:async () => true, aiEnabled:() => true,
    run:async () => { runs++; return execution; }, coach:async () => { reviews++; return feedback; }});
  const wrong = {...message, language:'java', source:'#include <stdio.h>\nint main() { return 0; }'};
  for (const action of ['run', 'check'] as const) {
    await session.handle({...wrong, action}, result => results.push(result));
    assert.match(results.at(-1)?.error ?? '', /looks like C code.*set to Java.*language to C/);
  }
  assert.equal(runs, 0); assert.equal(reviews, 0);
  await session.handle({...wrong, action:'coach'}, result => results.push(result));
  assert.equal(reviews, 1);
  await session.handle({...wrong, language:'c', revision:1, request:2}, result => results.push(result));
  assert.equal(runs, 1); assert.ok(results.at(-1)?.execution);
});

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

test('Instructor receives missing-dependency evidence and a successful retry replaces the error', async () => {
  const bodies:any[] = [];
  const missing = "Python dependency could not be loaded.\nModuleNotFoundError: No module named 'transformers'\n"
    + 'For the course container, choose Set up / rebuild course in the runtime dropdown.';
  let result = {...execution, exit_code:1, stdout:'', stderr:missing};
  const session = new RoomCodeSession({current:async () => true, aiEnabled:() => true,
    run:async () => result, coach:async body => {bodies.push(body); return feedback;}});
  const cell = {...message, source:'import transformers\nprint(transformers.__version__)'};
  await session.handle(cell, () => {});
  await session.handle({...cell, action:'coach', request:2}, () => {});
  assert.equal(bodies[0].observed_run.success, false);
  assert.equal(bodies[0].observed_run.stderr, missing);
  assert.match(bodies[0].error, /No module named 'transformers'/);
  result = {...execution, stdout:'4.57.6\n'};
  await session.handle({...cell, request:3}, () => {});
  await session.handle({...cell, action:'coach', request:4}, () => {});
  assert.equal(bodies[1].observed_run.success, true);
  assert.equal(bodies[1].observed_run.output, '4.57.6\n');
  assert.equal(bodies[1].error, '');
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

test('Run in another cell stops an earlier run that is still waiting for input, then runs', async () => {
  const results: CodeResult[] = [];
  const stopped = {...execution, status: 'cancelled', exit_code: null, stdout: '', stderr: 'Stopped.'};
  const session = new RoomCodeSession({current: async () => true, aiEnabled: () => true, coach: async () => feedback,
    run: (snapshot, signal) => snapshot.snippet === 'code-1'
      ? new Promise(resolve => signal!.addEventListener('abort', () => resolve(stopped), {once: true}))
      : Promise.resolve(execution)});
  const waiting = session.handle(message, r => results.push(r));
  await new Promise(resolve => setImmediate(resolve));
  await session.handle({...message, snippet: 'code-2', source: 'print(2)', request: 2}, r => results.push(r));
  await waiting;
  assert.deepEqual(results.map(r => [r.snippet, r.execution?.status, r.error]),
    [['code-1', 'cancelled', undefined], ['code-2', 'exited', undefined]]);
});

test('a run that ignores Stop does not block forever: the new Run explains and the next one works', async () => {
  const results: CodeResult[] = [];
  let release!: () => void;
  const previousWait = RoomCodeSession.stopWait; RoomCodeSession.stopWait = 10;
  try {
    const session = new RoomCodeSession({current: async () => true, aiEnabled: () => true, coach: async () => feedback,
      run: snapshot => snapshot.snippet === 'code-1' ? new Promise(resolve => { release = () => resolve(execution); }) : Promise.resolve(execution)});
    const stuck = session.handle(message, r => results.push(r));
    await new Promise(resolve => setImmediate(resolve));
    await session.handle({...message, snippet: 'code-2', request: 2}, r => results.push(r));
    assert.match(results.at(-1)?.error ?? '', /still starting or stopping/);
    release(); await stuck;
    await session.handle({...message, snippet: 'code-2', request: 3}, r => results.push(r));
    assert.equal(results.at(-1)?.execution?.status, 'exited');
  } finally { RoomCodeSession.stopWait = previousWait; }
});
