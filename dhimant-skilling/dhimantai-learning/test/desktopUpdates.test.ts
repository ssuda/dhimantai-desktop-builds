import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_RELEASES, DesktopUpdates, desktopArtifact, newerDesktopVersion } from '../src/desktopUpdates';
import { ExtensionUpdates } from '../src/updates';

const target = { version: '1.143.10007-preview.7', environment: 'staging', platform: 'macos', arch: 'arm64' };
const bytes = Buffer.from('verified installer fixture');
const artifact = { platform: 'macos', arch: 'arm64', channel: 'preview', version: '1.143.10008-preview.8',
  githubUrl: 'https://github.com/ssuda/dhimantai-downloads/releases/download/v1.143.10008-preview.8/dhimantAI-darwin-arm64.dmg',
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const manifest = { schemaVersion: 2, distribution: 'dhimantai-desktop', environment: 'staging', artifacts: [artifact] };

test('desktop releases never downgrade or confuse stable and preview ordering', () => {
  assert.equal(newerDesktopVersion(artifact.version, target.version), true);
  assert.equal(newerDesktopVersion(target.version, artifact.version), false);
  assert.equal(newerDesktopVersion('1.143.10008', artifact.version), true);
  assert.equal(newerDesktopVersion(artifact.version, '1.143.10008'), false);
  assert.equal(newerDesktopVersion('1.143.10008-preview.10', '1.143.10008-preview.9'), true);
  assert.equal(newerDesktopVersion('bad', target.version), false);
});

test('native update selection requires installation channel, exact CPU and owned release URL', () => {
  assert.equal(desktopArtifact(manifest, target)?.version, artifact.version);
  assert.equal(desktopArtifact(manifest, { ...target, version: artifact.version }), undefined);
  for (const invalid of [null, { ...manifest, environment: 'production' },
    { ...manifest, artifacts: [{ ...artifact, arch: 'x64' }] },
    { ...manifest, artifacts: [artifact, artifact] },
    ...['https://evil.test/setup.dmg', artifact.githubUrl.replace('/ssuda/', '/someone/'),
      artifact.githubUrl.replace('v1.143.10008', 'v1.143.10007'), artifact.githubUrl + '?other=1'].map(githubUrl =>
      ({ ...manifest, artifacts: [{ ...artifact, githubUrl }] })),
    ...[{ bytes: 0 }, { bytes: 2 ** 32 }, { sha256: 'bad' }, { version: 'invalid' }].map(value =>
      ({ ...manifest, artifacts: [{ ...artifact, ...value }] })),
  ]) assert.throws(() => desktopArtifact(invalid, target));
  assert.throws(() => desktopArtifact(manifest, { ...target, version: '1.143.10006' }));
});

async function fixture(fetcher: typeof fetch, run: (updates: DesktopUpdates, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-updates-test-'));
  const updates = new DesktopUpdates(target, directory, () => {}, fetcher);
  try { await run(updates, directory); } finally { updates.dispose(); await rm(directory, { recursive: true, force: true }); }
}
const goodFetch = (async (input: any, options?: RequestInit) => {
  assert.equal(options?.credentials, 'omit');
  return new Response(String(input) === DESKTOP_RELEASES ? JSON.stringify(manifest) : bytes);
}) as typeof fetch;

test('extension-only releases install automatically without downloading the unchanged desktop app', async () => {
  const requested: string[] = [];
  const extensionRelease = { extension: 'optficial.dhimantai-learning', version: '0.39.21',
    file: 'dhimantai-learning.vsix', sha256: createHash('sha256').update(bytes).digest('hex') };
  const fetcher = (async input => {
    const url = String(input); requested.push(url);
    if (url === DESKTOP_RELEASES) return new Response(JSON.stringify({ ...manifest,
      artifacts: [{ ...artifact, version: target.version, extensionVersion: '0.39.21',
        githubUrl: artifact.githubUrl.replace(artifact.version, target.version) }] }));
    if (url.endsWith('/downloads/dhimantai-learning.json')) return new Response(JSON.stringify(extensionRelease));
    if (url.endsWith('/downloads/dhimantai-learning.vsix')) return new Response(bytes);
    throw new Error('An extension update must never request a desktop installer: ' + url);
  }) as typeof fetch;
  await fixture(fetcher, async (desktop, directory) => {
    const learning = new ExtensionUpdates(() => 'staging', '0.39.20', () => {}, fetcher);
    let installed = '';
    try {
      await Promise.all([desktop.check(), learning.check()]);
      assert.equal(desktop.state.status, 'current');
      assert.equal(learning.state.status, 'available');
      await learning.installAutomatically({get: () => undefined, update: async () => {}}, async (actual, version) => {
        assert.deepEqual(actual, bytes); installed = version;
      });
      await desktop.download(); // Even an explicit call must respect the app-version gate.
      assert.equal(installed, '0.39.21');
      assert.equal(learning.state.status, 'ready');
      assert.equal(desktop.state.status, 'current');
      assert.equal(await desktop.installerPath(), undefined);
      assert.deepEqual(await readdir(directory), []);
      assert.equal(requested.length, 3, 'only two small manifests and the VSIX were fetched');
      assert.ok(!requested.some(url => url.startsWith('https://github.com/')));
    } finally { learning.dispose(); }
  });
});

test('concurrent checks and downloads coalesce; verified cache survives restart and is rechecked before opening', async () => {
  let downloads = 0;
  await fixture((async (input, options) => {
    if (String(input) !== DESKTOP_RELEASES) downloads++;
    return goodFetch(input, options);
  }) as typeof fetch, async (updates, directory) => {
    await Promise.all([updates.check(), updates.check()]);
    assert.equal(updates.state.status, 'available');
    await Promise.all([updates.download(), updates.download()]);
    assert.equal(downloads, 1);
    assert.equal(updates.state.status, 'ready');
    assert.equal(updates.state.installed, target.version);
    const path = await updates.installerPath(); assert.ok(path);
    const restarted = new DesktopUpdates(target, directory, () => {}, goodFetch);
    try { await restarted.check(); assert.equal(restarted.state.status, 'ready'); } finally { restarted.dispose(); }
    await writeFile(path, 'corrupted');
    assert.equal(await updates.installerPath(), undefined);
    assert.equal(updates.state.status, 'available');
  });
});

test('bad checksums, truncation, excess bytes and untrusted redirects never produce an installer', async () => {
  for (const response of [() => new Response(Buffer.alloc(bytes.length)), () => new Response('short'),
    () => new Response(Buffer.alloc(bytes.length + 1)),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.test/setup.dmg' } }),
    () => new Response(null, { status: 503 })]) {
    await fixture((async input => String(input) === DESKTOP_RELEASES ? new Response(JSON.stringify(manifest)) : response()) as typeof fetch,
      async (updates, directory) => {
        await updates.check(); await updates.download();
        assert.equal(updates.state.status, 'available');
        assert.equal(await updates.installerPath(), undefined);
        assert.deepEqual(await readdir(directory), []);
      });
  }
});

test('GitHub asset redirect is followed without credentials and progress reaches ready', async () => {
  const urls: string[] = [];
  await fixture((async (input, options) => {
    const url = String(input); urls.push(url);
    assert.equal(options?.credentials, 'omit');
    if (url === DESKTOP_RELEASES) return new Response(JSON.stringify(manifest));
    assert.equal(options?.redirect, 'manual');
    return url === artifact.githubUrl ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } }) : new Response(bytes);
  }) as typeof fetch, async updates => {
    await updates.check(); await updates.download();
    assert.equal(updates.state.status, 'ready'); assert.equal(urls.length, 3);
  });
});

test('missing or oversized metadata is unavailable rather than up to date', async () => {
  for (const response of [() => new Response(null, { status: 404 }), () => new Response('x'.repeat(128 * 1024 + 1))]) {
    await fixture((async () => response()) as typeof fetch, async updates => {
      await updates.check(); assert.equal(updates.state.status, 'unavailable');
    });
  }
});

test('shutdown cancels downloads, removes partial bytes and prevents late ready state', async () => {
  let complete!: (response: Response) => void, signal: AbortSignal | undefined;
  await fixture((async (input, options) => {
    if (String(input) === DESKTOP_RELEASES) return new Response(JSON.stringify(manifest));
    signal = options?.signal ?? undefined;
    return new Promise<Response>(resolve => { complete = resolve; });
  }) as typeof fetch, async (updates, directory) => {
    await updates.check(); const pending = updates.download();
    while (!complete) await new Promise(resolve => setImmediate(resolve));
    updates.dispose(); assert.equal(signal?.aborted, true); complete(new Response(bytes));
    await pending;
    assert.notEqual(updates.state.status, 'ready'); assert.deepEqual(await readdir(directory), []);
  });
});
