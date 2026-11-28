import { after, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as assert from 'node:assert/strict';
import { ExtensionUpdates, automaticUpdates, newerVersion, releaseVersion } from '../src/updates';

test('desktop silently updates by default while explicit opt-out and VS Code preferences are respected', () => {
  assert.equal(automaticUpdates('dhimantAI', undefined, false), true);
  assert.equal(automaticUpdates('dhimantAI', false, true), false);
  assert.equal(automaticUpdates('Visual Studio Code', undefined, false), false);
  assert.equal(automaticUpdates('Visual Studio Code', true), true);
});

const profiles = mkdtempSync(join(tmpdir(), 'learning-update-tests-'));
after(() => rm(profiles, {recursive:true, force:true}));
const cache = () => mkdtempSync(join(profiles, 'profile-'));

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
for (const [channel, origin] of [
  ['staging', 'https://app-staging.dhimant.ai'],
  ['production', 'https://app.dhimant.ai'],
] as const) {
  test(`the ${channel} VSIX feed offers updates only from its own host`, async () => {
    let url = '', options: RequestInit | undefined;
    const updates = new ExtensionUpdates(cache(), () => channel, '0.13.0', () => {}, (async (input, init) => {
      url = String(input); options = init; return new Response(JSON.stringify(release));
    }) as typeof fetch);
    await updates.check();
    assert.equal(url, origin + '/downloads/dhimantai-learning.json');
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    assert.equal(updates.state.status, 'available');
    assert.equal(updates.downloadUrl, origin + '/downloads/dhimantai-learning.vsix');
    assert.equal(updates.state.installed, '0.13.0', 'checking is not installation');
  });
}
test('missing manifest is unavailable, never up to date; a late response cannot cross environments', async () => {
  const failed = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', () => {}, (async () => new Response('', { status: 404 })) as typeof fetch);
  await failed.check();
  assert.equal(failed.state.status, 'unavailable');
  let environment: 'staging' | 'production' = 'staging';
  let done!: (value: Response) => void;
  const pending = new ExtensionUpdates(cache(), () => environment, '0.13.0', () => {}, (() => new Promise<Response>(r => { done = r; })) as typeof fetch);
  const checking = pending.check(); environment = 'production'; done(new Response(JSON.stringify(release))); await checking;
  assert.notEqual(pending.state.status, 'available');
  assert.equal(pending.state.available, undefined);
});

test('verified update installs once and keeps the running version until reload', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('test package bytes');
  const manifest = { ...release, sha256: createHash('sha256').update(bytes).digest('hex') };
  let downloads = 0, installs = 0;
  const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', () => {}, (async (input, options) => {
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
    const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', () => {}, (async (input) =>
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
  let started!: () => void;
  const fetching = new Promise<void>(resolve => { started = resolve; });
  const updates = new ExtensionUpdates(cache(), () => environment, '0.13.0', () => {}, (async (input) => {
    if (String(input).endsWith('.json')) return new Response(JSON.stringify({ ...release, sha256: createHash('sha256').update(bytes).digest('hex') }));
    return new Promise<Response>(r => { complete = r; started(); });
  }) as typeof fetch);
  await updates.check();
  const installing = updates.install(async () => { installs++; });
  await fetching;
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
  const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', () => {}, (async (input) =>
    String(input).endsWith('.json') ? new Response(JSON.stringify({ ...release, sha256: createHash('sha256').update(bytes).digest('hex') })) : new Response(bytes)) as typeof fetch);
  await updates.check();
  await updates.install(async () => { calls++; throw new Error('VS Code declined'); });
  assert.equal(calls, 1);
  assert.equal(updates.state.status, 'available');
  assert.match(updates.state.message, /could not be installed/);
});

