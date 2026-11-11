import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectContextProblem, publicContextPath, redactSecrets, selectProjectContext } from '../src/projectContext';

test('a question retrieves source, matching tests, imported helpers and data ahead of unrelated milestone files', () => {
  const all = new Map<string, string>(Array.from({length: 18}, (_, i) => [`course_agent/unrelated${i}.py`, '# another milestone']));
  all.set('README.md', 'Project brief');
  all.set('course_agent/search.py', 'from .documents import load_documents\nFIXTURE = "data/books.json"\ndef rank_books():\n    pass');
  all.set('course_agent/documents.py', 'def load_documents(): pass');
  all.set('tests/test_search.py', 'def test_ranking(): pass');
  all.set('data/books.json', '[{"title":"Dune"}]');
  const result = selectProjectContext(all, ['course_agent/unrelated0.py'], 'How does rank_books work in search.py?');
  assert.equal(result.files[0].path, 'course_agent/search.py');
  for (const path of ['README.md', 'tests/test_search.py', 'data/books.json', 'course_agent/documents.py'])
    assert.ok(result.files.some(file => file.path === path), path);
  assert.equal(result.structure.total_files, all.size);
  assert.ok(result.structure.files.includes('data/books.json'));
  assert.equal(result.files.length + result.omitted_count, all.size);
});

test('questions choose the actual symbol or explicit line inside long files and retain real offsets', () => {
  const source = Array.from({length: 220}, (_, i) => i === 170 ? 'def make_table():' : '# line ' + (i + 1)).join('\n');
  const all = new Map([['rich/table.py', source], ['README.md', 'Brief']]);
  for (const question of ['Explain make_table', 'Explain rich/table.py:171']) {
    const result = selectProjectContext(all, ['README.md'], question, {'rich/table.py': 20});
    const file = result.files.find(file => file.path === 'rich/table.py')!;
    assert.equal(file.start_line, 163);
    assert.equal(file.text.split('\n')[171 - file.start_line], 'def make_table():');
    assert.equal(file.truncated, true);
  }
});

test('related tests support the student’s active regression test without displacing it', () => {
  const all = new Map([
    ['README.md', 'Project brief'],
    ['tests/test_regression.py', 'from shelf.search import search\n# regression'],
    ['tests/test_search.py', 'from shelf.search import search\n# regression'],
    ['shelf/search.py', 'def search(): pass\n# regression'],
    ['check.py', 'def fail(): pass'],
  ]);
  const result = selectProjectContext(all, ['tests/test_regression.py', 'tests/test_search.py', 'shelf/search.py'],
    'Why does my regression test fail, and how can Git help investigate?');
  assert.equal(result.files[0].path, 'tests/test_regression.py');
  assert.ok(result.files.some(file => file.path === 'shelf/search.py'));
  assert.equal(selectProjectContext(all, ['README.md'], 'Explain search').files[0].path, 'shelf/search.py');
});

test('serialized context stays bounded with Unicode, escaping and a large public map', () => {
  const all = new Map(Array.from({length: 400}, (_, i) => [`tests/test_case_${i}.py`, '界😀\\"\t'.repeat(3000)]));
  all.set('README.md', 'Brief');
  const result = selectProjectContext(all, ['tests/test_case_399.py'], 'Explain test_case_399.py');
  assert.equal(result.files[0].path, 'tests/test_case_399.py');
  assert.equal(result.files.length, 12);
  assert.equal(result.omitted.length, 30);
  assert.equal(result.omitted_count, 389);
  assert.equal(result.structure.truncated, true);
  assert.ok(result.structure.files.length <= 100);
  assert.ok(Buffer.byteLength(JSON.stringify(result.files)) <= 20000);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structure.files)) <= 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 30000);
});

