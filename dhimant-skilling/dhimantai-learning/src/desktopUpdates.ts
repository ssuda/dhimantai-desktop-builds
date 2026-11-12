import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const DESKTOP_RELEASES = 'https://dhimant.ai/upskill/releases.json';
const MAX_INSTALLER = 1024 * 1024 * 1024;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/;
export interface DesktopTarget { version: string; environment: string; platform: string; arch: string }
export interface DesktopArtifact { version: string; githubUrl: string; bytes: number; sha256: string }
export interface DesktopUpdateState {
  status: 'unchecked' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'unavailable';
  installed: string; available?: string; progress?: number; message: string;
}

export function newerDesktopVersion(available: string, installed: string): boolean {
  const a = VERSION.exec(available), b = VERSION.exec(installed);
  if (!a || !b) return false;
  for (let i = 1; i <= 4; i++) {
    const x = a[i] === undefined ? Infinity : Number(a[i]);
    const y = b[i] === undefined ? Infinity : Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

/** Match the installed distribution, never the currently selected API service. */
export function desktopArtifact(data: unknown, target: DesktopTarget): DesktopArtifact | undefined {
  const manifest = data as any;
  if (manifest?.schemaVersion !== 2 || manifest.distribution !== 'dhimantai-desktop'
      || manifest.environment !== target.environment || !Array.isArray(manifest.artifacts)) {
    throw new Error('No desktop release is published for this installation’s channel.');
  }
  const matches = manifest.artifacts.filter((item: any) => item.platform === target.platform && item.arch === target.arch
    && item.channel === (target.version.includes('-preview.') ? 'preview' : 'stable'));
  if (matches.length !== 1) throw new Error('No desktop release is published for this computer.');
  const item = matches[0];
  if (typeof item.version !== 'string' || !VERSION.test(item.version)) throw new Error('Invalid desktop release version.');
  if (!newerDesktopVersion(item.version, target.version)) return undefined;
  const extension = { windows: '.exe', macos: '.dmg', linux: '.deb' }[target.platform];
  if (!extension || typeof item.githubUrl !== 'string' || !Number.isSafeInteger(item.bytes)
      || item.bytes <= 0 || item.bytes > MAX_INSTALLER || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) {
    throw new Error('Invalid desktop release information.');
  }
  const url = new URL(item.githubUrl);
  const prefix = `/ssuda/dhimantai-downloads/releases/download/v${item.version}/`;
  const file = url.pathname.slice(prefix.length);
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith(prefix) || !/^[a-zA-Z0-9._-]+$/.test(file) || !file.endsWith(extension)) {
    throw new Error('The desktop installer is not from the official release.');
  }
  return { version: item.version, githubUrl: url.href, bytes: item.bytes, sha256: item.sha256 };
}

export async function installedDesktop(appRoot: string, platform = process.platform, arch = process.arch): Promise<DesktopTarget> {
  const product = JSON.parse(await readFile(join(appRoot, 'product.json'), 'utf8'));
  const bundle = JSON.parse(await readFile(join(appRoot, 'extensions/optficial.dhimantai-learning/package.json'), 'utf8'));
  const version = product.dhimantaiDesktop?.version;
  const environment = bundle.contributes?.configurationDefaults?.['dhimantai.environment'];
  const targetPlatform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform as string];
  if (product.applicationName !== 'dhimantai' || typeof version !== 'string' || !VERSION.test(version)
      || !['staging', 'production'].includes(environment) || !targetPlatform || !['x64', 'arm64'].includes(arch)) {
    throw new Error('Desktop release information is unavailable for this installation.');
  }
  return { version, environment, platform: targetPlatform, arch };
}

