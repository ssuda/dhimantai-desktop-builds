import { ESSENTIAL_PATHS } from './essentials';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Auth } from './auth';
import { Environment, EnvironmentName } from './environments';
import { accessPeriod, CatalogCourse, LearningOffer, learnerRpc, PublicCatalog } from './learnerCatalog';
import { Api, LearningPurchases } from './api';
import { checkoutUri, priceLabel } from './learningBilling';
import type { CompanionCourse } from './studyContent';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Free and paid Engineering Essentials courses share one section; the price model stays per course.
const isEssential = (course: CatalogCourse) => course.id.startsWith('engineering-');

/** Courses grouped by catalog category, in a fixed order; Engineering Essentials sits under Software Engineering. */
const CATEGORIES = ['Software Engineering', 'AI & Machine Learning', 'AI for Professionals'];
function categorySections(courses: CatalogCourse[], card: (course: CatalogCourse) => string, essentials: string): string {
  const named = (course: CatalogCourse) => CATEGORIES.includes(course.category ?? '') ? course.category! : 'Software Engineering';
  return CATEGORIES.map(category => {
    const members = courses.filter(course => named(course) === category);
    const extra = category === 'Software Engineering' ? essentials : '';
    if (!members.length && !extra) return '';
    const id = 'category-' + category.toLowerCase().replace(/[^a-z]+/g, '-');
    return `<section class="category" aria-labelledby="${id}"><h3 id="${id}">${escape(category)}</h3>`
      + (members.length ? `<div class="courses">${members.map(card).join('')}</div>` : '') + extra + '</section>';
  }).join('');
}

function essentialsSection(courses: CatalogCourse[], card: (course: CatalogCourse) => string,
    button: (label: string, type: string, id?: string, disabled?: boolean, secondary?: boolean) => string): string {
  const present = new Set(courses.map(c => c.id));
  const paths = ESSENTIAL_PATHS.map(path => ({...path, ids: path.courses.map(id => 'engineering-' + id).filter(id => present.has(id))}))
    .filter(path => path.ids.length);
  const pathButton = (label: string, ids: string, pressed: boolean) =>
    `<button type="button" class="secondary" data-path="${escape(ids)}" aria-pressed="${pressed}">${escape(label)}</button>`;
  return `<section class="essentials" aria-labelledby="essentials-title"><h3 id="essentials-title">Engineering Essentials</h3>
    <p class="muted">Short courses on the habits strong engineers rely on, 30 to 50 minutes each. ${courses.some(c => c.is_free) ? 'Start free with ' + courses.filter(c => c.is_free).map(c => escape(c.title)).join(', ') + '. The others include a free first chapter. ' : ''}None is required before another course; pick the path for what you are about to do.</p>
    <div class="paths" role="group" aria-label="Suggested paths">${pathButton('All', '', true)}${paths.map(p => pathButton(p.label, p.ids.join(' '), false)).join('')}</div>
    <div class="courses">${courses.map(card).join('')}</div>
    <p class="muted">Read a Python codebase with Coach: start with shelf or explore the larger Rich repository. You can also build a Course Research Agent or fix the shelf capstone bug. ${button('Start a course project', 'capstone', '', false, true)}</p></section>`;
}

