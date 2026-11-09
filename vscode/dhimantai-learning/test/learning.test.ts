import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { DraftPayload, PracticeProject, RunConfiguration } from '../src/api';
import {
  LANGUAGE_EXTENSIONS, checkInputs, compareOutput, defaultArgv, errorLocation, expectedOutput, formatArguments,
  expectedRunOutput, parseArguments, payloadWith, samePayload, spliceSuggestion,
} from '../src/learning';

const config: RunConfiguration = {
  protocol: 2, preset: 'word_count',
  arguments: [{ value: '--count', description: '' }, { value: '--topcount', description: '' }],
  sample_files: [{ name: 'words.txt', content: 'b a b\n', description: '', expected_output: { '--count': 'a 1\nb 2\n', '--topcount': 'b 2\na 1\n' } }],
  max_files: 5, max_file_bytes: 32000, max_total_bytes: 64000,
};

const payload: DraftPayload = {
  language: 'python', notes: '', help_used: 'assistance_unknown', milestones: [],
  notebook: { nbformat: 4, cells: [{ cell_type: 'markdown', source: '# hi', metadata: {} }, { cell_type: 'code', source: 'print(1)\n', metadata: {} }] },
  argv: ['--count', 'words.txt'], stdin: '', files: [{ name: 'words.txt', content: 'b a b\n' }],
};

test('ordinary Run uses only the published sample for those exact inputs', () => {
  const sample = {kind: 'stdio' as const, id: 'one', stdin: '9\n', expected: '10'};
  const project = {run_configuration: config, public_examples: [sample]} as PracticeProject;
  const inputs = {source: '', stdin: '9\n', files: [], argv: []};
  assert.equal(expectedRunOutput(project, inputs), '10');
  assert.equal(expectedRunOutput(project, {...inputs, stdin: '8\n'}), undefined);
  assert.equal(expectedRunOutput(project, {...inputs, files: [{name: 'more.txt', content: 'x'}]}), undefined);
  assert.equal(expectedRunOutput({...project, public_examples: [sample, {...sample, expected: '11'}]}, inputs), undefined);
});

test('payloadWith replaces only the code cell and inputs', () => {
  const next = payloadWith(payload, { source: 'print(2)\n', argv: ['--topcount', 'words.txt'], stdin: '', files: payload.files! });
  assert.equal(next.notebook.cells[0].source, '# hi');
  assert.equal(next.notebook.cells[1].source, 'print(2)\n');
  assert.deepEqual(next.argv, ['--topcount', 'words.txt']);
  assert.equal(payload.notebook.cells[1].source, 'print(1)\n', 'original is not mutated');
  assert.ok(samePayload(next, { source: 'print(2)\n', argv: ['--topcount', 'words.txt'], stdin: '', files: payload.files! }));
  assert.ok(!samePayload(next, { source: 'print(3)\n', argv: ['--topcount', 'words.txt'], stdin: '', files: payload.files! }));
});

test('word count defaults and expected output only for unmodified samples', () => {
  assert.deepEqual(defaultArgv(config), ['--count', 'words.txt']);
  assert.equal(expectedOutput(config, ['--count', 'words.txt'], [{ name: 'words.txt', content: 'b a b\n' }]), 'a 1\nb 2\n');
  assert.equal(expectedOutput(config, ['--count', 'words.txt'], [{ name: 'words.txt', content: 'edited' }]), undefined);
  assert.equal(expectedOutput(config, ['--verbose', 'words.txt'], [{ name: 'words.txt', content: 'b a b\n' }]), undefined);
});

test('compareOutput distinguishes match, order and differences', () => {
  assert.deepEqual(compareOutput('a 1\nb 2\n', 'a 1\nb 2\n'), { result: 'match' });
  assert.deepEqual(compareOutput('a 1  \r\nb 2\n\n', 'a 1\nb 2\n'), { result: 'match' });
  assert.equal(compareOutput('b 2\na 1\n', 'a 1\nb 2\n').result, 'order');
  const diff = compareOutput('a 1\n', 'a 1\nb 2\n');
  assert.equal(diff.result, 'differs');
  if (diff.result === 'differs') {
    assert.equal(diff.line, 2);
    assert.equal(diff.actual, '(no more lines)');
    assert.equal(diff.missing, 1);
  }
  assert.deepEqual(compareOutput('', ''), { result: 'match' });
});

