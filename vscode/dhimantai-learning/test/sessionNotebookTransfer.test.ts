import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { sessionNotebookLink, sendSessionNotebook, TransferOperation, TransferBody } from '../src/sessionNotebookTransfer';
import { notebookLink, submissionCells } from '../src/notebookSubmission';

const metadata = { dhimantai: { protocol: 2, exercise_id: '9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a',
  export_id: '074dcfea-ea05-425f-a602-9a1d6a28e45a', account_id: 'learner-1', environment: 'staging',
  workspace: 'practice', draft_version: 3, language: 'python', base_revision: 3,
  transfer_id: 'f594f2bf-81b9-4869-a4d0-bef64dc4160e' } };
const link = sessionNotebookLink(metadata);
const cells = submissionCells([{ cell_type: 'code', source: 'print(42)' }], 'python');

test('session notebooks cannot use saved-draft submission, arbitrary services or invalid sessions', () => {
  assert.throws(() => notebookLink(metadata), /no valid/);
  for (const patch of [{ protocol: 1 }, { base_revision: -1 }, { base_revision: 2 ** 32 },
    { transfer_id: '../elsewhere' }, { environment: '__proto__' }, { workspace: 'course' }]) {
    assert.throws(() => sessionNotebookLink({ dhimantai: { ...metadata.dhimantai, ...patch } }));
  }
  const safe = sessionNotebookLink({ dhimantai: { ...metadata.dhimantai, token: 'never', apiUrl: 'https://elsewhere.test' } });
  assert.equal('apiUrl' in safe, false);
  assert.equal('token' in safe, false);
});

test('lost replies and notebook renames reuse the same transfer identity without saving source', async () => {
  let remembered: TransferOperation | undefined;
  const calls: TransferBody[] = [];
  const send = async (body: TransferBody) => {
    calls.push(body);
    if (calls.length === 1) throw new Error('lost receipt');
    return { receipt: { status: 'applied' as const, revision: 4 } };
  };
  const run = () => sendSessionNotebook(link, cells, send, remembered, state => { remembered = state; });
  await assert.rejects(run(), /lost receipt/);
  assert.equal((await run()).status, 'applied');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(JSON.stringify(remembered).includes('print(42)'), false);
});

test('only an applied receipt advances the baseline for subsequent edits', async () => {
  for (const status of ['applied', 'review', 'busy', 'rejected'] as const) {
    let remembered: TransferOperation | undefined;
    await sendSessionNotebook(link, cells, async () => ({ receipt: { status, revision: 7 } }),
      remembered, state => { remembered = state; });
    let baseline: number | undefined;
    await sendSessionNotebook(link, submissionCells([{ cell_type: 'code', source: 'print(43)' }], 'python'),
      async body => { baseline = body.base_revision; return { receipt: { status: 'review', revision: 8 } }; },
      remembered, state => { remembered = state; });
    assert.equal(baseline, status === 'applied' ? 7 : 3);
  }
});

test('invalid or missing application receipts cannot report success', async () => {
  for (const receipt of [undefined, { status: 'saved', revision: 1 }, { status: 'applied', revision: -1 }]) {
    await assert.rejects(sendSessionNotebook(link, cells, async () => ({ receipt } as any), undefined, () => {}), /valid receipt/);
  }
});
