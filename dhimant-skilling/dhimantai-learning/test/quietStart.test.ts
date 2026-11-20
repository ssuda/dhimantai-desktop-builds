import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUIET_START_MS, quietStart } from '../src/updates';

const catalog = { webview: 'mainThreadWebview-dhimantai.courseCatalog', dirty: false };

test('a fresh launch showing only the catalog applies a finished update', () => {
  assert.equal(quietStart(20_000, []), true);
  assert.equal(quietStart(20_000, [catalog]), true);
});

test('learner work keeps the update waiting for the next restart', () => {
  assert.equal(quietStart(20_000, [catalog, { webview: 'mainThreadWebview-dhimantai.learningRoom', dirty: false }]), false);
  assert.equal(quietStart(20_000, [{ webview: 'mainThreadWebview-dhimantai.auth', dirty: false }]), false);
  assert.equal(quietStart(20_000, [{ dirty: false }]), false, 'an open file or notebook');
  assert.equal(quietStart(20_000, [{ ...catalog, dirty: true }]), false);
});

test('only during launch', () => {
  assert.equal(quietStart(QUIET_START_MS, [catalog]), true);
  assert.equal(quietStart(QUIET_START_MS + 1, [catalog]), false);
  assert.equal(quietStart(-1, [catalog]), false);
});
