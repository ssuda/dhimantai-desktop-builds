import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ExtensionUpdates, newerVersion, releaseVersion } from '../src/updates';

const release = { extension: 'optficial.dhimantai-learning', version: '0.13.2', file: 'dhimantai-learning.vsix', sha256: 'a'.repeat(64) };
test('release versions compare numerically and never suggest a downgrade', () => {
  assert.equal(newerVersion('0.13.2', '0.13.1'), true);
  assert.equal(newerVersion('0.13.10', '0.13.2'), true);
  assert.equal(newerVersion('0.13.1', '0.13.2'), false);
  assert.equal(newerVersion('0.13.2', '0.13.2'), false);
  assert.equal(newerVersion('garbage', '0.13.2'), false);
});
test('invalid or unrelated release metadata is rejected', () => {
  assert.equal(releaseVersion(release), '0.13.2');
  for (const invalid of [null, {}, { ...release, extension: 'someone.else' }, { ...release, version: 'new' }, { ...release, sha256: '' }, { ...release, file: 'https://elsewhere.test/package.vsix' }]) {
    assert.throws(() => releaseVersion(invalid), /invalid/);
  }
});
test('checks the chosen service without credentials and offers only its download URL', async () => {
  let url = '', options: RequestInit | undefined;
  const updates = new ExtensionUpdates(() => 'staging', '0.13.0', () => {}, (async (input, init) => {
    url = String(input); options = init; return new Response(JSON.stringify(release));
  }) as typeof fetch);
  await updates.check();
  assert.equal(url, 'https://app-staging.dhimant.ai/downloads/dhimantai-learning.json');
  assert.equal(options?.credentials, 'omit');
  assert.equal(options?.redirect, 'error');
  assert.equal(updates.state.status, 'available');
  assert.equal(updates.downloadUrl, 'https://app-staging.dhimant.ai/downloads/dhimantai-learning.vsix');
  assert.equal(updates.state.installed, '0.13.0', 'checking is not installation');
});
test('missing manifest is unavailable, never up to date; a late response cannot cross environments', async () => {
  const failed = new ExtensionUpdates(() => 'staging', '0.13.0', () => {}, (async () => new Response('', { status: 404 })) as typeof fetch);
  await failed.check();
  assert.equal(failed.state.status, 'unavailable');
  let environment: 'staging' | 'production' = 'staging';
  let done!: (value: Response) => void;
  const pending = new ExtensionUpdates(() => environment, '0.13.0', () => {}, (() => new Promise<Response>(r => { done = r; })) as typeof fetch);
  const checking = pending.check(); environment = 'production'; done(new Response(JSON.stringify(release))); await checking;
  assert.notEqual(pending.state.status, 'available');
  assert.equal(pending.state.available, undefined);
});

test('verified update installs once and keeps the running version until reload', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('test package bytes');
  const manifest = { ...release, sha256: createHash('sha256').update(bytes).digest('hex') };
  let downloads = 0, installs = 0;
  const updates = new ExtensionUpdates(() => 'staging', '0.13.0', () => {}, (async (input, options) => {
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    if (String(input).endsWith('.json')) return new Response(JSON.stringify(manifest));
    downloads++;
    return new Response(bytes);
  }) as typeof fetch);
  await updates.check();
  const install = async (actual: Buffer, version: string) => { installs++; assert.deepEqual(actual, bytes); assert.equal(version, '0.13.2'); };
  await Promise.all([updates.install(install), updates.install(install)]);
  assert.equal(downloads, 1);
  assert.equal(installs, 1);
  assert.equal(updates.state.status, 'ready');
  assert.equal(updates.state.installed, '0.13.0');
  await updates.check();
  await updates.install(install);
  assert.equal(installs, 1);
});

