import { controlDialog, controlStyles, desktopControlsClient } from './desktopControlView';
import { catalogClient } from './catalogClient';
import { CatalogSection, categoryOf, categoryHue, escape, filterOptions, orderedSections, sectionKey, sectionChips, sectionOf, styleOf, typeColors, typeIcon } from './catalogLayout';
import { catalogGuide, setupCourseNames } from './catalogGuide';
import { catalogStyles } from './catalogStyles';
import {canResumePurchase, paymentsPage} from './managePayments';
import { accessLabel, applyTeachingChapters, catalogChapter, chapterActionLabel, courseLearningStatus, coursePriceKind, courseSuggestions, openChapter, resumeTopic } from './catalogDiscovery';
import {equipmentLesson} from './studioTypes';
import type { SkillingProfile } from './skilling';
import { ESSENTIAL_PATHS } from './essentials';
import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { Auth, type Session } from './auth';
import { Environment, EnvironmentName } from './environments';
import { accessPeriod, CatalogCourse, LearningOffer, learnerRpc, PublicCatalog } from './learnerCatalog';
import { Api, Course, LearningPurchases } from './api';
import { checkoutUri, priceLabel } from './learningBilling';
import type { CompanionCourse } from './studyContent';
import { architectureCase } from './architectureMemory';
import { CATALOG_PROJECTS, PROJECT_COURSES, projectAccessEnded } from './catalogProjects';
import { ProjectResults, ProjectSummary } from './projectResults';
import { compareCourseActivity, courseCoverage, coverageLabel, coverageNote, topicCoverageHtml } from './courseProgress';
import { progressBar, UI_TOKENS } from './uiTheme';
import { ERP_TASK_TOTAL } from './browserLearning';
import { starterExercises } from './starterExercises';
import { coursePreviews } from './coursePreviews';
import { CODE_READING_PROJECTS_ENABLED, STUDY_ENABLED } from './desktopFeatures';

function essentialPaths(courses: CatalogCourse[]): string {
  const present = new Set(courses.map(c => c.id));
  const paths = ESSENTIAL_PATHS.map(path => ({...path, ids: path.courses.map(id => 'engineering-' + id).filter(id => present.has(id))}))
    .filter(path => path.ids.length);
  const pathButton = (label: string, ids: string, pressed: boolean) =>
    `<button type="button" class="secondary" data-path="${escape(ids)}" aria-pressed="${pressed}">${escape(label)}</button>`;
  return `<div class="paths" role="group" aria-label="Suggested paths">${pathButton('All', '', true)}${paths.map(p => pathButton(p.label, p.ids.join(' '), false)).join('')}</div>`;
}

const previewFor = (course: CatalogCourse) => !course.expired && (course.can_join || course.enrolled)
  && course.chapters.length && (course.is_free || course.chapters[0].free)
  ? coursePreviews.get(course.id) : undefined;
const coveredCount = (course: CatalogCourse) => course.chapters.filter(ch => ch.progress?.status === 'covered').length;
const hasCoverage = (course: CatalogCourse) => course.chapters.some(ch => ch.progress && ch.progress.status !== 'unavailable');
function coverageMeter(course: CatalogCourse): string {
  const covered = coveredCount(course), label = courseCoverage(course.chapters);
  if (!hasCoverage(course)) return '<p class="small muted">Progress unavailable. Your saved notebook can still be opened.</p>';
  return `<div class="coverage">${progressBar(covered, course.chapters.length, `${covered} of ${course.chapters.length} chapters taught`)}<p class="small muted">${escape(label)}</p></div>`;
}
/** Most recently active first, so the course a learner was just in is the one they resume. */
function resumeOrder(courses: CatalogCourse[]): CatalogCourse[] {
  return courses.filter(c => c.enrolled && !c.expired).sort(compareCourseActivity);
}

