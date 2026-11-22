import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Api } from './api';
import { Auth, learnerInitial, type Session } from './auth';
import { ERP_COURSE } from './browserCourseProgress';
import type { Environment, EnvironmentName } from './environments';
import { escape, icon } from './gradeComponents';
import { destinations, resumeCard, sidebarHtml, sidebarResume, type SidebarLesson } from './learningSidebarHtml';

type ActiveLesson = () => SidebarLesson & {mode?: string};
interface ResumeTarget {
  owner: string; environment: EnvironmentName; course: string; chapter: string;
}

class LearningNavigation implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ready = false;
  private revision = 0;
  private resume?: ResumeTarget;
  private menuResume?: ResumeTarget;
  private projectRevision = 0;
  private root?: vscode.WorkspaceFolder;
  private directories: vscode.Uri[] = [];
  private entries: {uri:vscode.Uri; directory:boolean}[] = [];

  constructor(private readonly auth: Auth,
    private readonly environment: () => EnvironmentName, private readonly service: () => Environment,
    private readonly activeLesson: ActiveLesson) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = {enableScripts:true, localResourceRoots:[]};
    const updateProject = () => { void this.updateProject(); };
    const listeners = [
      view.webview.onDidReceiveMessage(message => {
        void this.handle(message).catch(error => vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not open the selected item.'));
      }),
      view.onDidChangeVisibility(() => { if (view.visible && this.ready) { this.refresh(); updateProject(); this.updateSelected(); } }),
      vscode.workspace.onDidChangeWorkspaceFolders(updateProject),
      vscode.workspace.onDidCreateFiles(updateProject), vscode.workspace.onDidDeleteFiles(updateProject), vscode.workspace.onDidRenameFiles(updateProject),
      vscode.window.onDidChangeActiveTextEditor(() => { if (this.workspaceRoot()?.uri.toString() !== this.root?.uri.toString()) updateProject(); }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateSelected()),
    ];
    view.onDidDispose(() => {
      for (const listener of listeners) listener.dispose();
      this.projectRevision++; this.entries = []; this.ready = false; this.view = undefined;
    });
    view.webview.html = sidebarHtml(randomBytes(16).toString('hex'));
  }

  refresh() {
    void this.loadLearner();
  }

  private async loadLearner() {
    const revision = ++this.revision, environment = this.environment(), service = this.service();
    this.resume = this.menuResume = undefined;
    void vscode.commands.executeCommand('setContext','dhimantai.canResume',false);
    const send = (account: string, resume: string, count?: number) =>
      this.view?.webview.postMessage({type:'learner',environment,account,resume,count,signedIn:!!session});
    const footer = (session: Session) => `<button data-key="profile" aria-label="Open account profile"><span class="avatar">${escape(learnerInitial(session))}</span>
      <span>Signed in<small>${escape(session.user.email || session.user.phone || session.user.displayName || 'Learner account')}</small></span></button>`;
    let session: Session | undefined;
    try {
      session = await this.auth.session();
      if (revision !== this.revision || environment !== this.environment()) return;
      if (!session) {
        void send('<button data-key="signIn"><span class="avatar">→</span>Sign in</button>',
          '');
        return;
      }
      void send(footer(session),resumeCard(undefined,revision,'Loading your course…'));
      const {courses} = await new Api(this.auth,()=>service,session.user.id).practiceCatalog();
      const owner = (await this.auth.session())?.user.id;
      if (revision !== this.revision || environment !== this.environment() || owner !== session.user.id) return;
      const resume = sidebarResume(courses,this.activeLesson());
      const started = courses.filter(course => course.chapters.some(ch => ch.progress &&
        ['in_progress','covered','content_changed'].includes(ch.progress.status)));
      const recent = sidebarResume(started, {});
      if (recent) {
        this.menuResume = {owner,environment,course:recent.course,chapter:recent.chapter};
        void vscode.commands.executeCommand('setContext','dhimantai.canResume',true);
      }
      if (resume) this.resume = {owner,environment,course:resume.course,chapter:resume.chapter};
      void send(footer(session),resumeCard(resume,revision,'Browse courses to find an available lesson.','courses'),courses.length);
    } catch {
      if (revision === this.revision && environment === this.environment())
        void send(session ? footer(session) : '',resumeCard(undefined,revision,'Your courses could not be loaded.','retry'));
    }
  }

  async openResume(target = this.menuResume) {
    if (!target) return;
    const owner = (await this.auth.session())?.user.id;
    if ((target !== this.menuResume && target !== this.resume) || owner !== target.owner || this.environment() !== target.environment) return;
    return target.course === ERP_COURSE ? vscode.commands.executeCommand('dhimantai.openBrowserCourse','erpnext-essentials')
      : vscode.commands.executeCommand('dhimantai.openLearningRoom',target.course,target.chapter);
  }

  private updateSelected(key?: string) {
    if (!this.ready || !this.view?.visible) return;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!key && input instanceof vscode.TabInputWebview) {
      if (input.viewType.endsWith('dhimantai.courseCatalog')) key = 'courses';
      else if (input.viewType.endsWith('dhimantai.courseGrade')) key = 'certificates';
      else if (input.viewType.endsWith('dhimantai.learningRoom')) {
        const mode = this.activeLesson().mode;
        key = mode === 'doubt_solver' ? 'doubt' : mode === 'practice' ? 'practice' : 'instructor';
      }
    }
    void this.view.webview.postMessage({type:'selected',key});
  }

  private workspaceRoot() {
    const document = vscode.window.activeTextEditor?.document.uri ?? vscode.window.activeNotebookEditor?.notebook.uri;
    return (document && vscode.workspace.getWorkspaceFolder(document)) ?? vscode.workspace.workspaceFolders?.[0];
  }

  private async updateProject() {
    if (!this.ready || !this.view?.visible) return;
    const revision = ++this.projectRevision, root = this.workspaceRoot();
    const send = (html: string) => this.view?.webview.postMessage({type:'workspace',html});
    if (root?.uri.toString() !== this.root?.uri.toString()) this.directories = [];
    this.root = root;
    this.entries = [];
    if (!root) { void send(''); return; }
    const dir = this.directories.at(-1) ?? root.uri;
    let files: string;
    try {
      const children = await vscode.workspace.fs.readDirectory(dir);
      if (revision !== this.projectRevision) return;
      const items = children.filter(([name,type])=>!name.startsWith('.') && !['node_modules','__pycache__'].includes(name)
        && (type===vscode.FileType.File || type===vscode.FileType.Directory))
        .sort(([a,ta],[b,tb]) => tb-ta || a.localeCompare(b));
      this.entries = items.map(([name,type]) => ({uri:vscode.Uri.joinPath(dir,name),directory:type===vscode.FileType.Directory}));
      files = items.map(([name],i)=>`<button class="file-row" data-key="file" data-id="${i}" data-revision="${revision}">${icon(this.entries[i].directory ? 'layers' : 'file')}${escape(name)}${this.entries[i].directory ? ' ›' : ''}</button>`).join('')
        || '<small>No files in this folder.</small>';
    } catch {
      if (revision !== this.projectRevision) return;
      files = '<small>This folder is unavailable.</small>';
    }
    const back = this.directories.length ? `<button data-key="parent" data-revision="${revision}">← Parent folder</button>` : '';
    void send(`<details class="project" open><summary>Current project</summary><div class="project-box"><h3>${escape(root.name)}</h3>
      ${back}<div class="files">${files}</div></div></details>`);
  }

  private async handle(message: {key?:string; id?:string; revision?:number}) {
    const key = message?.key;
    if (key === 'ready') {
      this.ready = true; this.refresh(); this.updateSelected(); return this.updateProject();
    }
    if (!this.ready || !this.view?.visible) return;
    if (key === 'retry') return this.refresh();
    if (key === 'resume') {
      const target = this.resume;
      if (!target || message.revision !== this.revision) return;
      return this.openResume(target);
    }
    if (key === 'profile' || key === 'signIn') return vscode.commands.executeCommand(key === 'profile' ? 'dhimantai.profile' : 'dhimantai.signIn');
    if (key === 'file' || key === 'parent') {
      if (!this.root || message.revision !== this.projectRevision || this.workspaceRoot()?.uri.toString() !== this.root.uri.toString()) return;
      if (key === 'parent') this.directories.pop();
      else {
        if (typeof message.id !== 'string' || !/^\d+$/.test(message.id)) return;
        const entry = this.entries[Number(message.id)];
        if (!entry) return;
        if (!entry.directory) return vscode.commands.executeCommand('vscode.open',entry.uri);
        this.directories.push(entry.uri);
      }
      return this.updateProject();
    }
    const nav = destinations.find(item=>item.key===key);
    if (nav) {
      this.updateSelected(nav.key);
      await vscode.commands.executeCommand(nav.command,...(nav.key === 'certificates' ? ['__certificates__'] : []));
    }
  }
}

export function registerLearningNavigation(context: vscode.ExtensionContext, auth: Auth,
    environment: () => EnvironmentName, service: () => Environment, activeLesson: ActiveLesson) {
  const desktop = vscode.env.appName === 'dhimantAI';
  void vscode.commands.executeCommand('setContext','dhimantai.customDesktop',desktop);
  if (!desktop) return;
  const provider = new LearningNavigation(auth,environment,service,activeLesson);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('dhimantai.learningNavigation',provider),
    auth.onDidChange(()=>provider.refresh()),
    vscode.workspace.onDidChangeConfiguration(e=>{if (e.affectsConfiguration('dhimantai.environment')) provider.refresh();}));
  context.subscriptions.push(vscode.commands.registerCommand('dhimantai.skilling.resume', () => provider.openResume()));
  // The sidebar can be closed for an entire lesson. Refresh the home shortcut on returning to the catalog or empty window.
  let atHome = false;
  const homeChanged = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const home = !input || input instanceof vscode.TabInputWebview && input.viewType.endsWith('dhimantai.courseCatalog');
    if (home && !atHome) provider.refresh();
    atHome = home;
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(homeChanged), vscode.window.tabGroups.onDidChangeTabGroups(homeChanged));
  provider.refresh();
  return provider;
}