async function verifiedFile(path: string, release: DesktopArtifact): Promise<boolean> {
  try {
    if ((await stat(path)).size !== release.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === release.sha256;
  } catch { return false; }
}

/** Stage an owned installer without executing it or interrupting a running lesson. */
export class DesktopUpdates {
  state: DesktopUpdateState;
  private release?: DesktopArtifact;
  private operation?: Promise<void>;
  private readonly abort = new AbortController();
  private disposed = false;
  constructor(private readonly target: DesktopTarget, private readonly directory: string,
    private readonly changed: () => void, private readonly fetcher: typeof fetch = fetch) {
    this.state = { status: 'unchecked', installed: target.version, message: 'Check for desktop updates.' };
  }
  private set(state: DesktopUpdateState) { if (!this.disposed) { this.state = state; this.changed(); } }
  private run(action: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.operation) return this.operation;
    const promise = action().finally(() => { if (this.operation === promise) this.operation = undefined; });
    this.operation = promise;
    return promise;
  }
  dispose() { this.disposed = true; this.abort.abort(); }
  private get path() { return this.release ? join(this.directory, basename(new URL(this.release.githubUrl).pathname)) : undefined; }
  check(): Promise<void> {
    return this.run(async () => {
      if (this.state.status === 'ready') return;
      this.release = undefined;
      this.set({ status: 'checking', installed: this.target.version, message: 'Checking desktop updates…' });
      try {
        const response = await this.fetcher(DESKTOP_RELEASES, { credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok || !response.body) throw new Error('Could not check desktop updates. Try again later.');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > 128 * 1024) throw new Error('Desktop release information is too large.');
            chunks.push(value);
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
        this.release = desktopArtifact(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.target);
        if (!this.release) {
          this.set({ status: 'current', installed: this.target.version, message: 'Your desktop app is up to date.' });
          return;
        }
        const ready = await verifiedFile(this.path!, this.release);
        this.set({ status: ready ? 'ready' : 'available', installed: this.target.version, available: this.release.version,
          message: ready ? 'Installer verified and ready. Open it when you finish your lesson.' : `Desktop ${this.release.version} is available.` });
      } catch (error) {
        this.set({ status: 'unavailable', installed: this.target.version,
          message: error instanceof Error ? error.message : 'Could not check desktop updates.' });
      }
    });
  }
  download(): Promise<void> {
    return this.run(async () => {
      const release = this.release, destination = this.path;
      if (this.state.status !== 'available' || !release || !destination) return;
      this.set({ ...this.state, status: 'downloading', progress: 0, message: 'Downloading desktop update…' });
      let temporary: string | undefined;
      try {
        await mkdir(this.directory, { recursive: true });
        temporary = await mkdtemp(join(this.directory, '.download-'));
        let url = release.githubUrl;
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(15 * 60 * 1000)]);
        let response: Response | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
          response = await this.fetcher(url, { credentials: 'omit', redirect: 'manual', signal });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location) throw new Error('The installer download has an invalid redirect.');
          const next = new URL(location, url);
          if (next.protocol !== 'https:' || next.username || next.password
              || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) {
            throw new Error('The installer download left the official release hosts.');
          }
          url = next.href;
        }
        if (!response?.ok || !response.body) throw new Error('Could not download the desktop installer. Try again.');
        const partial = join(temporary, 'installer.part');
        const file = await open(partial, 'wx');
        const reader = response.body.getReader();
        const hash = createHash('sha256'); let size = 0, lastProgress = -1;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > release.bytes) throw new Error('The installer size did not match the release. Nothing was installed.');
            hash.update(value); await file.writeFile(value);
            const progress = Math.floor(size / release.bytes * 100);
            if (progress !== lastProgress) {
              lastProgress = progress;
              this.set({ ...this.state, progress, message: `Downloading desktop update… ${progress}%` });
            }
          }
        } finally { await file.close(); await reader.cancel(); reader.releaseLock(); }
        if (size !== release.bytes || hash.digest('hex') !== release.sha256) {
          throw new Error('The installer checksum did not match the release. Nothing was installed.');
        }
        if (this.disposed) return;
        await rename(partial, destination);
        this.set({ status: 'ready', installed: this.target.version, available: release.version,
          message: 'Installer verified and ready. Open it when you finish your lesson.' });
      } catch {
        // Do not expose signed GitHub redirect URLs or raw network diagnostics.
        this.set({ status: 'available', installed: this.target.version, available: release.version,
          message: 'The installer could not be downloaded and verified. Retry the download; nothing was installed.' });
      } finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
    });
  }
  async installerPath(): Promise<string | undefined> {
    if (this.state.status !== 'ready' || !this.release || !this.path || this.disposed) return undefined;
    // Revalidate cached bytes immediately before handing off to the operating system.
    if (await verifiedFile(this.path, this.release)) return this.path;
    this.set({ status: 'available', installed: this.target.version, available: this.release.version,
      message: 'The saved installer changed. Download and verify it again.' });
    return undefined;
  }
}
