import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {Auth} from '../auth';
import {Api} from '../api';
import {Environment, EnvironmentName} from '../environments';
import {authoringHtml, StudioView} from './authoringHtml';
import {AuthorChapter, AuthorDraft, AuthorJob, demonstrationPrompt, pollAllowed, replayPassed, tasksFrom, tourFingerprint, updateRequest} from './authoringModel';
import {AuthoringBrowser} from './authoringBrowser';

type SavedDraft = AuthorDraft & {polls?: Record<string, {count: number; started: number}>};
const initial = (): StudioView => ({courses: [], chapters: [], history: [], draft: {prompt: ''}, busy: false, notice: '', connected: false, capturing: false, replayed: false});
export class AuthoringStudio implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private subscriptions: vscode.Disposable[];
  private api?: Api;
  private owner = '';
  private environment?: EnvironmentName;
  private epoch = 0;
  private selection = 0;
  private timer?: NodeJS.Timeout;
  private browser?: AuthoringBrowser;
  private capture?: Awaited<ReturnType<AuthoringBrowser['beginCapture']>>;
  private replayFingerprint?: string;
  private persistQueue = Promise.resolve();
  private state = initial();
  constructor(private context: vscode.ExtensionContext, private auth: Auth, private env: () => EnvironmentName, private service: () => Environment) {
    this.subscriptions = [vscode.commands.registerCommand('dhimantai.authorPracticalCourse', () => this.open()),
      auth.onDidChange(s => {if (this.owner && s?.user.id !== this.owner) this.clear();}),
      vscode.workspace.onDidChangeConfiguration(e => {if (e.affectsConfiguration('dhimantai.environment')) this.clear();})];
  }
  dispose() {this.clear(); this.subscriptions.forEach(s => s.dispose());}
  private clear() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined;
    const browser = this.browser; this.browser = undefined; void browser?.close().catch(() => {});
    const panel = this.panel; this.panel = undefined; panel?.dispose();
    this.api = undefined; this.owner = ''; this.capture = undefined; this.replayFingerprint = undefined; this.state = initial();
  }
  private async current(epoch = this.epoch) {return epoch === this.epoch && this.environment === this.env() && (await this.auth.session())?.user.id === this.owner;}
  private async open() {
    if (this.panel) {this.panel.reveal(); return;}
    let session = await this.auth.session(); if (!session) session = await this.auth.signIn(); if (!session) return;
    this.owner = session.user.id; this.environment = this.env();
    const epoch = this.epoch, environment = this.environment, service = this.service();
    this.api = new Api(this.auth, () => {if (epoch !== this.epoch || environment !== this.env()) throw new Error('Reopen authoring after changing service.'); return service;}, this.owner);
    this.state.draft = this.context.globalState.get<SavedDraft>(this.key()) ?? {prompt: ''};
    this.panel = vscode.window.createWebviewPanel('dhimantai.authoring', 'Course authoring', vscode.ViewColumn.One,
      {enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true});
    const received = this.panel.webview.onDidReceiveMessage(m => void this.handle(m));
    this.panel.onDidDispose(() => {received.dispose(); if (this.panel) {this.panel = undefined; this.clear();}});
    this.state.busy = true; this.state.notice = 'Loading your assigned courses…'; this.render();
    try {
      const catalog = await this.api.courseAuthoring<{courses: StudioView['courses']; updates: AuthorJob[]}>();
      if (!await this.current(epoch)) return;
      this.state.courses = catalog.courses; this.state.history = catalog.updates;
      const saved = this.state.draft;
      if (saved.course && catalog.courses.some(c => c.id === saved.course)) {
        await this.loadCourse(saved.course); if (saved.jobId) await this.loadJob(saved.jobId);
      } else this.state.draft = {prompt: saved.prompt};
      this.state.notice = '';
    } catch (error) {if (epoch === this.epoch) this.state.notice = this.message(error);}
    finally {if (epoch === this.epoch) {this.state.busy = false; this.render(); this.schedule();}}
  }
  private key() {return `authoring.draft.${this.environment}.${this.owner}`;}
  private persist() {
    const key = this.key(), draft = JSON.parse(JSON.stringify(this.state.draft));
    this.persistQueue = this.persistQueue.catch(() => {}).then(() => this.context.globalState.update(key, draft)); return this.persistQueue;
  }
  private render() {if (this.panel) this.panel.webview.html = authoringHtml(this.state, randomBytes(16).toString('hex'));}
  private message(error: unknown) {return error instanceof Error ? error.message : 'Could not complete this authoring action.';}
  private async disconnect() {
    const browser = this.browser; this.browser = undefined; this.capture = undefined;
    this.state.connected = false; this.state.capturing = false; this.state.webmcp = undefined; await browser?.close();
  }
  private async loadCourse(id: string) {
    const epoch = this.epoch;
    const result = await this.api!.courseAuthoring<{chapters: AuthorChapter[]}>('/courses/' + encodeURIComponent(id));
    if (!await this.current(epoch)) return;
    this.state.draft.course = id; this.state.chapters = result.chapters;
    if (!result.chapters.some(c => c.id === this.state.draft.chapter)) this.state.draft.chapter = undefined;
  }
  private async loadJob(id: string) {
    const epoch = this.epoch, selection = this.selection;
    const result = await this.api!.courseAuthoring<{update: AuthorJob}>('/updates/' + encodeURIComponent(id));
    if (!await this.current(epoch) || selection !== this.selection) return;
    if (result.update.course_id !== this.state.draft.course) await this.loadCourse(result.update.course_id);
    if (await this.current(epoch) && selection === this.selection) this.setJob(result.update);
  }
  private setJob(job: AuthorJob) {
    this.state.job = job; this.state.draft.jobId = job.id;
    const saved = this.state.draft as SavedDraft;
    const budget = (saved.polls ??= {})[job.id] ??= {count: 0, started: Date.now()};
    saved.pollCount = budget.count; saved.pollStarted = budget.started;
    this.state.history = [job, ...this.state.history.filter(j => j.id !== job.id)].slice(0, 30);
    this.state.replayed = this.replayFingerprint === tourFingerprint(tasksFrom(job.chapters ?? []));
  }
  private schedule() {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.panel || !['queued', 'running'].includes(this.state.job?.status ?? '')) return;
    if (!pollAllowed(this.state.draft)) {this.state.notice = 'Preparation is still pending. Refresh this saved update to check again.'; this.render(); return;}
    const epoch = this.epoch, id = this.state.job!.id, selection = this.selection;
    this.timer = setTimeout(async () => {
      if (epoch !== this.epoch || selection !== this.selection || id !== this.state.job?.id) return;
      if (this.state.busy) {this.schedule(); return;}
      const saved = this.state.draft as SavedDraft, budget = saved.polls![id]; budget.count++; saved.pollCount = budget.count;
      try {
        await this.persist(); await this.loadJob(id);
        if (epoch === this.epoch) {await this.persist(); this.render(); this.schedule();}
      } catch (error) {if (epoch === this.epoch) {this.state.notice = this.message(error); this.render();}}
    }, 4000);
  }
  private async handle(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as {type: string; id?: string; field?: string; prompt?: string};
    if (typeof m.type !== 'string' || this.state.busy || !this.api) return;
    const epoch = this.epoch;
    if (typeof m.prompt === 'string') this.state.draft.prompt = m.prompt.slice(0, 10000);
    if (m.type === 'edit') {void this.persist().catch(() => {}); return;}
    this.state.busy = true; clearTimeout(this.timer);
    if (['course', 'history', 'prepare'].includes(m.type)) this.selection++;
    try {
      if (!await this.current(epoch)) return;
      this.state.notice = ''; this.render(); const draft = this.state.draft;
      if (m.type === 'course' && typeof m.id === 'string') {
        if (m.id && !this.state.courses.some(c => c.id === m.id)) return;
        await this.disconnect(); if (!await this.current(epoch)) return;
        this.state.job = undefined; draft.jobId = undefined; draft.chapter = undefined;
        this.state.results = undefined; this.replayFingerprint = undefined; this.state.replayed = false;
        if (m.id) await this.loadCourse(m.id); else {draft.course = undefined; this.state.chapters = [];}
      } else if (m.type === 'chapter') {
        if (m.id && !(this.state.job?.chapters ?? this.state.chapters).some(c => c.id === m.id)) return;
        draft.chapter = m.id || undefined;
      } else if (m.type === 'starter') {
        draft.prompt = 'Create a guided practical workflow for this lesson. Begin with a realistic business situation, explain why each step matters, let learners decide key values, verify the saved result, and finish with an independent variation and a reasoning question.';
      } else if (m.type === 'prepare') {
        if (!draft.course || draft.prompt.trim().length < 5 || ['queued','running'].includes(this.state.job?.status ?? '')) throw new Error('Choose a course and describe the learning outcome.');
        if (['failed','applied'].includes(this.state.job?.status ?? '')) {draft.requestId = undefined; draft.fingerprint = undefined;}
        const body = updateRequest(draft); await this.persist(); this.state.notice = 'Preparing a saved proposal…'; this.render();
        const result = await this.api.courseAuthoring<{update: AuthorJob}>('/courses/' + encodeURIComponent(draft.course) + '/updates', body);
        if (!await this.current(epoch)) return;
        await this.disconnect(); if (!await this.current(epoch)) return;
        this.replayFingerprint = undefined; this.state.results = undefined; this.setJob(result.update);
        this.state.notice = 'Your request is saved. Review the changes when preparation finishes.';
      } else if (m.type === 'refresh' && this.state.job) await this.loadJob(this.state.job.id);
      else if (m.type === 'history' && m.id && this.state.history.some(j => j.id === m.id)) {
        await this.disconnect(); if (!await this.current(epoch)) return;
        this.replayFingerprint = undefined; this.state.results = undefined;
        await this.loadJob(m.id); draft.prompt = this.state.job!.prompt; draft.chapter = this.state.job!.chapter_id || undefined;
      } else if (m.type === 'history-refresh') {
        const result = await this.api.courseAuthoring<{courses: StudioView['courses']; updates: AuthorJob[]}>();
        if (!await this.current(epoch)) return; this.state.courses = result.courses; this.state.history = result.updates;
      } else if (m.type === 'apply' || m.type === 'retry-index') {
        const job = this.state.job; if (!job) return;
        if (m.type === 'apply' && (job.status !== 'ready' || job.tour_changed && !this.state.replayed)) throw new Error('Review and replay the changed tours before publishing.');
        const result = await this.api.courseAuthoring<{update: AuthorJob}>('/updates/' + job.id + '/' + m.type, {});
        if (!await this.current(epoch)) return; this.setJob(result.update);
        this.state.notice = m.type === 'apply' ? 'Course update published.' : 'Search indexing requested.';
      } else if (['connect','capture','replay','focus'].includes(m.type)) await this.browserAction(m, epoch);
      if (epoch === this.epoch) await this.persist();
    } catch (error) {if (epoch === this.epoch) this.state.notice = this.message(error);}
    finally {if (epoch === this.epoch) {this.state.busy = false; this.render(); this.schedule();}}
  }
  private async browserAction(m: {type: string; field?: string}, epoch: number) {
    if (this.state.draft.course !== 'erpnext-essentials') throw new Error('Live app authoring starts with ERPNext. Course text and labs can be edited for every assigned course.');
    await this.api!.courseAuthoring('/courses/erpnext-essentials'); if (!await this.current(epoch)) return;
    const tasks = tasksFrom(this.state.job?.chapters ?? this.state.chapters);
    if (m.type === 'connect') {
      await this.disconnect();
      if (!await this.current(epoch)) return;
      const browser = new AuthoringBrowser(this.context, this.owner, this.environment!, () => this.current(epoch), text => {
        if (epoch === this.epoch) {this.state.notice = text; this.render();}
      }); this.browser = browser;
      try {
        const webmcp = await browser.open(tasks);
        if (!await this.current(epoch)) {await browser.close(); return;}
        this.state.connected = true; this.state.webmcp = webmcp; this.state.notice = 'Training app ready beside the editor. Open a task to preview its guided tour.';
      } catch (error) {await browser.close(); this.browser = undefined; throw error;}
    } else if (m.type === 'focus' && m.field && tasks.some(t => t.steps.some(s => s.field === m.field))) await this.browser?.focus(m.field);
    else if (m.type === 'capture' && this.browser) {
      if (this.capture) {
        const changes = await this.browser.endCapture(this.capture);
        if (!await this.current(epoch)) return;
        if (!changes.length) {
          this.capture = undefined; this.state.capturing = false;
          this.state.notice = 'No field changes captured. Your prompt is unchanged.'; return;
        }
        this.state.draft.prompt = demonstrationPrompt(this.capture.form, changes); this.capture = undefined; this.state.capturing = false;
        this.state.notice = 'Demonstration captured into the prompt. Add the learning outcome, then prepare the update.';
      } else {
        const capture = await this.browser.beginCapture();
        if (!await this.current(epoch)) return;
        this.capture = capture; this.state.capturing = true;
      }
    } else if (m.type === 'replay' && this.browser && tasks.length) {
      this.state.notice = 'Replaying tours in your author training company. This creates practice records.'; this.render();
      const results = await this.browser.replay(tasks); if (!await this.current(epoch)) return;
      this.state.results = results; this.state.replayed = replayPassed(tasks, results);
      this.replayFingerprint = this.state.replayed ? tourFingerprint(tasks) : undefined;
      this.state.notice = this.state.replayed ? 'All tours passed the saved-record checks.' : 'Some tours need attention. Use the replay results to revise the update.';
    }
  }
}
