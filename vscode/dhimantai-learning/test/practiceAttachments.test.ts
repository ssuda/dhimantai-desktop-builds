import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MAX_BYTES, loadAttachments, practiceAttachments } from '../src/practiceAttachments';

const read = async () => Buffer.from([1, 2, 3]);
const size = (bytes: number) => async () => bytes;

test('chosen photos and PDFs are encoded with their type, and only within the server limits', async () => {
  assert.deepEqual(await loadAttachments(['/work/Error.PNG', '/work/notes.pdf'], read as any, size(3)),
    [{name: 'Error.PNG', type: 'image/png', data: 'AQID'}, {name: 'notes.pdf', type: 'application/pdf', data: 'AQID'}]);
  await assert.rejects(loadAttachments(['/work/clip.gif'], read as any, size(3)), /PNG, JPEG or WebP/);
  await assert.rejects(loadAttachments(['/work/phone.jpg'], read as any, size(MAX_BYTES + 1)), /under 2 MB/);
  await assert.rejects(loadAttachments(['/work/empty.png'], read as any, size(0)), /under 2 MB/);
  await assert.rejects(loadAttachments(['a.png', 'b.png'], read as any, size(MAX_BYTES - 1)), /2.75 MB in total/);
  await assert.rejects(loadAttachments(['1.png', '2.png', '3.png', '4.png', '5.png'], read as any, size(3)), /up to 4/);
});

test('attachments from a webview pass through only when every file is well formed', () => {
  const good = {name: 'error.png', type: 'image/png', data: 'AQID'};
  assert.deepEqual(practiceAttachments([good, {...good, extra: 'dropped'}]), [good, good]);
  assert.deepEqual(practiceAttachments([good, {...good, type: 'text/html'}]), []);
  assert.deepEqual(practiceAttachments([{...good, data: '<script>'}]), []);
  assert.deepEqual(practiceAttachments([{...good, data: 'A'.repeat(MAX_BYTES * 2)}]), []);
  assert.deepEqual(practiceAttachments(Array(5).fill(good)), []);
  assert.deepEqual(practiceAttachments('not a list'), []);
});
