import { GitSkill } from './gitPractice';
import { ArchitectureAttempts, ArchitectureEvent, ArchitectureHelp, ArchitectureTopic, PracticeFollowup, architectureSummary, isDebugProject, originSummary, transferTitles, waitsForIndependentAttempt } from './architectureMemory';
import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Api, ApiError, HandoffAvailability, HandoffReceipt } from './api';
import { Auth } from './auth';
import { CoachSurface, CoachRenderer } from './coachSurface';
import { CoachAudio, SpokenReply, instructorComposer, audioPolicy } from './coachAudio';
import { practiceAttachments, PracticeAttachment, attachmentNote } from './practiceAttachments';
import { bindDictation } from './dictation';
import { coachingLanguage, coachingLanguages } from './coachingLanguage';
import { courseAction, type SkillingTarget } from './skillingMenu';
import { CourseWorkspaces } from './courseWorkspace';
import { courseTerminalOptions } from './courseTerminal';
import { Environment, EnvironmentName } from './environments';
import { checkState, isEnabledProject, projectIdentity, loadProjectCurriculum, trackedProjectFiles, personalSource, ProjectCheckpoint, ProjectCurriculum, ProjectRun,
  prepareProjectHandoff, projectFiles, projectDebugTarget, projectSnapshot, checkDigest, evidenceFingerprint, publicProjectFile, runProjectCheck, ProjectSnapshot } from './projectCore';
import { CODE_READING_PAUSED, desktopProjectEnabled } from './desktopFeatures';
import { projectContextProblem, projectReferences, publicContextPath, redactSecrets } from './projectContext';
import type { ProjectDebugger } from './projectDebugger';
import { runManagedProject } from './projectLive';
import { onRecordsChanged } from './helpRecord';
import type { CourseworkOutbox } from './courseworkProgress';
import { PROJECT_COURSES } from './catalogProjects';
import { ProjectResults, ProjectSubmission, projectResultStatus, submitProject } from './projectResults';
import { projectGitHub } from './projectGitHub';
import { ProjectProgress, checkpointCurrent, checkpointEvidence, readingGuidance, milestoneHistory, checkpointProof, projectMilestones, projectOtherHelp, restoreProjectProgress, smallerProjectStep } from './projectProgress';

/** Offer catalog recovery for course access issues while preserving other service errors. */
function projectAccessError(error: unknown, course?: string) {
  if (!(error instanceof ApiError) || ![402, 403].includes(error.status) || !/course catalog/i.test(error.message)) return;
  const reason = course ? `Project course · ${course}. ${error.message}` : error.message;
  void vscode.window.showWarningMessage(reason, 'Open course catalog')
    .then(choice => choice && vscode.commands.executeCommand('dhimantai.courseCatalog'));
  return new Error(reason + ' You can continue with the milestone guides and local checks.');
}

// Reading notes are accessible from every reading milestone, including steps whose check tracks only source files.
function milestoneLinks(curriculum: ProjectCurriculum, step: ProjectCurriculum['steps'][number]) {
  return curriculum.mode === 'reading' && curriculum.files.includes('READING_NOTES.md') && !step.files.includes('READING_NOTES.md')
    ? [...step.files, 'READING_NOTES.md'] : step.files;
}

/** The existing Coach surface, scoped to one multi-file project and account at a time. */
const watchesArchitecture = (id: string) => ['personal-project', 'skilling-project', 'shelf', 'course-agent'].includes(id);
type ProjectMessage = {topic?:ArchitectureTopic; role:'learner' | 'tutor'; text:string; digest?:string; observation?:Observation['event']; references?:ReturnType<typeof projectReferences>};
type Observation = {event:'opened' | 'saved' | 'check' | 'git' | 'debug_pause'; path?:string; line?:number; current?:()=>boolean};

function practiceHintLevel(help: readonly string[] = []) {
  if (help.some(key => ['design_hint', 'isolate_hint', 'regression_hint'].includes(key))) return 2;
  return help.some(key => ['inspection_hint', 'reproduce_hint'].includes(key)) ? 1 : 0;
}

