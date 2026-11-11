import { catalogClient } from './catalogClient';
import type { SkillingProfile } from './skilling';
import { ESSENTIAL_PATHS } from './essentials';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Auth } from './auth';
import { Environment, EnvironmentName } from './environments';
import { accessPeriod, CatalogCourse, LearningOffer, learnerRpc, PublicCatalog } from './learnerCatalog';
import { Api, Course, LearningPurchases } from './api';
import { checkoutUri, priceLabel } from './learningBilling';
import type { CompanionCourse } from './studyContent';
import { CATALOG_PROJECTS, PROJECT_COURSES, projectAccessEnded } from './catalogProjects';
import { ProjectResults, ProjectSummary } from './projectResults';
import { courseCoverage, coverageLabel, coverageNote, nextChapter, topicCoverageHtml } from './courseProgress';
import { progressBar, UI_TOKENS } from './uiTheme';
import { ERP_TASK_TOTAL } from './browserLearning';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Free and paid Engineering Essentials courses share one section; the price model stays per course.
const isEssential = (course: CatalogCourse) => course.id.startsWith('engineering-');

/** The RPC orders categories and their courses using database display_order values. */
function categorySections(courses: CatalogCourse[], card: (course: CatalogCourse) => string): string {
  const named = (course: CatalogCourse) => course.category || 'Software Engineering';
  return [...new Set(courses.map(named))].map(category => {
    const group = courses.filter(course => named(course) === category);
    const id = 'category-' + category.toLowerCase().replace(/[^a-z]+/g, '-');
    // Keep Essentials' compact track UI without moving its cards past courses
    // that the database placed after it. Contiguous runs retain exact RPC order.
    const runs: CatalogCourse[][] = [];
    for (const course of group) {
      const last = runs.at(-1);
      if (last && isEssential(last[0]) === isEssential(course)) last.push(course);
      else runs.push([course]);
    }
    return `<section class="category" aria-labelledby="${id}"><h2 id="${id}">${escape(category)}</h2>`
      + runs.map((members, index) => isEssential(members[0])
        ? essentialsSection(members, card, id + '-essentials-' + index)
        : `<div class="courses">${members.map(card).join('')}</div>`).join('') + '</section>';
  }).join('');
}

function essentialsSection(courses: CatalogCourse[], card: (course: CatalogCourse) => string, id: string): string {
  const access = courses.every(c => c.is_free)
    ? 'Every course in this track is free in full, with all chapters included.'
    : courses.every(c => !c.is_free)
      ? 'Each course includes a free first chapter. Unlock the paid course to access the remaining chapters.'
      : 'Courses labelled Free include all chapters. Paid courses include a free first chapter; unlock the course for the remaining chapters.';
  const present = new Set(courses.map(c => c.id));
  const paths = ESSENTIAL_PATHS.map(path => ({...path, ids: path.courses.map(id => 'engineering-' + id).filter(id => present.has(id))}))
    .filter(path => path.ids.length);
  const pathButton = (label: string, ids: string, pressed: boolean) =>
    `<button type="button" class="secondary" data-path="${escape(ids)}" aria-pressed="${pressed}">${escape(label)}</button>`;
  return `<section class="essentials" aria-labelledby="${id}"><h3 id="${id}">Engineering Essentials</h3>
    <p class="muted">Short courses on the habits strong engineers rely on, 30 to 50 minutes each. ${access} None is required before another course; pick the path for what you are about to do.</p>
    <div class="paths" role="group" aria-label="Suggested paths">${pathButton('All', '', true)}${paths.map(p => pathButton(p.label, p.ids.join(' '), false)).join('')}</div>
    <div class="courses">${courses.map(card).join('')}</div></section>`;
}

const resumeChapter = (course: CatalogCourse) =>
  nextChapter(course.chapters, ch => !course.expired && !!(ch.free || course.unlocked || course.is_free));
const coveredCount = (course: CatalogCourse) => course.chapters.filter(ch => ch.progress?.status === 'covered').length;
function coverageMeter(course: CatalogCourse): string {
  const covered = coveredCount(course), label = courseCoverage(course.chapters);
  return `<div class="coverage">${progressBar(covered, course.chapters.length, `${covered} of ${course.chapters.length} chapters covered`)}<p class="small muted">${escape(label)}</p></div>`;
}
/** Most recently active first, so the course a learner was just in is the one they resume. */
function resumeOrder(courses: CatalogCourse[]): CatalogCourse[] {
  const latest = (course: CatalogCourse) => Math.max(0, ...course.chapters.map(ch => Date.parse(ch.progress?.updated_at ?? '') || 0));
  const started = (course: CatalogCourse) => course.chapters.some(ch => ch.progress && ch.progress.status !== 'not_started' && ch.progress.status !== 'unavailable') ? 1 : 0;
  return courses.filter(c => c.enrolled && !c.expired).sort((a, b) => latest(b) - latest(a) || started(b) - started(a));
}

