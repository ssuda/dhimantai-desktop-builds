import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runLocally } from '../src/localRunner';
import { errorLocation } from '../src/learning';
import { resolve } from 'node:path';

const has = (tool: string, ...args: string[]) => { try { execFileSync(tool, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const files = [{ name: 'words.txt', content: 'b a b\n' }];

test('python runs with argv and input files beside main.py', async () => {
  const run = await runLocally('python', {
    source: 'import sys\nwords = open(sys.argv[2]).read().split()\nprint(sys.argv[1], len(words))\n',
    argv: ['--count', 'words.txt'], stdin: '', files,
  });
  assert.equal(run.status, 'exited');
  assert.equal(run.exit_code, 0);
  assert.equal(run.stdout, '--count 3\n');
  assert.match(run.command, /main\.py --count words\.txt$/);
});

test('python traceback maps to the learner line', async () => {
  const run = await runLocally('python', { source: 'x = 1\nprint(x.lower())\n', argv: [], stdin: '', files: [] });
  assert.equal(run.exit_code, 1);
  assert.equal(errorLocation('python', run.stderr)?.line, 2);
});

test('stdin reaches the program and editor secrets do not', async () => {
  process.env.DHIMANTAI_SECRET_PROBE = 'leak';
  const run = await runLocally('python', { source: 'import os,sys\nprint(sys.stdin.read().strip(), os.environ.get("DHIMANTAI_SECRET_PROBE"))\n', argv: [], stdin: 'hello\n', files: [] });
  assert.equal(run.stdout, 'hello None\n');
});

test('a missing tool is reported with install guidance', async () => {
  const run = await runLocally('python', { source: 'print(1)\n', argv: [], stdin: '', files: [] }, { python: '/nonexistent/python3' });
  assert.equal(run.status, 'toolchain_missing');
  assert.match(run.stderr, /not found\. Install Python/);
});

test('javascript runs with node', async () => {
  const run = await runLocally('javascript', { source: 'console.log(process.argv.slice(2).join(","))\n', argv: ['a', 'b c'], stdin: '', files: [] });
  assert.equal(run.stdout, 'a,b c\n');
  assert.match(run.command, /'b c'$/);
});

test('TypeScript compiles typed code and runs with Node', async () => {
  const run = await runLocally('typescript', {source:'const value: number = 42; console.log(value);', argv:[], stdin:'', files:[]},
    {tsc:resolve(__dirname,'../../node_modules/typescript/bin/tsc')});
  assert.equal(run.status,'exited'); assert.equal(run.exit_code,0); assert.equal(run.stdout,'42\n');
});

test('C compiles, and compile errors map to the learner line', { skip: !has('cc', '--version') }, async () => {
  const ok = await runLocally('c', { source: '#include <stdio.h>\nint main(void){puts("hi");return 0;}\n', argv: [], stdin: '', files: [] });
  assert.equal(ok.stdout, 'hi\n');
  const bad = await runLocally('c', { source: '#include <stdio.h>\nint main(void){\n  puts("hi")\n  return 0;\n}\n', argv: [], stdin: '', files: [] });
  assert.equal(bad.status, 'compile_error');
  assert.ok([3, 4].includes(errorLocation('c', bad.stderr)!.line), bad.stderr);
});

test('Java compiles and runs Main', { skip: !has('javac', '-version') }, async () => {
  const run = await runLocally('java', { source: 'public class Main { public static void main(String[] a) { System.out.println(a.length); } }\n', argv: ['x'], stdin: '', files: [] });
  assert.equal(run.stdout.trim(), '1');
});

test('Go builds and runs', { skip: !has('go', 'version') }, async () => {
  const run = await runLocally('go', { source: 'package main\nimport "fmt"\nfunc main() { fmt.Println("go") }\n', argv: [], stdin: '', files: [] });
  assert.equal(run.stdout, 'go\n');
});

test('Rust builds and runs', { skip: !has('rustc', '--version') }, async () => {
  const run = await runLocally('rust', { source: 'fn main() { println!("rs"); }\n', argv: [], stdin: '', files: [] });
  assert.equal(run.stdout, 'rs\n');
});

test('a runaway program is stopped', async () => {
  const run = await runLocally('python', { source: 'while True: pass\n', argv: [], stdin: '', files: [] }, {}, 1500);
  assert.equal(run.status, 'timeout');
});

test('trace records each learner line with variables before it runs', async () => {
  const { traceLocally } = await import('../src/localRunner');
  const { join } = await import('node:path');
  const trace = await traceLocally(join(__dirname, '../../media/pytrace.py'), {
    source: 'total = 0\nfor n in [1, 2]:\n    total += n\nprint(total)\n', argv: [], stdin: '', files: [],
  });
  assert.equal(trace.execution.exit_code, 0);
  assert.equal(trace.stdout, '3\n');
  assert.deepEqual(trace.steps.map(s => s.line), [1, 2, 3, 2, 3, 2, 4, 4]);
  assert.equal(trace.steps.find(s => s.line === 4)!.locals.total, '3');
  assert.equal(trace.steps.at(-1)!.output, 2, 'output length known at each step');
});

test('trace stops at the step limit and reports errors on the learner line', async () => {
  const { traceLocally } = await import('../src/localRunner');
  const { join } = await import('node:path');
  const tracer = join(__dirname, '../../media/pytrace.py');
  const loop = await traceLocally(tracer, { source: 'while True:\n    pass\n', argv: [], stdin: '', files: [] }, {}, 50);
  assert.equal(loop.stopped, 'limit');
  assert.equal(loop.steps.length, 50);
  const crash = await traceLocally(tracer, { source: 'x = [1]\nprint(x[3])\n', argv: [], stdin: '', files: [] });
  assert.match(crash.error ?? '', /IndexError/);
  const failing = crash.steps.find(s => s.event === 'exception')!;
  assert.equal(failing.line, 2);
  assert.match(failing.exception!, /^IndexError/);
  assert.equal(errorLocation('python', crash.execution.stderr)?.line, 2);
});

test('public tests are judged locally like the server: stdio, cli and function values', async () => {
  const { runPublicTests } = await import('../src/localRunner');
  const { join } = await import('node:path');
  const pycall = join(__dirname, '../../media/pycall.py');
  const io = await runPublicTests('python', 'a, b = map(int, input().split())\nprint(a + b)\n', [
    { id: 's1', kind: 'stdio', stdin: '2 3\n', expected: '5\n' },
    { id: 's2', kind: 'stdio', stdin: '10 -4\n', expected: '7\n' },
    { id: 's3', kind: 'stdio', stdin: 'x y\n', expected: '0\n' },
  ], pycall);
  assert.deepEqual(io.map(r => r.verdict), ['passed', 'wrong_answer', 'runtime_error']);
  const cli = await runPublicTests('python', 'import sys\nprint(open(sys.argv[2]).read().split().__len__(), sys.argv[1])\n', [
    { id: 'c1', kind: 'cli', argv: ['--count', 'w.txt'], files: [{ name: 'w.txt', content: 'a b c' }], expected: '3 --count  \n\n' },
  ], pycall);
  assert.equal(cli[0].verdict, 'passed', 'trailing spaces and blank lines are ignored');
  const fn = await runPublicTests('python', "def f(n):\n    print('debug')\n    return {'b': n, 'a': 1}\n", [
    { id: 'f1', kind: 'function', call: 'f(2)', expected: "{'a': 1, 'b': 2}" },
    { id: 'f2', kind: 'function', call: 'f(3)', expected: "{'a': 1, 'b': 2}" },
    { id: 'f3', kind: 'function', call: 'g(3)', expected: '1' },
  ], pycall);
  assert.deepEqual(fn.map(r => r.verdict), ['passed', 'wrong_answer', 'runtime_error'], 'dict order cannot fail; prints do not count');
  assert.equal(fn[1].actual, "{'b': 3, 'a': 1}");
});
