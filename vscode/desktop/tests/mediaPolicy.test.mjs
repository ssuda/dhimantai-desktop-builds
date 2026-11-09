import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaCapturePolicy, learningExtension } from '../overlays/src/vs/platform/webview/common/dhimantaiMediaPolicy.ts';
const origin = 'vscode-webview://notebook123';
const allow = async () => true;
const active = () => true;
function registered() {
  const policy = new MediaCapturePolicy();
  policy.register(1, 'frame', origin, learningExtension, true);
  return policy;
}
test('remote frames, unregistered extensions and unknown device types are denied without prompting', async () => {
  const policy = registered(); let prompts = 0;
  policy.register(2, 'other', origin, 'another.extension', true);
  const prompt = async () => { prompts++; return true; };
  for (const [owner, url, types] of [[2, origin, ['audio']], [1, 'https://youtube.com', ['video']], [1, origin, []], [1, origin, ['display-capture']]]) {
    assert.equal(await policy.request(owner, url, types, prompt, active), false);
  }
  assert.equal(prompts, 0);
});
test('consent is device-specific and confined to the owning notebook and window', async () => {
  const policy = registered();
  assert.equal(policy.check(1, origin, 'audio'), false);
  assert.equal(await policy.request(1, origin, ['audio'], allow, active), true);
  assert.equal(policy.check(1, origin + '/index.html', 'audio'), true);
  assert.equal(policy.check(1, origin, 'video'), false);
  assert.equal(policy.check(2, origin, 'audio'), false);
  policy.register(1, 'frame', origin, learningExtension, false);
  assert.equal(policy.check(1, origin, 'audio'), false);
});
test('denial and navigation during consent never grant capture', async () => {
  const policy = registered();
  assert.equal(await policy.request(1, origin, ['video'], async () => false, active), false);
  assert.equal(await policy.request(1, origin, ['video'], async () => { policy.forget(1); return true; }, active), false);
  assert.equal(policy.check(1, origin, 'video'), false);
});
test('concurrent requests cannot open overlapping permission prompts', async () => {
  const policy = registered(); let finish;
  const pending = policy.request(1, origin, ['audio'], () => new Promise(resolve => { finish = resolve; }), active);
  assert.equal(await policy.request(1, origin, ['video'], allow, active), false);
  finish(true);
  assert.equal(await pending, true);
});
