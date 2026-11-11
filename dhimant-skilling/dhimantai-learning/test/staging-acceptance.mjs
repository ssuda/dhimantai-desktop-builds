// End-to-end check of the extension's API client against a real dhimantAI service.
//
// Uses a TEST learner account only: it saves drafts, runs the sandbox and records AI help
// (hint + one applied suggestion) on that account. The original draft content is restored at the end.
//
//   npm run compile
//   DHIMANTAI_EMAIL=... DHIMANTAI_PASSWORD=... node test/staging-acceptance.mjs [question-id]
//
// Optional: DHIMANTAI_ENV=staging|development|local|production (default staging).
// The password is read from the environment and never printed. A receipt is written to ./staging-acceptance.json.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { Api } = require('../out/src/api.js');
const { ENVIRONMENTS } = require('../out/src/environments.js');
const L = require('../out/src/learning.js');

const envName = process.env.DHIMANTAI_ENV ?? 'staging';
const env = ENVIRONMENTS[envName];
const qid = process.argv[2] ?? '9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a';
const { DHIMANTAI_EMAIL: email, DHIMANTAI_PASSWORD: password } = process.env;
if (!env || !email || !password) {
  console.error('Set DHIMANTAI_EMAIL and DHIMANTAI_PASSWORD for a test learner (and optionally DHIMANTAI_ENV).');
  process.exit(2);
}

const login = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: env.supabaseAnonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const session = await login.json();
assert.ok(login.ok, `sign-in failed: ${session.msg ?? login.status}`);
const api = new Api({ accessToken: async () => session.access_token }, () => env);

const SOLUTION = `import sys
from collections import Counter


def counts(filename):
    with open(filename, encoding='utf-8') as source:
        return Counter(source.read().lower().split())


def main():
    if len(sys.argv) != 3:
        print('usage: ./wordcount.py {--count | --topcount} file')
        sys.exit(1)
    words = counts(sys.argv[2])
    pairs = sorted(words.items()) if sys.argv[1] == '--count' else words.most_common(20)
    for word, count in pairs:
        print(word, count)


main()
`;
// Line 7 reads the file object as if it were a string: a typical learner mistake.
const BUGGY = SOLUTION.replace('source.read().lower().split()', 'source.lower().split()');
const BUG_LINE = BUGGY.split('\n').findIndex(l => l.includes('source.lower()')) + 1;

const receipt = { environment: envName, api: env.apiUrl, question_id: qid, steps: [] };
const step = (name, data) => { receipt.steps.push({ name, ...data }); console.log(`✓ ${name}`); };

let ws = await api.workspace(qid);
const original = { version: ws.draft.version, payload: ws.draft.payload };
const config = ws.project.run_configuration;
assert.equal(config.preset, 'word_count', 'expected the Word Count exercise');
assert.equal(ws.runtime.status, 'ready', `runtime ${ws.runtime.status}: ${ws.runtime.message}`);
step('workspace', { draft_version: ws.draft.version, samples: config.sample_files.map(s => s.name), runtime: ws.runtime.status });
const files = config.sample_files.map(s => ({ name: s.name, content: s.content }));

async function save(source, argv) {
  ws = await api.workspace(qid);
  const local = { source, argv, stdin: '', files };
  const { draft } = await api.save(qid, ws.draft.version, L.payloadWith(ws.draft.payload, local));
  assert.ok(L.samePayload(draft.payload, local), 'saved draft round-trips');
  return draft;
}

async function run(draft) {
  const { submission } = await api.run(qid, draft.version);
  const started = Date.now();
  for (;;) {
    const row = (await api.workspace(qid)).submissions.find(s => s.id === submission.id);
    if (row && (row.status === 'assessed' || row.status === 'failed')) return row;
    assert.ok(Date.now() - started < 150_000, 'run exceeded 150 s');
    await new Promise(r => setTimeout(r, 1500));
  }
}

try {
  for (const argv of [['--count', 'words.txt'], ['--topcount', 'top-20.txt'], ['--count', 'mixed-case.txt']]) {
    const draft = await save(SOLUTION, argv);
    const row = await run(draft);
    const e = row.automated.execution;
    const expected = L.expectedOutput(config, argv, files);
    const comparison = L.compareOutput(e.stdout, expected);
    assert.equal(row.status, 'assessed');
    assert.equal(comparison.result, 'match', JSON.stringify(comparison));
    step(`run ${argv.join(' ')}`, { draft_version: draft.version, submission_id: row.id, command: e.command, comparison: comparison.result });
  }

  const buggy = await save(BUGGY, ['--count', 'words.txt']);
  const failed = await run(buggy);
  const location = L.errorLocation('python', failed.automated.execution.stderr);
  assert.equal(location?.line, BUG_LINE, failed.automated.execution.stderr);
  step('error located', { submission_id: failed.id, line: location.line, message: location.message });

  const cell = L.codeCellIndex(buggy.payload);
  let { assistance: hint } = await api.assist(qid, { expected_version: buggy.version, mode: 'hint', cell_index: cell, selection_start: 0, selection_end: 0 });
  assert.equal(hint.status, 'ready', hint.error);
  assert.equal(hint.response.code, '', 'hints contain no code');
  hint = (await api.assistEvent(qid, hint.id, 'received')).assistance;
  assert.ok(hint.received_at);
  step('hint received', { assistance_id: hint.id, hint: hint.response.hint, check_question: hint.response.check_question });

  const lineStart = BUGGY.split('\n').slice(0, BUG_LINE - 1).join('\n').length + 1;
  let { assistance: fix } = await api.assist(qid, { expected_version: buggy.version, mode: 'statement', cell_index: cell, selection_start: lineStart, selection_end: lineStart });
  assert.equal(fix.status, 'ready', fix.error);
  await api.assistEvent(qid, fix.id, 'received');
  const proposed = L.spliceSuggestion(BUGGY, fix.target.selection_start, fix.target.selection_end, fix.response.code);
  const applied = await api.assistEvent(qid, fix.id, 'apply');
  assert.equal(applied.draft.version, buggy.version + 1);
  assert.equal(L.codeSource(applied.draft.payload), proposed, 'server applied exactly the previewed change');
  step('statement suggestion applied', { assistance_id: fix.id, suggested: fix.response.code, applied_version: applied.draft.version });

  const after = await run(applied.draft);
  step('run after applied help', { submission_id: after.id, status: after.automated?.execution?.status, exit_code: after.automated?.execution?.exit_code,
    comparison: after.automated?.execution ? L.compareOutput(after.automated.execution.stdout, L.expectedOutput(config, ['--count', 'words.txt'], files)).result : null });

  ws = await api.workspace(qid);
  assert.equal(ws.coding_help_received, true, 'help is recorded on the exercise');
  step('help recorded', { coding_help_received: ws.coding_help_received });
} finally {
  if (original.version > 0) {
    ws = await api.workspace(qid);
    const { draft } = await api.save(qid, ws.draft.version, original.payload);
    receipt.restored_to_version = draft.version;
    console.log(`Restored original draft content as v${draft.version}.`);
  }
  writeFileSync('staging-acceptance.json', JSON.stringify(receipt, null, 2) + '\n');
}
console.log('All steps passed. Receipt: staging-acceptance.json');