test('mismatched and oversized downloads never reach installation', async () => {
  for (const response of [new Response('wrong checksum'), new Response('large', { headers: { 'content-length': String(33 * 1024 * 1024) } })]) {
    let installs = 0;
    const updates = new ExtensionUpdates(() => 'staging', '0.13.0', () => {}, (async (input) =>
      String(input).endsWith('.json') ? new Response(JSON.stringify(release)) : response) as typeof fetch);
    await updates.check();
    await updates.install(async () => { installs++; });
    assert.equal(installs, 0);
    assert.equal(updates.state.status, 'available');
    assert.match(updates.state.message, /did not match|too large/);
  }
});

test('a changed service during download cannot install the previous service package', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('package');
  let environment: 'staging' | 'production' = 'staging';
  let complete!: (value: Response) => void;
  let installs = 0;
  const updates = new ExtensionUpdates(() => environment, '0.13.0', () => {}, (async (input) => {
    if (String(input).endsWith('.json')) return new Response(JSON.stringify({ ...release, sha256: createHash('sha256').update(bytes).digest('hex') }));
    return new Promise<Response>(r => { complete = r; });
  }) as typeof fetch);
  await updates.check();
  const installing = updates.install(async () => { installs++; });
  environment = 'production';
  await updates.check();
  complete(new Response(bytes));
  await installing;
  assert.equal(installs, 0);
  assert.equal(updates.state.status, 'available');
});

test('installer failure remains actionable and makes no automatic retry', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('package');
  let calls = 0;
  const updates = new ExtensionUpdates(() => 'staging', '0.13.0', () => {}, (async (input) =>
    String(input).endsWith('.json') ? new Response(JSON.stringify({ ...release, sha256: createHash('sha256').update(bytes).digest('hex') })) : new Response(bytes)) as typeof fetch);
  await updates.check();
  await updates.install(async () => { calls++; throw new Error('VS Code declined'); });
  assert.equal(calls, 1);
  assert.equal(updates.state.status, 'available');
  assert.match(updates.state.message, /could not be installed/);
});

test('concurrent checks share the same request and current versions cannot install', async () => {
  let requests = 0, installs = 0;
  const updates = new ExtensionUpdates(() => 'staging', '0.13.2', () => {}, (async () => {
    requests++; return new Response(JSON.stringify(release));
  }) as typeof fetch);
  await Promise.all([updates.check(), updates.check()]);
  assert.equal(requests, 1);
  await updates.install(async () => { installs++; });
  assert.equal(installs, 0);
  assert.equal(updates.state.status, 'current');
});

test('automatic failure budget survives activation and manual installation can recover', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('package');
  const persisted = new Map<string, boolean>();
  const store = { get: (key: string) => persisted.get(key), update: async (key: string, value: boolean) => { persisted.set(key, value); } };
  const make = () => new ExtensionUpdates(() => 'staging', '0.13.0', () => {}, (async (input) =>
    String(input).endsWith('.json') ? new Response(JSON.stringify({ ...release, sha256: createHash('sha256').update(bytes).digest('hex') })) : new Response(bytes)) as typeof fetch);
  let installs = 0;
  const failing = async () => { installs++; throw new Error('offline'); };
  let updates = make();
  await updates.check();
  await updates.installAutomatically(store, failing);
  await updates.check();
  await updates.installAutomatically(store, failing);
  updates = make(); // new activation, same durable store
  await updates.check();
  await updates.installAutomatically(store, failing);
  assert.equal(installs, 1);
  await updates.install(async () => { installs++; });
  assert.equal(installs, 2);
  assert.equal(updates.state.status, 'ready');
});

test('shutdown aborts owned requests and cannot publish a late release', async () => {
  let signal: AbortSignal | undefined;
  let complete!: (value: Response) => void;
  const updates = new ExtensionUpdates(() => 'staging', '0.13.0', () => {}, ((_, options) => {
    signal = options?.signal ?? undefined;
    return new Promise<Response>(r => { complete = r; });
  }) as typeof fetch);
  const checking = updates.check();
  updates.dispose();
  assert.equal(signal?.aborted, true);
  complete(new Response(JSON.stringify(release)));
  await checking;
  assert.notEqual(updates.state.status, 'available');
});
