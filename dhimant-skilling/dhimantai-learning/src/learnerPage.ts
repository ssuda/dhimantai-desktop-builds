import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Api, type Language, type QuestionPool } from './api';
import type { Auth } from './auth';
import { ERP_COURSE } from './browserCourseProgress';
import { learnerCourses } from './catalogDiscovery';
import type { Environment, EnvironmentName } from './environments';
import { onRecordsChanged, progressText, sharedRecords } from './helpRecord';
import { learnerRpc, type PublicCatalog } from './learnerCatalog';
import { learnerPageHtml, pageTitles, type LearnerPage, type LearnerPageData } from './learnerPagesHtml';
import type { PracticeBrowser } from './practiceBrowser';

interface Snapshot extends LearnerPageData {
  account: string; environment: EnvironmentName; languages: Language[]; pools: QuestionPool[];
}
interface Action {action: string; revision: number; course?: string; chapter?: string; id?: string}

export class LearnerPagePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private revision = 0;
  private loadSequence = 0;
  private snapshot?: Snapshot;
  private owner?: string;

  constructor(private page: LearnerPage, private auth: Auth, private environment: () => EnvironmentName,
      private service: () => Environment, private practice: PracticeBrowser,
      private savedNotebooks: (env: EnvironmentName, owner: string) => Promise<{id:string; title:string}[]>) {}

  open() {
    if (this.panel) { this.panel.reveal(this.panel.viewColumn); return; }
    const panel = this.panel = vscode.window.createWebviewPanel('dhimantai.' + this.page, pageTitles[this.page],
      vscode.ViewColumn.Active, {enableScripts:true, localResourceRoots:[], retainContextWhenHidden:true});
    let visible = panel.visible;
    const listeners = [
      panel.webview.onDidReceiveMessage((msg: Action) => void this.handle(msg).catch(error =>
        vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not open this item.'))),
      panel.onDidChangeViewState(() => {
        const returned = panel.visible && !visible;
        visible = panel.visible;
        if (returned) void this.refresh(true);
      }),
      this.auth.onDidChange(session => { if (this.owner !== session?.user.id) void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai.environment')) void this.refresh(); }),
      onRecordsChanged(() => {
        if (this.page === 'practicePage' && this.snapshot) {
          this.snapshot.progress = progressText(sharedRecords(this.snapshot.account));
          this.render();
        }
      }),
    ];
    panel.onDidDispose(() => {
      for (const listener of listeners) listener.dispose();
      this.panel = undefined; this.snapshot = undefined; this.owner = undefined; this.revision++; this.loadSequence++;
    });
    return this.refresh();
  }
  dispose() { this.panel?.dispose(); }

  private render(notice = '', signedOut = false) {
    if (this.panel) this.panel.webview.html = learnerPageHtml(this.page, randomBytes(16).toString('hex'), ++this.revision,
      this.snapshot, notice, signedOut, JSON.stringify([this.environment(), this.owner]));
  }

  private async refresh(returning = false) {
    const sequence = ++this.loadSequence, environment = this.environment(), service = this.service();
    const current = () => sequence === this.loadSequence && environment === this.environment();
    if (!returning || !this.snapshot || this.snapshot.environment !== environment) {
      this.snapshot = undefined; this.render('Loading…');
    }
    try {
      const account = (await this.auth.session())?.user.id;
      if (!current()) return;
      this.owner = account;
      if (!account) { this.snapshot = undefined; this.render('Sign in to see your learning.', true); return; }
      if (this.snapshot && this.snapshot.account !== account) { this.snapshot = undefined; this.render('Loading…'); }
      const api = new Api(this.auth, () => service, account), practice = this.page === 'practicePage';
      const [learning, metadata, notebooks, certificates] = await Promise.allSettled([
        api.practiceCatalog(),
        this.auth.accessToken().then(token => learnerRpc<PublicCatalog>(service, 'public_learning_catalog', {}, token)),
        practice ? this.savedNotebooks(environment, account) : undefined,
        practice ? api.courseCertificates() : undefined,
      ]);
      if ((await this.auth.session())?.user.id !== account || !current()) return;
      const catalog = metadata.status === 'fulfilled' ? metadata.value : undefined;
      const subjects = learning.status === 'fulfilled' ? learning.value : undefined;
      const courses = learnerCourses(subjects?.courses ?? [], catalog);
      const snapshot: Snapshot = {account, environment, courses, languages:subjects?.languages ?? [],
        pools:subjects?.question_pools ?? (catalog?.individual === false ? ['textbook','institution'] : ['textbook']),
        courseError:subjects ? undefined : 'Your courses could not be loaded. Select Refresh to try again.',
        progress:progressText(sharedRecords(account)), notebooks:notebooks.status === 'fulfilled' ? notebooks.value : undefined,
        certificates:certificates.status === 'fulfilled' ? certificates.value?.certificates.filter(c => !c.revoked_at).map(c => c.course_title) : undefined};
      // Returning to the same data keeps expanded outlines, keyboard focus and scroll position.
      if (returning && this.snapshot && JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return;
      this.snapshot = snapshot; this.render();
    } catch (error) {
      if (current()) {
        this.snapshot = undefined;
        this.render(error instanceof Error ? error.message : 'Could not load your learning. Select Refresh to try again.');
      }
    }
  }

  private async handle(msg: Action) {
    if (!msg || msg.revision !== this.revision) return;
    const command = vscode.commands.executeCommand;
    if (msg.action === 'refresh') return this.refresh();
    if (msg.action === 'signIn') return command('dhimantai.signIn');
    if (msg.action === 'catalog') return command('dhimantai.courseCatalog');
    const data = this.snapshot;
    if (!data || (await this.auth.session())?.user.id !== data.account || data !== this.snapshot || data.environment !== this.environment()) return;
    switch (msg.action) {
      case 'history': return command('dhimantai.practiceHistory', {allCourses:true});
      case 'notebook':
        if (data.notebooks?.some(n => n.id === msg.id)) return command('dhimantai.practiceHistory', {allCourses:true, id:msg.id});
        return;
      case 'certificates': return command('dhimantai.courseGrade','__certificates__');
      case 'files': return command('dhimantai.practice.focus');
      case 'split': return this.panel?.reveal(vscode.ViewColumn.Beside);
    }
    const course = data.courses.find(c => c.name === msg.course);
    const chapter = course?.chapters.find(ch => ch.id === msg.chapter && !ch.expired && !ch.locked);
    if (!course || !chapter) return;
    if (msg.action === 'tour' && course.name === ERP_COURSE) return command('dhimantai.openBrowserCourse', 'erpnext-essentials', true, chapter.id);
    if (msg.action === 'lesson') return command('dhimantai.openLearningRoom',course.name,chapter.id);
    if (msg.action === 'exercise') return this.practice.chooseExercise({kind:'chapter',chapter,course:course.name,
      environment:data.environment,account:data.account,languages:data.languages,pools:data.pools});
  }
}
