import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { notebookLink, submissionCells, submitNotebook, NotebookLink, NotebookOperation, NotebookApi } from '../src/notebookSubmission';
import type { Workspace, Submission } from '../src/api';

const link: NotebookLink = { protocol: 1, exercise_id: '9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a',
  export_id: '074dcfea-ea05-425f-a602-9a1d6a28e45a', account_id: 'learner-1', environment: 'staging',
  workspace: 'practice', draft_version: 3, language: 'python' };
const cells = submissionCells([{ cell_type: 'markdown', source: '# My work' },
  { cell_type: 'code', source: 'a = input()' }, { cell_type: 'code', source: 'print(a)' }], 'python');

function fixture(selected = link) {
  const question = selected.workspace === 'doubt_practice' ? `doubt:${selected.exercise_id}` : selected.exercise_id;
  const workspace = { project: { id: `practice:${question}`, question_id: question, languages: ['python'], tests: { public: [], hidden_count: 1, suite_version: 1 } },
    draft: { version: 3, payload: { question_id: question, language: 'python', notebook: { nbformat: 4, cells: [{ cell_type: 'code', source: '# solution', metadata: {} }] },
      notes: 'explanation', help_used: 'self_reported_ai', milestones: [], stdin: 'hello', argv: ['a'], files: [{ name: 'a.txt', content: 'b' }] } },
    submissions: [], source_changed: false } as unknown as Workspace;
  let state: NotebookOperation | undefined;
  let saves = 0, checks = 0, loseSave = false, loseCheck = false;
  const receipts = new Map<string, Submission>();
  const api: NotebookApi = {
    workspace: async () => structuredClone(workspace),
    save: async (version, payload) => {
      assert.equal(version, workspace.draft.version);
      saves++;
      workspace.draft = { version: version + 1, payload: structuredClone(payload) };
      if (loseSave) { loseSave = false; throw new Error('lost save response'); }
      return { draft: structuredClone(workspace.draft) };
    },
    check: async (version, id) => {
      if (!receipts.has(id)) {
        checks++;
        receipts.set(id, { id, draft_version: version, kind: 'check', status: 'queued', created_at: '' });
      }
      if (loseCheck) { loseCheck = false; throw new Error('lost check response'); }
      return { submission: receipts.get(id)! };
    },
  };
  return { workspace, run: (source = cells) => submitNotebook(selected, source, api, state, async value => { state = structuredClone(value); }),
    counts: () => ({ saves, checks }), loseSave: () => { loseSave = true; }, loseCheck: () => { loseCheck = true; } };
}

test('links accept only a supported environment and target, never a notebook-supplied URL', () => {
  assert.deepEqual(notebookLink({ dhimantai: { ...link, apiUrl: 'https://elsewhere.test', token: 'ignored' } }), link);
  for (const patch of [{ environment: 'https://elsewhere.test' }, { environment: '__proto__' }, { exercise_id: '../other' },
    { draft_version: -1 }, { protocol: 2 }, { workspace: 'course' }, { export_id: null }]) {
    assert.throws(() => notebookLink({ dhimantai: { ...link, ...patch } }), /no valid/);
  }
  assert.throws(() => notebookLink({}), /Export it again/);
});

test('all cells remain ordered, with no outputs or arbitrary metadata sent as evidence', () => {
  assert.deepEqual(cells.map(c => c.source), ['# My work', 'a = input()', 'print(a)']);
  assert.deepEqual(cells[1].outputs, []);
  assert.equal(cells[1].execution_count, null);
  assert.throws(() => submissionCells([{ cell_type: 'code', source: 'x', language: 'javascript' }], 'python'), /all code cells/);
  assert.throws(() => submissionCells([{ cell_type: 'code', source: 'x'.repeat(20001) }], 'python'), /20 KB/);
  assert.throws(() => submissionCells([{ cell_type: 'markdown', source: 'no code' }], 'python'), /solution/);
});

for (const kind of ['practice', 'doubt_practice'] as const) {
  test(`${kind}: save and check the exact question, preserving notes, inputs and help disclosure`, async () => {
    const f = fixture({ ...link, workspace: kind });
    const result = await f.run();
    assert.equal(result.version, 4);
    assert.equal(result.submission?.draft_version, 4);
    assert.deepEqual(f.workspace.draft.payload.notebook.cells, cells);
    assert.equal(f.workspace.draft.payload.notes, 'explanation');
    assert.equal(f.workspace.draft.payload.help_used, 'self_reported_ai');
    assert.equal(f.workspace.draft.payload.stdin, 'hello');
    assert.deepEqual(f.workspace.draft.payload.files, [{ name: 'a.txt', content: 'b' }]);
    await f.run();
    assert.deepEqual(f.counts(), { saves: 1, checks: 1 });
  });
}

test('a lost save response reconciles the exact server payload without another save', async () => {
  const f = fixture(); f.loseSave();
  await assert.rejects(f.run(), /lost save/);
  await f.run();
  assert.deepEqual(f.counts(), { saves: 1, checks: 1 });
});

test('a lost check response reuses its request ID without another evaluation', async () => {
  const f = fixture(); f.loseCheck();
  await assert.rejects(f.run(), /lost check/);
  await f.run();
  assert.deepEqual(f.counts(), { saves: 1, checks: 1 });
});

test('newer browser work blocks repeated submissions and never becomes the new baseline', async () => {
  const f = fixture(); f.workspace.draft.version++;
  await assert.rejects(f.run(), /different saved draft/);
  await assert.rejects(f.run(), /different saved draft/);
  assert.deepEqual(f.counts(), { saves: 0, checks: 0 });
});

test('an interrupted save cannot adopt a different concurrent payload', async () => {
  const f = fixture(); f.loseSave();
  await assert.rejects(f.run());
  f.workspace.draft.payload.stdin = 'different input';
  await assert.rejects(f.run(), /different saved draft/);
  assert.deepEqual(f.counts(), { saves: 1, checks: 0 });
});

test('changed code after a successful submit saves a new version and evaluates it', async () => {
  const f = fixture(); await f.run();
  await f.run(submissionCells([{ cell_type: 'code', source: 'print(2)' }], 'python'));
  assert.deepEqual(f.counts(), { saves: 2, checks: 2 });
});

test('wrong question and changed source are rejected before save', async () => {
  const f = fixture(); f.workspace.project.question_id = 'another';
  await assert.rejects(f.run(), /different question/);
  const g = fixture(); g.workspace.source_changed = true;
  await assert.rejects(g.run(), /requirements changed/);
  assert.deepEqual(f.counts(), { saves: 0, checks: 0 });
});

test('questions without tests save code without claiming evaluation', async () => {
  const f = fixture(); f.workspace.project.tests = null;
  assert.equal((await f.run()).submission, undefined);
  assert.deepEqual(f.counts(), { saves: 1, checks: 0 });
});