test('errorLocation finds the learner line in program output', () => {
  const py = 'Traceback (most recent call last):\n  File "/tmp/x/main.py", line 40, in <module>\n    main()\n  File "/tmp/x/main.py", line 12, in print_words\n    for w in f.split():\nAttributeError: \'_io.TextIOWrapper\' object has no attribute \'split\'\n';
  assert.deepEqual(errorLocation('python', py), { line: 12, column: undefined, message: "AttributeError: '_io.TextIOWrapper' object has no attribute 'split'" });
  assert.equal(errorLocation('python', '  File "/usr/lib/python3.12/json/__init__.py", line 3\nValueError: x'), undefined);
  assert.equal(errorLocation('rust', 'error[E0425]: cannot find value `x`\n --> main.rs:3:5\n')?.line, 3);
  assert.deepEqual(errorLocation('c', 'main.c:7:3: error: expected \';\' before \'}\' token\n'), { line: 7, column: 3, message: "expected ';' before '}' token" });
  assert.equal(errorLocation('typescript', 'main.ts(4,9): error TS2322: Type mismatch.')?.message, 'error TS2322: Type mismatch.');
  assert.equal(errorLocation('javascript', '/w/main.js:5\n  x.y\n    ^\nTypeError: Cannot read properties of undefined\n')?.line, 5);
  assert.equal(errorLocation('java', 'Main.java:9: error: cannot find symbol')?.line, 9);
});

test('arguments round-trip and input limits mirror the server', () => {
  assert.deepEqual(parseArguments('--count "my file.txt" \'a b\''), ['--count', 'my file.txt', 'a b']);
  assert.deepEqual(parseArguments(formatArguments(['--count', 'my file.txt', 'q"x'])), ['--count', 'my file.txt', 'q"x']);
  assert.equal(checkInputs(config, ['--count'], [{ name: 'ok.txt', content: 'x' }]), undefined);
  assert.match(checkInputs(config, [], [{ name: 'bad name.py', content: '' }])!, /Rename/);
  assert.match(checkInputs(config, [], Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, content: '' })))!, /at most 5/);
  assert.match(checkInputs(config, [], [{ name: 'big.txt', content: 'x'.repeat(33_000) }])!, /larger than/);
});

test('spliceSuggestion uses UTF-16 offsets like the server', () => {
  const source = 'print("😀")\nx = 1\n';
  const start = source.indexOf('x');
  assert.equal(spliceSuggestion(source, start, start + 5, 'x = 2'), 'print("😀")\nx = 2\n');
});

test('every course language has an editor support decision', () => {
  for (const language of ['python', 'rust', 'c', 'java', 'javascript', 'typescript', 'go']) {
    assert.ok(language in LANGUAGE_EXTENSIONS, language);
  }
  const pack = require('../../package.json').extensionPack as string[];
  for (const support of Object.values(LANGUAGE_EXTENSIONS)) {
    if (support) assert.ok(pack.includes(support.id), `${support.id} is in the extension pack`);
  }
});

test('baby names: the first run uses the 1990 page, compares with the reference, and .html inputs are allowed', () => {
  const page = '<h3 align="center">Popularity in 1990</h3>\n<tr align="right"><td>1</td><td>Michael</td><td>Jessica</td>\n';
  const config = { protocol: 2, preset: 'baby_names', arguments: [{ value: '--summaryfile', description: '' }], max_files: 12, max_file_bytes: 128000, max_total_bytes: 1000000,
    sample_files: [{ name: 'baby1990.html', content: page, description: '', expected_output: { '': '1990\nJessica 1\nMichael 1\n' } }] } as any;
  assert.deepEqual(defaultArgv(config), ['baby1990.html']);
  const files = [{ name: 'baby1990.html', content: page }];
  assert.equal(expectedOutput(config, ['baby1990.html'], files), '1990\nJessica 1\nMichael 1\n');
  assert.equal(expectedOutput(config, ['--summaryfile', 'baby1990.html'], files), undefined, '--summaryfile writes a file, so nothing is printed to compare');
  assert.equal(expectedOutput(config, ['baby1990.html'], [{ name: 'baby1990.html', content: page + 'x' }]), undefined, 'an edited page has no known answer');
  assert.equal(checkInputs(config, ['baby1990.html'], files), undefined);
  assert.equal(checkInputs(config, [], [{ name: 'baby2008.html', content: 'x'.repeat(70_000) }]), undefined, "Google's pages fit");
  assert.match(checkInputs(config, [], [{ name: 'run.exe', content: 'x' }]) ?? '', /Rename run\.exe/);
});
