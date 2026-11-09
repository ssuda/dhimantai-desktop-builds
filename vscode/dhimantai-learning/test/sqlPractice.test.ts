import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scaffold} from '../src/cellLayout';
import {practiceIpynb, practiceLink} from '../src/practiceIpynb';
import {CourseEngine} from '../src/courseEngine';
import type {PublicTest} from '../src/api';

// courseEngine imports only node modules, so its comparison can be loaded without VS Code.
const {sameRows} = require('../src/courseEngine') as {sameRows: (e: string, a: string, o: boolean) => boolean};

test('SQL rows compare like the server: columns and rows, order only when asked', () => {
  const want = '{"columns":["owner","total"],"rows":[["asha","10.50"],["ravi","3.00"]]}';
  const swapped = '{"columns":["owner","total"],"rows":[["ravi","3.00"],["asha","10.50"]]}';
  assert.equal(sameRows(want, swapped, false), true);
  assert.equal(sameRows(want, swapped, true), false);
  assert.equal(sameRows(want, '{"columns":["name","total"],"rows":[["asha","10.50"],["ravi","3.00"]]}', false), false);
  assert.equal(sameRows(want, '{"columns":["owner","total"],"rows":[["asha","10.50"]]}', false), false);
  assert.equal(sameRows(want, 'error', false), false);
  // Numbers compare by value: 0 equals 0.00, 10.5 equals 10.50.
  assert.equal(sameRows(want, '{"columns":["owner","total"],"rows":[["asha","10.5"],["ravi","3"]]}', false), true);
  assert.equal(sameRows('{"columns":["n"],"rows":[["0.00"]]}', '{"columns":["n"],"rows":[["0"]]}', true), true);
  assert.equal(sameRows(want, '{"columns":["owner","total"],"rows":[["asha","10.51"],["ravi","3"]]}', false), false);
});

test('the course container runs the same SQL runtime as Practice hidden tests', () => {
  const root = join(__dirname, '../../../..');
  assert.equal(readFileSync(join(root, 'vscode/dhimantai-learning/media/course/sql_runtime.py'), 'utf8'),
    readFileSync(join(root, 'agent/course_projects/runtime/sql_runtime.py'), 'utf8'));
});

for (const language of ['sql', 'pglab']) {
  test(`${language} public grading rejects truncated output and accounts for every requested case`, async t => {
    const engine = new CourseEngine('unused', 'unused', '/course');
    const expected = JSON.stringify({columns: ['n'], rows: [[1]]});
    const cases: PublicTest[] = ['complete', 'truncated', 'missing', 'stopped', 'timeout', 'error'].map(id =>
      ({id, kind: language === 'pglab' ? 'lab' : 'sql', expected}));
    const result = (id: string, extra = {}) => ({id, status: 'exited', exit_code: 0, stdout: expected,
      stderr: '', duration_seconds: 1, truncated: false, ...extra});
    t.mock.method(engine as any, 'sql', async (request: any) => {
      assert.equal(request.mode, language === 'pglab' ? 'lab_tests' : 'tests');
      return {tests: [result('truncated', {truncated: true}), result('complete'), result('unrequested'),
        result('stopped', {status: 'unavailable'}), result('timeout', {status: 'timeout', exit_code: null}),
        result('error', {exit_code: 1})]};
    });
    const results = await engine.tests(language, {source: '', argv: [], stdin: '', files: []}, cases);
    assert.deepEqual(results.map(r => [r.id, r.verdict]), [
      ['complete', 'passed'], ['truncated', 'wrong_answer'], ['missing', 'not_run'],
      ['stopped', 'not_run'], ['timeout', 'timeout'], ['error', 'runtime_error']
    ]);
  });
}

test('a SQL Practice notebook carries its dataset and mirrors to a .sql file', () => {
  const nb = practiceIpynb({id: '9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a', language: 'sql', question: 'Find owners.', starter: 'SELECT 1;',
    title: 'Owners', assistance: true, path: '/practice-code/9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a/notebook-coach', account: 'a',
    dataset: 'CREATE TABLE t(a int);', tests: [{id: 't1', kind: 'sql', setup: 'CREATE TABLE t(a int);', check: '', ordered: true, expected: '{}'}]}, 'staging') as any;
  assert.equal(nb.metadata.kernelspec.language, 'sql');
  const link = practiceLink(nb.metadata, ['staging']);
  assert.equal(link?.dataset, 'CREATE TABLE t(a int);');assert.equal(link?.tests[0].kind, 'sql');
  assert.equal(scaffold('sql', '').main, 'main.sql');
});

test('a PostgreSQL lab notebook uses shell cells, the pglab runtime and carries its setup', () => {
  const nb = practiceIpynb({id: '9d6ba91a-dce1-5d5e-b88c-46fc926a2f7b', language: 'pglab', question: 'Turn autovacuum back on.',
    starter: '# your script\n', title: 'Autovacuum', assistance: true, path: '/practice-code/9d6ba91a-dce1-5d5e-b88c-46fc926a2f7b/notebook-coach',
    account: 'a', dataset: 'psql -c "ALTER SYSTEM SET autovacuum = off"',
    tests: [{id: 't1', kind: 'lab', setup: 'true', check: 'SELECT 1', ordered: false, expected: '{}'}]}, 'staging') as any;
  assert.equal(nb.metadata.language_info.name, 'shellscript');
  const link = practiceLink(nb.metadata, ['staging']);
  assert.equal(link?.language, 'pglab');assert.equal(link?.tests[0].kind, 'lab');
  assert.match(link!.dataset, /autovacuum = off/);
});
