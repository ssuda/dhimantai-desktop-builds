import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import type {Page} from 'playwright-core';
import {ErpSandbox, sandboxKey} from '../browserSandbox';
import {ensurePodman} from '../podman';
import {BrowserLearning, BrowserTask} from '../browserLearning';
import {EnvironmentName} from '../environments';
import {FrappeServer} from './frappe';
import {openInjectedTab, InjectedTab} from './desktopBrowser';
import {connectPlaywright, discoverWebMcp} from './playwrightBrowser';
import {Replayer} from './replay';
import {TaskVerifier} from './verifier';
import {TourTask, freshReplayTasks} from './authoringModel';
import {AppField} from './types';

const safe = (f: AppField) => !f.readOnly && !f.hidden && f.type !== 'other' &&
  !/(password|secret|token|credential|email|phone|mobile|address|iban|bank_account)/i.test(f.name);
export function captureFields(fields: AppField[]): AppField[] {
  return fields.filter(safe).slice(0, 80).map(f => ({...f, ...(f.fields ? {fields: f.fields.filter(safe).slice(0, 20)} : {})}));
}
export class AuthoringBrowser {
  private tab?: InjectedTab;
  private driver?: {page: Page; close(): Promise<void>};
  private learning = new BrowserLearning();
  private runtime?: ErpSandbox;
  private server?: FrappeServer;
  private learner = '';
  private origin = '';
  private media: string;
  private closed = false;
  private cancel = new AbortController();
  constructor(private context: vscode.ExtensionContext, private account: string, private environment: EnvironmentName,
      private current: () => Promise<boolean>, private report: (text: string) => void) {
    this.media = vscode.Uri.joinPath(context.extensionUri, 'media', 'browser').fsPath;
  }
  private async credential(key: string) {
    let value = await this.context.secrets.get(key);
    if (!value) {value = randomBytes(24).toString('hex'); await this.context.secrets.store(key, value);}
    return value;
  }
  private async active() {if (this.closed || !await this.current()) throw new Error('Reopen authoring with your current account.');}
  async open(tasks: TourTask[]) {
    await this.active();
    const key = sandboxKey(this.context.globalStorageUri.fsPath + ':' + this.environment);
    // A separate training company/login keeps author rehearsals out of learner progress and records.
    this.learner = sandboxKey('author:' + this.environment + ':' + this.account);
    const [admin, password] = await Promise.all([this.credential('browser.erpnext.admin.' + key),
      this.credential('browser.erpnext.learner.' + key + '.' + this.learner)]);
    const bin = await ensurePodman(this.report, () => {}, (file, args) => new Promise<void>((resolve, reject) => {
      const terminal = vscode.window.createTerminal({name: 'Install course runtime', shellPath: '/usr/bin/sudo', shellArgs: [file, ...args]});
      const closed = vscode.window.onDidCloseTerminal(t => {if (t !== terminal) return; closed.dispose();
        t.exitStatus?.code === 0 ? resolve() : reject(new Error('Runtime installation did not finish.'));});
      terminal.show();
    }), 8192);
    await this.active();
    this.runtime = new ErpSandbox(bin, vscode.Uri.joinPath(this.context.extensionUri, 'media', 'browser', 'erpnext').fsPath, key, () => {});
    this.origin = await this.runtime.start(admin, {id: this.learner, password}, this.report);
    await this.active();
    this.server = new FrappeServer(this.origin, 'Administrator', admin);
    const learnerServer = new FrappeServer(this.origin, `learner-${this.learner}@training.invalid`, password);
    let bridge: URLSearchParams | undefined;
    if (tasks.length) {
      const verifier = new TaskVerifier(this.server, this.media + '/player'), records: Record<string, string> = {};
      bridge = new URLSearchParams(await this.learning.start({origin: this.origin, account: this.account, environment: this.environment,
        learner: this.learner, tasks: tasks as BrowserTask[], current: async () => !this.closed && await this.current(),
        course: {id: 'author-preview', title: 'Author preview'},
        recordVerified: async (id, done) => {
          const task = tasks.find(t => t.id === id);
          const ok = !!task && await verifier.verify(task, done.record, `learner-${this.learner}@training.invalid`, this.learner.slice(0, 10), records);
          if (ok) records[id] = done.record;
          return ok;
        }}));
      this.learning.setConnection(this.account, this.environment, false, 'Author preview. Learner progress is separate.');
    }
    this.tab = await openInjectedTab({url: this.origin, home: '/desk', media: this.media, adapter: 'frappe',
      learner: this.learner, bridge, server: learnerServer});
    if (!this.tab?.transport) throw new Error('Tour authoring needs the dhimantAI desktop integrated browser.');
    await this.active();
    this.driver = await connectPlaywright(this.tab.transport, this.origin);
    await this.driver.page.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && new URL(request.url()).origin !== this.origin) return route.abort();
      return route.continue();
    });
    await this.driver.page.waitForFunction('!!window.dhimantaiApp?.ready()', null, {timeout: 20000});
    return discoverWebMcp(this.driver.page);
  }
  private async page() {
    await this.active();
    if (!this.driver || new URL(this.driver.page.url()).origin !== this.origin) throw new Error('Open the training app to continue.');
    return this.driver.page;
  }
  async focus(field: string) {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(field)) return;
    const page = await this.page();
    await page.evaluate(`window.dhimantaiApp?.scrollTo(${JSON.stringify(field)})`);
    const locator = page.locator(`.form-layout [data-fieldname="${field}"]:visible`).first();
    if (!await locator.isVisible()) throw new Error('Open this tour’s form first. This field may depend on an earlier value.');
    await locator.scrollIntoViewIfNeeded();
    await locator.highlight();
  }
  async beginCapture() {
    const page = await this.page();
    const form = await page.evaluate<string>('window.dhimantaiApp?.current()?.form');
    if (!form) throw new Error('Open a training form before capturing a demonstration.');
    const fields = captureFields((await this.server!.describe(form)).fields);
    // Read only the discovered business fields; capture no page text, cookies or credential inputs.
    const snapshot = await this.snapshot(fields);
    return {form, fields, snapshot};
  }
  private async snapshot(fields: AppField[]) {
    const page = await this.page();
    return page.evaluate<Record<string, unknown>>(`(() => {
      const values = window.dhimantaiApp?.current()?.values || {}, result = {};
      const scalar = v => typeof v === 'string' ? v.slice(0, 600) : typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean' ? v : null;
      for (const f of ${JSON.stringify(fields)}) {
        const value = values[f.name];
        if (f.type === 'table') result[f.name] = Array.isArray(value) ? value.slice(0, 10).map(row => Object.fromEntries((f.fields || []).filter(c => row[c.name] != null).map(c => [c.name, scalar(row[c.name])]))) : [];
        else result[f.name] = scalar(value);
      }
      return result;
    })()`);
  }
  async endCapture(capture: {form: string; fields: AppField[]; snapshot: Record<string, unknown>}) {
    const page = await this.page();
    if (await page.evaluate('window.dhimantaiApp?.current()?.form') !== capture.form) throw new Error('Return to the form where you started this demonstration.');
    const after = await this.snapshot(capture.fields), tag = this.learner.slice(0, 10);
    return Object.entries(after).filter(([field, value]) => value !== null && JSON.stringify(value) !== JSON.stringify(capture.snapshot[field]))
      .slice(0, 12).map(([field, value]) => ({field, value: JSON.parse(JSON.stringify(value)
        .replaceAll('Training ' + tag, '{{company}}').replaceAll(tag, '{{tag}}'))}));
  }
  async replay(tasks: TourTask[]) {
    const page = await this.page();
    const definitions = freshReplayTasks(tasks, randomBytes(4).toString('hex'));
    const tag = this.learner.slice(0, 10);
    const replayer = new Replayer(this.tab!.client, this.tab!.sessionId, this.server!, new TaskVerifier(this.server!, this.media + '/player'),
      `learner-${this.learner}@training.invalid`, tag, this.media + '/player', undefined,
      async <T>(expression: string) => {await this.page(); return page.evaluate<T>(expression);},
      AbortSignal.any([this.cancel.signal, AbortSignal.timeout(300000)]));
    return replayer.run(definitions);
  }
  async close() {
    this.closed = true;
    this.cancel.abort();
    const driver = this.driver, tab = this.tab;
    this.driver = undefined; this.tab = undefined;
    // The training stack is shared; close only this author's session.
    await Promise.allSettled([driver?.close(), tab?.close?.(), this.learning.stop(), this.runtime?.revoke(this.learner)]);
  }
}