export class CourseCatalog implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private sequence = 0;
  private selection?: { environment: EnvironmentName; account?: string; catalog: PublicCatalog; billing?: LearningPurchases };
  private purchasing = false;
  /** Set after checkout opens; returning to VS Code then refreshes purchases without a manual step. */
  private awaitingPayment = false;
  private welcomePending?: Promise<void>;
  private subscriptions: vscode.Disposable[];

  constructor(private readonly auth: Auth, private readonly environment: () => EnvironmentName,
      private readonly service: () => Environment, private readonly joined: () => void,
      private readonly learningOpen: () => boolean = () => false,
      private readonly companions: CompanionCourse[] = []) {
    this.subscriptions = [auth.onDidChange(() => { void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai.environment')) void this.refresh(); }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused && this.awaitingPayment) void this.refresh(true); })];
  }
  dispose() { this.sequence++; this.panel?.dispose(); this.subscriptions.forEach(d => d.dispose()); }
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
  async open() {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('dhimantai.courseCatalog', 'DhimantAI Course Catalog', vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [] });
      this.panel.onDidDispose(() => { this.sequence++; this.panel = undefined; this.selection = undefined; });
      this.panel.webview.onDidReceiveMessage(message => { void this.handle(message); });
    }
    this.panel.reveal();
    await this.refresh();
  }
  async refresh(checkPayments = false) {
    if (!this.panel) return;
    const sequence = ++this.sequence, environment = this.environment(), env = this.service();
    this.selection = undefined;
    this.render(undefined, 'Loading courses…', true);
    try {
      const account = (await this.auth.session())?.user.id;
      const token = account ? await this.auth.accessToken() : undefined;
      if (sequence !== this.sequence || environment !== this.environment()) return;
      let billing: LearningPurchases | undefined;
      let billingMessage = '';
      if (account) {
        try { billing = await new Api(this.auth, () => env, account).learningPurchases(checkPayments); }
        catch { billingMessage = 'Purchases could not be refreshed. Try Refresh purchases before paying again.'; }
      }
      const catalog = await learnerRpc<PublicCatalog>(env, 'public_learning_catalog', {}, token);
      if (sequence !== this.sequence || environment !== this.environment()) return;
      this.selection = { environment, account, catalog, billing };
      if (checkPayments && billing && !billing.purchases.some(p => p.status === 'created' || p.status === 'creating')) this.awaitingPayment = false;
      this.render(catalog, billingMessage);
      if (checkPayments) this.joined();
    } catch (error) {
      if (sequence === this.sequence) this.render(undefined, error instanceof Error ? error.message : 'Could not load courses. Retry.');
    }
  }
  private async handle(message: any) {
    // Navigation and sign-in must also work while loading or when the catalog is offline.
    if (message?.type === 'tutor') return vscode.commands.executeCommand('dhimantai.openLearningRoom');
    if (message?.type === 'doubtSolver') return vscode.commands.executeCommand('dhimantai.openDoubtSolver');
    if (message?.type === 'practice') return vscode.commands.executeCommand('dhimantai.browsePractice');
    if (message?.type === 'study') {
      const companion = this.companions.find(c => c.id === message.id);
      const course = this.selection?.catalog.courses.find(c => c.id === message.id);
      return vscode.commands.executeCommand('dhimantai.openStudy', companion?.id ?? course?.title);
    }
    if (message?.type === 'capstone') return vscode.commands.executeCommand('dhimantai.startCapstone', message.id);
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
        if (this.purchasing || !selection.account || !selection.catalog.individual || !selection.billing?.payments_ready) return;
        const offer = selection.catalog.offers?.find(o => o.id === message.id);
        if (!offer || offer.owned) return;
        this.purchasing = true;
        try {
          const env = this.service();
          const result = await new Api(this.auth, () => {
            if (this.environment() !== selection.environment) throw new Error('Your service changed. Reopen Pricing.');
            return env;
          }, selection.account).purchaseLearningOffer(offer.id);
          if (this.selection !== selection || (await this.auth.session())?.user.id !== selection.account) return;
          await vscode.env.openExternal(vscode.Uri.parse(checkoutUri(result.checkout_url, env.apiUrl)));
          this.awaitingPayment = true;
          this.render(selection.catalog, 'Checkout opened in your browser. Your courses unlock when you come back after paying.');
        } finally { this.purchasing = false; }
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
      if (this.selection === selection) this.render(selection.catalog, error instanceof Error ? error.message : 'Could not join this course. Retry.');
    }
  }
  private render(catalog?: PublicCatalog, message = '', loading = false) {
    if (!this.panel) return;
    const nonce = randomBytes(16).toString('hex'), account = this.selection?.account, environment = this.environment();
    const button = (label: string, type: string, id = '', disabled = false, secondary = false) =>
      `<button type="button" data-action="${type}" data-id="${escape(id)}"${secondary ? ' class="secondary"' : ''} ${disabled ? 'disabled' : ''}>${escape(label)}</button>`;
    const courses = catalog?.courses ?? [], offers = catalog?.offers ?? [], billing = this.selection?.billing;
    const individual = !!catalog?.individual, canPay = !account || (individual && !!billing?.payments_ready);
    // A one-course offer is that course's price; offers covering several courses are bundles.
    const single = new Map(offers.filter(o => o.course_ids.length === 1).map(o => [o.course_ids[0], o]));
    const bundles = offers.filter(o => o.course_ids.length > 1);
    const buy = (offer: LearningOffer, label: string, secondary: boolean) => account && !individual
      ? button('Use individual account', 'signIn', '', false, secondary)
      : account ? button(label, 'buy', offer.id, !canPay, secondary) : button(label, 'signIn', '', false, secondary);
    const pending = !!billing?.purchases.some(p => p.status === 'created' || p.status === 'creating');
    // Free Engineering Essentials courses are one track with suggested paths, not a wall of separate cards.
    const essentials = courses.filter(isEssential), others = courses.filter(c => !isEssential(c));
    const courseCard = (course: CatalogCourse) => {
      const offer = single.get(course.id);
      const primary = course.enrolled ? button('Continue', 'practice')
        : !course.can_join ? button('Enrollment closed', 'join', course.id, true)
        : !account ? button('Start free', 'signUp')
        : individual ? button('Start free', 'join', course.id) : button('Use individual account', 'signIn');
      const unlock = (account && !individual) || course.is_free || course.unlocked || !offer || offer.owned ? ''
        : buy(offer, `${course.expired ? 'Buy again' : 'Unlock all'} · ${priceLabel(offer.amount, offer.currency)}`, true);
      const period = accessPeriod(course);
      if (isEssential(course)) return `<article class="course compact" data-course="${escape(course.id)}"><span class="muted small">${course.chapters.length} chapters · ${course.expired ? 'Access ended' : course.is_free ? 'Free' : course.unlocked ? 'Unlocked' : 'First chapter free'}${course.enrolled ? ' · Joined' : ''}</span>
        <h2>${escape(course.title)}</h2><p class="small">${escape(course.summary)}</p>
        <details><summary>Outline and preparation</summary><ol>${course.chapters.map(ch => `<li>${escape(ch.name)}</li>`).join('')}</ol><p class="muted small">${escape(course.prerequisites || '')}</p></details>
        ${period ? `<p class="muted small">${escape(period)}</p>` : ''}<div class="actions">${primary}${unlock}${course.enrolled ? button('Study', 'study', course.id, false, true) : ''}${course.id === 'engineering-code-reading' ? button('Read a project', 'capstone', course.id, false, true) : ''}</div></article>`;
      return `<article class="course" data-course="${escape(course.id)}"><span class="muted">${escape(course.level)} · ${course.chapters.length} chapters${course.enrolled ? ' · Joined' : ''}</span>
        <h2>${escape(course.title)}</h2><p>${escape(course.summary)}</p>
        <p class="muted small">Before you start: ${escape(course.prerequisites || 'See the course outline.')}</p>
        <details><summary>Course outline</summary><ol>${course.chapters.map(ch => `<li>${escape(ch.name)}${ch.lesson && ch.lesson !== ch.name ? ' — ' + escape(ch.lesson) : ''} <small class="muted">${course.expired ? '· Locked' : ch.free ? '· Free' : course.unlocked ? '' : '· Locked'}</small></li>`).join('')}</ol></details>
        <p class="access">${course.expired ? escape(period) : course.is_free ? 'Free course · All chapters included' : course.unlocked ? 'All chapters unlocked' : 'First chapter free'}${course.is_free || course.unlocked || offer ? '' : bundles.some(b => b.course_ids.includes(course.id)) ? ' · Unlock with a bundle below' : ' · Full-course price coming soon'}</p>
        ${period && !course.expired ? `<p class="muted small">${escape(period)}</p>` : ''}<div class="actions">${primary}${unlock}${course.enrolled ? button('Study', 'study', course.id, false, true) : ''}</div></article>`;
    };
    const bundleCard = (offer: LearningOffer) => {
      const titles = offer.course_ids.map(id => courses.find(c => c.id === id)?.title ?? id);
      const parts = offer.course_ids.map(id => single.get(id));
      const separate = parts.every(Boolean) ? parts.reduce((sum, o) => sum + o!.amount, 0) : 0;
      const owned = offer.course_ids.filter(id => courses.find(c => c.id === id)?.unlocked).length;
      return `<article class="course offer"><h2>${escape(offer.title)}</h2>
        <p><strong class="price">${escape(priceLabel(offer.amount, offer.currency))}</strong>${separate > offer.amount ? ` <span class="save">Save ${escape(priceLabel(separate - offer.amount, offer.currency))}</span>` : ''}</p>
        <p class="muted">${escape(titles.join(' · '))}</p>
        ${owned && !offer.owned ? '<p class="muted small">You already own part of this bundle. The price shown is the full bundle price.</p>' : ''}
        <div class="actions">${offer.owned ? '<span>Purchased</span>' : buy(offer, 'Buy bundle', false)}</div></article>`;
    };
    const statusText = ({paid: 'Paid · unlocked', refunded: 'Refunded', created: 'Awaiting payment', creating: 'Confirming checkout'}) as Record<string, string>;
    this.panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dhimantAI Course Catalog</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <style nonce="${nonce}">
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:1050px;margin:0 auto;padding:28px;line-height:1.55}
      h1{margin:0;font-size:26px}h2{margin:4px 0;font-size:19px}h3{margin:28px 0 8px;font-size:15px}p{margin:8px 0}.muted{color:var(--vscode-descriptionForeground)}.small{font-size:.92em}
      header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}nav,.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.actions{margin-top:14px}
      input{box-sizing:border-box;width:100%;padding:9px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);margin:6px 0 18px}
      .courses{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;margin-top:16px}.course{display:flex;flex-direction:column;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:20px}
      .course .actions{margin-top:auto;padding-top:12px}.essentials .courses{grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}.course.compact{padding:14px 16px}.course.compact h2{font-size:16px}.paths{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.paths button[aria-pressed="true"]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.access{font-weight:600}.price{font-size:18px}.save{margin-left:6px;padding:1px 7px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:.85em}
      button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;padding:7px 14px;border-radius:4px;cursor:pointer;font:inherit}
      button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground,transparent);color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));border-color:var(--vscode-button-border,var(--vscode-panel-border))}
      button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground))}button:disabled{opacity:.6;cursor:default}
      button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}
      details{margin:10px 0}summary{cursor:pointer}li{margin:4px 0}.course[hidden],[hidden]{display:none}#status{color:var(--vscode-descriptionForeground);min-height:1em}
      footer{margin-top:28px;font-size:.92em}ul{padding-left:20px}
      </style></head><body>
      <header><div><p class="muted small">Welcome to dhimantAI</p><h1>Course Catalog</h1>${environment === 'production' ? '' : `<p class="muted small">${escape(environment)} service</p>`}</div>
      <nav aria-label="Learning">${button('Instructor', 'tutor', '', false, true)}${button('Study', 'study', '', false, true)}${button('Doubt Solver', 'doubtSolver', '', false, true)}${account ? button('My courses', 'practice', '', false, true) : button('Sign in', 'signIn', '', false, true)}</nav></header>
      <p>Choose a course below, learn step by step with <strong>Instructor</strong>, or bring a specific question to <strong>Doubt Solver</strong>.</p>
      <p class="muted">Write, debug, and test code here in VS Code. Run it with a course container, this computer, or a Colab runtime for Python notebooks.</p>
      <details><summary>About code help and runtime setup</summary><p>To protect independent assessment work, dhimantAI disables VS Code's built-in Copilot chat and AI suggestions while the extension is enabled, including in other workspaces through your user settings. Instructor and Doubt Solver remain available. To use Copilot again, disable or uninstall dhimantAI, then turn off <strong>Chat: Disable AI Features</strong> in Settings.</p><p>First course container setup takes several minutes and needs internet access. To prepare it before your first run, choose <strong>Set up / rebuild course</strong> in the notebook's runtime dropdown. Later runs reuse the prepared runtime.</p></details>
      <p class="muted">Free courses include every chapter. Other courses include a free first chapter, with a one-time payment to unlock the rest.
        Each course gives access for a set number of days from when you join or buy it; after that every chapter locks, the first one too.</p>
      ${catalog && account && !individual ? '<p>You are signed in with an institute account. Public courses use a separate individual learner account. Choose <strong>Use individual account</strong> to sign in with email or create an individual account. Join a course there to see it in Practice. <strong>My courses</strong> opens your institute learning.</p>' : ''}
      ${account && billing && !billing.payments_ready ? '<p class="muted">Payments are not available yet. Free courses and free first chapters remain available.</p>' : ''}
      <p id="status" role="status">${escape(message)}${pending || this.awaitingPayment ? ' ' + button('Check payment', 'refresh', '', false, true) : ''}</p>
      ${courses.length + this.companions.length > 6 ? '<label for="search" class="muted small">Search courses</label><input id="search" type="search" placeholder="Course name or topic">' : ''}
      <main>${categorySections(others, courseCard, essentials.length ? essentialsSection(essentials, courseCard, button) : '')}
      ${this.companions.length ? `<section aria-labelledby="book-companions"><h3 id="book-companions">Programming book companions</h3><p class="muted">Original lessons, worked examples and practice activities with links to seven influential books. Included with the extension; reading works offline. Sign in for Study help.</p><div class="courses">${this.companions.map(c => `<article class="course" data-course="${escape(c.id)}"><span class="muted small">${c.chapters.length} chapters · Free companion</span><h2>${escape(c.title)}</h2><p class="muted small">Book by ${escape(c.author)}</p><p>${escape(c.summary)}</p><details><summary>Outline and preparation</summary><ol>${c.chapters.map(ch => `<li>${escape(ch.title)}</li>`).join('')}</ol><p>${escape(c.preparation)}</p></details><div class="actions">${button('Study', 'study', c.id)}</div></article>`).join('')}</div></section>` : ''}</main>
      <p id="empty" ${courses.length || this.companions.length ? 'hidden' : ''}>${catalog ? 'No published courses are available yet. Please check again later.' : ''}</p>
      ${bundles.length ? `<section aria-labelledby="pricing"><h3 id="pricing">Bundles</h3><div class="courses">${bundles.map(bundleCard).join('')}</div></section>` : ''}
      ${billing?.purchases.length ? `<h3>Your purchases</h3><ul>${billing.purchases.map(p => `<li>${escape(p.title)} · ${escape(priceLabel(p.amount, p.currency))} · ${escape(statusText[p.status] ?? p.status)}</li>`).join('')}</ul>` : ''}
      <div class="actions">${button('Refresh courses & purchases', 'refresh', '', loading, true)}</div>
      ${offers.length ? '<footer class="muted">Secure checkout with Razorpay opens in your browser. One-time payment, no automatic renewal.</footer>' : ''}
      <script nonce="${nonce}">const vscode=acquireVsCodeApi();
      document.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b||b.disabled)return;
        if(['join','buy','refresh'].includes(b.dataset.action)){b.disabled=true;document.getElementById('status').textContent=b.dataset.action==='buy'?'Opening secure checkout…':b.dataset.action==='refresh'?'Refreshing courses and purchases…':'Joining…';}
        vscode.postMessage({type:b.dataset.action,id:b.dataset.id});});
      document.getElementById('search')?.addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();let count=0;
        document.querySelectorAll('.course[data-course]').forEach(c=>{c.hidden=!c.textContent.toLowerCase().includes(q);if(!c.hidden)count++;});
        document.querySelectorAll('.paths button').forEach(p=>p.setAttribute('aria-pressed',String(p.dataset.path==='')));
        const empty=document.getElementById('empty');empty.hidden=count>0;empty.textContent='No matching courses. Try another search.';});
      document.querySelectorAll('.paths button').forEach(b=>b.addEventListener('click',()=>{const ids=b.dataset.path?b.dataset.path.split(' '):null;
        document.querySelectorAll('.paths button').forEach(p=>p.setAttribute('aria-pressed',String(p===b)));
        document.querySelectorAll('.essentials .course').forEach(c=>{c.hidden=!!ids&&!ids.includes(c.dataset.course);});
        const order=ids||[];document.querySelectorAll('.essentials .course').forEach(c=>{c.style.order=ids?String(order.indexOf(c.dataset.course)):'';});}));
      </script></body></html>`;
  }
}