export class CourseCatalog implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  get activeControlPanel() { return !this.payments && this.panel?.active ? this.panel : undefined; }
  continueLearning(account: string) {
    const selection = this.selection;
    const recent = selection?.account === account && selection.environment === this.environment()
      ? resumeOrder(selection.catalog.courses)[0] : undefined;
    return recent ? this.handle({type: recent.id === 'erpnext-essentials' ? 'browserCourse' : 'practice', id: recent.id})
      : vscode.commands.executeCommand('dhimantai.openLearningRoom');
  }
  private sequence = 0;
  private selection?: { environment: EnvironmentName; account?: string; accountLabel?: string; catalog: PublicCatalog; catalogUnavailable?: boolean; billing?: LearningPurchases; lessons?: Course[]; practiceProgress?: Record<string,'completed' | 'in_progress'> };
  private purchasing = false;
  private scope?: {environment: EnvironmentName; account?: string; accountLabel?: string};
  private refreshQueued?: boolean;
  /** Returning to the desktop application after opening checkout triggers a purchase refresh. */
  private awaitingPayment?: string;
  private welcomePending?: Promise<void>;
  private subscriptions: vscode.Disposable[];
  private projects: ProjectSummary[] = [];
  private projectRefresh = 0;
  private studyCourses = new Set<string>();
  private pathways:Record<string,SkillingProfile> = {};
  private focusCourse?:string;
  private focusProjects = false;
  private payments = false;
  private setup?: {message: string; busy: boolean};
  private starting?: {id: string; choosing: boolean};

  constructor(private readonly auth: Auth, private readonly environment: () => EnvironmentName,
      private readonly service: () => Environment, private readonly joined: () => void,
      private readonly learningOpen: () => boolean = () => false,
      private readonly companions: CompanionCourse[] = [], private readonly results?: ProjectResults,
      private readonly media = '',
      /** ERPNext tasks this account verified on this computer; practice evidence, kept apart from Instructor coverage. */
      private readonly browserProgress?: (environment: EnvironmentName, account: string) => number,
      private readonly state?: vscode.Memento,
      private readonly preparedCourses?: (environment: EnvironmentName, account: string) => Set<string>) {
    this.subscriptions = [auth.onDidChange(session => {
      // Token renewal is not an account switch and must not invalidate a checkout.
      if (this.scope?.environment === this.environment() && this.scope.account === session?.user.id) return;
      this.clearAccount(); void this.refresh();
    }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dhimantai.environment')) { this.starting = undefined; this.clearAccount(); void this.refresh(); }
      }),
      vscode.window.onDidChangeWindowState(state => {
        if (!state.focused) return;
        if (this.awaitingPayment) void this.refresh(true);
        else if (this.panel?.visible && !this.payments && !this.purchasing) void this.refreshProjectCards();
      })];
  }
  dispose() { this.starting = undefined; this.sequence++; this.panel?.dispose(); this.subscriptions.forEach(d => d.dispose()); }
  private clearAccount() {
    this.sequence++; this.selection = undefined; this.scope = undefined; this.setup = undefined;
    this.projects = []; this.studyCourses.clear(); this.pathways = {}; this.awaitingPayment = undefined;
    this.render(undefined, this.payments ? 'Loading payments…' : 'Loading courses…', true);
  }
  private status(message: string, busy = this.purchasing) {
    void this.panel?.webview.postMessage({type:'catalogStatus', message, busy, paymentPending:!!this.awaitingPayment});
  }
  private showCourseStart() {
    void this.panel?.webview.postMessage({type:'courseStartState', id:this.starting?.id});
  }
  /** One welcome per VS Code profile, including profiles upgrading from the old notebook-first experience. */
  welcome(state: vscode.Memento): Promise<void> {
    return this.welcomePending ??= this.showWelcome(state).finally(() => { this.welcomePending = undefined; });
  }
  private async showWelcome(state: vscode.Memento) {
    const desktop = vscode.env.appName === 'dhimantAI';
    if (!desktop && state.get<boolean>('courseCatalogWelcomeShown')) return;
    if (desktop) {
      // Retired built-in walkthrough tabs are not learner work. Do not close a
      // real document or extension page merely because its title is Welcome.
      const oldWelcome = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.label === 'Welcome'
        && !(tab.input instanceof vscode.TabInputText) && !(tab.input instanceof vscode.TabInputNotebook)
        && !(tab.input instanceof vscode.TabInputWebview));
      if (oldWelcome.length) await vscode.window.tabGroups.close(oldWelcome, true);
    }
    // Restored work takes precedence. A later empty window can show the welcome.
    // Use owned state: VS Code's tab list can lag behind a newly opened notebook.
    if (this.learningOpen() || vscode.window.activeTextEditor || vscode.window.activeNotebookEditor) return;
    if (desktop && vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputNotebook
      || tab.input instanceof vscode.TabInputWebview && !tab.input.viewType.endsWith('dhimantai.courseCatalog')))) return;
    await this.open();
    await state.update('courseCatalogWelcomeShown', true);
  }
  async open(courseId?:string, payments = false, projects = false) {
    const changed=this.payments!==payments;this.payments=payments;
    this.focusCourse=courseId;
    this.focusProjects=projects;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('dhimantai.courseCatalog', 'dhimantAI Course Catalog', vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
      let wasVisible = this.panel.visible;
      this.panel.onDidChangeViewState(({webviewPanel}) => {
        const returned = !wasVisible && webviewPanel.visible;
        wasVisible = webviewPanel.visible;
        if (returned && !this.payments && this.selection?.account && !this.starting) void this.refresh();
      });
      if (vscode.env.appName === 'dhimantAI') {
        const showNavigation = () => {
          if (!this.panel?.active) return;
          void vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
          void vscode.commands.executeCommand('dhimantai.learningNavigation.focus', {preserveFocus:true});
        };
        this.panel.onDidChangeViewState(showNavigation);
        showNavigation();
      }
      this.panel.onDidDispose(() => { this.sequence++; this.panel = undefined; this.selection = undefined; this.setup = undefined; });
      this.panel.webview.onDidReceiveMessage(message => { void this.handle(message).catch(error => this.status(
        error instanceof Error ? error.message : 'Could not complete that action. Try again.')); });
    }
    this.panel.reveal();
    if (this.selection && this.selection.environment === this.environment()) {
      if (!payments && this.selection.catalogUnavailable) return this.refresh();
      if(changed)this.render(this.selection.catalog);
      if (changed && payments) return this.refresh(!!this.awaitingPayment);
      if (changed && !payments) void this.refreshProjectCards();
      if (projects) void this.panel.webview.postMessage({type:'browseProjects'});
      if (courseId) void this.panel.webview.postMessage({type:'focusCourse', id:courseId});
      this.focusProjects = false;
      this.focusCourse = undefined;
      return;
    }
    await this.refresh();
  }
  private async readPracticeProgress(account?: string) {
    if (!account) return;
    try { return await new Api(this.auth, this.service, account).projectPracticeProgress(); }
    catch { return undefined; }
  }

  private async refreshProjectCards() {
    const selection = this.selection, sequence = this.sequence;
    if (!selection) return;
    const {environment, account} = selection, refresh = ++this.projectRefresh;
    const [projects, progress] = await Promise.all([
      this.results?.summaries(this.media, environment, account ?? 'local') ?? [],
      this.readPracticeProgress(account),
    ]);
    const session = await this.auth.session();
    if (refresh !== this.projectRefresh || sequence !== this.sequence || selection !== this.selection ||
        this.payments || this.purchasing || environment !== this.environment() || account !== session?.user.id) return;
    if (JSON.stringify(projects) === JSON.stringify(this.projects) &&
        JSON.stringify(progress) === JSON.stringify(selection.practiceProgress)) return;
    this.projects = projects;
    selection.practiceProgress = progress;
    this.render(selection.catalog);
  }

  async refresh(checkPayments = false, openSetup = false) {
    if (!this.panel) return;
    if (this.purchasing) { this.refreshQueued = (this.refreshQueued ?? false) || checkPayments; return; }
    const sequence = ++this.sequence, environment = this.environment(), env = this.service();
    try {
      const session = await this.auth.session(), account = session?.user.id;
      if (sequence !== this.sequence || environment !== this.environment()) return;
      if (this.selection && (this.selection.account !== account || this.selection.environment !== environment)) {
        this.setup = undefined; this.selection = undefined; this.projects = []; this.studyCourses.clear(); this.pathways = {}; this.awaitingPayment = undefined;
      }
      this.scope = {environment, account, accountLabel:session?.user.email ?? session?.user.phone};
      if (this.selection) this.status(checkPayments ? 'Checking purchases…' : 'Refreshing courses…', this.payments);
      else this.render(undefined, this.payments ? 'Loading payments…' : 'Loading courses…', true);
      const projects = await this.results?.summaries(this.media, environment, account ?? 'local') ?? [];
      if (sequence !== this.sequence || environment !== this.environment()) return;
      // Saved project evidence is local and remains useful when the catalog service is offline.
      this.projects = projects;
      const token = account ? await this.auth.accessToken() : undefined;
      if (sequence !== this.sequence || environment !== this.environment()) return;
      let billing: LearningPurchases | undefined;
      let billingMessage = '';
      if (account) {
        try { billing = await new Api(this.auth, () => env, account).learningPurchases(checkPayments, this.awaitingPayment); }
        catch {
          billingMessage = 'Payment status could not be refreshed. Please try again.';
          if (this.payments && this.selection?.billing) billing = {...this.selection.billing, payments_ready:false};
        }
        if (billing?.refresh_incomplete) billingMessage = 'Razorpay could not confirm some payments. Showing their last known status.';
        else if (billing?.more_pending) billingMessage = 'Checked three pending orders. Refresh again to check the next orders.';
      }
      let catalogUnavailable = false;
      const [catalog, books, progress, pathways, practiceProgress] = await Promise.all([
        learnerRpc<PublicCatalog>(env, 'public_learning_catalog', {}, token).catch(error => {
          if (!this.payments || !billing) throw error;
          catalogUnavailable = true;
          billingMessage = [billingMessage, 'Current course access could not be verified. Refresh Status to try again.'].filter(Boolean).join(' ');
          return {individual:false, courses:[]} as PublicCatalog;
        }),
        STUDY_ENABLED && account ? new Api(this.auth, () => env, account).studyCatalog().catch(() => ({courses:[]})) : Promise.resolve({courses:[]}),
        account ? new Api(this.auth, () => env, account).practiceCatalog().catch(() => undefined) : undefined,
        fetch(env.apiUrl.replace(/\/+$/,'')+'/skilling/catalog',{signal:AbortSignal.timeout(10000)}).then(async r=>r.ok?(await r.json()).courses:{}).catch(()=>({})),
        this.payments ? undefined : this.readPracticeProgress(account),
      ]);
      if (sequence !== this.sequence || environment !== this.environment()) return;
      if (account !== (await this.auth.session())?.user.id || sequence !== this.sequence || environment !== this.environment()) return;
      this.projects = projects; this.pathways = pathways;
      applyTeachingChapters(catalog.courses, progress?.courses);
      this.studyCourses = new Set(books.courses.filter(c => c.chapters.length).map(c => c.title));
      this.selection = {...this.scope, environment, account, catalog, catalogUnavailable, billing, lessons:progress?.courses, practiceProgress:this.payments ? this.selection?.practiceProgress : practiceProgress};
      if (checkPayments && billing && this.awaitingPayment) {
        const opened = billing.purchases.find(p => p.id === this.awaitingPayment);
        if (opened && (opened.status === 'paid' || opened.status === 'refunded' || opened.attempt_state === 'failed'))
          this.awaitingPayment = undefined;
      }
      const refreshed = account ? 'Payment and course access status refreshed.' : 'Courses refreshed.';
      this.render(catalog, billingMessage || (checkPayments ? refreshed : ''), false, openSetup);
      if (checkPayments) this.joined();
    } catch (error) {
      if (sequence !== this.sequence) return;
      const message = error instanceof Error ? error.message : 'Could not load courses. Retry.';
      this.render(this.selection?.catalog, message, false, openSetup);
    }
  }
  private confirmationKey(environment: EnvironmentName, email: string) {
    return 'courseSignup.' + environment + '.' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }

  async continueConfirmedSignup(session: Session) {
    if (this.starting) return true;
    if (!session.user.email) return false;
    const key = this.confirmationKey(this.environment(), session.user.email);
    const id = this.state?.get<string>(key);
    if (!id) return false;
    await this.startCourse(id, session);
    return true;
  }

  /** Bind the choice to this authentication attempt, then recheck access with the signed-in learner's token. */
  private async startCourse(id: string, confirmed?: Session) {
    const environment = this.environment(), service = this.service();
    const chosen = this.selection?.catalog.courses.find(course => course.id === id);
    if ((this.starting && (!this.starting.choosing || this.starting.id === id))
        || (!confirmed && (!chosen || chosen.expired || !chosen.can_join && !chosen.enrolled))) {
      this.showCourseStart();
      return;
    }
    const operation = {id, choosing: false};
    this.starting = operation;
    this.showCourseStart();
    const current = () => operation === this.starting && environment === this.environment();
    try {
      let confirmationKey: string | undefined;
      let session = confirmed ?? await this.auth.session();
      if ((!confirmed && session?.user.id !== this.selection?.account) || !current()) return;
      if (!session || (!confirmed && !this.selection?.catalog.individual)) {
        operation.choosing = true;
        const course = {title: chosen!.title, waitingForEmail: async (email: string) => {
          if (!current()) return;
          confirmationKey = this.confirmationKey(environment, email);
          await this.state?.update(confirmationKey, id);
        }};
        session = session ? await this.auth.signIn(course) : await this.auth.signUp(course);
      }
      if (!session || !current()) return;
      operation.choosing = false;
      if (confirmationKey && (!session.user.email || this.confirmationKey(environment, session.user.email) !== confirmationKey)) return;
      const owner = session.user.id;
      const stillSignedIn = async () => (await this.auth.session())?.user.id === owner && current();
      const token = await this.auth.accessToken();
      if (!await stillSignedIn()) return;
      const catalog = await learnerRpc<PublicCatalog>(service, 'public_learning_catalog', {}, token);
      if (!await stillSignedIn()) return;
      const course = catalog.courses.find(item => item.id === id);
      if (!catalog.individual) throw new Error('Use an individual learner account to start this course.');
      if (!course || course.expired || (!course.enrolled && !course.can_join))
        throw new Error('This course is no longer available to start. Choose another course in the catalog.');
      if (!course.enrolled) {
        this.status('Joining ' + course.title + '…');
        await learnerRpc(service, 'join_learning_course', {p_course:id}, token);
        if (!await stillSignedIn()) return;
        this.joined();
      }
      if (id === 'erpnext-essentials') await vscode.commands.executeCommand('dhimantai.openBrowserCourse', id, true);
      else if (!course.enrolled) {
        const first = course.chapters.find(ch => openChapter(course, ch));
        if (!first) throw new Error('You joined this course, but its first lesson is unavailable.');
        // Instructor loads and checks this chapter with the signed-in learner's token.
        await vscode.commands.executeCommand('dhimantai.openLearningRoom', course.title, first.id);
      }
      else {
        // Match syllabus IDs even when the catalog and teaching service use different course names.
        const lessons = await new Api(this.auth, () => service, owner).practiceCatalog();
        if (!await stillSignedIn()) return;
        const chapterIds = new Set(course.chapters.map(ch => ch.id));
        const subject = lessons.courses.find(item => item.chapters.some(ch => chapterIds.has(ch.id)));
        applyTeachingChapters([course], lessons.courses);
        const lesson = this.projectChapter(course);
        if (!subject || !lesson) throw new Error('Your first lesson is not available yet. Refresh courses and try again.');
        await vscode.commands.executeCommand('dhimantai.openLearningRoom', subject.name, lesson.id);
      }
      await this.refresh();
      if (session.user.email && current()) await this.state?.update(this.confirmationKey(environment, session.user.email), undefined);
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : 'Could not open this course. Please try again.';
        await this.open(id);
        await this.refresh();
        if (current()) this.status(message);
      }
    } finally {
      if (current()) {
        this.starting = undefined;
        this.showCourseStart();
      }
    }
  }

  private projectChapter(course:CatalogCourse) {
    const account=this.selection?.account;
    if(course.id==='laravel-react-mysql' && course.enrolled && account && this.selection?.environment===this.environment()) {
      const scope=createHash('sha256').update(this.environment()+'\0'+account).digest('hex').slice(0,24);
      const saved=this.state?.get<{mode:string;lesson:string}[]>('buildStudio.'+scope)?.find(row=>row.mode==='guided');
      const chapter=saved && course.chapters.find(ch=>equipmentLesson(ch.id)===saved.lesson && openChapter(course,ch));
      if(chapter)return chapter;
    }
    return catalogChapter(course);
  }

  private projectAccessEnded(id: string) { return projectAccessEnded(id, this.selection?.catalog.courses, this.selection?.lessons); }
  private async handle(message: any) {
    if (message?.type === 'desktopControlAction' || message?.type === 'desktopControlReady') return;
    if (message?.type === 'getCourseStartState') return this.showCourseStart();
    if(message?.type==='payments'||message?.type==='catalog') {
      this.payments=message.type==='payments';
      if (!this.payments && this.selection?.catalogUnavailable) return this.refresh();
      this.render(this.selection?.catalog);
      if (this.payments) return this.refresh(!!this.awaitingPayment);
      return;
    }
    if(message?.type==='receipt') {
      const selection=this.selection;
      if(!selection || selection.environment!==this.environment() || !selection.account
        || (await this.auth.session())?.user.id!==selection.account)return;
      const purchase=selection.billing?.purchases.find(p=>p.id===message.id);
      if(!purchase)return;
      if (purchase.status !== 'paid' && purchase.status !== 'refunded') return;
      const {paymentReceipt} = await import('./paymentReceipt');
      const pdf = await paymentReceipt(purchase, selection.catalog.courses);
      if ((await this.auth.session())?.user.id !== selection.account || selection.environment !== this.environment()
          || this.selection?.account !== selection.account || this.selection.environment !== selection.environment || !this.payments) return;
      if (this.selection.billing?.purchases.find(p => p.id === purchase.id)?.status !== purchase.status) {
        return this.status('Payment details changed. Download the updated receipt from Manage Payments.');
      }
      await this.panel?.webview.postMessage({type: 'receiptDownload', scope: JSON.stringify([selection.environment, selection.account]),
        id: purchase.id, bytes: Uint8Array.from(pdf).buffer});
      return;
    }
    if (message?.type === 'browserCourse' && message.id === 'erpnext-essentials') {
      const course = this.selection?.catalog.courses.find(c => c.id === message.id);
      if (course?.expired || course && !course.enrolled && !course.can_join) return;
      if (course && !course.enrolled) return this.startCourse(message.id);
      return vscode.commands.executeCommand('dhimantai.openBrowserCourse', message.id, true);
    }
    if (message?.type === 'browserDemo') return vscode.commands.executeCommand('dhimantai.openErpDemo');
    // Navigation and sign-in must also work while loading or when the catalog is offline.
    if (message?.type === 'getPreparedCourses') {
      const selection = this.selection;
      if (!selection?.account || selection.environment !== this.environment()) return;
      const prepared = this.preparedCourses?.(selection.environment, selection.account);
      const names = setupCourseNames(selection.lessons).filter(name => prepared?.has(name));
      return this.panel?.webview.postMessage({type:'preparedCourses', names});
    }
    if (message?.type === 'support') {
      const link = vscode.Uri.parse('mailto:contact@optficial.ai?subject=dhimantAI%20Course%20Support');
      const opened = await vscode.env.openExternal(link).then(value => value, () => false);
      if (!opened) this.status('Email contact@optficial.ai for course support.');
      return;
    }
    if (message?.type === 'signInForSetup') {
      const environment = this.environment(), panel = this.panel;
      await vscode.commands.executeCommand('dhimantai.signIn', environment);
      if (await this.auth.session() && panel === this.panel && environment === this.environment()) await this.refresh(false, true);
      return;
    }
    if (message?.type === 'setupCourse') return this.setupContainer(message.id);
    if (message?.type === 'signOut') return vscode.commands.executeCommand('dhimantai.signOut');
    if (message?.type === 'commands') return vscode.commands.executeCommand('dhimantai.searchCommands');
    if (message?.type === 'tutor') return vscode.commands.executeCommand('dhimantai.openLearningRoom');
    if (message?.type === 'doubtSolver') return vscode.commands.executeCommand('dhimantai.openDoubtSolver');
    if (message?.type === 'certificates') return vscode.commands.executeCommand('dhimantai.courseGrade', '__certificates__');
    if(message?.type==='projectChapter') {
      const course=this.selection?.catalog.courses.find(c=>c.id==='laravel-react-mysql' && c.enrolled);
      const chapter=course?.chapters.find(c=>c.id===message.id && openChapter(course,c));
      if(chapter && this.selection?.environment===this.environment() && equipmentLesson(chapter.id))
        return vscode.commands.executeCommand('dhimantai.openLearningRoom',course!.title,chapter.id);
      return;
    }
    if (message?.type === 'practice') {
      const course = this.selection?.catalog.courses.find(c => c.id === message.id && c.enrolled);
      const subject = course && this.selection?.lessons?.find(lesson => lesson.chapters.some(ch => course.chapters.some(c => c.id === ch.id)))?.name;
      if (!message.id) return vscode.commands.executeCommand('dhimantai.myCourses');
      if (!course || this.selection?.environment !== this.environment()) return;
      const chapter = this.projectChapter(course);
      if (!chapter) return this.status('No chapter is currently available. Check the course outline and access.');
      return vscode.commands.executeCommand('dhimantai.openLearningRoom', subject ?? course.title, chapter.id);
    }
    if (message?.type === 'grade' && this.selection?.catalog.courses.some(c => c.id === message.id && c.enrolled))
      return vscode.commands.executeCommand('dhimantai.courseGrade', message.id);
    if (message?.type === 'study') {
      const companion = this.companions.find(c => c.id === message.id);
      const course = this.selection?.catalog.courses.find(c => c.id === message.id);
      return vscode.commands.executeCommand('dhimantai.openStudy', companion?.id ?? course?.title);
    }
    if (message?.type === 'capstone' && CODE_READING_PROJECTS_ENABLED && message.id === 'engineering-code-reading') {
      if (this.selection?.catalog.courses.find(c => c.id === message.id)?.expired) return;
      return vscode.commands.executeCommand('dhimantai.startCapstone', message.id);
    }
    if (message?.type === 'resumeProject') {
      const saved = this.projects.find(p => p.root === message.id);
      if (!saved || this.projectAccessEnded(saved.projectId)) return;
      return vscode.commands.executeCommand('dhimantai.openSavedProject', saved.root);
    }
    if (message?.type === 'project') {
      const project = CATALOG_PROJECTS.find(p => p.id === message.id);
      if (project) {
        if (this.projectAccessEnded(project.id)) return;
        const records = this.projects.filter(p => p.projectId === project.id);
        if (!records.length) return vscode.commands.executeCommand('dhimantai.startCapstone', project.id);
        const record = await vscode.window.showQuickPick<{label: string; description?: string; detail?: string; root?: string}>(
          [...records.map(r => ({label: r.title, description: r.root, detail: r.status, root: r.root})),
            {label: 'Choose another course…', detail: 'Create or reopen the project in that course folder'}], {title: project.title});
        if (!record) return;
        if (record.root) return vscode.commands.executeCommand('dhimantai.openSavedProject', record.root);
        return vscode.commands.executeCommand('dhimantai.startCapstone', project.id);
      }
      return;
    }
    if (['studioGuided','studioAssignment','studioPhp'].includes(message?.type) && message.id==='laravel-react-mysql') {
      return vscode.commands.executeCommand('dhimantai.openProjectMentor',{project:'equipment-desk',mode:message.type==='studioAssignment'?'independent':'guided',
        ...(message.type==='studioPhp'?{lesson:'php'}:{})});
    }
    if (message?.type === 'courseProject') {
      const course = this.selection?.catalog.courses.find(c => c.id === message.id);
      if (!course || !this.pathways?.[course.id]) return;
      if (!this.selection?.account) return vscode.commands.executeCommand('dhimantai.signIn');
      if (!course.enrolled || course.expired) {
        void vscode.window.showInformationMessage(course.expired ? 'Renew course access before starting a project.' : 'Start this course first, then return to Projects.');
        return;
      }
      return vscode.commands.executeCommand('dhimantai.startCourseProject', course.id);
    }
    if (message?.type === 'join' && !this.selection?.catalog.individual) return this.showCourseStart();
    if (message?.type === 'join' || (message?.id && ['signUp', 'signIn'].includes(message.type)))
      return this.startCourse(message.id);
    if (message?.type === 'signUp' || message?.type === 'signIn') {
      await vscode.commands.executeCommand(`dhimantai.${message.type}`, this.environment());
      return this.refresh();
    }
    if (message?.type === 'refresh') return this.refresh(true);
    // Only catalog mutations need a selection; ignore unrelated lifecycle messages.
    if (message?.type !== 'buy' && message?.type !== 'resume') return;
    const selection = this.selection;
    if (!selection || selection.environment !== this.environment()) return this.refresh();
    try {
      if (this.purchasing) return;
      const resume = message.type === 'resume';
      if (!selection.account || (!resume && !selection.catalog.individual)) throw new Error('Sign in with an individual learner account to unlock a course.');
      if (!selection.billing?.payments_ready) throw new Error('Payments are unavailable. Refresh and try again.');
      if (resume) {
        const purchase = selection.billing.purchases.find(p => p.id === message.id);
        if (!this.payments || !purchase || !canResumePurchase(purchase)) return this.refresh(true);
      } else {
        const offer = selection.catalog.offers?.find(o => o.id === message.id);
        if (!offer || offer.owned) return this.refresh(true);
      }
      this.purchasing = true;
      this.sequence++; // A slower catalog read must not replace checkout state.
      this.status('Opening secure checkout…');
      let notice = '';
      try {
        const env = this.service();
        const api = new Api(this.auth, () => {
          if (this.environment() !== selection.environment) throw new Error('Your service changed. Reopen Pricing.');
          return env;
        }, selection.account);
        const result = resume ? await api.resumeLearningPurchase(message.id) : await api.purchaseLearningOffer(message.id);
        if (resume && result.order_id !== message.id) throw new Error('Checkout does not match the selected purchase. Refresh its status.');
        if (!this.panel || this.selection !== selection || this.environment() !== selection.environment || (await this.auth.session())?.user.id !== selection.account) return;
        const uri = vscode.Uri.parse(checkoutUri(result.checkout_url, env.apiUrl));
        this.awaitingPayment = result.order_id;
        const opened = await vscode.env.openExternal(uri);
        if (!opened) { this.awaitingPayment = undefined; throw new Error('Could not open your browser. Try again to reopen the same pending checkout.'); }
        notice = this.payments ? 'Checkout opened in your browser. Return here after payment to check your status.'
          : 'Checkout opened in your browser. After payment, return here and select Refresh purchases to activate your purchased courses.';
      } catch (error) {
        notice = error instanceof Error ? error.message : 'Checkout could not be opened. Refresh purchases before trying again.';
      } finally {
        this.purchasing = false;
        if (this.environment() === selection.environment && (await this.auth.session())?.user.id === selection.account) this.status(notice);
        const queued = this.refreshQueued; this.refreshQueued = undefined;
        if (queued !== undefined) await this.refresh(queued);
      }
    } catch (error) {
      if (this.selection === selection) this.status(error instanceof Error ? error.message : 'Could not join this course. Retry.');
    }
  }
  private async setupContainer(name: string) {
    const selection = this.selection;
    if (!selection?.account || selection.environment !== this.environment() || !setupCourseNames(selection.lessons).includes(name)) return;
    if ((await this.auth.session())?.user.id !== selection.account || this.selection !== selection || this.setup?.busy) return;
    const operation = {message:'Preparing the container for ' + name + '…', busy:true};
    this.setup = operation;
    void this.panel?.webview.postMessage({type:'setupStatus', ...operation});
    try {
      const folder = await vscode.commands.executeCommand<vscode.Uri>('dhimantai.setupCourse', name);
      operation.message = folder ? 'Setup completed for ' + name + '. You can run code in its notebook.'
        : 'Setup did not finish for ' + name + '. Choose Set Up Course Container to try again.';
    } catch (error) {
      operation.message = error instanceof Error ? error.message : 'Course setup failed. Try again.';
    } finally {
      operation.busy = false;
      if (this.setup === operation) void this.panel?.webview.postMessage({type:'setupStatus', ...operation});
    }
  }

  private render(catalog?: PublicCatalog, message = '', loading = false, openSetup = false) {
    if (!this.panel) return;
    const nonce = randomBytes(16).toString('hex'), account = this.scope?.account ?? this.selection?.account, environment = this.environment();
    const button = (label: string, type: string, id = '', disabled = false, secondary = false) =>
      `<button type="button" data-action="${type}" data-id="${escape(id)}"${secondary ? ' class="secondary"' : ''} data-disabled="${disabled}" ${disabled ? 'disabled' : ''}>${escape(label)}</button>`;
    const courses = catalog?.courses ?? [], offers = catalog?.offers ?? [], billing = this.selection?.billing;
    if (this.payments) {
      this.panel.title = 'Manage payments';
      this.panel.webview.html = paymentsPage({nonce, scope:JSON.stringify([environment, account ?? null]), environment,
        account, accountLabel:this.scope?.accountLabel, billing, courses, message, loading});
      return;
    }
    this.panel.title = 'dhimantAI Course Catalog';
    const individual = !!catalog?.individual, canPay = !account || (individual && !!billing?.payments_ready);
    // A one-course offer is that course's price; offers covering several courses are bundles.
    const single = new Map(offers.filter(o => o.course_ids.length === 1).map(o => [o.course_ids[0], o]));
    const bundles = offers.filter(o => o.course_ids.length > 1);
    const buy = (offer: LearningOffer, label: string, secondary: boolean) => account && !individual
      ? button('Use individual account', 'signIn', '', false, secondary)
      : account ? button(label, 'buy', offer.id, !canPay, secondary) : button(label, 'signIn', '', false, secondary);
    const pending = !!billing?.purchases.some(p => p.status === 'created' || p.status === 'creating');
    const resume = resumeOrder(courses).filter(c => c.id === 'erpnext-essentials' || catalogChapter(c)).slice(0, 3);
    const availableToLearn = (course: CatalogCourse) => !course.expired && (course.enrolled || course.can_join);
    const discovery = (course: CatalogCourse) => `data-course="${escape(course.id)}" data-category="${escape(categoryOf(course))}" data-price="${coursePriceKind(course)}" data-track="${escape(sectionOf(course))}" data-level="${escape(course.level)}" data-enrolled="${course.enrolled}" data-available="${availableToLearn(course)}" data-status="${courseLearningStatus(course) ?? ''}"`;
    const chapterButton = (course: CatalogCourse, secondary = false) => {
      if (course.expired) return button('Access ended', 'practice', course.id, true, secondary);
      if (!course.can_join && !course.enrolled) return button('Enrollment closed', 'join', course.id, true, secondary);
      const chapter = this.projectChapter(course);
      if (!chapter) return button('No accessible chapter', 'practice', course.id, true, secondary);
      const action = course.enrolled ? 'practice' : !account ? 'signUp' : individual ? 'join' : 'signIn';
      const label = action === 'signIn' ? 'Use individual account' : chapterActionLabel(course, chapter);
      return button(label, action, course.id, false, secondary);
    };
    const trackTag = (course: CatalogCourse) => `<span class="track-tag" data-color="${categoryHue(sectionOf(course))}" data-tone="${styleOf(sectionOf(course))}">${escape(sectionOf(course))}</span>`;
    const suggestions = courseSuggestions(courses);
    const courseCard = (course: CatalogCourse) => {
      const p=this.pathways?.[course.id];
      const readiness=p?`<details><summary>Skills, projects and readiness</summary><p>${escape(p.role||'Foundation for a role pathway')} · ${escape(p.level)}</p><p>${escape(p.technology_stack.join(' · '))}</p><ul>${p.outcomes.map(o=>`<li>${escape(o)}</li>`).join('')}</ul><p>Project theme: ${escape(p.project_theme)}</p><p>Micro: one concept. Minor: integrated skills. Major: end-to-end delivery.</p><p>${p.certifiable?'Certification requires independent assessment of projects, an unfamiliar observed task and a project defence.':'Continue to a role pathway for job-readiness certification.'}</p>${p.prerequisites.length?`<p>Readiness prerequisites: ${p.prerequisites.map(id=>escape(courses.find(c=>c.id===id)?.title??id)).join(', ')}</p>`:''}</details>`:'';
      const offer = single.get(course.id);
      const primary = chapterButton(course);
      const purchasable = offer && !offer.owned && !course.is_free && !course.unlocked && (!account || individual) ? offer : undefined;
      const unlock = purchasable ? buy(purchasable, `${course.expired ? 'Buy again' : 'Unlock all'} · ${priceLabel(purchasable.amount, purchasable.currency)}`, !course.expired) : '';
      const period = accessPeriod(course);
      const progress = course.enrolled ? coverageMeter(course) : '';
      // Covered chapters read as done (a check), never as cancelled (strikethrough).
      const chapterName = (ch:CatalogCourse['chapters'][number]) => {
        const title=course.id==='laravel-react-mysql' && course.enrolled && openChapter(course,ch) && equipmentLesson(ch.id)
          ? button(ch.name,'projectChapter',ch.id,false,true) : escape(ch.name);
        return ch.progress?.status==='covered' ? `<span class="covered"><span aria-hidden="true">✓</span> ${title}</span>` : title;
      };
      const outline = `<ol>${course.chapters.map(ch => `<li data-catalog-chapter="${escape(ch.id)}">${chapterName(ch)}${ch.lesson && ch.lesson !== ch.name ? ' — ' + escape(ch.lesson) : ''}
        <small class="muted">${course.enrolled ? ' · ' + escape(coverageLabel(ch.progress)) : ''}${course.expired ? ' · Locked' : ch.locked ? ' · Locked' : ch.free || course.is_free ? ' · Free' : course.unlocked ? ' · Unlocked' : ' · Locked'}</small>
        ${course.enrolled ? topicCoverageHtml(ch.progress) : ''}</li>`).join('')}</ol>`
        + (course.enrolled ? `<p class="muted small">${coverageNote}</p>` + button('Roadmap, grade & certificate', 'grade', course.id, false, true) : '');
      const preview = previewFor(course);
      const previewId = 'preview-' + escape(course.id);
      const sample = preview ? `<button type="button" class="preview-entry" aria-haspopup="dialog" aria-controls="${previewId}">
          <strong>Try a chapter preview <span aria-hidden="true">→</span></strong></button>
        <dialog class="course-preview" id="${previewId}" aria-labelledby="${previewId}-title">
          <header><p class="preview-caption">${escape(course.title)} · Chapter preview</p><form method="dialog"><button class="secondary" aria-label="Close preview">Close</button></form></header>
          <h2 id="${previewId}-title" tabindex="-1" autofocus>${escape(preview.title)}</h2>
          <pre><code>${escape(preview.source)}</code></pre>
          <fieldset><legend>${escape(preview.question)}</legend><div class="preview-answers">
            ${preview.answers.map(answer => `<button type="button" class="secondary" aria-pressed="false" data-feedback="${escape(answer.feedback)}" data-correct="${!!answer.correct}">${escape(answer.label)}</button>`).join('')}
          </div></fieldset><p class="preview-feedback" role="status"></p>
          <footer>${primary}</footer>
        </dialog>` : '';
      const style = styleOf(sectionOf(course));
      const access = accessLabel(course);
      const needsOffer = !course.company_training && !course.is_free && !course.unlocked && !offer && (!account || individual);
      const bundlePricing = needsOffer && bundles.some(b => !b.owned && b.course_ids.includes(course.id))
        ? `<button type="button" class="secondary" data-browse-category="type:bundle" data-browse-query="${escape(course.title)}">View bundle pricing</button>` : '';
      const priceNote = needsOffer && !bundlePricing ? 'Full-course checkout is currently unavailable.' : '';
      const renew = !!(course.expired && unlock);
      const extraActions = (STUDY_ENABLED && course.enrolled && this.studyCourses.has(course.title) ? button('Study', 'study', course.id, false, true) : '')
        + (CODE_READING_PROJECTS_ENABLED && course.id === 'engineering-code-reading' && !course.expired ? button('Read a project', 'capstone', course.id, false, true) : '');
      return `<article class="course" data-category-card data-color="${categoryHue(sectionOf(course))}" data-tone="${style}" data-layout="${style}" ${discovery(course)} data-preview="${!!preview}">
        <div class="card-body"><div class="meta">${trackTag(course)}<span class="level">${escape(course.level)}</span><span>${course.chapters.length} chapters</span>
          ${course.enrolled ? '<span class="joined">✓ Joined</span>' : ''}</div>
          <h3>${escape(course.title)}</h3><p class="summary">${escape(course.summary)}</p>
          <span class="access-tag">${access}</span>
          ${priceNote ? `<p class="muted small">${priceNote}</p>` : ''}${sample}<details data-course-outline><summary>Course outline</summary>
            ${period ? `<p class="period">${escape(period)}</p>` : ''}${progress}${extraActions}${course.prerequisites ? `<p>Before you start: ${escape(course.prerequisites)}</p>` : ''}${outline}${readiness}
          </details></div>
        <div class="actions">${renew ? unlock : primary + unlock + bundlePricing}
          </div></article>`;
    };
    const courseById = new Map(courses.map(c => [c.id, c]));
    const bundleCard = (offer: LearningOffer) => {
      const members = offer.course_ids.map(id => courseById.get(id));
      const titles = members.map((c, i) => c?.title ?? offer.course_ids[i]);
      const levels = [...new Set(members.flatMap(c => c?.level ? [c.level] : []))];
      const parts = offer.course_ids.map(id => single.get(id));
      const separate = parts.every(part => part && part.currency === offer.currency) ? parts.reduce((sum, o) => sum + o!.amount, 0) : 0;
      const statuses = members.map(c => c && courseLearningStatus(c));
      const status = statuses.every(s => s === 'covered') ? 'covered' : statuses.some(s => s === 'inProgress' || s === 'covered') ? 'inProgress'
        : statuses.every(s => s === 'notStarted') ? 'notStarted' : '';
      const owned = members.filter(c => c?.unlocked).length;
      return `<article class="course offer" data-category-card data-price="paid" data-bundle="${escape(offer.id)}" data-search-topics="${escape(titles.join(' '))}" data-levels="${escape(JSON.stringify(levels))}"
        data-enrolled="${offer.owned}" data-available="${members.some(c => c && availableToLearn(c))}" data-status="${status}" data-tone="bundles"><div class="offer-head"><h3>${escape(offer.title)}</h3>
        <p><strong class="price">${escape(priceLabel(offer.amount, offer.currency))}</strong>${separate > offer.amount ? ` <span class="save">Save ${escape(priceLabel(separate - offer.amount, offer.currency))}</span>` : ''}</p></div>
        <div class="offer-body"><ul class="members">${titles.slice(0, 3).map(title => `<li>${escape(title)}</li>`).join('')}</ul>
        ${titles.length > 3 ? `<details><summary>${titles.length - 3} more course${titles.length === 4 ? '' : 's'}</summary><ul class="members">${titles.slice(3).map(title => `<li>${escape(title)}</li>`).join('')}</ul></details>` : ''}
        ${owned && !offer.owned ? '<p class="muted small">You already own part of this bundle. The price shown is the full bundle price.</p>' : ''}
        <div class="actions">${offer.owned ? '<span>Purchased</span>' : buy(offer, 'Buy bundle', false)}</div></div></article>`;
    };
    const erp = courseById.get('erpnext-essentials');
    const erpChecked = account && this.browserProgress ? Math.min(ERP_TASK_TOTAL, this.browserProgress(this.environment(), account)) : 0;
    const tourButton = (course: CatalogCourse, secondary = false) => course.expired || !availableToLearn(course)
      ? button(course.expired ? 'Access ended' : 'Enrollment closed', 'browserCourse', course.id, true, secondary)
      : button(erpChecked || course.enrolled ? 'Resume guided tour' : 'Start guided tour', course.enrolled ? 'browserCourse'
        : !account ? 'signUp' : individual ? 'join' : 'signIn', course.id, false, secondary);
    const homeAction = (course: CatalogCourse, secondary = false) => course.id === 'erpnext-essentials' ? tourButton(course, secondary) : chapterButton(course, secondary);
    const available = courses.filter(c => availableToLearn(c) && (c.id === 'erpnext-essentials' || catalogChapter(c)));
    const free = available.filter(c => coursePriceKind(c) === 'free');
    const starter = (course: CatalogCourse) => course.chapters[0] && openChapter(course, course.chapters[0])
      ? starterExercises.find(exercise => exercise.courseId === course.id) : undefined;
    const featured = resume[0] ?? free.find(c => c.level?.toLowerCase() === 'foundation') ?? free[0]
      ?? available.find(c => starter(c)) ?? available[0];
    const homeCard = (course: CatalogCourse, first: boolean, label = '') => {
      const chapter = this.projectChapter(course);
      const number = chapter ? course.chapters.indexOf(chapter) + 1 : 0;
      const chapterTitle = (chapter?.lesson || chapter?.name || '').replace(new RegExp('^chapter\\s+' + number + '\\s*[:.·–—-]\\s*', 'i'), '');
      const activity = starter(course);
      const topic = resumeTopic(course, chapter?.id);
      return `<article class="resume-card${first ? ' first' : ''}" data-color="${categoryHue(sectionOf(course))}" data-tone="${styleOf(sectionOf(course))}" data-category-card data-home-course="${escape(course.id)}">${label ? `<p class="dh-eyebrow">${label}</p>` : ''}<div class="meta">${trackTag(course)}<span>${escape(course.level)}</span></div>
        <h3>${escape(course.title)}</h3>${first ? `<p>${escape(activity && !course.enrolled ? activity.activity + ' ' + activity.preparation : course.summary)}</p>` : ''}
        <p class="next">${course.id === 'erpnext-essentials' ? 'Guided tour with the Instructor' : chapter ? `Chapter ${number} · <strong>${escape(chapterTitle)}</strong>` : ''}</p>
        ${topic ? `<p class="small">Next topic · ${escape(topic)}</p>` : ''}
        ${course.enrolled && hasCoverage(course) ? progressBar(coveredCount(course), course.chapters.length, courseCoverage(course.chapters)) : ''}
        ${course.enrolled && !hasCoverage(course) && course.id !== 'erpnext-essentials' ? '<p class="small">Progress unavailable</p>' : ''}
        <div class="actions">${homeAction(course, !first)}<span class="home-access">${escape(accessLabel(course))}</span></div></article>`;
    };
    const otherHome = resume.length ? resume.slice(1) : available.filter(c => c !== featured && starter(c)).slice(0, 2);
    // Home asks what to work on: the course and the project sit side by side, and the learner chooses.
    const savedProject = this.projects.find(p => p.root && p.title && p.status !== 'Project folder unavailable' && !this.projectAccessEnded(p.projectId));
    const choosing = !!resume.length || !!savedProject;
    const projectCard = savedProject ? `<article class="resume-card first project-choice" data-category-card data-tone="projects">
        <p class="dh-eyebrow">Continue project</p><div class="meta"><span class="track-tag" data-tone="projects">Project</span></div>
        <h3>${escape(savedProject.title)}</h3>${savedProject.status ? `<p class="next">${escape(savedProject.status)}</p>` : ''}
        <div class="actions">${button(savedProject.status?.startsWith('Completed') ? 'Open project' : 'Resume project', 'resumeProject', savedProject.root)}</div></article>`
      : CATALOG_PROJECTS.length ? `<article class="resume-card first project-choice" data-category-card data-tone="projects">
        <p class="dh-eyebrow">Build a project</p><div class="meta"><span class="track-tag" data-tone="projects">Projects</span></div>
        <h3>Practise on a real codebase</h3><p>Investigate, repair and verify working software with the Project Mentor.</p>
        <div class="actions"><button type="button" class="secondary" data-browse-category="type:project">Browse projects</button></div></article>` : '';
    const otherCards = otherHome.length ? `<div class="home-other">${otherHome.map(c => homeCard(c, false)).join('')}</div>` : '';
    const hero = choosing ? `<section class="resume" aria-labelledby="home-title">
      <div class="home-choices">${featured ? homeCard(featured, true, resume.length ? 'Continue learning' : 'Start learning') : ''}${projectCard}</div>${otherCards}</section>`
      : featured ? `<section class="intro" aria-labelledby="home-title">
      <div class="home-feature">${homeCard(featured, true)}${otherCards}</div></section>` : '';
    const freeShelf = free.length ? `<section id="free-shelf" aria-labelledby="free-title"><div class="shelf-heading"><h2 id="free-title">Fully free courses</h2>
      <button class="text-button" type="button" data-browse-price="free">See all free courses →</button></div>
      <div class="home-grid">${free.slice(0, 4).map(c => `<article class="home-tile" data-category-card data-color="${categoryHue(sectionOf(c))}" data-tone="${styleOf(sectionOf(c))}" data-home-course="${escape(c.id)}"><div class="meta">${trackTag(c)}<span>${escape(c.level)}</span></div><h3>${escape(c.title)}</h3>
        <p>${escape(c.summary)}</p><div class="actions"><span class="access-tag">All chapters free</span>${homeAction(c, true)}</div></article>`).join('')}</div></section>` : '';
    // Show renewal when the companion expired and there is no other eligible course.
    const projectRenewal = (id: string) => {
      const offer = single.get(PROJECT_COURSES[id]);
      return offer && !offer.owned ? buy(offer, `Renew access · ${priceLabel(offer.amount, offer.currency)}`, false)
        : button('View pricing & purchases', 'payments');
    };
    const projectCourses = courses.filter(c => !!this.pathways?.[c.id]);
    const courseProjects = projectCourses.length ? `<article class="course project" data-category-card data-tone="projects" data-project="course-projects" data-available="${projectCourses.some(c => c.enrolled && !c.expired)}"><h3>Course projects & custom setup</h3>
      <p>Choose a course to set up a Micro, Minor or Capstone project using its brief or your own idea.</p><div class="setup-controls">
      <label for="project-course">Course</label><select id="project-course">${projectCourses.map(c => `<option value="${escape(c.id)}">${escape(c.title)}</option>`).join('')}</select>
      <div class="actions">${button('Set up project', 'courseProject')}</div></div></article>` : '';
    const projects = `
      ${courses.some(c=>c.id==='laravel-react-mysql') ? `<article class="course project" data-category-card data-project="equipment-desk" data-tone="projects"><h3>Equipment Desk</h3><p>Build a checkout app with PHP, Laravel, MySQL and React.</p><div class="actions">${button('Learn to build','studioGuided','laravel-react-mysql')}${button('Start assignment','studioAssignment','laravel-react-mysql',false,true)}</div><details><summary>Lesson entry points</summary>${button('Model stock in PHP','studioPhp','laravel-react-mysql',false,true)}</details></article>` : ''}
      ${courseProjects}
      <div class="courses">${CATALOG_PROJECTS.map(project => {
        const companion = courses.find(c => c.id === PROJECT_COURSES[project.id]);
        const ended = projectAccessEnded(project.id, courses, this.selection?.lessons);
        const records = this.projects.filter(p => p.projectId === project.id);
        const saved = records.find(p => p.status.startsWith('Completed locally')) ?? records[0];
        const remote = this.selection?.practiceProgress?.[project.id];
        const recorded = remote === 'completed';
        const progress = saved?.status ?? (recorded ? 'Practice completed on your account' : remote === 'in_progress' ? 'In progress'
          : this.selection?.account && !this.selection.practiceProgress && architectureCase(project.id) ? 'Account progress unavailable' : 'Not started');
        const status = [progress, saved && recorded ? 'Practice completion recorded' : ''].filter(Boolean).join(' · ');
        return `<article class="course project" data-category-card data-tone="projects" data-project="${escape(project.id)}" data-status="${recorded || saved?.status.startsWith('Completed locally') ? 'covered' : saved || remote ? 'inProgress' : progress === 'Not started' ? 'notStarted' : ''}" data-level="${escape(project.difficulty)}" data-enrolled="${!!saved || !!remote}" data-available="${!ended}"
          data-search-topics="${escape(project.outcomes.join(' '))}" aria-labelledby="project-${escape(project.id)}">
        <div class="meta project-meta"><span class="size-tag">${escape(project.level)}</span><span class="level">${escape(project.difficulty)}</span>
          <span>Estimated ${escape(project.estimatedTime)}</span><span class="project-status">${escape(ended ? 'Access ended' : status)}</span></div>
        <h3 id="project-${escape(project.id)}">${escape(project.title)}</h3><p>${escape(project.description)}</p>
        ${companion ? `<p class="small">Companion course · ${escape(companion.title)}</p>` : ''}
        <details><summary>Learning outcomes</summary><ul class="small">${project.outcomes.map(outcome => `<li>${escape(outcome)}</li>`).join('')}</ul></details>
        <div class="actions">${ended ? projectRenewal(project.id)
          : button(saved ? 'Open Project' : remote ? 'Open on this computer' : 'Start Project', 'project', project.id)}</div></article>`;
      }).join('')}</div>`;
    const businessCard = `<article class="course" data-category-card data-tone="business" data-layout="business" data-price="${erp ? coursePriceKind(erp) : ''}" data-browser-course="erpnext-essentials" data-category="Business applications" data-level="Beginner" data-available="${!erp?.expired}" data-enrolled="${!!erp?.enrolled}" data-status="${erpChecked === ERP_TASK_TOTAL ? 'covered' : erpChecked ? 'inProgress' : 'notStarted'}"><div class="card-body"><div class="meta"><span class="level">Beginner</span><span>${ERP_TASK_TOTAL} linked tasks</span><span class="access-tag">${erp ? escape(accessLabel(erp)) : 'Live Instructor'}</span></div>
          <h3>ERPNext Essentials</h3>${erp && accessPeriod(erp) ? `<p class="period">${escape(accessPeriod(erp))}</p>` : ''}<p>Run a small company in an ERPNext sandbox. Buy stock, fulfil orders and collect payment with your Instructor.</p>
          <details data-course-outline><summary>Course outline and preparation</summary><ol><li>Your company’s accounts</li><li>Customers</li><li>Suppliers</li><li>Stock items</li><li>Purchase orders</li><li>Receiving goods</li><li>Supplier bills</li><li>Paying suppliers</li><li>Sales orders</li><li>Deliveries</li><li>Sales invoices</li><li>Collecting payment</li><li>Bills of materials</li><li>Final challenge: a new customer, start to finish, without hints</li></ol>
          <p>The sandbox runs on your computer. Accounts share one ERPNext instance with separate logins and training companies. First setup downloads the application image and requires 6 GB of runtime memory. HR and payroll are not included in this course.</p></details>
          ${erpChecked ? `${progressBar(erpChecked, ERP_TASK_TOTAL, `${erpChecked} of ${ERP_TASK_TOTAL} tasks done`)}<p class="small muted">${erpChecked} of ${ERP_TASK_TOTAL} tasks done: saved work checked in ERPNext and explained</p>` : ''}
          </div>
          <div class="actions">${erp ? tourButton(erp) : button('Start guided tour', 'browserCourse', 'erpnext-essentials')}</div></article>`;
    const groups = new Map<string, CatalogCourse[]>();
    for (const course of courses) {
      const title = sectionOf(course);
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title)!.push(course);
    }
    if (!groups.has('Business applications')) groups.set('Business applications', []);
    const sections: CatalogSection[] = [...groups].map(([title, members]) => {
      const style = styleOf(title);
      const cards = members.map(course => course.id === 'erpnext-essentials' ? businessCard : courseCard(course));
      if (style === 'business' && !members.some(course => course.id === 'erpnext-essentials')) cards.push(businessCard);
      return {title, style, content:cards.join('')};
    });
    sections.push({title:'Projects', style:'projects', content:projects});
    if (bundles.length) sections.push({title:'Bundles', style:'bundles', content:`<div class="courses">${bundles.map(bundleCard).join('')}</div>`});
    const exploreSections = orderedSections(sections);
    const categoryOptions = [['', 'All'], ['type:course', 'Courses'], ...exploreSections.map(section => [sectionKey(section), section.title])];
    const availableLevels = new Set([...courses.map(c => c.level), 'Beginner', ...CATALOG_PROJECTS.map(p => p.difficulty)].filter(Boolean));
    const levels = [...new Set(['Foundation','Beginner','Beginner to Intermediate','Intermediate','Advanced','Professional', ...availableLevels])]
      .filter(level => availableLevels.has(level));
    const homeProjects = CATALOG_PROJECTS.filter(project => !this.projectAccessEnded(project.id)).slice(0, 4);
    const projectShelf = homeProjects.length ? `<section aria-labelledby="home-projects"><div class="shelf-heading"><h2 id="home-projects">Build something real</h2>
      <button type="button" class="text-button" data-browse-category="type:project">All projects →</button></div><div class="home-grid">
      ${homeProjects.map(project => `<article class="home-tile" data-category-card data-tone="projects"><div class="meta"><span class="track-tag" data-tone="projects">${escape(project.level)}</span>${escape(project.estimatedTime)}</div>
        <h3>${escape(project.title)}</h3><p>${escape(project.description)}</p><div class="actions">${button(this.projects.some(p => p.projectId === project.id) ? 'Open project' : this.selection?.practiceProgress?.[project.id] ? 'Open on this computer' : 'Start project', 'project', project.id, false, true)}</div></article>`).join('')}</div></section>` : '';
    const desktop = vscode.env.appName === 'dhimantAI';
    const guideLink = `<button type="button" id="open-guide" aria-haspopup="dialog" aria-controls="course-guide">${typeIcon('other')}Help &amp; Course Guide</button>`;
    this.panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dhimantAI Course Catalog</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <style nonce="${nonce}">${UI_TOKENS}
      .preview-entry{display:block;background:transparent;color:var(--vscode-textLink-foreground);border:0;padding:0;margin:7px 0;text-align:start;font-size:.9em}
      .preview-caption{font-size:.9em;color:var(--dh-muted)}.preview-entry strong{font-weight:500}
      .course-preview{box-sizing:border-box;width:min(600px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;padding:clamp(16px,4vw,32px);color:var(--vscode-foreground);background:var(--vscode-editor-background);border:1px solid var(--dh-border);border-radius:var(--dh-radius);box-shadow:var(--dh-shadow)}
      .course-preview::backdrop{background:rgb(0 0 0 / .52)}.course-preview header{display:flex;align-items:center;justify-content:space-between;gap:12px}.course-preview header p{margin:0}
      .course-preview h2{font-size:clamp(20px,3vw,28px);line-height:1.25;margin:14px 0}.course-preview pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background,var(--dh-surface));border:1px solid var(--dh-border);border-radius:var(--dh-radius-sm);padding:12px;font:14px/1.65 var(--vscode-editor-font-family,monospace)}
      .course-preview fieldset{border:0;padding:0;margin:20px 0 0;min-width:0}.course-preview legend{padding:0;font-weight:600}.preview-answers{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
      .preview-answers button[aria-pressed=true]{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}.preview-feedback:not(:empty){padding:10px 12px;border-inline-start:3px solid var(--vscode-focusBorder);background:var(--dh-surface)}.preview-feedback[data-correct=true]{border-color:var(--dh-success)}
      .course-preview footer{display:flex;justify-content:flex-end;border-top:1px solid var(--dh-border);padding-top:14px;margin-top:18px}
      ${catalogStyles}
      ${desktop ? controlStyles : ''}
      ${typeColors}
      ${sections.map(section => `[data-color="${categoryHue(section.title)}"] {--hue:${categoryHue(section.title)}}`).join('')}
      </style></head><body${desktop ? ' class="learning-desktop"' : ''}>
      ${desktop ? `${controlDialog}<script nonce="${nonce}">const initializeDesktopControls = ${desktopControlsClient.toString()};</script>` : ''}
      <div class="catalog-bar"><header class="top"><div><p class="dh-eyebrow">Welcome to dhimantAI</p><h1>Course Catalog</h1>${desktop || environment === 'production' ? '' : `<p class="muted small">${escape(environment)} service</p>`}</div>
      <div class="actions" aria-label="Account">${account
        ? `<span class="small">Signed in${(this.scope?.accountLabel ?? this.selection?.accountLabel) ? ' as ' + escape((this.scope?.accountLabel ?? this.selection?.accountLabel)!) : ''}</span>${button('Sign out', 'signOut', '', false, true)}`
        : button('Sign in', 'signIn', '', false, true)}</div></header>
      <nav class="catalog-nav" aria-label="Learning"><button type="button" class="view-link" data-view="home" aria-controls="catalog-home" aria-current="page">Home</button>
        <button type="button" class="view-link" data-view="explore" aria-controls="catalog-explore">Explore</button>${desktop ? '' : `${button('Instructor', 'tutor', '', false, true)}${STUDY_ENABLED ? button('Study', 'study', '', false, true) : ''}${button('Doubt Solver', 'doubtSolver', '', false, true)}${account ? button('My courses', 'practice', '', false, true) + button('My certificates', 'certificates', '', false, true) : ''}`}
        ${desktop ? '' : guideLink}</nav></div>
      <main data-loading="${loading}" data-starting="${escape(this.starting?.id ?? '')}">
      ${catalog && account && !individual ? '<p class="notice">You are signed in with an institute account. Public courses use a separate individual learner account. Choose <strong>Use individual account</strong> to sign in with email or create an individual account. Join a course there to see it in Practice. <strong>My courses</strong> opens your institute learning.</p>' : ''}
      ${account && billing && !billing.payments_ready ? '<p class="muted">Payments are not available yet. Free courses and free first chapters remain available.</p>' : ''}
      <p id="status" role="status"><span id="status-message">${escape(message)}</span> <span id="payment-check"${pending || this.awaitingPayment || (!catalog && !loading) ? '' : ' hidden'}>${button(account ? 'Refresh purchases' : 'Refresh courses', 'refresh', '', false, true)}</span></p>
      <div id="catalog-content"><div id="catalog-home" aria-labelledby="home-title">
      <h2 class="view-title" id="home-title" tabindex="-1">${choosing ? 'What do you want to work on today?' : featured ? 'Choose your first lesson' : 'Find a course'}</h2>
      ${hero}${freeShelf}
      ${sectionChips(sections)}
      ${suggestions.length ? `<section aria-labelledby="suggestions-title"><h2 id="suggestions-title">Recommended for you</h2><div class="suggestions">${suggestions.map(({course,reason})=>`<button class="secondary" data-color="${categoryHue(sectionOf(course))}" data-tone="${styleOf(sectionOf(course))}" data-discover="${escape(course.title)}">${typeIcon(styleOf(sectionOf(course)))}<span>${escape(course.title)}<small>${escape(reason)}</small></span></button>`).join('')}</div></section>` : ''}
      ${projectShelf}</div>
      <div id="catalog-explore" aria-labelledby="explore-title" hidden>
      <h2 class="view-title" id="explore-title" tabindex="-1">Explore courses</h2>
      <div class="explore-search" role="search"><label for="search">Search courses, projects and bundles</label><input id="search" type="search" placeholder="Search by title, topic or track"></div>
      ${filterOptions('category', 'Category', categoryOptions, false, true)}
      <div class="explore-layout"><aside aria-label="Catalog filters"><button id="toggle-filters" class="secondary" aria-controls="filter-fields" aria-expanded="false">Filters</button>
      <div class="discovery-filters" id="filter-fields"><h3>Filters</h3>
      ${filterOptions('show', 'Show', [['','All'], ['freeStart','Free to start'], ['enrolled','Joined'], ['available','Available to learn'],
        ...(courses.some(previewFor) ? [['preview','With chapter previews']] : [])], false, true)}
      ${filterOptions('level', 'Level', levels.map(level => [level, level]), true, true)}
      ${filterOptions('price', 'Course price', [['','Any price'], ['free','All chapters free'], ['preview','Chapter 1 free'], ['paid','Paid · no free chapter']])}
      ${filterOptions('status', 'Learning status', [['notStarted','Not started'], ['inProgress','In progress'], ['covered','Completed lessons']], true)}
      ${groups.has('Engineering Essentials') ? `<div id="essential-paths" hidden>${essentialPaths(groups.get('Engineering Essentials')!)}</div>` : ''}
      <button class="text-button" id="clear-filters" type="button">Clear filters</button></div></aside>
      <div class="explore-matches"><div class="result-tools"><p id="result-count" role="status" aria-live="polite"></p>
      <label>Sort <select id="catalog-sort"><option value="">Catalog order</option><option value="title">Title A–Z</option></select></label></div>
      <div id="active-filters" role="group" aria-label="Applied filters"></div>

      <div id="results">${exploreSections.map(section => `<section class="result-group" data-group="${escape(sectionKey(section))}" data-title="${escape(section.title)}">
        <div class="shelf-heading"><h2>${escape(section.title)}</h2><small class="group-count"></small></div><div class="category-grid">${section.content}</div>
        <button type="button" class="secondary group-more">Show more <span class="sr-only">${escape(section.title)}</span></button></section>`).join('')}
      ${STUDY_ENABLED && this.companions.length ? `<section class="result-group" data-group="Programming book companions" data-title="Programming book companions" aria-labelledby="book-companions"><h2 id="book-companions">Programming book companions</h2><p class="muted">Original lessons, worked examples and practice activities with links to seven influential books. Included with the extension; reading works offline. Sign in for Study help.</p><div class="category-grid">${this.companions.map(c => `<article class="course" data-category-card data-course="${escape(c.id)}"><span class="muted small">${c.chapters.length} chapters · Free companion</span><h3>${escape(c.title)}</h3><p class="muted small">Book by ${escape(c.author)}</p><p>${escape(c.summary)}</p><details><summary>Outline and preparation</summary><ol>${c.chapters.map(ch => `<li>${escape(ch.title)}</li>`).join('')}</ol><p>${escape(c.preparation)}</p></details><div class="actions">${button('Study', 'study', c.id)}</div></article>`).join('')}</div><button type="button" class="secondary group-more">Show more companions</button></section>` : ''}
      </div><div id="empty" hidden><h3>No matching results</h3><p>Try a broader search or clear a filter.</p><button type="button" class="secondary" data-reset-search>Clear search and filters</button></div>
      <button type="button" class="secondary" id="more-results" hidden>Show more results</button></div></div></div>

      </div></main>
      ${desktop ? `<footer class="catalog-help">${guideLink}</footer>` : ''}
      ${catalogGuide({button, courses, lessons:this.selection?.lessons, signedIn:!!account, desktop:vscode.env.appName === 'dhimantAI',
        shortcut:platform() === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P', loading, message, setup:this.setup})}
      <script nonce="${nonce}">(${catalogClient.toString()})(${JSON.stringify(JSON.stringify([environment, account ?? null])).replace(/</g, '\\u003c')}, ${JSON.stringify(this.focusCourse ?? '').replace(/</g, '\\u003c')}, ${openSetup}, ${this.focusProjects});</script></body></html>`;
    if (catalog) { this.focusCourse = undefined; this.focusProjects = false; }
  }
}
