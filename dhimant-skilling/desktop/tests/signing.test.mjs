import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {signingOptions} from '../sign-macos.mjs';

const env = {MACOS_SIGNING_IDENTITY: 'Developer ID Application: Example Ltd (ABCDEFGHIJ)',
  APPLE_TEAM_ID: 'ABCDEFGHIJ', MACOS_SIGNING_KEYCHAIN: '/private/signing.keychain-db'};

test('release signs every helper with hardened runtime, a timestamp and its upstream entitlements', () => {
  const options = signingOptions('/source', '/app.app', 'developer-id', env);
  assert.equal(options.identity, env.MACOS_SIGNING_IDENTITY);
  assert.equal(options.identityValidation, true);
  assert.equal(options.keychain, env.MACOS_SIGNING_KEYCHAIN);
  assert.equal(options.strictVerify, true);
  for (const [name, type] of [['dhimantAI.app', 'app'], ['dhimantAI Helper.app', 'helper'],
    ['dhimantAI Helper (GPU).app', 'helper-gpu'], ['dhimantAI Helper (Renderer).app', 'helper-renderer'],
    ['dhimantAI Helper (Plugin).app', 'helper-plugin']]) {
    const file = options.optionsForFile('/app/Contents/Frameworks/' + name);
    assert.equal(file.hardenedRuntime, true);
    assert.equal(file.timestamp, undefined); // osx-sign's secure Apple timestamp default
    assert.deepEqual(file.additionalArguments, []);
    assert.equal(file.entitlements, join('/source', 'build/azure-pipelines/darwin', `${type}-entitlements.plist`));
  }
});

test('missing or wrong release identity never falls back to ad-hoc', () => {
  for (const invalid of [{}, {...env, APPLE_TEAM_ID: 'WRONGTEAM1'},
    {...env, MACOS_SIGNING_IDENTITY: 'Apple Development: Example (ABCDEFGHIJ)'}]) {
    assert.throws(() => signingOptions('/source', '/app.app', 'developer-id', invalid));
  }
  assert.throws(() => signingOptions('/source', '/app.app', undefined, env));
});

test('ad-hoc requires an explicit mode and never uses release credentials', () => {
  const options = signingOptions('/source', '/app.app', 'ad-hoc', env);
  assert.equal(options.identity, '-');
  assert.equal(options.keychain, undefined);
  assert.equal(options.optionsForFile('/app.app').hardenedRuntime, false);
  assert.equal(options.optionsForFile('/app.app').timestamp, 'none');
});