export class ProjectCoach implements vscode.Disposable {
  private readonly menuChanged = new vscode.EventEmitter<void>();
  readonly onMenuChange = this.menuChanged.event;
  private readonly subscriptions: vscode.Disposable[] = [this.menuChanged];
  private curriculum: Promise<ProjectCurriculum>;
  private root?: string;
  private step = 0;
  private revision = 0;
  private request?: AbortController;
  private snapshotCheck?: AbortController;
  private reviewRequest?: AbortController;
  private reviewTimer?: ReturnType<typeof setTimeout>;
  private lastReviewAt = 0;
  private lastEvidence = '';
  private lastPublicGit = '';
  private busy = false;
  private status = '';
  private run?: ProjectRun;
  private debugger?: ProjectDebugger;
  private checkpoint?: ProjectCheckpoint;
  private progress: ProjectProgress = {visited: [], checkpoints: {}};
  private assistance = 0;
  private owner = '';
  private messages: ProjectMessage[] = [];
  private chats: Record<string, ProjectMessage[]> = {};
  private architectureAttempts: ArchitectureAttempts = {};
  private architectureProblem = '';
  private followup?: PracticeFollowup;
  private followupSequence = 0;
  private followupTimer?: ReturnType<typeof setTimeout>;
  private personalPaths:string[] = [];
  private personal = false;
  private memorySequence = 0;
  private milestone = '';
  private conversationId = randomBytes(16).toString('hex');
  private spoken?: SpokenReply;
  private lastGuide?: string;
  private conversationLanguage?: string;
  private selectedVoiceLanguage?: string;
  private handoff?: HandoffAvailability;
  private receipt?: HandoffReceipt;
  private handoffRequest?: {id: string; fingerprint: string};
  private handoffStatus = 'Not submitted. Institute learners submit to their assigned teacher; independent learners prepare a local handoff.';
  private liveOutput = '';
  private refreshSequence = 0;
  private disposed = false;
  private inProject = false;
  private watcher?: vscode.Disposable;
  private opening = false;
  private openSequence = 0;
  private loadedKey = '';
  private resetSequence = 0;

  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: Auth,
    private readonly environment: () => EnvironmentName, private readonly service: () => Environment,
    private readonly courses: CourseWorkspaces, private readonly surface: CoachSurface, private readonly results?: ProjectResults,
    private readonly recordCoursework?: (environment: EnvironmentName, owner: string, curriculum: ProjectCurriculum, submission: ProjectSubmission) => Promise<void>,
    private readonly coursework?: CourseworkOutbox) {
    this.subscriptions.push(onRecordsChanged(() => { if (this.inProject) void this.refresh(); }));
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.curriculum = loadProjectCurriculum(media.fsPath, 'course-agent');
    let lastTab: vscode.Tab | undefined;
    const editedLine = new WeakMap<vscode.TextDocument, number>();
    const followTab = () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (tab === lastTab) return;
      const previous = lastTab?.input;
      lastTab = tab;
      if (!this.root || this.opening) return;
      const input = tab?.input;
      // On older hosts the Coach itself occupies an adjacent editor tab.
      if (input instanceof vscode.TabInputWebview && input.viewType.endsWith('dhimantai.buildStudio')) return;
      let uri: vscode.Uri | undefined;
      if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom)
        uri = input.uri;
      else if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff)
        uri = input.modified;
      if (uri && this.path(uri)) {
        this.inProject = true;
        if (previous instanceof vscode.TabInputWebview) this.showProjectFiles();
        this.surface.select(this.render); void this.surface.show(true); void this.refresh();
        if (this.personal) this.queueReview({event:'opened', path:this.path(uri)});
      } else {
        if (this.inProject && vscode.env.appName === 'dhimantAI' && input instanceof vscode.TabInputWebview
            && input.viewType.endsWith('dhimantai.courseGrade')) {
          void vscode.commands.executeCommand('workbench.action.closeSidebar');
          void vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        }
        void this.hide();
      }
    };
    this.subscriptions.push(vscode.commands.registerCommand('dhimantai.discussProjectSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!this.root || !editor || !this.path(editor.document.uri) || editor.selection.isEmpty) return;
        const chat = this.conversationId;
        const snapshot = await this.snapshot();
        if (chat !== this.conversationId) return;
        if (!snapshot.selection) { void vscode.window.showInformationMessage('Select lines in a public project file to discuss them.'); return; }
        this.inProject = true;
        this.surface.select(this.render);
        await this.surface.show(false);
        await this.refresh();
        if (chat === this.conversationId) await this.surface.webviewFor(this.render)?.postMessage({type:'focusComposer', conversationId:chat});
      }),
      auth.onDidChange(session => {
        if ((session?.user.id ?? 'local') === this.owner) return;
        this.clearChat(); this.invalidate('Account changed. Reopen Project Mentor to continue.'); this.run = undefined; this.checkpoint = undefined; void this.resetOwner();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dhimantai.environment') || e.affectsConfiguration('dhimantai.aiAssistance')) {
          this.clearChat(); this.invalidate('Project Mentor settings changed.'); this.run = undefined; void this.resetOwner();
        }
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length && this.path(e.document.uri)) {
          editedLine.set(e.document, e.contentChanges[0].range.start.line + 1);
          this.invalidate('Files changed. Check again before discussing a result.');
        }
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        const path = this.path(document.uri);
        if (path) {
          this.invalidate('Files saved.');
          this.queueReview({event:'saved', path, line:editedLine.get(document)});
          editedLine.delete(document);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (this.path(e.textEditor.document.uri)) void this.refresh();
      }),
      vscode.window.tabGroups.onDidChangeTabs(followTab),
      vscode.window.tabGroups.onDidChangeTabGroups(followTab));
  }

  private showProjectFiles() {
    if (vscode.env.appName === 'dhimantAI')
      void vscode.commands.executeCommand('workbench.explorer.fileView.focus', {preserveFocus:true});
  }

  private path(uri: vscode.Uri) {
    if (!this.root || uri.scheme !== 'file') return;
    const path = relative(this.root, uri.fsPath).replace(/\\/g, '/');
    return path && !path.startsWith('..') && !path.startsWith('/') ? path : undefined;
  }
  // Existing workspaces store checkpoints, chat and submission retry IDs under this key.
  private key() { return `projectCoach:${this.environment()}:${this.owner}:${this.root}`; }
  private async resetOwner() {
    // Load into locals and assign together, so a later save never writes another
    // account's, project's or an empty progress record under the current key.
    this.loadedKey = ''; this.architectureAttempts = {}; this.architectureProblem = ''; this.followup = undefined; this.followupSequence++; clearTimeout(this.followupTimer); this.memorySequence++;
    const sequence = ++this.resetSequence;
    this.handoff = undefined; this.receipt = undefined; this.liveOutput = '';
    this.handoffStatus = 'Not submitted. Refresh submission status to check your account and earlier submissions.';
    const owner = (await this.auth.session().catch(() => undefined))?.user.id ?? 'local';
    const curriculum = await this.curriculum;
    // A newer reset (account, settings or project change) supersedes this one and loads instead.
    if (sequence !== this.resetSequence || this.disposed) return;
    this.owner = owner;
    const key = this.key();
    const saved = this.context.workspaceState.get<{checkpoint?: ProjectCheckpoint; assistance?: number; step?: number;
      progress?: ProjectProgress; chats?: Record<string, ProjectMessage[]>; handoffRequest?: {id: string; fingerprint: string}}>(key);
    const progress = restoreProjectProgress(curriculum, saved);
    const older = curriculum.steps.filter(s => s.guide && progress.checkpoints[s.id]?.completed && !progress.checkpoints[s.id].noteLines);
    if (older.length && this.root) {
      const snapshot = await projectSnapshot(this.root, curriculum, [], this.dirty(false)).catch(() => undefined);
      if (sequence !== this.resetSequence || this.disposed || key !== this.key()) return;
      for (const step of older) {
        const checkpoint = progress.checkpoints[step.id];
        // A previous version stored a whole-notebook hash. Upgrade only a baseline we can still verify.
        if (snapshot?.reading && checkpointCurrent(checkpoint, snapshot))
          progress.checkpoints[step.id] = {...checkpoint, ...checkpointEvidence(step, snapshot)};
      }
    }
    this.progress = progress; this.assistance = saved?.assistance ?? 0;
    this.handoffRequest = saved?.handoffRequest;
    this.step = Math.max(0, Math.min(saved?.step ?? 0, curriculum.steps.length - 1));
    const step = curriculum.steps[this.step];
    this.chats = Object.fromEntries(curriculum.steps.map(step => {
      const messages = saved?.chats?.[step.id];
      return [step.id, Array.isArray(messages) ? messages.filter(m => m && ['learner','tutor'].includes(m.role) && typeof m.text === 'string').slice(-40) : []];
    }));
    this.milestone = step.id; this.messages = this.chats[step.id];
    this.checkpoint = this.progress.checkpoints[step.id];
    if (curriculum.id === 'market-checkout' && this.root)
      this.run = this.results?.get(this.environment(), owner, this.root)?.submissions.at(-1)?.runs.at(-1);
    if (!this.progress.visited.includes(step.id)) this.progress.visited.push(step.id);
    this.loadedKey = key;
    if (curriculum.architecture || curriculum.gitPractice) {
      if (owner === 'local') this.architectureProblem = 'Sign in to remember your practice across projects.';
      else try { await this.architectureEvent(curriculum, {event:'started'}); }
      catch { if (key === this.key()) this.architectureProblem = 'Practice memory is unavailable. Reopen the project or retry your next action.'; }
      if (sequence !== this.resetSequence || this.disposed || key !== this.key()) return;
    }
    if (owner !== 'local' && (curriculum.architecture || curriculum.gitPractice || watchesArchitecture(curriculum.id))) {
      await this.loadFollowup();
      if (sequence !== this.resetSequence || this.disposed || key !== this.key()) return;
    }
    await this.persist();
    if (this.root && !this.personal) await this.results?.save(this.environment(), this.owner, this.root, curriculum);
    void this.refresh();
  }
  private selectStep(curriculum: ProjectCurriculum, index: number) {
    this.chats[this.milestone] = this.messages.slice(-40);
    this.clearChat(); this.invalidate(''); this.step = index;
    const next = curriculum.steps[this.step];
    this.milestone = next.id; this.messages = [...this.chats[next.id] ?? []];
    this.checkpoint = this.progress.checkpoints[next.id];
    if (!this.progress.visited.includes(next.id)) this.progress.visited.push(next.id);
  }

  private persist() {
    // Until resetOwner loads the current account/project, the fields belong to another key.
    if (this.loadedKey !== this.key()) return Promise.resolve();
    this.chats[this.milestone] = this.messages.slice(-40);
    return this.context.workspaceState.update(this.key(), {chats:{...this.chats}, checkpoint: this.checkpoint, progress: this.progress, assistance: this.assistance, step: this.step,
      handoffRequest: this.handoffRequest});
  }
  private invalidate(message: string) {
    this.cancelReview();
    if (this.request && this.liveOutput === 'Running your project against the managed live model…') this.liveOutput = 'Managed live run cancelled. Retry explicitly when ready.';
    this.revision++; this.request?.abort(); this.request = undefined; this.busy = false; this.status = message;
    void this.refresh();
  }
  private clearChat() {
    this.lastEvidence = ''; this.lastPublicGit = ''; this.lastReviewAt = 0;
    this.messages = []; this.spoken = undefined; this.lastGuide = undefined;
    this.conversationLanguage = undefined; this.selectedVoiceLanguage = undefined; this.conversationId = randomBytes(16).toString('hex');
  }
  async hide() {
    this.inProject = false;
    void this.surface.webviewFor(this.render)?.postMessage({type: 'audioOff'});
    this.invalidate(''); await this.surface.hide(this.render);
  }

  async menuTarget(uri: vscode.Uri): Promise<SkillingTarget> {
    const folder = uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    if (!folder || folder.uri.scheme !== 'file') return {};
    const root = folder.uri.fsPath;
    const current = this.root === root;
    const id = current ? (await this.curriculum).id : await projectIdentity(root)
      ?? (vscode.workspace.isTrusted && this.context.workspaceState.get('personalInstructor:' + root) ? 'personal-project' : undefined);
    if (!id || !desktopProjectEnabled(id)) return {};
    const curriculum = current ? await this.curriculum : await loadProjectCurriculum(join(this.context.extensionUri.fsPath, 'media'), id, root);
    const reveal = async () => {
      if (this.root !== root) return this.open(root);
      this.inProject = true;
      this.surface.select(this.render);
      await this.surface.show(true);
      await this.refresh();
    };
    const course = curriculum.courseId ?? PROJECT_COURSES[id];
    const target: SkillingTarget = {project:reveal};
    if (course) target.course = courseAction(course);
    if (publicContextPath(relative(root, uri.fsPath).replace(/\\/g, '/'))) target.discuss = async () => {
      const editor = vscode.window.activeTextEditor, selection = editor?.selection;
      if (!editor || editor.document.uri.toString() !== uri.toString() || !selection || selection.isEmpty) return;
      if (this.root !== root) await this.open(root);
      if (this.root === root && vscode.window.activeTextEditor === editor && editor.selection.isEqual(selection))
        await vscode.commands.executeCommand('dhimantai.discussProjectSelection');
    };
    return target;
  }

  async canRestore(root: string) {
    return await isEnabledProject(root) || vscode.workspace.isTrusted && !!this.context.workspaceState.get('personalInstructor:' + root);
  }
  async open(root: string, restoring = false) {
    const opening = ++this.openSequence;
    try {
      const id = await projectIdentity(root) ?? 'personal-project';
      if (id === 'personal-project') {
        if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file' && folder.uri.fsPath === root))
          throw new Error('Open the trusted project folder in this window to review your own work.');
        await this.context.workspaceState.update('personalInstructor:' + root, true);
      }
      if (!desktopProjectEnabled(id)) {
        void vscode.window.showInformationMessage(CODE_READING_PAUSED);
        return;
      }
      const curriculum = await loadProjectCurriculum(join(this.context.extensionUri.fsPath, 'media'), id,root);
      if (opening !== this.openSequence || this.disposed) return;
      this.opening = true;
      this.inProject = false;
      this.clearChat(); this.invalidate(''); this.root = root; this.personal = id === 'personal-project'; this.personalPaths = []; this.run = undefined;
      this.curriculum = Promise.resolve(curriculum);
      this.menuChanged.fire();
      // resetOwner restores the saved step; until then never index past a shorter curriculum.
      this.step = Math.max(0, Math.min(this.step, curriculum.steps.length - 1));
      this.watcher?.dispose();
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
      const projectRoot = root, trackedFiles = new Set(trackedProjectFiles(curriculum));
      const changed = async (uri: vscode.Uri, onDisk: boolean) => {
        const path = this.path(uri);
        if (!path || this.root !== projectRoot) return;
        const tracked = trackedFiles.has(path) || (this.personal && personalSource(path)) || (curriculum.architecture && path.endsWith('.py') && publicContextPath(path)) || (curriculum.mode === 'guided' && /^(src|tests)\//.test(path))
          || /^(course_agent|shelf|rich|reading|examples|tests|checks)\/.*\.py$/.test(path)
          || /^(data|scenarios)\/[A-Za-z0-9_-]+\.json$/.test(path);
        // The submission compares Git and file snapshots before and after reading history.
        // A delayed disk event from a commit already in that snapshot must not cancel the check.
        if (!tracked || this.snapshotCheck && this.snapshotCheck === this.request) return;
        // VS Code also reports its own saves through the filesystem watcher. A late duplicate
        // must not cancel a check the learner started immediately after saving the same text.
        const editor = onDisk && vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === uri.fsPath && !doc.isDirty);
        if (editor) {
          const disk = await publicProjectFile(projectRoot, path).then(file => readFile(file, 'utf8')).catch(() => undefined);
          if (disk === editor.getText()) return;
        }
        if (opening === this.openSequence && !this.disposed) {
          this.invalidate('Project files changed.');
          this.queueReview({event:'saved', path});
        }
      };
      watcher.onDidChange(uri => changed(uri, true)); watcher.onDidCreate(uri => changed(uri, true));
      watcher.onDidDelete(uri => changed(uri, false));
      // Recursive workspace watchers commonly exclude .git. Watch the index and HEAD reflog directly.
      const gitWatchers = ['.git', '.git/logs'].map(dir => {
        const events = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(join(root!, dir), '*'));
        const onGitChange = (uri: vscode.Uri) => {
          if (opening !== this.openSequence || !['.git/HEAD', '.git/index', '.git/packed-refs', '.git/logs/HEAD'].includes(this.path(uri) ?? '')) return;
          if (!this.reviewTimer && !this.reviewRequest && !this.busy) this.queueReview({event:'git'});
          if (curriculum.id === 'shelf' || curriculum.gitPractice) void this.refresh();
        };
        events.onDidChange(onGitChange); events.onDidCreate(onGitChange); events.onDidDelete(onGitChange);
        return events;
      });
      this.watcher = vscode.Disposable.from(watcher, ...gitWatchers);
      await this.resetOwner();
      if (opening !== this.openSequence || this.disposed) return;
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (restoring && activeTab instanceof vscode.TabInputWebview && !activeTab.viewType.endsWith('dhimantai.buildStudio')) return;
      if (!this.personal && !this.path(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse('untitled:'))) {
        const guide = join(root, curriculum.mode === 'reading' ? 'READING.md' : 'README.md');
        const firstFile = curriculum.id === 'shelf-reading' && curriculum.steps[this.step].id === 'map'
          ? await publicProjectFile(root, 'READING_NOTES.md').catch(() => guide) : guide;
        await vscode.window.showTextDocument(vscode.Uri.file(firstFile), {preview: true});
      }
      if (opening !== this.openSequence || this.disposed) return;
      this.opening = false;
      this.inProject = true;
      this.showProjectFiles();
      this.surface.select(this.render);
      await this.surface.show(true, !restoring);
      await this.refresh();
      this.queueReview({event:'opened'});
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not open Project Mentor.'); }
    finally { if (opening === this.openSequence) { this.opening = false; void this.refresh(); } }
  }

  private dirty(onlyDirty = true) {
    const dirty = new Map<string, string>();
    for (const document of vscode.workspace.textDocuments) {
      const path = this.path(document.uri);
      if (path && (!onlyDirty || document.isDirty)) dirty.set(path, document.getText());
    }
    return dirty;
  }
  private async snapshot(question = '', observation?: Observation) {
    const curriculum = await this.curriculum, step = curriculum.steps[this.step];
    const editor = vscode.window.activeTextEditor, selected = editor && this.path(editor.document.uri);
    const locations: Record<string, number | string> = {...step.anchors};
    if (selected && editor) locations[selected] = editor.selection.active.line + 1;
    if (observation?.path && observation.line) locations[observation.path] = observation.line;
    const range = editor?.selection;
    const selection = selected && range && !range.isEmpty ? {path:selected, start:range.start.line + 1,
      end:range.end.line + (range.end.character === 0 ? 0 : 1)} : undefined;
    const focus = observation?.path ?? selected;
    const savedLocation = observation?.path && observation.line ? observation.path + ':' + observation.line : observation?.path;
    if (this.personal && focus && personalSource(focus))
      this.personalPaths = [focus, ...this.personalPaths.filter(path => path !== focus)].slice(0, 6);
    return projectSnapshot(this.root!, curriculum, [...(focus ? [focus] : []), ...this.personalPaths, ...step.files],
      observation ? new Map() : this.dirty(false), locations, observation ? savedLocation ?? '' : question,
      observation ? undefined : selection, !!observation || !!question);
  }

  private cancelReview() {
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = undefined;
    this.reviewRequest?.abort(); this.reviewRequest = undefined;
  }

  private reviewingAllowed() {
    return this.inProject && !this.disposed && !this.opening && !this.busy && vscode.workspace.isTrusted &&
      this.surface.visible && !!this.surface.webviewFor(this.render) && this.canUseInstructor();
  }

  private queueReview(observation: Observation) {
    if (!this.reviewingAllowed() && !(observation.event === 'debug_pause' && this.busy)) return;
    this.cancelReview();
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = undefined;
      void this.review(observation);
    }, Math.max(2500, this.lastReviewAt + 20000 - Date.now()));
  }

  private async review(observation: Observation) {
    if (!this.reviewingAllowed() || observation.current?.() === false) return;
    const controller = this.reviewRequest = new AbortController(), revision = this.revision;
    try {
      const curriculum = await this.curriculum;
      if (controller.signal.aborted || revision !== this.revision) return;
      if (curriculum.gitPractice) {
        this.lastReviewAt = Date.now();
        await this.rememberGitProgress(curriculum,controller.signal);
        if (controller.signal.aborted || revision !== this.revision) return;
        void this.refresh();
        // The repository can demonstrate progress without the mentor suggesting the next move.
        if (waitsForIndependentAttempt(curriculum.id,this.architectureAttempts[curriculum.id])) return;
      }
      await this.ask('', curriculum, curriculum.steps[this.step], [], observation, controller);
    } catch (error) {
      if (!controller.signal.aborted && this.reviewingAllowed()) {
        this.status = error instanceof ApiError && [402, 403, 429].includes(error.status)
          ? error.message : 'Mentor feedback is unavailable for this change.';
        void this.refresh();
      }
    } finally { if (this.reviewRequest === controller) this.reviewRequest = undefined; }
  }
  /** What Coach would receive for this question, shown before it is sent. */
  private sharing(snapshot: Pick<ProjectSnapshot, 'files' | 'omitted' | 'omitted_count' | 'structure' | 'git'>) {
    return {sharedFiles: snapshot.files.map(f => f.path + ':' + f.start_line + '–' + (f.start_line + f.text.split('\n').length - 1) + (f.truncated ? ' (excerpt)' : '')),
      omitted: snapshot.omitted, omittedCount: snapshot.omitted_count, structure: snapshot.structure, git: snapshot.git};
  }
  private checkoutProgress(curriculum: ProjectCurriculum, snapshot?: ProjectSnapshot) {
    if (curriculum.id !== 'market-checkout' || !this.root) return;
    const saved = this.results?.get(this.environment(), this.owner, this.root);
    const last = saved?.submissions.at(-1);
    const complete = !!snapshot && last?.outcome === 'completed' && last.digest === snapshot.digest;
    const attempt = this.architectureAttempts[curriculum.id];
    const accountRecorded = !!attempt?.repair_digest;
    const identified = complete || accountRecorded || !!attempt?.recognition_help || attempt?.first_diagnosis === 'after_edit';
    const status = !snapshot ? 'Current files unavailable' : saved ? projectResultStatus(saved, snapshot.digest) : 'In progress';
    let guide: string;
    if (!snapshot) guide = 'Reopen the project files to check their completion status.';
    else if (complete) guide = this.checkpoint?.note && checkpointCurrent(this.checkpoint, snapshot)
      ? 'All required steps are complete. Your reflection is saved on this computer.'
      : 'All required steps are complete. You can save a before-and-after observation in the optional checkpoint.';
    else if (last && last.digest !== snapshot.digest) guide = 'The files changed after the last check. Save your work and select Verify repair.';
    else if (last) guide = 'Inspect the check output, revise pricing.py and select Verify repair again.';
    else if (identified || this.owner === 'local')
      guide = 'Trace the ledger write in pricing.py, make your repair, then save the file and select Verify repair.';
    else guide = 'Read pricing.py and trace one preview followed by one purchase. Record your prediction before editing. If you already made the repair, save your work and select Verify repair.';
    let sync = '';
    if (complete) {
      if (this.owner === 'local') sync = 'Saved on this computer.';
      else if (accountRecorded) sync = 'Practice completion recorded in your account.';
      else sync = attempt ? 'Practice completion is awaiting account sync.' : 'Account completion could not be confirmed.';
    }
    return {status, complete, guide, sync, accountRecorded, identified};
  }

  private async refresh() {
    if (!this.root || this.disposed || this.opening) return;
    const sequence = ++this.refreshSequence, root = this.root;
    try {
      const curriculum = await this.curriculum;
      let snapshot: ProjectSnapshot | undefined, problem = '';
      try { snapshot = await this.snapshot(); }
      catch (error) {
        // Keep the panel usable: guides, navigation and checkpoints don't need the snapshot.
        const paths = await projectFiles(root, curriculum).catch(() => undefined);
        problem = await projectContextProblem(error, root, paths, this.dirty(false), curriculum.id === 'rich-reading' ? 2048 : 64);
      }
      if (sequence !== this.refreshSequence || this.disposed) return;
      const step = curriculum.steps[this.step];
      const workspace = this.courses.recordFor(vscode.Uri.file(root));
      const milestones = projectMilestones(curriculum, this.progress, snapshot);
      const saved = this.results?.get(this.environment(), this.owner, root);
      const last = saved?.submissions.at(-1);
      const checkout = this.checkoutProgress(curriculum, snapshot);
      if (checkout) milestones[0].status = checkout.complete ? 'complete' : 'in_progress';
      else if ((curriculum.architecture || curriculum.gitPractice) && snapshot) {
        if ((last?.outcome === 'completed' && last.digest === snapshot.digest) || (curriculum.gitPractice && this.architectureAttempts[curriculum.id]?.complete_digest === snapshot.digest)) milestones[0].status = 'complete';
      }
      const check = checkState(this.run, snapshot ? checkDigest(snapshot, step) : '', step.id);
      const completion = saved ? projectResultStatus(saved, snapshot?.digest, true, snapshot) : 'In progress';
      const sameSubmission = last?.outcome === 'completed' && snapshot && completion.startsWith('Completed locally');
      const sync = sameSubmission && this.owner !== 'local' && ['shelf','course-agent'].includes(curriculum.id)
        ? this.coursework?.projectSync(this.environment(), this.owner, last.id) : undefined;
      const guide = checkout?.guide ?? readingGuidance(curriculum, this.step, milestones, this.progress, check, snapshot);
      const voiceAvailable = this.canUseInstructor();
      if (voiceAvailable && guide && (guide !== this.lastGuide || (!this.spoken && !this.busy))) {
        this.lastGuide = guide;
        this.spoken = {id: randomUUID(), text: guide.replace(/`/g, ''), account: this.owner, environment: this.environment(),
          path: '/notebook-coach/project', query: this.voiceQuery(curriculum, this.voiceLanguage(), workspace?.course)};
      }
      void this.surface.webviewFor(this.render)?.postMessage({type: 'state', revision: this.revision, conversationId: this.conversationId, title: curriculum.title,
        scope: this.key(), personal:this.personal, followup:!curriculum.gitPractice && !curriculum.architecture && this.followup?.project && transferTitles[this.followup.project], reading: curriculum.mode === 'reading', guided:curriculum.mode==='guided',
        debugAvailable:!this.personal && !curriculum.gitPractice && !!projectDebugTarget(step,snapshot?.structure?.files),
        steps: curriculum.steps.map(s => s.title), step: this.step, current: {...step, files: milestoneLinks(curriculum, step)}, busy: this.busy,
        status: [problem, this.status].filter(Boolean).join(' '), contextProblem: problem,
        checkout, architecture:(curriculum.architecture || curriculum.gitPractice) && {prediction:curriculum.architecture?.prediction, git:!!curriculum.gitPractice, debug:isDebugProject(curriculum.id),
          identified:checkout?.identified ?? (!!curriculum.gitPractice || this.architectureAttempts[curriculum.id]?.recognition_help != null || !!this.architectureAttempts[curriculum.id]?.repair_digest),
          summary:[this.architectureProblem, architectureSummary(curriculum.id,this.architectureAttempts), originSummary(this.followup?.origins[curriculum.id])].filter(Boolean).join(' ')},
        milestones, guide, verifiedWorkflow:curriculum.steps.every(s => s.checkpointCheck),
        hintLevel: curriculum.architecture ? practiceHintLevel(this.architectureAttempts[curriculum.id]?.help) : this.messages.some(m => m.role === 'tutor' && m.text === smallerProjectStep(step)) ? 2
          : this.messages.some(m => m.role === 'tutor' && m.text === step.hint) ? 1 : 0,
        signedIn: this.owner !== 'local', audioId: this.spoken?.id ?? null,
        voiceAvailable, selectedVoiceLanguage:this.selectedVoiceLanguage ?? 'auto',
        coachCourse: workspace?.account === this.owner && workspace.environment === this.environment() ? workspace.course : undefined,
        messages: this.messages, sourceDigest:snapshot?.digest, selection:snapshot?.selection, checkpoint: this.checkpoint, runtime: 'course',
        finalStep: curriculum.id === 'course-agent' && step.id === 'handoff', liveStep: curriculum.id === 'course-agent' && step.id === 'live',
        handoffMode: this.handoff?.mode, handoffStatus: this.handoffStatus, liveOutput: this.liveOutput,
        submissionStep: !this.personal && !curriculum.gitPractice && !curriculum.architecture && this.step === curriculum.steps.length - 1,
        completion, sync, submissionId: last?.id,
        courseAvailable: this.owner !== 'local', runtimeLabel: curriculum.title + ' · ' +
          (curriculum.gitPractice ? 'Local Git' : curriculum.mode === 'guided' ? curriculum.courseTitle ?? curriculum.courseId : 'Python 3.12 · Git'),
        check,
        checkDiagnostic: this.run?.step === step.id && this.run.status === 'failed' ? this.run.diagnostic : undefined,
        ...this.sharing(snapshot ?? {files: [], omitted: [], omitted_count: 0, structure: {files: [], total_files: 0, truncated: false}}),
        ai: vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true)});
    } catch (error) {
      if (sequence === this.refreshSequence) void this.surface.webviewFor(this.render)?.postMessage({type: 'error', text: String(error)});
    }
  }

  private readonly render: CoachRenderer = webview => {
    void vscode.commands.executeCommand('setContext', 'dhimantai.projectOpen', true);
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media'), nonce = randomBytes(16).toString('hex');
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
    webview.options = {enableScripts: true, localResourceRoots: [media]};
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; connect-src ${audioPolicy}; media-src blob:; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}">
<link rel="stylesheet" href="${asset('coach.css')}"><link rel="stylesheet" href="${asset('coachMarkdown.css')}"><link rel="stylesheet" href="${asset('learning-room/composer.css')}"><link rel="stylesheet" href="${asset('projectCoach.css')}"></head>
<body><main id="coach" aria-label="Project Mentor"><h2 id="title">Course project</h2>
<div class="milestone-picker"><span id="stepTitle" aria-hidden="true"></span><select id="step" aria-label="Project milestone"></select></div>
<div class="milestone-progress"><p id="progressText" role="status"></p><progress id="progress" value="0" max="1" aria-label="Milestones marked complete"></progress>
<button id="previous" class="secondary" aria-label="Previous milestone" title="Previous milestone">‹</button><button id="next" class="secondary" aria-label="Next milestone" title="Next milestone">›</button></div>
<details id="reviewList" hidden><summary id="reviewTitle"></summary><p>Files used by these checkpoints changed after completion. Open a milestone, review its evidence, then select Save changes.</p><div id="reviewSteps"></div></details>
<div id="projectContent">
<section class="milestone-work" aria-labelledby="taskTitle"><h3 id="taskTitle">Your task</h3>
<p id="requirements" hidden></p><div id="guidePanel" hidden><p id="guide" aria-live="polite"></p></div><div id="task"></div><p id="startFile" hidden></p>
<button id="architectureFollowup" class="secondary" hidden></button>
<div id="architecturePractice" hidden><p id="architectureMemory" role="status"></p><div id="architectureIdentify">
<label for="architectureLocation">Which original file and line best explain the report?</label>
<input id="architectureLocation" placeholder="file.py:line" maxlength="120">
<label id="architectureQuestion" for="architectureCount"></label><input id="architectureCount" type="number" min="0" max="999">
<button id="architecturePredict" class="secondary">Record prediction</button></div>
</div>
<div class="row"><button id="check">Check this step</button><button id="hint" class="secondary">I’m stuck</button></div></section>
<section id="checkResult" aria-label="Check result"><p id="checkState" role="status"></p><div id="checkDiagnostic" hidden><p id="checkCause"></p><button type="button" class="link" id="checkLocation" hidden></button></div><p id="checkRecovery" class="muted"></p><details id="checkDetails" hidden><summary id="checkSummary">Show check output</summary><pre id="output"></pre></details></section>
<section id="liveRun" hidden><button id="runLive">Run live model</button><p class="muted">Uses platform access in the project container. No personal API key. Up to six model calls per run and 36 per day. These calls are separate from scripted checks.</p><pre id="liveOutput"></pre></section>
<details id="fullTask"><summary>Milestone brief and files</summary>
<div id="instructions"></div><section aria-labelledby="expectedTitle"><h3 id="expectedTitle">Expected outcome</h3><p id="expected"></p></section>
<p id="goal"></p><p id="opening"></p><div id="files" class="row"></div>
<details id="milestoneReflection"><summary>Reflect on this step</summary><p id="reflection"></p></details></details>
<details id="checkpointDetails"><summary id="checkpointTitle">Checkpoint</summary><div class="checkpoint-form">
<label for="note" id="evidencePrompt">What did you find?</label>
<textarea id="note" rows="2" maxlength="1000" placeholder="Required to complete this milestone" aria-describedby="noteError"></textarea>
<p id="noteError" role="alert"></p>
<div class="row"><button id="checkpoint">Complete milestone</button><button id="saveDraft" class="link">Save draft</button></div>
<p id="saved" class="muted" role="status"></p><p id="milestoneStatus" class="muted"></p></div></details>
<section id="submission" hidden><button id="submitProject">Submit Project</button><p id="completion" role="status"></p><p class="muted" id="submissionHelp">Runs the final checks in your project container. Eligible checks also count toward the associated course grade for signed-in learners.</p></section>
<button id="architectureNext" class="secondary" hidden>Try Field service dispatch</button>
<details id="projectTools"><summary>Project tools</summary>
<div class="runtime-row"><label for="runtime">Runtime</label><select id="runtime"><option value="course">Project container</option><option value="setup">Set up and verify environment…</option><option value="terminal">Open project terminal</option><option value="run" hidden>Run this step</option><option value="debug" hidden>Debug this step</option></select></div>
<p id="runtimeTip" class="muted">The first check or terminal session prepares this project’s environment.</p>
<label for="externalHelp">Other assistance (optional)</label><select id="externalHelp"><option value="unknown">Not reported</option><option value="reported">I used other help</option><option value="none_reported">No other help reported</option></select>
<label for="projectActions">Project actions</label><select id="projectActions"><option value="">Choose an action…</option><option value="structure">Discuss project structure</option><option value="preview">Preview running application</option><option value="roadmap">Course roadmap & assessment</option><option value="results">View saved results</option><option value="publish">Publish to GitHub…</option><option value="pullRequest">Create pull request…</option></select>
<details id="handoff" hidden><summary>Teacher review or export</summary><p id="handoffStatus" role="status"></p><p class="muted">Share a copy of public source, tests and explanation with your assistance report. Local check results are learner-reported evidence.</p><div class="row"><button id="finish">Prepare final handoff</button><button id="refreshHandoff" class="secondary">Refresh submission status</button></div></details>
</details>
<div id="conversation" class="log" role="log" aria-live="polite"></div><p id="status" role="status"></p>
</div>
${instructorComposer(webview, media, nonce, {assistant:'Project Mentor', maxlength:600, sendId:'ask', support:`<p id="selectionContext" class="muted" hidden></p><div class="project-chat-tools"><details id="sharingDetails"><summary id="sharedSummary" class="muted shared-summary">Files shared with the mentor</summary><p id="reviewSharing" class="muted" hidden>Your mentor reviews saved project work, check results and public Git activity while this panel is open. AI assistance controls this in Settings.</p><p id="courseAccess" class="muted"></p><pre id="shared"></pre></details><button id="newChat" type="button" class="link">New chat</button></div>`})}
</main><script nonce="${nonce}" src="${asset('coachMarkdown.js')}"></script><script nonce="${nonce}" src="${asset('learning-room/composer.js')}"></script><script nonce="${nonce}" src="${asset('projectCoach.js')}"></script></body></html>`;
    const playback = new CoachAudio(this.context.secrets, this.service).bind(webview,
      () => this.surface.visible && this.canUseInstructor() ? this.spoken : undefined);
    const dictation = bindDictation(webview, () => {
      if (!this.surface.visible || this.busy || !this.canUseInstructor()) return;
      const service = this.service();
      return {key: this.conversationId, api: new Api(this.auth, () => service, this.owner), language:this.selectedVoiceLanguage ?? 'auto'};
    });
    return vscode.Disposable.from(playback, dictation, webview.onDidReceiveMessage(message => {
      if (message?.type === 'audioJoin' || message?.type === 'audioStart' || message?.type === 'voiceInputGrant' || message?.type === 'cancelDictation') return;
      const scope = this.key(), conversation = this.conversationId;
      void this.handle(message).catch(error => {
        if (scope !== this.key() || conversation !== this.conversationId) return;
        if (message.type === 'checkpoint') {
          if (message.step === this.step) void webview.postMessage({type: 'checkpointError', scope, step: this.step, conversationId: conversation,
            text: 'Checkpoint could not be saved. ' + (error instanceof Error ? error.message : 'Try saving again.')});
          return;
        }
        this.status = error instanceof Error ? error.message : 'Project action failed. Retry explicitly.'; void this.refresh();
      });
    }));
  };

  async openProjectTerminal() {
    if (this.inProject && !this.personal) await this.handle({type:'runtime', value:'terminal', scope:this.key(),
      step:this.step, conversationId:this.conversationId});
  }

  private async handle(message: any): Promise<void> {
    if (message?.type === 'ready') return this.refresh();
    // The panel disables its controls on click; an ignored message must repaint them.
    if (!this.root || message?.scope !== this.key() || message?.step !== this.step || message?.conversationId !== this.conversationId
      || this.loadedKey !== this.key()) return this.refresh();
    const curriculum = await this.curriculum, step = curriculum.steps[this.step];
    if (message.scope !== this.key() || message.step !== this.step || message.conversationId !== this.conversationId) return this.refresh();
    if (message.type === 'voiceLanguage') {
      if (this.busy || typeof message.value !== 'string' || message.value !== 'auto' && !Object.hasOwn(coachingLanguages, message.value)) return this.refresh();
      this.selectedVoiceLanguage = message.value === 'auto' ? undefined : message.value;
      this.conversationLanguage = this.selectedVoiceLanguage;
      this.cancelReview();
      if (this.spoken) this.spoken = {...this.spoken, id:randomUUID(),
        query:this.voiceQuery(curriculum, this.voiceLanguage(), this.coachWorkspace()?.course)};
      return this.refresh();
    }
    if (message.type === 'reportGitHelp' && curriculum.gitPractice && this.owner !== 'local') {
      await this.architectureEvent(curriculum,{event:'external_help'}); return this.refresh();
    }
    if (message.type === 'architectureFollowup') {
      const target = this.followup?.project;
      if (target && Object.hasOwn(transferTitles, target)) await vscode.commands.executeCommand('dhimantai.startCapstone', target);
      return;
    }
    if (this.personal && ['check','checkpoint','submitProject','runtime','projectAction'].includes(message.type)) return this.refresh();
    if (curriculum.id === 'market-checkout' && ['architectureNext', 'syncPractice'].includes(message.type)) {
      if (this.busy) return;
      const scope = this.key(), revision = this.revision;
      const snapshot = await this.snapshot();
      if (this.busy || scope !== this.key() || revision !== this.revision || !this.checkoutProgress(curriculum, snapshot)?.complete) return this.refresh();
      if (message.type === 'architectureNext') {
        await vscode.commands.executeCommand('dhimantai.startCapstone', 'field-dispatch'); return;
      }
      const saved = this.results?.get(this.environment(), this.owner, this.root)?.submissions.at(-1);
      if (this.owner === 'local' || !saved || saved.id !== message.id) return this.refresh();
      this.busy = true; this.status = ''; void this.refresh();
      try {
        if (saved.assistance.otherHelp === 'reported') await this.architectureEvent(curriculum, {event:'external_help'});
        if (scope === this.key() && revision === this.revision)
          await this.architectureEvent(curriculum, {event:'passed', digest:snapshot.digest});
      } finally { if (scope === this.key() && revision === this.revision) { this.busy = false; void this.refresh(); } }
      return;
    }
    if (curriculum.architecture && message.type === 'diagnosis') {
      if (this.busy || typeof message.location !== 'string' || !Number.isInteger(message.prediction)) return this.refresh();
      const revision = this.revision, root = this.root;
      this.busy = true; this.cancelReview(); void this.refresh();
      try {
        const path = curriculum.architecture.focusFile;
        const file = await publicProjectFile(root, path);
        const source = this.dirty().get(path) ?? await readFile(file, 'utf8');
        if (revision !== this.revision) return;
        const digest = createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
        if (message.help === 'reported') await this.architectureEvent(curriculum, {event:'external_help'});
        if (revision !== this.revision) return;
        const result = await this.architectureEvent(curriculum, {event:'diagnosis', location:message.location, prediction:message.prediction, digest});
        if (revision === this.revision && result) this.status = result.event === 'located' ? 'Location and prediction match. Try your repair.' :
          result.event === 'after_edit' ? 'The starter has changed. You can still verify your repair.' : 'The location or count differs from the starter. Trace another call and try again.';
      } finally { if (revision === this.revision) { this.busy = false; void this.refresh(); } }
      return;
    }
    if ((curriculum.architecture || curriculum.gitPractice) && message.type === 'check') {
      message = {...message, type:'submitProject', note:'', help:message.help ?? 'unknown'};
    }
    if (message.type === 'contextPreview') {
      if (typeof message.text !== 'string' || message.text.length > 600) return;
      const snapshot = await this.snapshot(message.text).catch(() => undefined);
      if (snapshot && message.scope === this.key())
        void this.surface.webviewFor(this.render)?.postMessage({type: 'contextPreview', scope: message.scope, text: message.text, ...this.sharing(snapshot)});
      return;
    }
    if (message.type === 'step' && Number.isInteger(message.index) && curriculum.steps[message.index]) {
      this.selectStep(curriculum, message.index);
      await this.persist(); return this.refresh();
    }
    if (message.type === 'newChat') {
      this.clearChat();
      this.invalidate('New conversation started.'); await this.persist(); return this.refresh();
    }
    if (message.type === 'file' || message.type === 'checkLocation' || message.type === 'reference') {
      const root = this.root, run = this.run;
      let diagnosticLine: number | undefined;
      const current = () => !this.disposed && message.scope === this.key() && message.conversationId === this.conversationId;
      if (message.type === 'checkLocation') {
        if (!run || run.step !== step.id || run.status !== 'failed' || !run.diagnostic?.file
            || run.diagnostic.file !== message.path || run.diagnostic.line !== message.line) return;
        const snapshot = await this.snapshot();
        if (run.digest !== checkDigest(snapshot, step) || !(await projectFiles(root, curriculum)).includes(message.path)) return this.refresh();
        diagnosticLine = run.diagnostic.line ?? 1;
      } else if (message.type === 'reference') {
        const reply = this.messages[message.index];
        if (reply?.role !== 'tutor' || !reply.digest || !reply.references?.some(ref => ref.path === message.path && ref.line === message.line)) return;
        const snapshot = await this.snapshot();
        const paths = this.personal ? snapshot.structure.files : await projectFiles(root, curriculum);
        if (reply.digest !== snapshot.digest || !paths.includes(message.path)) return this.refresh();
        diagnosticLine = message.line;
      } else if (!milestoneLinks(curriculum, step).includes(message.path)) return;
      const file = await publicProjectFile(root, message.path);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (!current() || (message.type !== 'file' && message.revision !== this.revision) || (message.type === 'checkLocation' && run !== this.run)) return;
      const section = step.guide && message.path === 'READING_NOTES.md'
        ? (step.guide.sections.includes(message.section) ? message.section : step.guide.sections[0]) : undefined;
      const anchor = section ? '## ' + section : step.anchors?.[message.path];
      const line = diagnosticLine !== undefined ? Math.min(diagnosticLine, doc.lineCount) - 1
        : anchor ? Math.max(0, doc.getText().split('\n').findIndex(text => text.includes(anchor))) : 0;
      const selection = new vscode.Range(line, 0, line, 0);
      const editor = await vscode.window.showTextDocument(doc, {preview: true, preserveFocus: false, selection});
      editor.revealRange(selection, vscode.TextEditorRevealType.AtTop); return;
    }
    if (message.type === 'hint') {
      if (this.busy) return;
      this.cancelReview();
      const lastTopic = [...this.messages].reverse().find(item => item.role === 'tutor')?.topic;
      if (watchesArchitecture(curriculum.id) && (this.personal || lastTopic) && this.canUseInstructor()) {
        if (lastTopic?.skill.startsWith('git-')) {
          const kind = lastTopic.skill.slice(4) as GitSkill;
          await this.ask('Help me with this Git decision.',curriculum,step,[],undefined,undefined,kind,lastTopic);
          return;
        }
        const incident = lastTopic?.skill === 'shared-state' || lastTopic?.skill === 'test-oracle';
        const level:ArchitectureHelp = incident
          ? (lastTopic.help === 'reproduce' ? 'isolate' : lastTopic.help === 'isolate' ? 'regression' : 'reproduce')
          : lastTopic?.help === 'trace' ? 'design' : lastTopic?.help === 'design' ? 'verification' : 'trace';
        const prompts = {reproduce:'Help me reproduce this behavior.', isolate:'Help me isolate the cause.',
          regression:'Help me reason through a regression test.', trace:'Help me trace the behavior in my current source.', design:'Help me reason about the design of this change.',
          verification:'Help me decide how to verify my repair.'};
        await this.ask(prompts[level], curriculum, step, [], undefined, undefined, level, lastTopic);
        return;
      }
      if (curriculum.gitPractice) {
        const revision = this.revision, controller = this.request = new AbortController();
        this.busy = true;
        try {
          const verified = await this.rememberGitProgress(curriculum,controller.signal);
          if (controller.signal.aborted || revision !== this.revision) return;
          const state = await this.snapshot('Git status');
          if (controller.signal.aborted || revision !== this.revision) return;
          const conflicted = state.git?.changed_files.some(change => ['DD','AU','UD','UA','DU','AA','UU'].includes(change.status));
          const kind:GitSkill = conflicted ? 'conflict' : !state.git?.branch || ['main','HEAD'].includes(state.git.branch) ? 'branch'
            : verified?.skills.includes('commits') ? 'conflict' : 'commits';
          const clues = {branch:'Which branch currently owns your work? Compare its starting point with main.',
            commits:'Compare the staged diff with each request in the brief. Which pieces should a reviewer be able to revert together?',
            conflict:'Compare the common ancestor and both parents. Which part of each version still belongs in the final settings?'};
          if (this.owner !== 'local') await this.architectureEvent(curriculum,{event:'git_hint',skills:[kind]});
          if (controller.signal.aborted || revision !== this.revision) return;
          this.messages.push({role:'tutor',text:clues[kind]}); this.assistance++; await this.persist();
        } finally { if (revision === this.revision) { this.busy=false; this.request=undefined; void this.refresh(); } }
        return;
      }
      if (curriculum.architecture) {
        const help = this.architectureAttempts[curriculum.id]?.help ?? [];
        if (practiceHintLevel(help) < 2) {
          const revision = this.revision, level = practiceHintLevel(help) === 1 ? 2 : 1;
          this.busy = true;
          try {
            const receipt = await this.architectureEvent(curriculum, {event:'hint', hint_level:level});
            if (!receipt || revision !== this.revision) return;
            this.messages.push({role:'tutor', text:level === 1 ? step.hint : curriculum.architecture.boundaryHint});
            this.assistance++; await this.persist();
          } finally { if (revision === this.revision) { this.busy = false; void this.refresh(); } }
          return;
        }
        if (vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true))
          return this.handle({...message, type:'ask', text:'Help me decide what to inspect next, using what I have already tried.'});
        this.status = curriculum.architecture.boundaryHint; return this.refresh();
      }
      const smaller = smallerProjectStep(step);
      if (this.messages.some(m => m.role === 'tutor' && m.text === smaller)) {
        if (vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true) && this.owner !== 'local')
          return this.handle({...message, type: 'ask', text: 'I am still stuck after both help steps. If the current files and check result do not show what went wrong, first ask what I tried, what I expected and what happened. If they show a concept I am missing, explain it using this project and suggest one action I can try.'});
        this.status = 'Use the smaller step above, then record your prediction and observation in a checkpoint. ' +
          (this.owner === 'local' ? 'Sign in to ask the mentor a follow-up.' : 'Turn on AI assistance to ask the mentor a follow-up.');
        return this.refresh();
      }
      const text = this.messages.some(m => m.role === 'tutor' && m.text === step.hint) ? smaller : step.hint;
      this.messages.push({role: 'tutor', text}); this.messages = this.messages.slice(-40);
      this.assistance++; await this.persist(); return this.refresh();
    }
    if (message.type === 'runtime' && (message.value === 'debug' || message.value === 'run')) {
      const runOnly = message.value === 'run';
      if (this.busy || curriculum.gitPractice) return this.refresh();
      if (!vscode.workspace.isTrusted || this.dirty().size) throw new Error('Trust the workspace and save your project files before starting this step.');
      const revision = this.revision, scope = this.key(), root = this.root;
      const current = () => !this.disposed && revision === this.revision && this.key() === scope;
      this.busy = true;
      try {
        const target = projectDebugTarget(step,await projectFiles(root,curriculum));
        if (!current() || !target) return;
        const engine = await this.courses.forProject(root,curriculum,'python');
        if (!current()) return;
        if (!engine) throw new Error('Set up the project container before starting this step.');
        if (!this.debugger) {
          const {ProjectDebugger} = await import('./projectDebugger');
          if (!current()) return;
          this.debugger = new ProjectDebugger((folder,path,line,atPause) => {
            if (folder === this.root && atPause()) this.queueReview({event:'debug_pause',path,line,current:atPause});
          });
          this.subscriptions.push(this.debugger);
        }
        await this.debugger.start(root,engine,target,current,runOnly);
        if (current()) this.status = runOnly ? 'See the program output in the Debug Console.' : 'Use a gutter breakpoint to pause. Inspect Variables, predict one change, then Step Over. Rerun the check after your edit.';
      } finally { if (current()) {this.busy = false; void this.refresh();} }
      return;
    }
    if (message.type === 'runtime') {
      this.invalidate(''); this.run = undefined;
      if (message.value === 'setup' && !curriculum.gitPractice) {
        await this.courses.forProject(this.root,curriculum);
        this.status = curriculum.title + ' environment verified. The project tools are ready.';
      }
      if (message.value === 'terminal') {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to open its runtime terminal.');
        const engine = await this.courses.forProject(this.root,curriculum);
        if (!engine) throw new Error('Open Project tools → Runtime → Set up and verify environment, then retry.');
        const options = courseTerminalOptions(engine,curriculum.title,this.root);
        const terminalKey = this.root + '|' + engine.name;
        options.env = {...options.env, DHIMANTAI_PROJECT_TERMINAL: terminalKey};
        const terminal = vscode.window.terminals.find(t => !t.exitStatus && 'env' in t.creationOptions && t.creationOptions.env?.DHIMANTAI_PROJECT_TERMINAL === terminalKey)
          ?? vscode.window.createTerminal(options);
        terminal.show();
      }
      return this.refresh();
    }
    if (message.type === 'checkpoint') {
      if (curriculum.id === 'market-checkout' && message.completed) return this.refresh();
      if (typeof message.note !== 'string' || message.note.length > 1000 || !['reported','none_reported','unknown'].includes(message.help)) return;
      if (message.completed && !message.note.trim()) throw new Error('Add your evidence or explanation before marking this milestone complete.');
      if (this.busy) return;
      const revision = this.revision, root = this.root;
      const verification = message.completed ? step.checkpointCheck : undefined;
      const controller = new AbortController();
      this.busy = true;
      if (verification) { this.snapshotCheck = this.request = controller; this.status = 'Verifying milestone evidence…'; void this.refresh(); }
      try {
        const snapshot = await this.snapshot();
        let verified: ProjectCheckpoint['verified'];
        if (verification) {
          if (!vscode.workspace.isTrusted || this.dirty().size) throw new Error('Trust the workspace and save your files before verifying this milestone.');
          const engine = await this.courses.forProject(root, curriculum);
          if (!engine) throw new Error('Set up the project container to verify milestone evidence.');
          const fingerprint = evidenceFingerprint(snapshot);
          const run = await runProjectCheck(root, {...step, check:verification}, fingerprint, controller.signal, engine, undefined, snapshot.gitRevision);
          if (controller.signal.aborted) throw new Error('Verification was interrupted. Review the saved files and try again.');
          if (run.status !== 'passed') throw new Error(run.output.trim() || 'Milestone verification could not finish.');
          const summary = checkpointProof(step, run.output, message.note);
          if (fingerprint !== evidenceFingerprint(await this.snapshot()) || this.dirty().size)
            throw new Error('The project changed during verification. Save your work and retry.');
          verified = {summary, fingerprint};
        }
        if (message.scope !== this.key() || message.step !== this.step || message.conversationId !== this.conversationId) return this.refresh();
        if (revision !== this.revision) throw new Error('The project changed during the save. Review your evidence and try again.');
        const checkpoint: ProjectCheckpoint = {step: step.id, note: message.note, digest: snapshot.digest, ...checkpointEvidence(step, snapshot), at: new Date().toISOString(), assistance: this.assistance,
          externalHelp: message.help, completed: message.completed === true, verified};
        const checkpoints = this.progress.checkpoints, previous = checkpoints[step.id];
        this.checkpoint = checkpoints[step.id] = checkpoint;
        try { await this.persist(); }
        catch (error) {
          if (checkpoints[step.id] === checkpoint) {
            if (previous) checkpoints[step.id] = previous;
            else delete checkpoints[step.id];
          }
          if (this.checkpoint === checkpoint) this.checkpoint = previous;
          throw error;
        }
        if (this.checkpoint !== checkpoint || revision !== this.revision || this.disposed) return;
        this.status = '';
        if (verified && !previous?.verified) {
          const next = curriculum.steps.findIndex((item, i) => i > this.step && item.checkpointCheck && !checkpoints[item.id]?.verified);
          const remaining = next >= 0 ? next : curriculum.steps.findIndex(item => item.checkpointCheck && !checkpoints[item.id]?.verified);
          if (remaining >= 0) {
            this.selectStep(curriculum, remaining);
            await this.persist();
          }
        }
      } finally {
        if (this.snapshotCheck === controller) this.snapshotCheck = undefined;
        if (revision === this.revision) { this.busy = false; this.request = undefined; this.status = ''; }
        void this.refresh();
      }
      return;
    }
    if (this.busy) return;
    this.cancelReview();
    if(message.type==='projectAction'&&message.action==='preview')return vscode.commands.executeCommand('dhimantai.projectPreview');
    if(message.type==='projectAction'&&message.action==='roadmap')return vscode.commands.executeCommand('dhimantai.courseGrade',curriculum.courseId ?? PROJECT_COURSES[curriculum.id]);
    if(message.type==='submitProject'&&curriculum.mode==='guided')return vscode.commands.executeCommand('dhimantai.courseGrade',curriculum.courseId);
    if (message.type === 'projectAction' && ['results', 'publish', 'pullRequest'].includes(message.action)) {
      if (message.action === 'results') {
        const record = this.results?.get(this.environment(), this.owner, this.root);
        const document = await vscode.workspace.openTextDocument({language: 'json', content: JSON.stringify(record ?? {submissions: []}, null, 2)});
        await vscode.window.showTextDocument(document, {preview: true});
      } else {
        const scope = this.key(), revision = this.revision;
        this.busy = true; void this.refresh();
        try { await projectGitHub(this.root, message.action, () => scope === this.key() && revision === this.revision && !this.disposed); }
        finally { if (scope === this.key() && revision === this.revision) { this.busy = false; await this.refresh(); } }
      }
      return;
    }
    if (message.type === 'syncProject' && this.step === curriculum.steps.length - 1 && this.owner !== 'local' && this.recordCoursework) {
      const environment = this.environment(), owner = this.owner, scope = this.key();
      const last = this.results?.get(environment, owner, this.root)?.submissions.at(-1);
      if (!last || last.id !== message.id || last.outcome !== 'completed' || !['shelf','course-agent'].includes(curriculum.id)) return this.refresh();
      this.busy = true; this.status = 'Syncing the saved project result…'; void this.refresh();
      try {
        await this.recordCoursework(environment, owner, curriculum, last);
        if (scope === this.key()) this.status = 'Coursework result recorded.';
      } finally { if (scope === this.key()) { this.busy = false; void this.refresh(); } }
      return;
    }
    if (message.type === 'openProjectGrade') {
      const course = PROJECT_COURSES[curriculum.id];
      if (course && this.owner !== 'local') await vscode.commands.executeCommand('dhimantai.courseGrade',course);
      return;
    }
    if (message.type === 'submitProject' && this.step === curriculum.steps.length - 1) {
      if (!this.results) throw new Error('Project result storage is unavailable. Reopen the project.');
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running the final checker.');
      if (!['reported', 'none_reported', 'unknown'].includes(message.help) || typeof message.note !== 'string' || message.note.length > 1000) return this.refresh();
      if (this.dirty().size) throw new Error('Save your project files before submitting.');
      const revision = this.revision, scope = this.key(), root = this.root, owner = this.owner, environment = this.environment();
      const controller = this.request = new AbortController(); this.busy = true;
      if (curriculum.gitPractice || curriculum.id === 'shelf') this.snapshotCheck = controller;
      this.status = 'Running final project checks…'; void this.refresh();
      try {
        const engine = curriculum.gitPractice ? undefined : await this.courses.forProject(root,curriculum);
        if (revision !== this.revision) return;
        const submission = await submitProject(root, curriculum, {coachTurns: this.assistance, otherHelp: projectOtherHelp(this.progress, message.help)},
          message.note, controller.signal, engine);
        if (revision !== this.revision || scope !== this.key() || this.dirty().size) return;
        await this.results.save(environment, owner, root, curriculum, submission);
        if (revision !== this.revision) {
          // The local submission was committed. Finish its account-scoped delivery even if the view moved.
          if (owner !== 'local' && ['shelf','course-agent'].includes(curriculum.id))
            await this.recordCoursework?.(environment, owner, curriculum, submission).catch(() => {});
          return;
        }
        this.run = submission.runs.at(-1);
        this.status = submission.outcome === 'completed' ? 'Final checks passed. Project result saved on this computer.'
          : 'Final check did not pass. Result saved; inspect the output, fix the project and submit again.';
        if (curriculum.architecture || curriculum.gitPractice) {
          this.status = submission.outcome === 'completed' ? 'Repair passed the local behavior checks.' : 'Repair check failed. Inspect the output and try again.';
          const debug = isDebugProject(curriculum.id);
          const evidence = this.run?.gitEvidence;
          const event = curriculum.gitPractice ? undefined : debug ? this.run?.practiceEvent : submission.outcome === 'completed' ? 'passed' : undefined;
          if (debug || curriculum.gitPractice) this.status = this.run?.output || 'The project check could not finish.';
          if ((event || evidence) && owner !== 'local') {
            try {
              if (submission.assistance.otherHelp === 'reported') await this.architectureEvent(curriculum, {event:'external_help'});
              if (revision === this.revision) {
                if (evidence) await this.architectureEvent(curriculum,{event:'git_check',digest:submission.digest,...evidence});
                else if (event) await this.architectureEvent(curriculum, {event, digest:submission.digest});
                if (revision === this.revision) await this.loadFollowup();
              }
            } catch { if (revision === this.revision) this.status += curriculum.id === 'market-checkout' && submission.outcome === 'completed'
              ? ' Select Sync practice to record the saved result.' : ' Practice memory could not sync. Run the check again to record it.'; }
          }
        } else if (owner !== 'local' && curriculum.mode !== 'reading' && this.recordCoursework) {
          try {
            await this.recordCoursework(environment, owner, curriculum, submission);
            if (revision === this.revision) this.status += ' Course grade updated.';
          } catch (error) {
            if (revision === this.revision) this.status += ' Course result pending sync. ' + (error instanceof Error ? error.message : 'Retry when connected.');
          }
        }
      } finally {
        if (this.snapshotCheck === controller) this.snapshotCheck = undefined;
        if (revision === this.revision) { this.busy = false; this.request = undefined; await this.refresh(); }
      }
      if (curriculum.id === 'market-checkout' && revision === this.revision) this.queueReview({event:'check'});
      return;
    }
    if (curriculum.id === 'course-agent' && (message.type === 'refreshHandoff' || message.type === 'finish' && step.id === 'handoff')) {
      const scope = this.key(); this.busy = true; void this.refresh();
      try { await (message.type === 'finish' ? this.finishProject(message.help, message.note) : this.refreshHandoff()); }
      finally { if (scope === this.key()) { this.busy = false; void this.refresh(); } }
      return;
    }
    if (message.type === 'runLive' && curriculum.id === 'course-agent' && step.id === 'live') return this.liveProject();
    if (message.type === 'check') {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running its Python checks.');
      // Claim busy before any await, so a double click cannot start a second check.
      const revision = this.revision;
      const controller = this.request = new AbortController(); this.busy = true; this.status = curriculum.mode === 'reading' ? 'Running the reading example or focused tests…' : 'Running public checks…'; void this.refresh();
      try {
        const paths = await projectFiles(this.root, curriculum);
        if (revision !== this.revision) return;
        if ([...this.dirty().keys()].some(path => paths.includes(path))) throw new Error('Save your project files before checking this step.');
        const snapshot = await this.snapshot();
        if (revision !== this.revision) return;
        const engine = await this.courses.forProject(this.root,curriculum);
        if (!engine) throw new Error('Open Project tools → Runtime → Set up and verify environment, then retry.');
        const run = await runProjectCheck(this.root, step, checkDigest(snapshot, step), controller.signal, engine, undefined, snapshot.gitRevision);
        if (this.revision === revision) { this.run = run; this.status = run.status === 'passed'
          ? (curriculum.mode === 'reading' || curriculum.mode === 'guided' || step.check.startsWith('shelf:') && step.check !== 'shelf:capstone' ? 'Command finished successfully. Compare its output with your prediction; this is not an assessment.' : 'Container checks passed for this snapshot.')
          : 'Container check: ' + run.status.replace('_', ' ') + '. Open the check output to inspect it.'; }
      } finally { if (this.revision === revision) { this.busy = false; this.request = undefined; void this.refresh(); } }
      if (this.revision === revision && this.run?.step === step.id) this.queueReview({event:'check', path:this.run.diagnostic?.file, line:this.run.diagnostic?.line});
      return;
    }
    if (message.type !== 'ask' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 600) return this.refresh();
    if (!vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true)) throw new Error('AI assistance is off. The milestone guide and checks remain available.');
    if (!this.selectedVoiceLanguage && typeof message.spokenLanguage === 'string' && Object.hasOwn(coachingLanguages, message.spokenLanguage))
      this.conversationLanguage = message.spokenLanguage;
    const askingRevision = this.revision;
    this.busy = true;
    try { await this.ask(message.text, curriculum, step, practiceAttachments(message.attachments)); }
    finally { if (askingRevision === this.revision) { this.busy = false; void this.refresh(); } }
  }

  private async rememberGitProgress(curriculum:ProjectCurriculum, signal:AbortSignal) {
    if (!this.root || !curriculum.gitPractice || !vscode.workspace.isTrusted || this.dirty().size) return;
    const scope = this.key(), revision = this.revision;
    const submission = await submitProject(this.root,curriculum,{coachTurns:this.assistance,
      otherHelp:projectOtherHelp(this.progress,'unknown')},'',signal,undefined);
    const evidence = submission.runs[0]?.gitEvidence;
    if (!evidence || signal.aborted || revision !== this.revision || scope !== this.key() || this.dirty().size) return;
    const prior = this.architectureAttempts[curriculum.id];
    if (this.owner !== 'local' && (evidence.skills.some(skill => !prior?.git_evidence?.[skill]) || evidence.complete && !prior?.complete_digest)) {
      if (submission.assistance.otherHelp === 'reported') await this.architectureEvent(curriculum,{event:'external_help'});
      if (signal.aborted || revision !== this.revision || scope !== this.key()) return;
      await this.architectureEvent(curriculum,{event:'git_check',digest:submission.digest,...evidence});
      if (evidence.complete && !signal.aborted && scope === this.key()) await this.loadFollowup();
    }
    return evidence;
  }

  private async loadFollowup() {
    const scope = this.key(), sequence = ++this.followupSequence;
    try {
      const course = this.coachWorkspace()?.course, api = await this.projectApi();
      const followup = await api.architecturePractice(course);
      if (scope !== this.key() || sequence !== this.followupSequence || this.disposed) return;
      this.followup = followup;
      clearTimeout(this.followupTimer);
      if (followup.due_at) {
        const delay = Math.max(1000, Date.parse(followup.due_at) - Date.now() + 1000);
        this.followupTimer = setTimeout(() => {
          if (scope === this.key() && !this.disposed) void this.loadFollowup().then(() => this.refresh());
        }, Math.min(delay, 2147483647));
      }
    } catch { /* Offline workspace review remains usable. Reopening retries the account lookup. */ }
  }

  private async architectureEvent(curriculum: ProjectCurriculum, event: ArchitectureEvent) {
    const scope = this.key(), sequence = ++this.memorySequence;
    const course = this.coachWorkspace()?.course;
    const api = await this.projectApi();
    if (scope !== this.key() || this.loadedKey !== scope) return;
    const result = await api.architectureMemory(curriculum.id, event, course);
    if (scope !== this.key() || this.loadedKey !== scope || this.disposed) return;
    if (sequence === this.memorySequence) {
      this.architectureAttempts = result.attempts;
      this.architectureProblem = '';
    }
    return result;
  }

  private async projectApi() {
    const owner = this.owner, scope = this.key();
    const session = await this.auth.session();
    if (!session || session.user.id !== owner || scope !== this.key()) throw new Error('Sign in to dhimantAI and reopen Project Mentor.');
    return new Api(this.auth, this.service, owner);
  }

  private coachWorkspace() {
    const workspace = this.courses.recordFor(vscode.Uri.file(this.root!));
    if (workspace && (workspace.account !== this.owner || workspace.environment !== this.environment()))
      throw new Error('Sign in with the learning account and service used for this project workspace.');
    return workspace;
  }

  private canUseInstructor() {
    if (!this.root || this.owner === 'local' || this.key() !== this.loadedKey ||
        !vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true)) return false;
    const workspace = this.courses.recordFor(vscode.Uri.file(this.root));
    return !workspace || (workspace.account === this.owner && workspace.environment === this.environment());
  }

  private voiceLanguage() {
    return this.conversationLanguage ?? coachingLanguage(this.context.globalState.get(`dhimantai.coachingLanguage.${this.environment()}.${this.owner}`));
  }

  private voiceQuery(curriculum: ProjectCurriculum, language: string, course?: string) {
    const query = new URLSearchParams({project_id: curriculum.id, language});
    if (curriculum.courseId) query.set('course_id', curriculum.courseId);
    if (course && curriculum.mode !== 'guided') query.set('course', course);
    return '?' + query;
  }

  private async refreshHandoff() {
    const scope = this.key();
    const api = await this.projectApi(), availability = await api.projectHandoffAvailability();
    if (scope !== this.key()) return;
    this.handoff = availability;
    this.handoffStatus = availability.mode === 'handoff' ? 'Independent learner · prepare a local handoff to share. This is not an institute submission.'
      : availability.teachers.length ? 'Ready to submit to: ' + availability.teachers.map(t => t.name).join(', ') + '.'
      : 'No assigned Python teacher is available. Contact your institute; you can prepare a local handoff meanwhile.';
    const latest = availability.history[0];
    if (latest) {
      let detail = await api.projectHandoffDetail(latest.thread_id);
      if (scope !== this.key()) return;
      // Teacher replies append to a versioned conversation; show its latest page.
      if (detail.has_more) detail = await api.projectHandoffDetail(latest.thread_id, Math.floor((detail.thread.version - 1) / 50));
      if (scope !== this.key()) return;
      this.receipt = {thread: detail.thread, source_hash: latest.source_hash};
      this.handoffStatus = 'Submission ' + detail.thread.id + ' · ' + ({open: 'Awaiting teacher review', answered: 'Teacher replied', resolved: 'Review resolved'}[detail.thread.status] ?? detail.thread.status)
        + ' · ' + new Date(detail.thread.created_at).toLocaleString() + '. This refers to the submitted snapshot, not later edits.';
      const replies = detail.messages.filter(m => m.author_role === 'teacher');
      if (replies.length) this.handoffStatus += '\n' + replies.map(m => m.author_name + ': ' + m.body).join('\n');
    }
    await this.refresh();
  }

  private async finishProject(help: unknown, note: unknown) {
    if (!['reported', 'none_reported', 'unknown'].includes(String(help)) || typeof note !== 'string' || note.length > 1000) return;
    const scope = this.key(), root = this.root!, curriculum = await this.curriculum;
    const paths = await projectFiles(root, curriculum);
    if (paths.some(path => this.dirty().has(path))) throw new Error('Save your project files before preparing the final handoff.');
    const prepared = await prepareProjectHandoff(root, curriculum,
      {coach_turns: this.assistance, other_help: projectOtherHelp(this.progress, help as ProjectCheckpoint['externalHelp'])}, note, this.run);
    try { await this.refreshHandoff(); }
    catch (error) {
      if (scope !== this.key()) return;
      const save = await vscode.window.showWarningMessage('Teacher submission is unavailable. ' + (error instanceof Error ? error.message : ''), 'Save local handoff');
      if (!save) return;
      this.handoff = undefined;
    }
    if (scope !== this.key()) return;
    const submit = this.handoff?.mode === 'teacher' && this.handoff.teachers.length > 0;
    if (!submit) {
      const destination = await vscode.window.showSaveDialog({defaultUri: vscode.Uri.file(join(root, 'course-agent-handoff.json')),
        filters: {'Project handoff': ['json']}, saveLabel: 'Save handoff'});
      if (!destination || scope !== this.key()) return;
      await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(prepared, null, 2) + '\n'));
      this.handoffStatus = 'Local handoff saved: ' + destination.fsPath + '. Share this file through your chosen review channel. Not submitted to a teacher.';
      await this.refresh(); return;
    }
    const approved = await vscode.window.showInformationMessage('Submit this project snapshot to your assigned Python teacher?',
      {modal: true, detail: 'These ' + prepared.files.length + ' files will be stored for teacher review with your assistance report, local check output and checkpoint note.\n'
        + prepared.files.map(f => f.path).join('\n') + '\nNo chat, .env files or Git history are included.'}, 'Submit project');
    if (!approved || scope !== this.key()) return;
    const current = await prepareProjectHandoff(root, curriculum, prepared.assistance, prepared.checkpoint, this.run);
    if (paths.some(path => this.dirty().has(path)) || JSON.stringify(current) !== JSON.stringify(prepared))
      throw new Error('Project files changed while preparing the handoff. Review and submit the current version.');
    const fingerprint = createHash('sha256').update(JSON.stringify(prepared)).digest('hex');
    if (this.handoffRequest?.fingerprint !== fingerprint) this.handoffRequest = {id: randomUUID(), fingerprint};
    await this.persist();
    const requestId = this.handoffRequest.id;
    this.busy = true; this.handoffStatus = 'Submitting project…'; await this.refresh();
    try {
      const receipt = await (await this.projectApi()).sendProjectHandoff(requestId, prepared);
      if (scope !== this.key()) return;
      this.receipt = receipt;
      this.handoffStatus = 'Submitted for teacher review · ' + receipt.thread.id + ' · ' + new Date(receipt.thread.created_at).toLocaleString()
        + '. Your teacher can review it in My courses → Python → Project reviews. Refresh here for feedback.';
    } catch (error) {
      if (scope === this.key()) this.handoffStatus = 'Submission not confirmed. Refresh status or retry the same handoff. ' + (error instanceof Error ? error.message : 'Service unavailable.');
    } finally { if (scope === this.key()) { this.busy = false; await this.refresh(); } }
  }

  private async liveProject() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running the project.');
    if (!vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true)) throw new Error('AI assistance is off. Enable it to use a managed live model.');
    const revision = this.revision, root = this.root!, curriculum = await this.curriculum;
    // Busy covers the question prompt too, so a live run cannot overlap a check or start twice.
    this.busy = true; void this.refresh();
    try {
      const question = await vscode.window.showInputBox({title: 'Run Course Research Agent with a live model',
        prompt: 'Project observations are sent to the platform model. No personal API key is required.',
        value: 'How do I submit my project?', validateInput: value => value.trim() && value.length <= 600 ? undefined : 'Enter a question under 600 characters.'});
      if (!question || revision !== this.revision) return;
      if (this.dirty().size) throw new Error('Save project files before running the live model.');
      const api = await this.projectApi(), engine = await this.courses.forProject(root,curriculum);
      if (revision !== this.revision) return;
      if (!engine) throw new Error('Set up the project container before running the project.');
      const runner = await readFile(join(this.context.extensionUri.fsPath, 'media/projects/managed_live.py'), 'utf8');
      if (revision !== this.revision) return;
      const controller = this.request = new AbortController(), runId = randomUUID();
      this.liveOutput = 'Running your project against the managed live model…'; await this.refresh();
      const result = await runManagedProject(root, runner, question, controller.signal, engine,
        (messages, signal) => api.projectModel(runId, messages, signal));
      if (revision === this.revision) this.liveOutput = result.output + '\n' + (result.passed ? 'Run completed. Inspect the citations and trace; this is not an assessment.' : 'Run did not complete successfully. Inspect the output and retry explicitly.');
    } catch (error) { throw projectAccessError(error) ?? error; }
    finally { if (revision === this.revision) { this.busy = false; this.request = undefined; await this.refresh(); } }
  }

  private async ask(text: string, curriculum: ProjectCurriculum, step: ProjectCurriculum['steps'][number],
      attachments:PracticeAttachment[], observation?: Observation, reviewController?: AbortController, requestedHelp?: ArchitectureHelp, topic?: ArchitectureTopic) {
    if (this.personal && !vscode.workspace.isTrusted) return;
    if (observation && waitsForIndependentAttempt(curriculum.id, this.architectureAttempts[curriculum.id])) return;
    const revision = this.revision, environment = this.environment(), backend = this.service();
    const account = (await this.auth.session())?.user.id;
    if (revision !== this.revision) return;
    if (!account || account !== this.owner) throw new Error('Sign in to dhimantAI, then send your question again.');
    const workspace = this.coachWorkspace();
    const language = this.voiceLanguage();
    const voiceQuery = this.voiceQuery(curriculum, language, workspace?.course);
    const courseQuery = workspace && curriculum.mode !== 'guided' ? '?course=' + encodeURIComponent(workspace.course) : '';
    const snapshot = await this.snapshot(text, observation);
    const gitOnly = !snapshot.files.length && snapshot.git?.state === 'available' &&
      (!observation || observation.event === 'git');
    const selected = (observation?.path ? snapshot.files.find(file => file.path === observation.path) : snapshot.files[0]) ?? (gitOnly ? {path:'', text:'', start_line:1} : undefined);
    if (revision !== this.revision || reviewController?.signal.aborted) return;
    if (!selected && observation) return;
    if (!selected) throw new Error('Open an available project source file before asking the mentor.');
    const check = checkState(this.run, checkDigest(snapshot, step), step.id);
    const publicGit = JSON.stringify(snapshot.git ?? null);
    const evidence = createHash('sha256').update(JSON.stringify([snapshot.digest, publicGit, check, observation?.event === 'debug_pause' ? [observation.path,observation.line] : null])).digest('hex');
    if (observation) {
      if (!this.reviewingAllowed() || observation.current?.() === false || evidence === this.lastEvidence) return;
      if (observation.event === 'opened' && curriculum.mode === 'reading' && !snapshot.git?.changed_files.length ||
          observation.event === 'git' && publicGit === this.lastPublicGit) {
        this.lastPublicGit = publicGit; return;
      }
    }
    if (observation) this.lastReviewAt = Date.now();
    const controller = reviewController ?? (this.request = new AbortController());
    const history = this.messages.slice(-8).map(m => ({role: m.role,
      text: ((m.digest && m.digest !== snapshot.digest ? '[Earlier project version] ' : '') + m.text).slice(0,1500)}));
    const selection = snapshot.selection;
    const selectedLines = selection ? `Selected lines: ${selection.path}:${selection.start}–${selection.end}` : '';
    const observedLine = observation?.path === selected.path && observation.line && observation.line <= 100000 && observation.line >= selected.start_line
      && observation.line < selected.start_line + selected.text.split('\n').length ? observation.line : undefined;
    if (observation?.event === 'debug_pause' && !observedLine) return;
    if (!observation) {
      this.spoken = undefined;
      void this.surface.webviewFor(this.render)?.postMessage({type:'questionAccepted', scope:this.key(), step:this.step,
        conversationId:this.conversationId, text});
      this.messages.push({role:'learner', text:[text,attachmentNote(attachments),selectedLines].filter(Boolean).join('\n'), digest:snapshot.digest});
      this.busy = true; this.status = 'Reading your shared project files…'; void this.refresh();
    }
    try {
      if (!observation && curriculum.gitPractice) {
        await this.rememberGitProgress(curriculum,controller.signal);
        if (controller.signal.aborted || revision !== this.revision) return;
      }
      const api = new Api(this.auth, () => backend, account);
      const checkout = this.checkoutProgress(curriculum, snapshot);
      const task = checkout ? [step.task, checkout.status, checkout.guide, checkout.sync,
        'The checkpoint reflection and Git commit are optional. This practice has no certificate credit.'].filter(Boolean).join('\n')
        : [step.task, step.evidencePrompt && 'Checkpoint evidence: ' + step.evidencePrompt].filter(Boolean).join('\n');
      const reply = await api.notebookCoach('/notebook-coach/project' + courseQuery, {stage: 'guide', language: gitOnly ? 'git' : this.personal ? (vscode.workspace.textDocuments.find(doc =>
        this.path(doc.uri) === selected.path)?.languageId ?? selected.path.split('.').at(-1) ?? 'text') : curriculum.language ?? 'python',
        ...(this.conversationLanguage ? {coaching_language:language} : {}),
        question: [`${curriculum.title}: ${step.goal}\n${task}`, selectedLines].filter(Boolean).join('\n'), source: selected.text, message: text, history, ...(attachments.length ? {attachments} : {}),
        project_context: {project_id: curriculum.id,
          ...(watchesArchitecture(curriculum.id) ? {workspace_key:createHash('sha256').update(this.key()).digest('hex')} : {}),
          ...(requestedHelp ? {architecture_help:requestedHelp} : {}),
          ...(topic?.file && topic.line !== undefined ? {practice_location:{skill:topic.skill, file:topic.file, line:topic.line}} : {}), ...(curriculum.courseId?{course_id:curriculum.courseId}:{}), milestone: step.title, goal: step.goal, task,
          ...(observation ? {observation:observation.event, observation_line:observedLine} : {}),
          ...(Object.keys(this.progress.checkpoints).length ? {milestone_history:milestoneHistory(curriculum, this.progress, snapshot)} : {}),
          selected_file: selected.path, files: snapshot.files, omitted: snapshot.omitted,
          omitted_count: snapshot.omitted_count, structure: snapshot.structure,
          ...(snapshot.git ? {git: snapshot.git} : {}),
          check: 'output' in check ? {...check, output:redactSecrets(check.output ?? '')} : check,
          checkpoint: redactSecrets(this.checkpoint?.note ?? ''),
          checkpoint_step: this.checkpoint?.step ?? '', checkpoint_state: !this.checkpoint ? 'none'
            : this.checkpoint.step !== step.id ? 'other_milestone' : checkpointCurrent(this.checkpoint, snapshot) ? 'current' : 'changed'}}, controller.signal);
      const currentAccount = (await this.auth.session())?.user.id;
      if (controller.signal.aborted || revision !== this.revision) return;
      const currentSnapshot = await this.snapshot('', observation);
      // New chat, account changes and edits can happen during either await above.
      if (revision !== this.revision || environment !== this.environment() || currentAccount !== account || controller.signal.aborted) return;
      if (observation && (!this.reviewingAllowed() || observation.current?.() === false)) return;
      if (observation && JSON.stringify(currentSnapshot.git ?? null) !== publicGit) {
        this.queueReview({event:'git'}); return;
      }
      if (currentSnapshot.digest !== snapshot.digest) { if (!observation) this.status = 'Your project files changed. Ask again with the current code.'; return; }
      this.lastPublicGit = publicGit; this.lastEvidence = evidence;
      const answer = [reply.guidance, reply.prompt].filter(Boolean).join('\n\n');
      if (!answer.trim() || observation && this.messages.at(-1)?.text === answer) return;
      this.messages.push({role: 'tutor', text: answer, digest: snapshot.digest, ...(reply.architecture_topic ? {topic:reply.architecture_topic} : {}), ...(observation ? {observation:observation.event} : {}), references:projectReferences(answer, reply.line, snapshot.files)});
      this.spoken = {id: randomUUID(), text: answer, account, environment, path: '/notebook-coach/project', query: voiceQuery};
      this.messages = this.messages.slice(-40); this.assistance++;
      if (!observation) this.status = '';
      await this.persist();
      if (curriculum.architecture || curriculum.gitPractice) {
        try { await this.architectureEvent(curriculum, {event:'started'}); }
        catch { if (revision === this.revision) this.architectureProblem = 'Practice memory could not refresh.'; }
      }
      if (reply.architecture_topic && reply.architecture_topic.help !== 'noticed') await this.loadFollowup();
      if (observation) void this.refresh();
    } catch (error) {
      // A cancelled/obsolete request must not repaint the new conversation with its error.
      if (revision === this.revision && !controller.signal.aborted) throw observation ? error : projectAccessError(error, workspace?.course) ?? error;
    } finally { if (!observation && revision === this.revision) { this.busy = false; this.request = undefined; void this.refresh(); } }
  }
  dispose() { clearTimeout(this.followupTimer); this.disposed = true; this.cancelReview(); this.request?.abort(); this.watcher?.dispose(); this.surface.release(this.render); this.subscriptions.forEach(s => s.dispose()); }
}
