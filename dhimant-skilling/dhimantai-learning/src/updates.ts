import { createHash } from 'node:crypto';
import type { EnvironmentName } from './environments';
import { WEB_APP_ORIGINS as ORIGINS } from './appLinks';

const VERSION = /^\d+\.\d+\.\d+$/;
class UpdateCheckError extends Error {}
export function newerVersion(available: string, installed: string) {
  if (!VERSION.test(available) || !VERSION.test(installed)) return false;
  const a = available.split('.').map(Number), b = installed.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

interface Release { extension: string; version: string; file: string; sha256: string }
export function releaseVersion(data: unknown): string {
  const release = data as Partial<Release> | null;
  if (release?.extension !== 'optficial.dhimantai-learning' || !VERSION.test(release?.version ?? '')
      || release?.file !== 'dhimantai-learning.vsix' || !/^[a-f0-9]{64}$/.test(release?.sha256 ?? '')) {
    throw new UpdateCheckError('The release information is invalid. Try again or download the VSIX manually.');
  }
  return release.version!;
}

export interface UpdateStatus {
  status: 'unchecked' | 'checking' | 'available' | 'current' | 'unavailable' | 'installing' | 'ready';
  installed: string;
  available?: string;
  message: string;
}

/** Desktop updates are on unless the learner explicitly opts out. Bundled
 * previews used a false default; that is not a learner preference. */
export function automaticUpdates(appName:string, explicit:boolean|undefined, configured=false) {
  return explicit ?? (appName==='dhimantAI' || configured);
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new UpdateCheckError('The update could not be downloaded. Try again later.');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new UpdateCheckError('The update file is too large. Download the VSIX manually.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new UpdateCheckError('The update file is too large. Download the VSIX manually.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Public fixed-origin releases only. One attempt, no background retry loop.
 * The injected installer receives bytes only after SHA-256 verification. */
export class ExtensionUpdates {
  state: UpdateStatus;
  private request = 0;
  private release?: Release & { environment: EnvironmentName };
  private checking?: { environment: EnvironmentName; promise: Promise<void> };
  private installing?: Promise<void>;
  private abort = new AbortController();
  constructor(private readonly environment: () => EnvironmentName, private readonly installed: string,
    private readonly changed: (state: UpdateStatus) => void, private readonly fetcher: typeof fetch = fetch) {
    this.state = { status: 'unchecked', installed, message: 'Check for updates from your selected dhimantAI service.' };
  }
  get downloadUrl() { const origin = ORIGINS[this.environment()]; return origin ? `${origin}/downloads/dhimantai-learning.vsix` : undefined; }
  private set(state: UpdateStatus) { this.state = state; this.changed(state); }
  dispose() { ++this.request; this.abort.abort(); }
  check(): Promise<void> {
    const environment = this.environment();
    if (this.checking?.environment === environment) return this.checking.promise;
    if (this.state.status === 'ready' && this.release?.environment === environment) return Promise.resolve();
    if (this.installing && this.release?.environment === environment) return Promise.resolve();
    const promise = this.performCheck(environment);
    this.checking = { environment, promise };
    void promise.finally(() => { if (this.checking?.promise === promise) this.checking = undefined; });
    return promise;
  }
  private async performCheck(environment: EnvironmentName) {
    const request = ++this.request;
    this.abort.abort();
    this.abort = new AbortController();
    this.release = undefined;
    this.set({ status: 'checking', installed: this.installed, message: 'Checking the available extension version…' });
    try {
      const origin = ORIGINS[environment];
      if (!origin) throw new UpdateCheckError('Use your locally built VSIX for the local service.');
      const response = await this.fetcher(`${origin}/downloads/dhimantai-learning.json`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
      });
      const release = JSON.parse((await readBounded(response, 16 * 1024)).toString('utf8'));
      const available = releaseVersion(release);
      if (request !== this.request || environment !== this.environment()) return;
      this.release = { ...release, environment };
      const newer = newerVersion(available, this.installed);
      this.set({ status: newer ? 'available' : 'current', installed: this.installed, available,
        message: newer ? `Version ${available} is available. Install the update here, then reload when you are ready.`
          : available === this.installed ? 'You have the latest published version for this service.' : 'Your installed version is newer than this service’s published version.' });
    } catch (error) {
      if (request !== this.request || environment !== this.environment()) return;
      this.set({ status: 'unavailable', installed: this.installed,
        message: error instanceof UpdateCheckError ? error.message : 'Could not check for updates. Try again or download the VSIX manually.' });
    }
  }
  install(installer: (bytes: Buffer, version: string) => Promise<void>): Promise<void> {
    if (this.installing) return this.installing;
    const promise = this.performInstall(installer);
    this.installing = promise;
    void promise.finally(() => { if (this.installing === promise) this.installing = undefined; });
    return promise;
  }
  async installAutomatically(store: { get(key: string): unknown; update(key: string, value: boolean): PromiseLike<void> },
    installer: (bytes: Buffer, version: string) => Promise<void>) {
    const release = this.release;
    if (this.state.status !== 'available' || !release || release.environment !== this.environment()) return;
    const key = `automaticUpdateAttempt:${release.environment}:${release.version}`;
    if (store.get(key)) return;
    // Save before the attempt; a new activation must not retry a failed install.
    await store.update(key, true);
    if (release === this.release) await this.install(installer);
  }
  private async performInstall(installer: (bytes: Buffer, version: string) => Promise<void>) {
    const release = this.release;
    if (this.state.status !== 'available' || !release || release.environment !== this.environment()) return;
    const request = this.request;
    const stillSelected = () => request === this.request && release.environment === this.environment();
    this.set({ ...this.state, status: 'installing', message: `Downloading and verifying ${release.version}…` });
    try {
      const response = await this.fetcher(`${ORIGINS[release.environment]}/downloads/dhimantai-learning.vsix`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
      });
      const bytes = await readBounded(response, 32 * 1024 * 1024);
      if (!stillSelected()) return;
      if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
        throw new UpdateCheckError('The download did not match the verified release. Nothing was installed. Check for updates and try again.');
      }
      this.set({ ...this.state, message: `Installing ${release.version}…` });
      await installer(bytes, release.version);
      if (!stillSelected()) return;
      this.set({ ...this.state, status: 'ready', message: `Version ${release.version} is installed and will activate when you next open the app. This window continues with ${this.installed}.` });
    } catch (error) {
      if (!stillSelected()) return;
      this.set({ status: 'available', installed: this.installed, available: release.version,
        message: error instanceof UpdateCheckError ? error.message : 'The update could not be installed. Try Install update again or download the VSIX manually.' });
    }
  }
}
