import {createRequire} from 'node:module';
import {join} from 'node:path';

/** The task fields the desktop needs to re-check a learner's claim. */
export interface VerifiableTask {
  id: string; doctype: string; expected: Record<string, unknown>; readOnly?: boolean;
  also?: {doctype: string; record: string; expected: Record<string, unknown>}[];
}

/**
 * Re-reads a claimed ERPNext record as the sandbox administrator and applies the same predicate as the
 * in-page guide. Progress therefore never rests on what the page reports: a record that does not
 * exist, belongs to another login, or does not match is not counted.
 */
export class ErpVerifier {
  private cookie = '';
  private readonly equal: (actual: unknown, expected: unknown) => boolean;
  constructor(private readonly origin: string, private readonly adminPassword: string, mediaDir: string,
      private readonly request: typeof fetch = fetch, private readonly user = 'Administrator') {
    // One predicate for page and desktop: the guide exports it for CommonJS callers.
    this.equal = createRequire(__filename)(join(mediaDir, 'guide.js')).equal;
  }
  private async login() {
    const response = await this.request(this.origin + '/api/method/login', {method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({usr: this.user, pwd: this.adminPassword}), signal: AbortSignal.timeout(15000)});
    const sid = /(?:^|[,;\s])sid=([^;,\s]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    if (!response.ok || !sid || sid === 'Guest') throw new Error('The ERPNext sandbox did not accept the administrator login.');
    this.cookie = 'sid=' + sid;
  }
  private async read(doctype: string, name: string): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie) await this.login();
      const response = await this.request(`${this.origin}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
        {headers: {Cookie: this.cookie, Accept: 'application/json'}, signal: AbortSignal.timeout(15000)});
      if (response.status === 404) return undefined;
      if (response.status === 401 || response.status === 403) { this.cookie = ''; continue; }
      if (!response.ok) throw new Error('ERPNext could not return the record.');
      return (await response.json() as {data: Record<string, unknown>}).data;
    }
    throw new Error('ERPNext refused the administrator session.');
  }
  /** Resolves the template for this learner and earlier verified records, then checks the record and its consequences. */
  async verify(task: VerifiableTask, record: string, learner: string, earlier: Record<string, string>): Promise<boolean> {
    const tag = learner.slice(0, 10);
    const resolve = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('{{tag}}', tag)
      .replaceAll('{{company}}', 'Training ' + tag)
      .replace(/\{\{ref:([a-z0-9-]+)\}\}/g, (_, id: string) => JSON.stringify(earlier[id] ?? '\u0000missing').slice(1, -1)));
    const expected = resolve(task.expected);
    if (JSON.stringify(expected).includes('\u0000missing')) return false;
    const doc = await this.read(task.doctype, record);
    if (!doc || !this.equal(doc, expected)) return false;
    // A learner's work is their own document; only the read-only company task inspects a prepared record.
    if (!task.readOnly && doc.owner !== `learner-${learner}@training.invalid`) return false;
    for (const extra of resolve(task.also ?? [])) {
      const linked = await this.read(extra.doctype, extra.record);
      if (!linked || !this.equal(linked, extra.expected)) return false;
    }
    return true;
  }
}
