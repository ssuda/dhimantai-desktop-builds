import type { SkillingPathway } from './skilling';
import { skillingAction, SkillingMessage } from './skillingActions';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Auth } from './auth';
import { Api } from './api';
import { Environment, EnvironmentName } from './environments';
import { learnerRpc, PublicCatalog } from './learnerCatalog';
import { CourseworkOutbox, CourseCertificate, CourseGrade } from './courseworkProgress';
import { courseGradeHtml } from './courseGradeHtml';
import { onRecordsChanged } from './helpRecord';

export class CourseGradeView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private sequence = 0;
  private course = '';
  private owner = '';
  private environment?: EnvironmentName;
  private api?: Api;
  private apiUrl = '';
  private grade?: CourseGrade;
  private learning?: SkillingPathway;
  private certificates: CourseCertificate[] = [];
  private busy = false;
  private notice = '';
  private subscriptions: vscode.Disposable[];
  constructor(private readonly context:vscode.ExtensionContext, private readonly auth: Auth, private readonly env: () => EnvironmentName,
      private readonly service: () => Environment, private readonly outbox: CourseworkOutbox) {
    this.subscriptions = [auth.onDidChange(() => { this.clear(); void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai.environment')) { this.clear(); void this.refresh(); } }),
      onRecordsChanged(() => { if (!this.busy) void this.refresh(); }),
      vscode.commands.registerCommand('dhimantai.courseGrade', (course?: string) => this.open(course))];
  }
  private clear() { this.sequence++; this.grade = undefined; this.learning = undefined; this.certificates = []; this.api = undefined; this.owner = ''; this.render('Loading…'); }
  dispose() { this.sequence++; this.panel?.dispose(); this.subscriptions.forEach(s => s.dispose()); }
  async open(course?: string) {
    try {
      const owner = (await this.auth.session())?.user.id;
      if (!owner) { await vscode.commands.executeCommand('dhimantai.signIn'); return; }
      const environment = this.env(), backend = this.service();
      const catalog = course === '__certificates__' ? undefined
        : await learnerRpc<PublicCatalog>(backend, 'public_learning_catalog', {}, await this.auth.accessToken());
      if (environment !== this.env() || (await this.auth.session())?.user.id !== owner) return;
      const selected = course === '__certificates__' ? {id:''} : course ? catalog!.courses.find(c => c.id === course || c.title === course)
        : (await vscode.window.showQuickPick([{label:'My certificates',id:''}, ...catalog!.courses.filter(c => c.enrolled || !catalog!.individual)
          .map(c => ({label:c.title,id:c.id}))], {title:'Course grade & certificate'}));
      if (!selected) return;
      this.course = selected.id;
      if (!this.panel) {
        this.panel = vscode.window.createWebviewPanel('dhimantai.courseGrade','Course grade & certificate',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[]});
        this.panel.onDidDispose(() => { this.sequence++; this.panel = undefined; });
        this.panel.webview.onDidReceiveMessage(message => { void this.handle(message); });
      }
      this.panel.reveal(); await this.refresh();
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Course grades are unavailable.'); }
  }
  private render(notice = this.notice) {
    this.notice = notice;
    if (this.panel) this.panel.webview.html = courseGradeHtml(randomBytes(16).toString('hex'),this.grade,this.certificates,this.notice,
      this.owner && this.environment ? this.outbox.pending(this.environment,this.owner).length : 0,this.busy,!this.course,this.learning,`${this.owner}:${this.environment}:${this.course}`);
  }
  private async refresh() {
    if (!this.panel) return;
    const sequence = ++this.sequence, environment = this.env(), backend = this.service();
    this.grade = undefined; this.learning = undefined; this.certificates = []; this.api = undefined; this.render('Loading course results…');
    try {
      const owner = (await this.auth.session())?.user.id;
      if (sequence !== this.sequence) return;
      if (!owner) { this.owner = ''; this.render('Sign in to view your course grade.'); return; }
      this.owner = owner; this.environment = environment; this.apiUrl = backend.apiUrl;
      const api = new Api(this.auth, () => { if (environment !== this.env()) throw new Error('Your service changed.'); return backend; }, owner);
      const [result, history, learning] = await Promise.allSettled([this.course ? api.courseGrade(this.course) : Promise.resolve(undefined),api.courseCertificates(),this.course?api.skillingPathway(this.course):Promise.resolve(undefined)]);
      if (sequence !== this.sequence || (await this.auth.session())?.user.id !== owner) return;
      this.api = api;
      if(learning.status==='fulfilled') this.learning=learning.value;
      if (history.status === 'fulfilled') this.certificates = history.value.certificates.filter(c => !this.course || c.course_id === this.course);
      if (result.status === 'fulfilled' && result.value) {
        this.grade = result.value.gradebook;
        const certificate = result.value.certificate;
        if (certificate) this.grade.certificate_id = certificate.id;
        if (certificate && !this.certificates.some(c => c.id === certificate.id)) this.certificates.unshift(certificate);
      }
      this.render(result.status === 'rejected' ? String(result.reason?.message ?? 'Course grade could not be loaded.')
        : history.status === 'rejected' ? 'Earlier certificates could not be loaded. Refresh to try again.'
        : !this.course && !this.certificates.length ? 'No certificates yet. Complete your coursework and open Grade & certificate from your course.' : '');
    } catch (error) { if (sequence === this.sequence) this.render(error instanceof Error ? error.message : 'Course results could not be loaded.'); }
  }
  private async handle(message: SkillingMessage) {
    if (this.busy) return;
    if (message.type === 'refresh') return this.refresh();
    const api = this.api, owner = this.owner, environment = this.environment, sequence = this.sequence;
    if (!api || !environment || (await this.auth.session())?.user.id !== owner || this.env() !== environment) return;
    try {
      if(['nextCourse','skillingProject','skillingSubmit','weeklyStart','weeklySubmit','challenge','interview','authoredChallenge'].includes(message.type??'')) {
        this.busy=true;this.render('Working…');
        await skillingAction(message,api,this.course,this.learning,this.context,async()=>sequence===this.sequence&&this.env()===environment&&(await this.auth.session())?.user.id===owner,owner);
        if(sequence===this.sequence) await this.refresh();
        return;
      }
      if (message.type === 'certificate' || message.type === 'copy') {
        const c = this.certificates.find(c => c.id === message.id && !c.revoked_at);
        if (!c) return;
        const url = this.apiUrl.replace(/\/+$/,'') + '/course-projects/certificates/' + encodeURIComponent(c.id) + '/verify';
        if (message.type === 'copy') await vscode.env.clipboard.writeText(url);
        else await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      const req = this.grade?.requirements.find(r => r.id === message.id && r.kind === message.type);
      if (req) {
        if (req.kind === 'exercise') await vscode.commands.executeCommand('dhimantai.openExercise',req.id,owner,this.grade!.course_title,req.title);
        else await vscode.commands.executeCommand('dhimantai.startCapstone',req.id);
        return;
      }
      if (message.type !== 'claim' && message.type !== 'sync') return;
      if (message.type === 'claim' && !this.grade?.eligible) return;
      this.busy = true; this.render(message.type === 'claim' ? 'Issuing certificate…' : 'Syncing results…');
      if (message.type === 'claim') await api.claimCourseCertificate(this.course);
      else await this.outbox.retry(environment,owner,v => api.courseworkResult(v.kind,v.id,v.result));
      if (sequence === this.sequence) await this.refresh();
    } catch (error) { if (sequence === this.sequence) this.render(error instanceof Error ? error.message : 'Please retry.'); }
    finally { this.busy = false; if (this.panel) this.render(); }
  }
}