export class CourseCatalog implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private sequence = 0;
  private selection?: { environment: EnvironmentName; account?: string; accountLabel?: string; catalog: PublicCatalog; billing?: LearningPurchases; lessons?: Course[] };
  private purchasing = false;
  private scope?: {environment: EnvironmentName; account?: string; accountLabel?: string};
  private refreshQueued?: boolean;
  /** Set after checkout opens; returning to VS Code then refreshes purchases without a manual step. */
  private awaitingPayment = false;
  private welcomePending?: Promise<void>;
  private subscriptions: vscode.Disposable[];
  private projects: ProjectSummary[] = [];
  private studyCourses = new Set<string>();
  private pathways:Record<string,SkillingProfile> = {};
  private focusCourse?:string;

  constructor(private readonly auth: Auth, private readonly environment: () => EnvironmentName,
      private readonly service: () => Environment, private readonly joined: () => void,
      private readonly learningOpen: () => boolean = () => false,
      private readonly companions: CompanionCourse[] = [], private readonly results?: ProjectResults,
      private readonly media = '',
      /** ERPNext tasks this account verified on this computer; practice evidence, kept apart from Instructor coverage. */
      private readonly browserProgress?: (environment: EnvironmentName, account: string) => number) {
    this.subscriptions = [auth.onDidChange(session => {
      // Token renewal is not an account switch and must not invalidate a checkout.
      if (this.scope?.environment === this.environment() && this.scope.account === session?.user.id) return;
      this.clearAccount(); void this.refresh();
    }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dhimantai.environment')) { this.clearAccount(); void this.refresh(); }
      }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused && this.awaitingPayment) void this.refresh(true); })];
  }
  dispose() { this.sequence++; this.panel?.dispose(); this.subscriptions.forEach(d => d.dispose()); }
  private clearAccount() {
    this.sequence++; this.selection = undefined; this.scope = undefined;
    this.projects = []; this.studyCourses.clear(); this.pathways = {}; this.awaitingPayment = false;
    this.render(undefined, 'Loading courses…', true);
  }
  private status(message: string) {
    void this.panel?.webview.postMessage({type:'catalogStatus', message, busy:this.purchasing, paymentPending:this.awaitingPayment});
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
    if (desktop) await vscode.commands.executeCommand('dhimantai.learningNavigation.focus');
    // Restored work takes precedence. A later empty window can show the welcome.
    // Use owned state: VS Code's tab list can lag behind a newly opened notebook.
    if (this.learningOpen() || vscode.window.activeTextEditor || vscode.window.activeNotebookEditor) return;
    if (desktop && vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputNotebook
      || tab.input instanceof vscode.TabInputWebview && !tab.input.viewType.endsWith('dhimantai.courseCatalog')))) return;
    await this.open();
    await state.update('courseCatalogWelcomeShown', true);
  }
  async open(courseId?:string) {
    this.focusCourse=courseId;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('dhimantai.courseCatalog', 'DhimantAI Course Catalog', vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
      this.panel.onDidDispose(() => { this.sequence++; this.panel = undefined; this.selection = undefined; });
      this.panel.webview.onDidReceiveMessage(message => { void this.handle(message).catch(error => this.status(
        error instanceof Error ? error.message : 'Could not complete that action. Try again.')); });
    }
    this.panel.reveal();
    if (this.selection && this.selection.environment === this.environment()) {
      if (courseId) void this.panel.webview.postMessage({type:'focusCourse', query:this.selection.catalog.courses.find(c => c.id === courseId)?.title ?? ''});
      this.focusCourse = undefined;
      return;
    }
    await this.refresh();
  }
  async refresh(checkPayments = false) {
    if (!this.panel) return;
    if (this.purchasing) { this.refreshQueued = (this.refreshQueued ?? false) || checkPayments; return; }
    const sequence = ++this.sequence, environment = this.environment(), env = this.service();
    try {
      const session = await this.auth.session(), account = session?.user.id;
      if (sequence !== this.sequence || environment !== this.environment()) return;
      if (this.selection && (this.selection.account !== account || this.selection.environment !== environment)) {
        this.selection = undefined; this.projects = []; this.studyCourses.clear(); this.pathways = {}; this.awaitingPayment = false;
      }
      this.scope = {environment, account, accountLabel:session?.user.email ?? session?.user.phone};
      if (this.selection) this.status(checkPayments ? 'Checking purchases…' : 'Refreshing courses…');
      else this.render(undefined, 'Loading courses…', true);
      const projects = await this.results?.summaries(this.media, environment, account ?? 'local') ?? [];
      const token = account ? await this.auth.accessToken() : undefined;
      if (sequence !== this.sequence || environment !== this.environment()) return;
      let billing: LearningPurchases | undefined;
      let billingMessage = '';
      if (account) {
        try { billing = await new Api(this.auth, () => env, account).learningPurchases(checkPayments); }
        catch { billingMessage = 'Purchases could not be refreshed. Try Refresh courses & purchases before paying again.'; }
      }
      const [catalog, books, progress, pathways] = await Promise.all([
        learnerRpc<PublicCatalog>(env, 'public_learning_catalog', {}, token),
        account ? new Api(this.auth, () => env, account).studyCatalog().catch(() => ({courses:[]})) : Promise.resolve({courses:[]}),
        account ? new Api(this.auth, () => env, account).practiceCatalog().catch(() => undefined) : undefined,
        fetch(env.apiUrl.replace(/\/+$/,'')+'/skilling/catalog',{signal:AbortSignal.timeout(10000)}).then(async r=>r.ok?(await r.json()).courses:{}).catch(()=>({})),
      ]);
      if (sequence !== this.sequence || environment !== this.environment()) return;
      if (account !== (await this.auth.session())?.user.id || sequence !== this.sequence || environment !== this.environment()) return;
      this.projects = projects; this.pathways = pathways;
      const chapters = new Map(progress?.courses.flatMap(course => course.chapters.map(ch => [ch.id, ch.progress] as const)));
      for (const course of catalog.courses) if (course.enrolled)
        for (const chapter of course.chapters) chapter.progress = chapters.get(chapter.id);
      this.studyCourses = new Set(books.courses.filter(c => c.chapters.length).map(c => c.title));
      this.selection = {...this.scope, environment, account, catalog, billing, lessons:progress?.courses};
      if (checkPayments && billing && !billing.purchases.some(p => p.status === 'created' || p.status === 'creating')) this.awaitingPayment = false;
      this.render(catalog, billingMessage);
      if (checkPayments) this.joined();
    } catch (error) {
      if (sequence !== this.sequence) return;
      const message = error instanceof Error ? error.message : 'Could not load courses. Retry.';
      if (this.selection) this.status(message);
      else this.render(undefined, message);
    }
  }
  private projectAccessEnded(id: string) { return projectAccessEnded(id, this.selection?.catalog.courses); }
  private async handle(message: any) {
    if (message?.type === 'browserCourse' && message.id === 'erpnext-essentials')
      return vscode.commands.executeCommand('dhimantai.openBrowserCourse', message.id);
    // Navigation and sign-in must also work while loading or when the catalog is offline.
    if (message?.type === 'signOut') return vscode.commands.executeCommand('dhimantai.signOut');
    if (message?.type === 'commands') return vscode.commands.executeCommand('dhimantai.searchCommands');
    if (message?.type === 'tutor') return vscode.commands.executeCommand('dhimantai.openLearningRoom');
    if (message?.type === 'doubtSolver') return vscode.commands.executeCommand('dhimantai.openDoubtSolver');
    if (message?.type === 'practice') {
      const course = this.selection?.catalog.courses.find(c => c.id === message.id && c.enrolled);
      const subject = course && this.selection?.lessons?.find(lesson => lesson.chapters.some(ch => course.chapters.some(c => c.id === ch.id)))?.name;
      const resume = course && resumeChapter(course)?.id;
      return course ? vscode.commands.executeCommand('dhimantai.openLearningRoom', subject ?? course.title, ...(resume ? [resume] : []))
        : vscode.commands.executeCommand('dhimantai.browsePractice');
    }
    if (message?.type === 'grade' && this.selection?.catalog.courses.some(c => c.id === message.id && c.enrolled))
      return vscode.commands.executeCommand('dhimantai.courseGrade', message.id);
    if (message?.type === 'study') {
      const companion = this.companions.find(c => c.id === message.id);
      const course = this.selection?.catalog.courses.find(c => c.id === message.id);
      return vscode.commands.executeCommand('dhimantai.openStudy', companion?.id ?? course?.title);
    }
    if (message?.type === 'capstone') {
      if (this.selection?.catalog.courses.find(c => c.id === message.id)?.expired) return;
      return vscode.commands.executeCommand('dhimantai.startCapstone', message.id);
    }
    if (message?.type === 'project') {
      const project = CATALOG_PROJECTS.find(p => p.id === message.id);
      if (project) {
        if (this.projectAccessEnded(project.id)) return;
        const records = this.projects.filter(p => p.projectId === project.id);
        // Several saved copies: missing folders stay listed (opening one offers recovery) and a fresh copy is one choice away.
        const record = records.length < 2 ? records[0] : await vscode.window.showQuickPick<{label: string; description?: string; detail?: string; root?: string}>(
          [...records.map(r => ({label: r.title, description: r.root, detail: r.status, root: r.root})),
            {label: '$(add) Start a new copy', detail: 'Create or reopen the project in a course folder'}], {title: 'Open project'});
        if (record?.root) return vscode.commands.executeCommand('dhimantai.openSavedProject', record.root);
        if (record || !records.length) return vscode.commands.executeCommand('dhimantai.startCapstone', project.id);
      }
      return;
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
    if (message?.type === 'signUp' || message?.type === 'signIn') {
      await vscode.commands.executeCommand(`dhimantai.${message.type}`, this.environment());
      return this.refresh();
    }
    if (message?.type === 'refresh') return this.refresh(true);
    // Only catalog mutations need a selection; ignore unrelated lifecycle messages.
    if (message?.type !== 'join' && message?.type !== 'buy') return;
    const selection = this.selection;
    if (!selection || selection.environment !== this.environment()) return this.refresh();
    try {
      if (message.type === 'buy') {
        if (this.purchasing) return;
        if (!selection.account || !selection.catalog.individual) throw new Error('Sign in with an individual learner account to unlock a course.');
        if (!selection.billing?.payments_ready) throw new Error('Payments are unavailable. Refresh courses & purchases and try again.');
        const offer = selection.catalog.offers?.find(o => o.id === message.id);
        if (!offer || offer.owned) return this.refresh(true);
        this.purchasing = true;
        this.sequence++; // A slower catalog read must not replace checkout state.
        this.status('Opening secure checkout…');
        let notice = '';
        try {
          const env = this.service();
          const result = await new Api(this.auth, () => {
            if (this.environment() !== selection.environment) throw new Error('Your service changed. Reopen Pricing.');
            return env;
          }, selection.account).purchaseLearningOffer(offer.id);
          if (!this.panel || this.environment() !== selection.environment || (await this.auth.session())?.user.id !== selection.account) return;
          const uri = vscode.Uri.parse(checkoutUri(result.checkout_url, env.apiUrl));
          this.awaitingPayment = true;
          const opened = await vscode.env.openExternal(uri);
          if (!opened) { this.awaitingPayment = false; throw new Error('Could not open your browser. Try Unlock all again to reopen the same pending checkout.'); }
          notice = 'Checkout opened in your browser. Return here after paying to refresh course access.';
        } catch (error) {
          notice = error instanceof Error ? error.message : 'Checkout could not be opened. Refresh purchases before trying again.';
        } finally {
          this.purchasing = false;
          if (this.environment() === selection.environment && (await this.auth.session())?.user.id === selection.account) this.status(notice);
          const queued = this.refreshQueued; this.refreshQueued = undefined;
          if (queued !== undefined) await this.refresh(queued);
        }
        return;
      }
      const course = selection.catalog.courses.find(c => c.id === message.id);
      if (!course || !selection.catalog.individual || !course.can_join || !selection.account) return;
      const token = await this.auth.accessToken();
      if (this.environment() !== selection.environment || (await this.auth.session())?.user.id !== selection.account) return this.refresh();
      await learnerRpc(this.service(), 'join_learning_course', { p_course: course.id }, token);
      this.joined();
      await this.refresh();
    } catch (error) {
      if (this.selection === selection) this.status(error instanceof Error ? error.message : 'Could not join this course. Retry.');
    }
  }
  private render(catalog?: PublicCatalog, message = '', loading = false) {
    if (!this.panel) return;
    const nonce = randomBytes(16).toString('hex'), account = this.scope?.account ?? this.selection?.account, environment = this.environment();
    const button = (label: string, type: string, id = '', disabled = false, secondary = false) =>
      `<button type="button" data-action="${type}" data-id="${escape(id)}"${secondary ? ' class="secondary"' : ''} data-disabled="${disabled}" ${disabled ? 'disabled' : ''}>${escape(label)}</button>`;
    const courses = catalog?.courses ?? [], offers = catalog?.offers ?? [], billing = this.selection?.billing;
    const individual = !!catalog?.individual, canPay = !account || (individual && !!billing?.payments_ready);
    // A one-course offer is that course's price; offers covering several courses are bundles.
    const single = new Map(offers.filter(o => o.course_ids.length === 1).map(o => [o.course_ids[0], o]));
    const bundles = offers.filter(o => o.course_ids.length > 1);
    const buy = (offer: LearningOffer, label: string, secondary: boolean) => account && !individual
      ? button('Use individual account', 'signIn', '', false, secondary)
      : account ? button(label, 'buy', offer.id, !canPay, secondary) : button(label, 'signIn', '', false, secondary);
    const pending = !!billing?.purchases.some(p => p.status === 'created' || p.status === 'creating');
    const courseCard = (course: CatalogCourse) => {
      const p=this.pathways?.[course.id];
      const readiness=p?`<details><summary>Skills, projects and readiness</summary><p>${escape(p.role||'Foundation for a role pathway')} · ${escape(p.level)}</p><p>${escape(p.technology_stack.join(' · '))}</p><ul>${p.outcomes.map(o=>`<li>${escape(o)}</li>`).join('')}</ul><p>Project theme: ${escape(p.project_theme)}</p><p>Micro: one concept. Minor: integrated skills. Major: end-to-end delivery.</p><p>${p.certifiable?'Certification requires independent assessment of projects, an unfamiliar observed task and a project defence.':'Continue to a role pathway for job-readiness certification.'}</p>${p.prerequisites.length?`<p>Readiness prerequisites: ${p.prerequisites.map(id=>escape(courses.find(c=>c.id===id)?.title??id)).join(', ')}</p>`:''}</details>`:'';
      const offer = single.get(course.id);
      const primary = course.enrolled ? button('Continue', 'practice', course.id)
        : !course.can_join ? button('Enrollment closed', 'join', course.id, true)
        : !account ? button('Start free', 'signUp')
        : individual ? button('Start free', 'join', course.id) : button('Use individual account', 'signIn');
      const unlock = (account && !individual) || course.is_free || course.unlocked || !offer || offer.owned ? ''
        : buy(offer, `${course.expired ? 'Buy again' : 'Unlock all'} · ${priceLabel(offer.amount, offer.currency)}`, true);
      const period = accessPeriod(course);
      const progress = course.enrolled ? coverageMeter(course) : '';
      // Covered chapters read as done (a check), never as cancelled (strikethrough).
      const outline = `<ol>${course.chapters.map(ch => `<li>${ch.progress?.status === 'covered' ? `<span class="covered"><span aria-hidden="true">✓</span> ${escape(ch.name)}</span>` : escape(ch.name)}${ch.lesson && ch.lesson !== ch.name ? ' — ' + escape(ch.lesson) : ''}
        <small class="muted">${course.enrolled ? ' · ' + escape(coverageLabel(ch.progress)) : ''}${course.expired ? ' · Locked' : ch.free ? ' · Free' : course.unlocked ? '' : ' · Locked'}</small>
        ${course.enrolled ? topicCoverageHtml(ch.progress) : ''}</li>`).join('')}</ol>`
        + (course.enrolled ? `<p class="muted small">${coverageNote}</p>` + button('Roadmap, grade & certificate', 'grade', course.id, false, true) : '');
      if (isEssential(course)) return `<article class="course compact" data-course="${escape(course.id)}"><span class="meta muted small">${course.chapters.length} chapters · ${course.expired ? 'Access ended' : course.is_free ? 'Free' : course.unlocked ? 'Unlocked' : 'First chapter free'}${course.enrolled ? ' <span class="dh-chip accent">Joined</span>' : ''}</span>
        <h4>${escape(course.title)}</h4><p class="small">${escape(course.summary)}</p>${progress}${readiness}
        <details><summary>Outline and preparation</summary>${outline}<p class="muted small">${escape(course.prerequisites || '')}</p></details>
        ${period ? `<p class="muted small">${escape(period)}</p>` : ''}<div class="actions">${primary}${unlock}${course.enrolled && this.studyCourses.has(course.title) ? button('Study', 'study', course.id, false, true) : ''}${course.id === 'engineering-code-reading' && !course.expired ? button('Read a project', 'capstone', course.id, false, true) : ''}</div></article>`;
      return `<article class="course" data-course="${escape(course.id)}"><span class="meta muted small">${escape(course.level)} · ${course.chapters.length} chapters${course.enrolled ? ' <span class="dh-chip accent">Joined</span>' : ''}</span>
        <h3>${escape(course.title)}</h3><p>${escape(course.summary)}</p>${progress}${readiness}
        <p class="muted small">Before you start: ${escape(course.prerequisites || 'See the course outline.')}</p>
        <details><summary>Course outline</summary>${outline}</details>
        <p class="access">${course.expired ? escape(period) : course.is_free ? 'Free course · All chapters included' : course.unlocked ? 'All chapters unlocked' : 'First chapter free'}${course.is_free || course.unlocked || offer ? '' : bundles.some(b => b.course_ids.includes(course.id)) ? ' · Unlock with a bundle below' : ' · Full-course price coming soon'}</p>
        ${period && !course.expired ? `<p class="muted small">${escape(period)}</p>` : ''}<div class="actions">${primary}${unlock}${course.enrolled && this.studyCourses.has(course.title) ? button('Study', 'study', course.id, false, true) : ''}</div></article>`;
    };
    const bundleCard = (offer: LearningOffer) => {
      const titles = offer.course_ids.map(id => courses.find(c => c.id === id)?.title ?? id);
      const parts = offer.course_ids.map(id => single.get(id));
      const separate = parts.every(Boolean) ? parts.reduce((sum, o) => sum + o!.amount, 0) : 0;
      const owned = offer.course_ids.filter(id => courses.find(c => c.id === id)?.unlocked).length;
      return `<article class="course offer"><h3>${escape(offer.title)}</h3>
        <p><strong class="price">${escape(priceLabel(offer.amount, offer.currency))}</strong>${separate > offer.amount ? ` <span class="save">Save ${escape(priceLabel(separate - offer.amount, offer.currency))}</span>` : ''}</p>
        <p class="muted">${escape(titles.join(' · '))}</p>
        ${owned && !offer.owned ? '<p class="muted small">You already own part of this bundle. The price shown is the full bundle price.</p>' : ''}
        <div class="actions">${offer.owned ? '<span>Purchased</span>' : buy(offer, 'Buy bundle', false)}</div></article>`;
    };
    const resume = resumeOrder(courses).slice(0, 3);
    const erpChecked = account && this.browserProgress ? Math.min(ERP_TASK_TOTAL, this.browserProgress(this.environment(), account)) : 0;
    const resumeCard = (course: CatalogCourse, first: boolean) => {
      const next = resumeChapter(course), covered = coveredCount(course), total = course.chapters.length;
      const label = next ? next.lesson && next.lesson !== next.name ? next.lesson : next.name : '';
      return `<article class="resume-card dh-card${first ? ' first' : ''}"><p class="dh-eyebrow">${escape(course.level || 'Course')}</p><h3>${escape(course.title)}</h3>
        <p class="next">${next ? `${next.progress?.status === 'in_progress' ? 'Pick up' : 'Up next'}: <strong>${escape(label)}</strong>` : covered === total && total ? 'Every chapter covered. Review any chapter or take the grade check.' : 'Unlock the next chapter to continue.'}</p>
        ${progressBar(covered, total, `${covered} of ${total} chapters covered`)}<p class="small muted">${covered} of ${total} chapters covered</p>
        <div class="actions">${button(next ? 'Continue learning' : 'Open course', course.id === 'erpnext-essentials' ? 'browserCourse' : 'practice', course.id, false, !first)}${covered === total && total ? button('Roadmap, grade & certificate', 'grade', course.id, false, true) : ''}</div></article>`;
    };
    const hero = resume.length
      ? `<section class="resume" aria-labelledby="resume-title"><h2 id="resume-title">Continue learning</h2><div class="resume-list">${resume.map((c, i) => resumeCard(c, i === 0)).join('')}</div></section>`
      : `<section class="intro dh-card" aria-labelledby="intro-title"><h2 id="intro-title">${account ? 'Pick a course to begin' : 'Learn by building, with an instructor beside you'}</h2>
        <p>Guided lessons, real code in your own course container, and step-by-step help when you are stuck. Every course starts with a free first chapter.</p>
        ${account ? '' : `<div class="actions">${button('Start free', 'signUp')}</div>`}</section>`;
    const statusText = ({paid: 'Paid · unlocked', refunded: 'Refunded', created: 'Awaiting payment', creating: 'Confirming checkout'}) as Record<string, string>;
    // An ended course access period also closes its projects until the course is bought again.
    const projectRenewal = (id: string) => {
      const offer = single.get(PROJECT_COURSES[id]);
      return offer && !offer.owned ? buy(offer, `Buy again · ${priceLabel(offer.amount, offer.currency)}`, false)
        : button('Access ended', 'project', id, true);
    };
    const projectCourses = courses.filter(c => !!this.pathways?.[c.id]);
    const courseProjects = projectCourses.length ? `<article class="course project" data-project="course-projects"><h3>Course projects & custom setup</h3>
      <p>Build a Micro project, combine skills in a Minor project, then deliver a final Capstone. Use your course brief or describe your own project. Each level follows the prerequisites in your course roadmap.</p>
      <label for="project-course">Course</label><select id="project-course">${projectCourses.map(c => `<option value="${escape(c.id)}">${escape(c.title)}</option>`).join('')}</select>
      <div class="actions">${button('Set up project', 'courseProject')}</div></article>` : '';
    const projects = `<section class="category projects" aria-labelledby="projects-title"><h2 id="projects-title">Projects</h2>
      <p class="muted">Practise with a guided repository or a project for your course. Projects use your course container; estimated times exclude initial setup.</p>
      ${courseProjects}
      <div class="courses">${CATALOG_PROJECTS.map(project => `<article class="course project" data-project="${escape(project.id)}" aria-labelledby="project-${escape(project.id)}">
        <span class="muted small">${escape(project.level)} · ${escape(project.difficulty)} · Estimated ${escape(project.estimatedTime)}</span>
        <h3 id="project-${escape(project.id)}">${escape(project.title)}</h3><p>${escape(project.description)}</p>
        <p class="small"><strong>Learning outcomes</strong></p><ul class="small">${project.outcomes.map(outcome => `<li>${escape(outcome)}</li>`).join('')}</ul>
        <p class="small" role="status">${escape(projectAccessEnded(project.id, courses) ? 'Access ended · Buy again'
          : this.projects.find(p => p.projectId === project.id)?.status ?? 'Not started')}</p>
        <div class="actions">${projectAccessEnded(project.id, courses) ? projectRenewal(project.id)
          : button(this.projects.some(p => p.projectId === project.id) ? 'Open Project' : 'Start Project', 'project', project.id)}</div></article>`).join('')}</div></section>`;
    this.panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dhimantAI Course Catalog</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <style nonce="${nonce}">${UI_TOKENS}
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:1050px;margin:0 auto;padding:28px;line-height:1.55}
      h1{margin:2px 0 0;font-size:26px;line-height:1.2}h2{margin:var(--dh-space-6) 0 var(--dh-space-2);font-size:17px}h3{margin:4px 0;font-size:18px;line-height:1.3}h4{margin:4px 0;font-size:15px;line-height:1.3}
      .how h3{margin:var(--dh-space-4) 0 0;font-size:14px}p{margin:8px 0}.muted{color:var(--vscode-descriptionForeground)}.small{font-size:.92em}
      header.top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--dh-space-3);padding-bottom:var(--dh-space-4);border-bottom:1px solid var(--dh-border)}
      nav,.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.actions{margin-top:14px}
      .resume h2{margin-top:var(--dh-space-5)}.resume-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:var(--dh-space-3)}
      .resume-card{display:flex;flex-direction:column;gap:var(--dh-space-1);padding:var(--dh-space-4)}.resume-card p{margin:0}.resume-card .next{margin:var(--dh-space-1) 0 var(--dh-space-2)}
      .resume-card.first{border-color:var(--dh-accent);box-shadow:0 0 0 1px var(--dh-accent),var(--dh-shadow)}.resume-card .actions{margin-top:auto;padding-top:var(--dh-space-3)}
      .intro{margin-top:var(--dh-space-5);padding:var(--dh-space-5)}.intro h2{margin:0 0 var(--dh-space-1);font-size:20px}.intro p{max-width:62ch}
      .notice{padding:var(--dh-space-3) var(--dh-space-4);border-left:3px solid var(--dh-accent);background:var(--dh-surface);border-radius:var(--dh-radius-sm)}
      .search{margin-top:var(--dh-space-5)}.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.coverage{margin:var(--dh-space-2) 0}.coverage p{margin:6px 0 0}
      .covered{color:var(--dh-muted)}.covered>span{color:var(--dh-success);font-weight:700}
      .how{margin-top:var(--dh-space-6);padding:var(--dh-space-3) var(--dh-space-4);border:1px solid var(--dh-border);border-radius:var(--dh-radius)}.how summary{font-weight:600}.how p{max-width:75ch}
      input,select{box-sizing:border-box;width:100%;padding:9px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--dh-border));border-radius:var(--dh-radius-sm);margin:6px 0 4px}
      .courses{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;margin-top:16px}.course{display:flex;flex-direction:column;border:1px solid var(--dh-border);border-radius:var(--dh-radius);padding:20px;background:var(--dh-surface)}.course[data-course]:has(.dh-chip.accent){border-color:var(--dh-accent)}
      .projects .courses{grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))}.project ul{margin-top:0}
      .course .actions{margin-top:auto;padding-top:12px}.essentials .courses{grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}.course.compact{padding:14px 16px}.paths{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.paths button[aria-pressed="true"]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.access{font-weight:600}.price{font-size:18px}.save{margin-left:6px;padding:1px 7px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:.85em}
      button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;padding:7px 14px;border-radius:var(--dh-radius-sm);cursor:pointer;font:inherit}
      button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground,transparent);color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));border-color:var(--vscode-button-border,var(--vscode-panel-border))}
      button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground))}button:disabled{opacity:.6;cursor:default}
      button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}
      details{margin:10px 0}summary{cursor:pointer}li{margin:4px 0}.course[hidden],[hidden]{display:none}#status{color:var(--vscode-descriptionForeground);min-height:1em}
      footer{margin-top:28px;font-size:.92em}ul{padding-left:20px}
      </style></head><body>
      <header class="top"><div><p class="dh-eyebrow">Welcome to dhimantAI</p><h1>Course Catalog</h1>${environment === 'production' ? '' : `<p class="muted small">${escape(environment)} service</p>`}</div>
      <nav aria-label="Learning">${button('Instructor', 'tutor', '', false, true)}${button('Study', 'study', '', false, true)}${button('Doubt Solver', 'doubtSolver', '', false, true)}${account ? button('My courses', 'practice', '', false, true) : button('Sign in', 'signIn', '', false, true)}</nav>
      ${account ? `<div class="actions" aria-label="Account"><span class="small">Signed in${(this.scope?.accountLabel ?? this.selection?.accountLabel) ? ' as ' + escape((this.scope?.accountLabel ?? this.selection?.accountLabel)!) : ''}</span>${button('Sign out', 'signOut', '', false, true)}</div>` : ''}</header>
      <main>${hero}
      ${catalog && account && !individual ? '<p class="notice">You are signed in with an institute account. Public courses use a separate individual learner account. Choose <strong>Use individual account</strong> to sign in with email or create an individual account. Join a course there to see it in Practice. <strong>My courses</strong> opens your institute learning.</p>' : ''}
      ${account && billing && !billing.payments_ready ? '<p class="muted">Payments are not available yet. Free courses and free first chapters remain available.</p>' : ''}
      <p id="status" role="status"><span id="status-message">${escape(message)}</span> <span id="payment-check"${pending || this.awaitingPayment ? '' : ' hidden'}>${button('Check payment', 'refresh', '', false, true)}</span></p>
      ${courses.length + this.companions.length + CATALOG_PROJECTS.length > 6 ? `<div class="search"><label for="search" class="muted small">Search courses and projects</label><input id="search" type="search" placeholder="Course, project, or topic" value="${escape(courses.find(c=>c.id===this.focusCourse)?.title??'')}"></div>` : ''}
      <div id="results">${categorySections(courses.filter(c=>c.id!=='erpnext-essentials'), courseCard)}
      <section class="browser-courses" aria-labelledby="browser-courses-title"><h2 id="browser-courses-title">Business applications</h2><div class="courses">
        <article class="course" data-browser-course="erpnext-essentials"><span class="muted small">Beginner · ${ERP_TASK_TOTAL} linked tasks · Live Instructor</span>
          <h3>ERPNext Essentials</h3><p>Run a small company in a real ERPNext sandbox: order from a supplier, receive and pay for the goods, then take a customer order, deliver, invoice and collect. You predict each result before you submit and explain every decision to the live Instructor. Help fades as you go, and a final challenge serves a new customer on your own.</p>
          <details><summary>Course outline and preparation</summary><ol><li>Your company’s accounts</li><li>Customers</li><li>Suppliers</li><li>Stock items</li><li>Purchase orders</li><li>Receiving goods</li><li>Supplier bills</li><li>Paying suppliers</li><li>Sales orders</li><li>Deliveries</li><li>Sales invoices</li><li>Collecting payment</li><li>Bills of materials</li><li>Final challenge: a new customer, start to finish, without hints</li></ol>
          <p>The sandbox runs on your computer. Accounts share one ERPNext instance with separate logins and training companies. First setup downloads the application image and requires 6 GB of runtime memory. HR and payroll are not included in this course.</p></details>
          ${erpChecked ? `${progressBar(erpChecked, ERP_TASK_TOTAL, `${erpChecked} of ${ERP_TASK_TOTAL} tasks done`)}<p class="small muted">${erpChecked} of ${ERP_TASK_TOTAL} tasks done: saved work checked in ERPNext and explained</p>` : ''}
          <div class="actions">${button(erpChecked ? 'Continue course' : 'Open course', 'browserCourse', 'erpnext-essentials')}</div></article></div></section>
      ${projects}
      ${this.companions.length ? `<section aria-labelledby="book-companions"><h2 id="book-companions">Programming book companions</h2><p class="muted">Original lessons, worked examples and practice activities with links to seven influential books. Included with the extension; reading works offline. Sign in for Study help.</p><div class="courses">${this.companions.map(c => `<article class="course" data-course="${escape(c.id)}"><span class="muted small">${c.chapters.length} chapters · Free companion</span><h3>${escape(c.title)}</h3><p class="muted small">Book by ${escape(c.author)}</p><p>${escape(c.summary)}</p><details><summary>Outline and preparation</summary><ol>${c.chapters.map(ch => `<li>${escape(ch.title)}</li>`).join('')}</ol><p>${escape(c.preparation)}</p></details><div class="actions">${button('Study', 'study', c.id)}</div></article>`).join('')}</div></section>` : ''}</div>
      <p id="empty" hidden>No matching courses or projects. Try another search.</p>
      ${bundles.length ? `<section aria-labelledby="pricing"><h2 id="pricing">Bundles</h2><div class="courses">${bundles.map(bundleCard).join('')}</div></section>` : ''}
      ${billing?.purchases.length ? `<h2>Your purchases</h2><ul>${billing.purchases.map(p => `<li>${escape(p.title)} · ${escape(priceLabel(p.amount, p.currency))} · ${escape(statusText[p.status] ?? p.status)}</li>`).join('')}</ul>` : ''}
      <details class="how"><summary>How courses, access and code help work</summary>
        <p>Choose a course or project, learn step by step with <strong>Instructor</strong>, or bring a specific question to <strong>Doubt Solver</strong>.</p>
        <p>Write, debug, and test code here in VS Code. Run projects and tests in your course container. Open its terminal from the Runtime dropdown.</p>
        <p>Free courses include every chapter. Other courses include a free first chapter, with a one-time payment to unlock the rest.
        Each course gives access for a set number of days from when you join or buy it; after that every chapter locks, the first one too.</p>
        <h3>Code help and runtime setup</h3><p>${button('Search commands', 'commands', '', false, true)} Find an action by name in the Command Palette. New commands appear here automatically.</p><p>To protect independent assessment work, dhimantAI disables VS Code's built-in Copilot chat and AI suggestions while the extension is enabled, including in other workspaces through your user settings. Instructor and Doubt Solver remain available. To use Copilot again, disable or uninstall dhimantAI, then turn off <strong>Chat: Disable AI Features</strong> in Settings.</p><p>First course container setup takes several minutes and needs internet access. To prepare it before your first run, choose <strong>Set up / rebuild course</strong> in the notebook's runtime dropdown. Later runs reuse the prepared runtime.</p></details>
      <div class="actions">${button('Refresh courses & purchases', 'refresh', '', loading, true)}</div></main>
      ${offers.length ? '<footer class="muted">Secure checkout with Razorpay opens in your browser. One-time payment, no automatic renewal.</footer>' : ''}
      <script nonce="${nonce}">(${catalogClient.toString()})(${JSON.stringify(JSON.stringify([environment, account ?? null])).replace(/</g, '\\u003c')}, ${JSON.stringify(courses.find(c => c.id === this.focusCourse)?.title ?? '').replace(/</g, '\\u003c')});</script></body></html>`;
    if (catalog) this.focusCourse = undefined;
  }
}