test('private, unsupported and escaping paths never enter the excerpts or project map', () => {
  const all = new Map(['.env', 'data/credentials.json', 'data/secret.json', '../outside.py', 'foo//bar.py',
    'foo/./bar.py', '/tmp/public.py', 'folder/.private/info.py', 'data/photo.png', 'C:/source.py'].map(path => [path, 'SECRET']));
  all.set('README.md', 'Brief'); all.set('data/example.csv', 'name\nDune');
  const result = selectProjectContext(all, [], 'What is in credentials.json?');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(result.structure.files, ['README.md', 'data/example.csv']);
});

test('secret paths are excluded by whole name, matching the server', () => {
  for (const path of ['token_utils.py', 'tokenizer.py', 'keyword_search.py', 'agent/secret_config.py', 'docs/notes.md'])
    assert.ok(publicContextPath(path), path);
  for (const path of ['.env.local', 'secrets.json', 'keys/x.json', 'data/api_token.json', 'service_account.json', 'tokens/a.py', 'data/db_credentials.csv', 'secret.json'])
    assert.ok(!publicContextPath(path), path);
});

test('likely secrets are redacted from excerpts with line structure kept', () => {
  const lines = [
    'OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"',
    'claude = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"',
    'gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"; pat = "github_pat_11ABCDEFG0123456789_abcdefghij"',
    'aws = "AKIAABCDEFGHIJKLMNOP"', 'slack = "xoxb-123456789012-abcdefghij"',
    'API_KEY = "local-dev-value-1"', "settings = {'password': 'hunter2-long'}", 'client_secret: "abcdefgh12"',
    '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', 'abcdefghij==', '-----END RSA PRIVATE KEY-----',
    'tokenizer = "bert-base-uncased"', 'max_tokens = 400', 'token = os.environ["TOKEN"]', 'def rank_books(): pass',
  ];
  const source = lines.join('\n');
  const redacted = redactSecrets(source);
  assert.equal(redacted.split('\n').length, lines.length);
  for (const secret of ['abcdefghijklmnopqrstuvwxyz', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-', 'local-dev-value', 'hunter2', 'abcdefgh12', 'MIIEowIBAAKCAQEA', 'abcdefghij=='])
    assert.ok(!redacted.includes(secret), secret);
  assert.match(redacted, /API_KEY = "\[redacted\]"/);
  assert.match(redacted, /-----BEGIN RSA PRIVATE KEY-----\n\[redacted\]\n\[redacted\]\n-----END RSA PRIVATE KEY-----/);
  for (const kept of ['tokenizer = "bert-base-uncased"', 'max_tokens = 400', 'token = os.environ["TOKEN"]', 'def rank_books(): pass'])
    assert.ok(redacted.includes(kept), kept);
  assert.equal(redactSecrets('key: "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----"'),
    'key: "-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----"');
  const result = selectProjectContext(new Map([['course_agent/config.py', source]]), ['course_agent/config.py'], 'Explain line 16 config.py:16');
  assert.ok(!JSON.stringify(result).includes('hunter2'));
  assert.equal(result.files[0].text.split('\n').length, lines.length - result.files[0].start_line + 1);
});

test('snapshot failures name the file or limit in plain words', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-context-'));
  try {
    await writeFile(join(root, 'big.json'), 'x'.repeat(600000));
    await writeFile(join(root, 'small.py'), 'pass');
    await symlink(join(root, 'small.py'), join(root, 'linked.py'));
    assert.match(await projectContextProblem(new Error('Project source files must be smaller than 512 KB.'), root, ['small.py', 'big.json']),
      /big\.json is larger than 512 KB/);
    assert.match(await projectContextProblem(new Error('Project context is too large.'), root, ['small.py'], new Map([['small.py', 'y'.repeat(600000)]])),
      /small\.py is larger than 512 KB/);
    assert.match(await projectContextProblem(new Error('Project context is too large.'), root, ['small.py']), /larger than 8 MB/);
    assert.match(await projectContextProblem(new Error('Linked files cannot be shared with Coach.'), root, ['small.py', 'linked.py']),
      /linked\.py is a link/);
    assert.match(await projectContextProblem(new Error('Too many public project source, test and fixture files.'), root, undefined),
      /more public source, test and data files than Coach can read \(64\)/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
