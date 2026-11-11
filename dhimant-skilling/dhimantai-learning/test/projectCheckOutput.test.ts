import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ProjectCheckOutput, projectFrame } from '../src/projectCheckOutput';

const traceback = 'Traceback (most recent call last):\n'
  + '  File "/course/project/checks/test_tools.py", line 22, in test_invalid_actions_never_dispatch\n'
  + '    self.assertEqual(dispatch(action, []), {"error": error})\n'
  + '  File "/course/project/course_agent/tools.py", line 14, in dispatch\n'
  + '    raise NotImplementedError("Implement dispatch in milestone 4")\n'
  + 'NotImplementedError: Implement dispatch in milestone 4\n';

test('long subtest output retains the first cause, source line, traceback and final result', () => {
  const capture = new ProjectCheckOutput();
  const raw = 'test_invalid_actions_never_dispatch ... ERROR\n'.repeat(200) + traceback
    + 'another subtest ... ERROR\n'.repeat(300) + traceback.replaceAll('dispatch', 'later_failure')
    + '\nRan 2 tests in 0.001s\n\nFAILED (errors=8)\n';
  for (let start = 0; start < raw.length; start += 7) capture.append(Buffer.from(raw.slice(start, start + 7)), 'stderr');
  const result = capture.finish();
  assert.deepEqual(result.diagnostic, {cause: 'This part is not implemented yet: Implement dispatch in milestone 4',
    file: 'course_agent/tools.py', line: 14});
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 4000);
  assert.match(result.output, /Traceback \(most recent call last\):/);
  assert.match(result.output, /line 14, in dispatch/);
  assert.match(result.output, /output omitted/);
  assert.match(result.output, /FAILED \(errors=8\)\n$/);
});

test('UTF-8 and interleaved pipes do not corrupt a diagnostic split across chunks', () => {
  const capture = new ProjectCheckOutput();
  capture.append(Buffer.from('stdout without a newline'), 'stdout');
  const raw = Buffer.from(traceback.replace('NotImplementedError: Implement dispatch in milestone 4', 'AssertionError: “café” != “tea”'));
  for (const byte of raw) capture.append(Buffer.from([byte]), 'stderr');
  const result = capture.finish();
  assert.equal(result.truncated, false);
  assert.equal(result.output, 'stdout without a newline' + raw.toString());
  assert.equal(result.diagnostic?.cause, 'A check did not match its expected result: “café” != “tea”');
});

test('syntax errors without a traceback heading use the affected file, including Windows separators', () => {
  const capture = new ProjectCheckOutput();
  capture.append(Buffer.from('  File "C:\\course\\course_agent\\documents.py", line 5\n    def read_document(\n                     ^\nSyntaxError: unexpected EOF'), 'stderr');
  assert.deepEqual(capture.finish().diagnostic, {cause: 'Python could not read this code: unexpected EOF',
    file: 'course_agent/documents.py', line: 5});
});

test('ordinary command output is preserved and unsupported failures do not invent a cause or path', () => {
  for (const raw of ['Ran 2 tests\nOK\n', 'tool exited with code 1\n', 'AssertionError: printed by a program\n']) {
    const capture = new ProjectCheckOutput(); capture.append(Buffer.from(raw), 'stdout');
    assert.deepEqual(capture.finish(), {output: raw, truncated: false, diagnostic: undefined});
  }
  const capture = new ProjectCheckOutput();
  capture.append(Buffer.from(traceback.replaceAll('/course/project/checks/test_tools.py', '/usr/lib/python/unittest/case.py')
    .replaceAll('/course/project/course_agent/tools.py', '/course/course_agent/../../private.py')), 'stderr');
  assert.equal(capture.finish().diagnostic?.file, undefined);
});

test('unbounded single lines are skipped without losing a later traceback or growing retained output', () => {
  const capture = new ProjectCheckOutput();
  for (let i = 0; i < 100; i++) capture.append(Buffer.from('x'.repeat(10000)), 'stderr');
  capture.append(Buffer.from('\n' + traceback), 'stderr');
  const result = capture.finish();
  assert.equal(result.diagnostic?.file, 'course_agent/tools.py');
  assert.ok(result.output.length <= 4000);
  assert.equal(result.truncated, true);
});

test('frames are anchored to the project folder; the deepest learner frame wins over tests, checks and packages', () => {
  const dir = '/course/python/course-research-agent';
  const raw = 'Traceback (most recent call last):\n'
    + `  File "${dir}/checks/test_tools.py", line 22, in test_dispatch\n`
    + `  File "${dir}/course_agent/agent.py", line 40, in run\n`
    + `  File "${dir}/course_agent/tools.py", line 14, in dispatch\n`
    + `  File "${dir}/.venv/lib/python3.12/site-packages/json/__init__.py", line 3, in loads\n`
    + '  File "/usr/local/lib/python3.12/site-packages/tests/test_x.py", line 9, in helper\n'
    + '  File "/course/python/other-project/course_agent/tools.py", line 2, in elsewhere\n'
    + 'ValueError: bad input\n';
  const capture = new ProjectCheckOutput(dir); capture.append(Buffer.from(raw), 'stderr');
  assert.deepEqual(capture.finish().diagnostic, {cause: 'ValueError: bad input', file: 'course_agent/tools.py', line: 14});
  assert.equal(projectFrame('/usr/lib/python3.12/site-packages/rich/console.py', dir), undefined);
  assert.equal(projectFrame('/usr/lib/python3.12/site-packages/rich/console.py'), undefined, 'packages are rejected without a project folder too');
  assert.equal(projectFrame(`${dir}/rich/console.py`, dir), 'rich/console.py');
  assert.equal(projectFrame('check.py', dir), 'check.py');
  assert.equal(projectFrame(`${dir}/../secret.py`, dir), undefined);
  // Only a checker frame: report it rather than nothing.
  const checker = new ProjectCheckOutput(dir);
  checker.append(Buffer.from(`Traceback (most recent call last):\n  File "${dir}/check.py", line 7, in <module>\nAssertionError: expected failure\n`), 'stderr');
  assert.equal(checker.finish().diagnostic?.file, 'check.py');
});

test('skipped tests that fail the final check point at the placeholder test', () => {
  const capture = new ProjectCheckOutput('/course/agent');
  capture.append(Buffer.from("test_my_case (tests.test_my_agent.MyAgentTests.test_my_case) ... skipped 'Replace this placeholder'\n"
    + '\nRan 12 tests in 0.1s\n\nOK (skipped=1)\n'), 'stderr');
  capture.append(Buffer.from('Final checker: 12 tests; 1 skipped\n'), 'stdout');
  const diagnostic = capture.finish().diagnostic!;
  assert.equal(diagnostic.file, 'tests/test_my_agent.py');
  assert.match(diagnostic.cause, /Replace the placeholder test in tests\/test_my_agent.py/);
  const summary = new ProjectCheckOutput(); summary.append(Buffer.from('Final checker: 3 tests; 2 skipped\n'), 'stdout');
  assert.match(summary.finish().diagnostic!.cause, /skipped/);
  const none = new ProjectCheckOutput(); none.append(Buffer.from('Final checker: 3 tests; 0 skipped\n'), 'stdout');
  assert.equal(none.finish().diagnostic, undefined);
});