test('concurrent checks share the same request and current versions cannot install', async () => {
  let requests = 0, installs = 0;
  const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.2', () => {}, (async () => {
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
  const make = () => new ExtensionUpdates(cache(), () => 'staging', '0.13.0', () => {}, (async (input) =>
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
  const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', () => {}, ((_, options) => {
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

test('checks the minimum editor version before downloading an incompatible VSIX', async () => {
  const requests: string[] = [];
  const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', () => {}, async input => {
    requests.push(String(input)); return new Response(JSON.stringify({...release, minimumEditorVersion:'1.120.0'}));
  }, '1.118.0');
  await updates.check();
  assert.equal(updates.state.status, 'incompatible');
  assert.match(updates.state.message, /1\.120\.0/);
  await updates.install(async () => assert.fail('incompatible extension installed'));
  assert.equal(requests.length, 1);
});

test('extension progress uses streamed bytes only when the response size is known', async () => {
  const {createHash} = await import('node:crypto');
  const bytes = Buffer.from('1234'), sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const known of [true, false]) {
    const percentages: number[] = [];
    const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', state => {
      if (state.progress !== undefined) percentages.push(state.progress);
    }, async input => {
      if (String(input).endsWith('.json')) return Response.json({...release, sha256});
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(bytes.subarray(0,1)); controller.enqueue(bytes.subarray(1)); controller.close();
      }}), {headers:known ? {'content-length':'4'} : undefined});
    });
    await updates.check(); await updates.install(async () => {});
    assert.equal(updates.state.status,'ready');
    assert.deepEqual(percentages, known ? [25,100] : []);
    updates.dispose();
  }
});

for (const stalls of [false, true]) {
  test(stalls ? 'a stalled VSIX download offers an in-app retry' : 'a progressing VSIX download survives the old 30-second cutoff', async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    t.mock.method(AbortSignal, 'timeout', (ms:number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('deadline')), ms);
      return controller.signal;
    });
    const {createHash} = await import('node:crypto');
    const bytes = Buffer.from('abc'), sha256 = createHash('sha256').update(bytes).digest('hex');
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let received = 0;
    const updates = new ExtensionUpdates(cache(), () => 'staging', '0.13.0', state => { received = state.progress ?? received; }, async (url, init) => {
      if (String(url).endsWith('.json')) return Response.json({...release, sha256});
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {once:true});
        },
        pull() { started(); },
      }), {headers:{'content-length':String(bytes.length)}});
    });
    await updates.check();
    let installed:Buffer|undefined;
    const task = updates.install(async value => {installed = value;});
    await reading;
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const [index, byte] of bytes.entries()) {
      t.mock.timers.tick(25_000);
      body.enqueue(Uint8Array.of(byte));
      while (received < Math.floor(100*(index+1)/bytes.length)) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (stalls) t.mock.timers.tick(60_001);
    else body.close();
    await task;
    if (stalls) {
      assert.equal(installed, undefined);
      assert.equal(updates.state.retry, true);
      assert.match(updates.state.message, /stopped receiving data/);
    } else {
      assert.deepEqual(installed, bytes);
      assert.equal(updates.state.status, 'ready');
    }
    updates.dispose();
  });
}

test('a fresh window resumes the interrupted VSIX and only installs verified bytes', async () => {
  const {createHash} = await import('node:crypto');
  const bytes = Buffer.from('a complete VSIX');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = cache(), offset = 4;
  const ranges: (string|null)[] = [];
  const make = () => new ExtensionUpdates(directory, () => 'staging', '0.13.0', () => {}, async (url, init) => {
    if (String(url).endsWith('.json')) return Response.json({...release, sha256});
    ranges.push(new Headers(init?.headers).get('range'));
    if (ranges.length === 1) return new Response(bytes.subarray(0, offset), {headers:{'content-length':String(bytes.length)}});
    return new Response(bytes.subarray(offset), {status:206, headers:{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}});
  });
  const first = make(); await first.check(); await first.install(async () => assert.fail('partial VSIX reached installation'));
  assert.equal(first.state.retry, true); first.dispose();
  const second = make(); await second.check();
  let installed: Buffer|undefined;
  await second.install(async b => {installed=b;});
  assert.deepEqual(ranges, [null, 'bytes=4-']);
  assert.deepEqual(installed, bytes); assert.equal(second.state.status, 'ready');
  second.dispose();
});
