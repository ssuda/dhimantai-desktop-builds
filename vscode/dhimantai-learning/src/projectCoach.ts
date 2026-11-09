import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Api, HandoffAvailability, HandoffReceipt } from './api';
import { Auth } from './auth';
import { CoachSurface, CoachRenderer } from './coachSurface';
import { CourseWorkspaces } from './courseWorkspace';
import { courseTerminalOptions } from './courseTerminal';
import { Environment, EnvironmentName } from './environments';
import { checkState, isProject, projectIdentity, loadProjectCurriculum, trackedProjectFiles, ProjectCheckpoint, ProjectCurriculum, ProjectRun,
  prepareProjectHandoff, projectFiles, projectSnapshot, publicProjectFile, runProjectCheck } from './projectCore';
import { runManagedProject } from './projectLive';
import { ProjectResults, projectResultStatus, submitProject } from './projectResults';
import { projectGitHub } from './projectGitHub';
import { ProjectProgress, projectMilestones, projectOtherHelp, restoreProjectProgress, smallerProjectStep } from './projectProgress';

/** The existing Coach surface, scoped to one multi-file project and account at a time. */
export class ProjectCoach implements vscode.Disposable {
  private readonly surface: CoachSurface;
  private readonly subscriptions: vscode.Disposable[] = [];
  private curriculum: Promise<ProjectCurriculum>;
  private root?: string;
  private step = 0;
  private revision = 0;
  private request?: AbortController;
  private busy = false;
  private status = '';
  private run?: ProjectRun;
  private checkpoint?: ProjectCheckpoint;
  private progress: ProjectProgress = {visited: [], checkpoints: {}};
  private assistance = 0;
  private owner = '';
  private messages: {role: 'learner' | 'tutor'; text: string; digest?: string}[] = [];
  private conversationId = randomBytes(16).toString('hex');
  private handoff?: HandoffAvailability;
  private receipt?: HandoffReceipt;
  private handoffRequest?: {id: string; fingerprint: string};
  private handoffStatus = 'Not submitted. Institute learners submit to their assigned teacher; independent learners prepare a local handoff.';
  private liveOutput = '';
  private refreshSequence = 0;
  private disposed = false;
  private watcher?: vscode.FileSystemWatcher;
  private opening = false;
  private openSequence = 0;
  private contextQuestion = '';

  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: Auth,
    private readonly environment: () => EnvironmentName, private readonly service: () => Environment,
    private readonly courses: CourseWorkspaces, private readonly results?: ProjectResults) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.curriculum = loadProjectCurriculum(media.fsPath, 'course-agent');
    this.surface = new CoachSurface(media, async () => {});
    this.subscriptions.push(vscode.commands.registerCommand('dhimantai.openProjectCoach', (root?: string) => this.open(root)),
      auth.onDidChange(session => {
        if ((session?.user.id ?? 'local') === this.owner) return;
        this.invalidate('Account changed. Reopen Coach to continue.'); this.messages = []; this.run = undefined; this.checkpoint = undefined; void this.resetOwner();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dhimantai.environment') || e.affectsConfiguration('dhimantai.aiAssistance')) {
          this.invalidate('Coach settings changed.'); this.messages = []; this.run = undefined; void this.resetOwner();
        }
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length && this.root && this.path(e.document.uri)) this.invalidate('Files changed. Check again before discussing a result.');
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (this.root && this.path(document.uri)) this.invalidate('Files saved. Check again to use this version.');
      }),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (this.path(e.textEditor.document.uri)) void this.refresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor || !this.root) return;
        if (this.path(editor.document.uri)) { this.surface.select(this.render); void this.surface.show(true); void this.refresh(); }
        else void this.hide();
      }));
  }

  private path(uri: vscode.Uri) {
    if (!this.root || uri.scheme !== 'file') return;
    const path = relative(this.root, uri.fsPath).replace(/\\/g, '/');
    return path && !path.startsWith('..') && !path.startsWith('/') ? path : undefined;
  }
  private key() { return `projectCoach:${this.environment()}:${this.owner}:${this.root}`; }
  private async resetOwner() {
    this.contextQuestion = '';
    this.checkpoint = undefined; this.progress = {visited: [], checkpoints: {}}; this.assistance = 0;
    this.handoff = undefined; this.receipt = undefined; this.handoffRequest = undefined; this.liveOutput = '';
    this.handoffStatus = 'Not submitted. Refresh submission status to check your account and earlier submissions.';
    const revision = this.revision;
    const owner = (await this.auth.session().catch(() => undefined))?.user.id ?? 'local';
    if (revision !== this.revision || this.disposed) return;
    const curriculum = await this.curriculum;
    if (revision !== this.revision || this.disposed) return;
    this.owner = owner;
    const saved = this.context.workspaceState.get<{checkpoint?: ProjectCheckpoint; assistance?: number; step?: number;
      progress?: ProjectProgress; handoffRequest?: {id: string; fingerprint: string}}>(this.key());
    this.progress = restoreProjectProgress(curriculum, saved); this.assistance = saved?.assistance ?? 0;
    this.handoffRequest = saved?.handoffRequest;
    this.step = Math.max(0, Math.min(saved?.step ?? 0, curriculum.steps.length - 1));
    const step = curriculum.steps[this.step];
    this.checkpoint = this.progress.checkpoints[step.id];
    if (!this.progress.visited.includes(step.id)) this.progress.visited.push(step.id);
    await this.persist();
    if (this.root) await this.results?.save(this.environment(), this.owner, this.root, curriculum);
    void this.refresh();
  }
  private persist() {
    return this.context.workspaceState.update(this.key(), {checkpoint: this.checkpoint, progress: this.progress, assistance: this.assistance, step: this.step,
      handoffRequest: this.handoffRequest});
  }
  private invalidate(message: string) {
    if (this.request && this.liveOutput === 'Running your project against the managed live model…') this.liveOutput = 'Managed live run cancelled. Retry explicitly when ready.';
    this.revision++; this.request?.abort(); this.request = undefined; this.busy = false; this.status = message;
    void this.refresh();
  }
  async hide() { this.invalidate(''); await this.surface.hide(); }

  async restore() {
    const roots = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
    for (const folder of roots) if (await isProject(folder.uri.fsPath)) { await this.open(folder.uri.fsPath); break; }
  }
  async open(root?: string) {
    const opening = ++this.openSequence;
    try {
      if (!root) {
        const folders = [];
        for (const folder of vscode.workspace.workspaceFolders ?? [])
          if (folder.uri.scheme === 'file' && await isProject(folder.uri.fsPath)) folders.push(folder);
        root = folders.length === 1 ? folders[0].uri.fsPath : (await vscode.window.showQuickPick(
          folders.map(f => ({label: f.name, root: f.uri.fsPath})), {placeHolder: 'Choose a course project'}))?.root;
      }
      if (!root) { void vscode.window.showInformationMessage('Open a course project folder, or choose Start a Course Project.'); return; }
      const id = await projectIdentity(root);
      if (!id) throw new Error('This folder is not a supported course project.');
      const curriculum = await loadProjectCurriculum(join(this.context.extensionUri.fsPath, 'media'), id);
      if (opening !== this.openSequence || this.disposed) return;
      this.opening = true;
      this.invalidate(''); this.root = root; this.messages = []; this.run = undefined;
      this.curriculum = Promise.resolve(curriculum);
      this.watcher?.dispose();
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
      const changed = async (uri: vscode.Uri) => {
        const path = this.path(uri);
        if (path && curriculum.id === 'shelf' && /^\.git\/(HEAD|index|packed-refs|refs\/heads\/.+)$/.test(path)) {
          // Git may refresh its index during a check. Recompute evidence without cancelling that check.
          void this.refresh(); return;
        }
        if (path && (trackedProjectFiles(await this.curriculum).includes(path) || /^(course_agent|shelf|rich|reading|examples|tests|checks)\/.*\.py$/.test(path)
          || /^(data|scenarios)\/[A-Za-z0-9_-]+\.json$/.test(path))) this.invalidate('Project files changed. Check again to use this version.');
      };
      this.watcher.onDidChange(changed); this.watcher.onDidCreate(changed); this.watcher.onDidDelete(changed);
      await this.resetOwner();
      if (opening !== this.openSequence || this.disposed) return;
      await vscode.commands.executeCommand('setContext', 'dhimantai.projectOpen', true);
      if (!this.path(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse('untitled:')))
        await vscode.window.showTextDocument(vscode.Uri.file(join(root, curriculum.mode === 'reading' ? 'READING.md' : 'README.md')), {preview: true});
      if (opening !== this.openSequence || this.disposed) return;
      this.opening = false;
      this.surface.select(this.render);
      await this.surface.show(true);
      await this.refresh();
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not open Project Coach.'); }
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
  private async snapshot(question = this.contextQuestion) {
    const curriculum = await this.curriculum, step = curriculum.steps[this.step];
    const selected = vscode.window.activeTextEditor && this.path(vscode.window.activeTextEditor.document.uri);
    const locations: Record<string, number | string> = {...step.anchors};
    if (selected) locations[selected] = vscode.window.activeTextEditor!.selection.active.line + 1;
    return projectSnapshot(this.root!, curriculum, [...(selected ? [selected] : []), ...step.files], this.dirty(false), locations, question);
  }
  private async refresh() {
    if (!this.root || this.disposed || this.opening) return;
    const sequence = ++this.refreshSequence;
    try {
      const curriculum = await this.curriculum, snapshot = await this.snapshot();
      if (sequence !== this.refreshSequence || this.disposed) return;
      const step = curriculum.steps[this.step];
      void this.surface.webviewFor(this.render)?.postMessage({type: 'state', revision: this.revision, conversationId: this.conversationId, title: curriculum.title,
        scope: this.key(), reading: curriculum.mode === 'reading',
        steps: curriculum.steps.map(s => s.title), step: this.step, current: step, busy: this.busy, status: this.status,
        milestones: projectMilestones(curriculum, this.progress, snapshot.digest),
        hintLevel: this.messages.some(m => m.role === 'tutor' && m.text === smallerProjectStep(step)) ? 2
          : this.messages.some(m => m.role === 'tutor' && m.text === step.hint) ? 1 : 0,
        signedIn: this.owner !== 'local',
        messages: this.messages, checkpoint: this.checkpoint, runtime: 'course',
        finalStep: curriculum.id === 'course-agent' && step.id === 'handoff', liveStep: curriculum.id === 'course-agent' && step.id === 'live',
        handoffMode: this.handoff?.mode, handoffStatus: this.handoffStatus, liveOutput: this.liveOutput,
        submissionStep: this.step === curriculum.steps.length - 1,
        completion: this.results?.get(this.environment(), this.owner, this.root)
          ? projectResultStatus(this.results.get(this.environment(), this.owner, this.root)!, snapshot.digest) : 'In progress',
        courseAvailable: !!this.courses.recordFor(vscode.Uri.file(this.root)),
        check: checkState(this.run, snapshot.digest, step.id),
        sharedFiles: snapshot.files.map(f => f.path + ':' + f.start_line + '–' + (f.start_line + f.text.split('\n').length - 1) + (f.truncated ? ' (excerpt)' : '')),
        omitted: snapshot.omitted, omittedCount: snapshot.omitted_count, structure: snapshot.structure, git: snapshot.git,
        ai: vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true)});
    } catch (error) {
      if (sequence === this.refreshSequence) void this.surface.webviewFor(this.render)?.postMessage({type: 'error', text: String(error)});
    }
  }

  private readonly render: CoachRenderer = webview => {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media'), nonce = randomBytes(16).toString('hex');
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
    webview.options = {enableScripts: true, localResourceRoots: [media]};
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${asset('coach.css')}"><link rel="stylesheet" href="${asset('coachMarkdown.css')}"><link rel="stylesheet" href="${asset('projectCoach.css')}"></head>
<body><main id="coach" aria-label="Project Coach"><h2 id="title">Course project</h2>
<div class="runtime-row"><label for="runtime">Runtime</label><select id="runtime"><option value="course">Course container</option><option value="setup">Set up course…</option><option value="terminal">Open course terminal</option></select></div>
<div class="milestone-nav"><label for="step">Project milestone</label><button id="previous" class="secondary" aria-label="Previous milestone">Previous</button><button id="next" class="secondary" aria-label="Next milestone">Next</button></div><select id="step"></select>
<p id="progressText" role="status"></p><progress id="progress" value="0" max="1" aria-label="Milestones marked complete"></progress><div id="projectContent"><p id="milestoneStatus" class="muted"></p><p id="goal"></p>
<section id="submission" hidden><button id="submitProject">Submit Project</button><p class="muted">Runs the final checks in your course container and saves a local result. This does not award a grade or establish mastery.</p></section>
<p id="completion" role="status"></p><label for="projectActions">Project actions</label><select id="projectActions"><option value="">Choose an action…</option><option value="results">View saved results</option><option value="publish">Publish to GitHub…</option><option value="pullRequest">Create pull request…</option></select>
<details id="handoff" hidden><summary>Teacher review or export</summary><p id="handoffStatus" role="status"></p><p class="muted">Share a copy of public source, tests and explanation with your assistance report. Local check results are learner-reported evidence.</p><div class="row"><button id="finish">Prepare final handoff</button><button id="refreshHandoff" class="secondary">Refresh submission status</button></div></details>
<p id="task"></p>
<section aria-labelledby="expectedTitle"><h3 id="expectedTitle">Expected outcome</h3><p id="expected"></p></section>
<details><summary>Why this step</summary><p id="opening"></p></details>
<section aria-labelledby="filesTitle"><h3 id="filesTitle">Relevant files</h3><div id="files" class="row"></div></section><div class="row"><button id="check">Check this step</button><button id="hint" class="secondary">I’m stuck</button></div>
<details><summary id="checkSummary">Current check</summary><p id="checkState"></p><p id="checkRecovery"></p><pre id="output"></pre></details>
<section id="liveRun" hidden><button id="runLive">Run live model</button><p class="muted">Uses platform access in the course container. No personal API key. Up to six model calls per run and 36 per day. These calls are separate from scripted checks.</p><pre id="liveOutput"></pre></section>

<details><summary>Files shared when you ask Coach</summary><p>Coach selects public source, tests and data for each question, with README, a project map, the current milestone and check. This list updates when you send a question. Shelf Capstone also shares the Git summary below. Context is temporary.</p><pre id="shared"></pre></details>
<div id="conversation" class="log" role="log" aria-live="polite"></div><p id="emptyChat" class="muted">Ask Coach about this milestone to start a conversation.</p><p id="status" role="status"></p>
<details><summary>Explain your approach (optional)</summary><p id="reflection"></p><p>Share your explanation in the conversation when you are ready.</p></details>
<details id="checkpointDetails"><summary>Save milestone progress</summary><label for="note">Your decision, evidence and next step</label><textarea id="note" rows="3" maxlength="1000"></textarea>
<label for="externalHelp">Other assistance</label><select id="externalHelp"><option value="unknown">Not reported</option><option value="reported">I used other help</option><option value="none_reported">No other help reported</option></select>
<label class="completion-choice"><input id="completed" type="checkbox"> Mark this milestone complete (self-reported)</label>
<button id="checkpoint">Save checkpoint</button><p id="saved" class="muted"></p><p class="muted">Local progress and assistance only. This does not submit work, award a grade or establish mastery.</p></details></div>
<form id="composer"><label for="message">Ask, predict or explain</label><textarea id="message" rows="2" maxlength="600" placeholder="Ask about your project…"></textarea><div class="row"><button id="ask" type="submit">Send</button><button id="newChat" type="button" class="secondary">New chat</button></div></form>
</main><script nonce="${nonce}" src="${asset('coachMarkdown.js')}"></script><script nonce="${nonce}" src="${asset('projectCoach.js')}"></script></body></html>`;
    return vscode.Disposable.from(webview.onDidReceiveMessage(message => {
      const scope = this.key(), conversation = this.conversationId;
      void this.handle(message).catch(error => {
        if (scope !== this.key() || conversation !== this.conversationId) return;
        this.status = error instanceof Error ? error.message : 'Project action failed. Retry explicitly.'; void this.refresh();
      });
    }));
  };

  private async handle(message: any): Promise<void> {
    if (message?.type === 'ready') return this.refresh();
    if (!this.root || message?.scope !== this.key() || message?.step !== this.step || message?.conversationId !== this.conversationId) return;
    const curriculum = await this.curriculum, step = curriculum.steps[this.step];
    if (message.scope !== this.key() || message.step !== this.step || message.conversationId !== this.conversationId) return;
    if (message.type === 'step' && Number.isInteger(message.index) && curriculum.steps[message.index]) {
      this.contextQuestion = '';
      this.invalidate(''); this.step = message.index; this.messages = [];
      const next = curriculum.steps[this.step];
      this.checkpoint = this.progress.checkpoints[next.id];
      if (!this.progress.visited.includes(next.id)) this.progress.visited.push(next.id);
      await this.persist(); return this.refresh();
    }
    if (message.type === 'newChat') {
      this.contextQuestion = '';
      this.messages = []; this.conversationId = randomBytes(16).toString('hex');
      this.invalidate('New conversation started.'); return this.refresh();
    }
    if (message.type === 'file' && step.files.includes(message.path)) {
      const file = await publicProjectFile(this.root, message.path);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const anchor = step.anchors?.[message.path];
      const line = anchor ? Math.max(0, doc.getText().split('\n').findIndex(text => text.includes(anchor))) : 0;
      const selection = new vscode.Range(line, 0, line, 0);
      const editor = await vscode.window.showTextDocument(doc, {preview: true, preserveFocus: false, selection});
      editor.revealRange(selection, vscode.TextEditorRevealType.AtTop); return;
    }
    if (message.type === 'hint') {
      if (this.busy) return;
      const smaller = smallerProjectStep(step);
      if (this.messages.some(m => m.role === 'tutor' && m.text === smaller)) {
        if (vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true) && this.owner !== 'local')
          return this.handle({...message, type: 'ask', text: 'I am still stuck after both help steps. Use the current files and check result to help me take one smaller action. Ask what I tried before giving a solution.'});
        this.status = 'Use the smaller step above, then record your prediction and observation in a checkpoint. ' +
          (this.owner === 'local' ? 'Sign in to ask Coach a follow-up.' : 'Turn on AI assistance to ask Coach a follow-up.');
        return this.refresh();
      }
      const text = this.messages.some(m => m.role === 'tutor' && m.text === step.hint) ? smaller : step.hint;
      this.messages.push({role: 'tutor', text}); this.messages = this.messages.slice(-40);
      this.assistance++; await this.persist(); return this.refresh();
    }
    if (message.type === 'runtime') {
      this.invalidate(''); this.run = undefined;
      if (message.value === 'setup') {
        const folder = await vscode.commands.executeCommand<vscode.Uri>('dhimantai.setupCourse', vscode.Uri.file(this.root));
        if (folder) this.status = 'Course folder: ' + folder.fsPath + '. Projects inside that folder can use this runtime.';
      }
      if (message.value === 'terminal') {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to open its runtime terminal.');
        const engine = await this.courses.forFile(vscode.Uri.file(this.root), 'python');
        if (!engine) throw new Error('Set up a course runtime and open a project inside its course folder. Project execution requires the container.');
        const options: vscode.TerminalOptions = courseTerminalOptions(engine, 'Course project', this.root);
        const terminalKey = this.root + '|course';
        options.env = {...options.env, DHIMANTAI_PROJECT_TERMINAL: terminalKey};
        const terminal = vscode.window.terminals.find(t => !t.exitStatus && 'env' in t.creationOptions && t.creationOptions.env?.DHIMANTAI_PROJECT_TERMINAL === terminalKey)
          ?? vscode.window.createTerminal(options);
        terminal.show();
      }
      return this.refresh();
    }
    if (message.type === 'checkpoint') {
      if (typeof message.note !== 'string' || message.note.length > 1000 || !['reported','none_reported','unknown'].includes(message.help)) return;
      if (message.completed && !message.note.trim()) throw new Error('Add your evidence or explanation before marking this milestone complete.');
      const revision = this.revision;
      const snapshot = await this.snapshot();
      if (message.scope !== this.key() || message.step !== this.step || revision !== this.revision) return;
      this.checkpoint = {step: step.id, note: message.note, digest: snapshot.digest, at: new Date().toISOString(), assistance: this.assistance,
        externalHelp: message.help, completed: message.completed === true};
      this.progress.checkpoints[step.id] = this.checkpoint;
      await this.persist(); this.status = this.checkpoint.completed ? 'Milestone marked complete on this computer (self-reported).' : 'Checkpoint saved on this computer.'; return this.refresh();
    }
    if (this.busy) return;
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
    if (message.type === 'submitProject' && this.step === curriculum.steps.length - 1) {
      if (!this.results) throw new Error('Project result storage is unavailable. Reopen the project.');
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running the final checker.');
      if (!['reported', 'none_reported', 'unknown'].includes(message.help)) return;
      if (this.dirty().size) throw new Error('Save your project files before submitting.');
      const revision = this.revision, scope = this.key(), root = this.root, owner = this.owner, environment = this.environment();
      const controller = this.request = new AbortController(); this.busy = true;
      this.status = 'Running final project checks…'; void this.refresh();
      try {
        const engine = await this.courses.forFile(vscode.Uri.file(root), 'python');
        if (revision !== this.revision) return;
        if (!engine) throw new Error('Set up the course container before submitting this project.');
        const submission = await submitProject(root, curriculum, {coachTurns: this.assistance, otherHelp: projectOtherHelp(this.progress, message.help)},
          this.checkpoint?.note ?? '', controller.signal, engine);
        if (revision !== this.revision || scope !== this.key() || this.dirty().size) return;
        await this.results.save(environment, owner, root, curriculum, submission);
        if (revision !== this.revision) return;
        this.run = submission.runs.at(-1);
        this.status = submission.outcome === 'completed' ? 'Project completed locally. Result saved; teacher review and live-model verification are separate.'
          : 'Final check did not pass. Result saved; inspect the output, fix the project and submit again.';
      } finally { if (revision === this.revision) { this.busy = false; this.request = undefined; await this.refresh(); } }
      return;
    }
    if (curriculum.id === 'course-agent' && (message.type === 'refreshHandoff' || message.type === 'finish' && step.id === 'handoff')) {
      const scope = this.key(); this.busy = true; void this.refresh();
      try { await (message.type === 'finish' ? this.finishProject(message.help) : this.refreshHandoff()); }
      finally { if (scope === this.key()) { this.busy = false; void this.refresh(); } }
      return;
    }
    if (message.type === 'runLive' && curriculum.id === 'course-agent' && step.id === 'live') return this.liveProject();
    if (message.type === 'check') {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running its Python checks.');
      const paths = await projectFiles(this.root, curriculum);
      if ([...this.dirty().keys()].some(path => paths.includes(path))) throw new Error('Save your project files before checking this step.');
      const revision = this.revision;
      const controller = this.request = new AbortController(); this.busy = true; this.status = curriculum.mode === 'reading' ? 'Running the reading example or focused tests…' : 'Running public checks…'; void this.refresh();
      try {
        const snapshot = await this.snapshot();
        if (revision !== this.revision) return;
        const engine = await this.courses.forFile(vscode.Uri.file(this.root), 'python');
        if (!engine) throw new Error('Set up a course runtime and open a project inside its course folder. Project execution requires the container.');
        const run = await runProjectCheck(this.root, step, snapshot.digest, controller.signal, engine);
        if (this.revision === revision) { this.run = run; this.status = run.status === 'passed'
          ? (curriculum.mode === 'reading' || step.check.startsWith('shelf:') && step.check !== 'shelf:capstone' ? 'Command finished successfully. Compare its output with your prediction; this is not an assessment.' : 'Container checks passed for this snapshot.')
          : 'Container check: ' + run.status.replace('_', ' ') + '. Open the check output to inspect it.'; }
      } finally { if (this.revision === revision) { this.busy = false; this.request = undefined; void this.refresh(); } }
      return;
    }
    if (message.type !== 'ask' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 600) return;
    if (!vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true)) throw new Error('AI assistance is off. The milestone guide and checks remain available.');
    const askingRevision = this.revision;
    this.busy = true;
    try { await this.ask(message.text, curriculum, step); }
    finally { if (askingRevision === this.revision) { this.busy = false; void this.refresh(); } }
  }

  private async projectApi() {
    const owner = this.owner, scope = this.key();
    const session = await this.auth.session();
    if (!session || session.user.id !== owner || scope !== this.key()) throw new Error('Sign in to dhimantAI and reopen Project Coach.');
    return new Api(this.auth, this.service, owner);
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

  private async finishProject(help: unknown) {
    if (!['reported', 'none_reported', 'unknown'].includes(String(help))) return;
    const scope = this.key(), root = this.root!, curriculum = await this.curriculum;
    const paths = await projectFiles(root, curriculum);
    if (paths.some(path => this.dirty().has(path))) throw new Error('Save your project files before preparing the final handoff.');
    const prepared = await prepareProjectHandoff(root, curriculum,
      {coach_turns: this.assistance, other_help: projectOtherHelp(this.progress, help as ProjectCheckpoint['externalHelp'])}, this.checkpoint?.note ?? '', this.run);
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
    const revision = this.revision, root = this.root!;
    const question = await vscode.window.showInputBox({title: 'Run Course Research Agent with a live model',
      prompt: 'Project observations are sent to the platform model. No personal API key is required.',
      value: 'How do I submit my project?', validateInput: value => value.trim() && value.length <= 600 ? undefined : 'Enter a question under 600 characters.'});
    if (!question || revision !== this.revision) return;
    if (this.dirty().size) throw new Error('Save project files before running the live model.');
    const api = await this.projectApi(), engine = await this.courses.forFile(vscode.Uri.file(root), 'python');
    if (revision !== this.revision) return;
    if (!engine) throw new Error('Set up the course container before running the project.');
    const runner = await readFile(join(this.context.extensionUri.fsPath, 'media/projects/managed_live.py'), 'utf8');
    if (revision !== this.revision) return;
    const controller = this.request = new AbortController(), runId = randomUUID();
    this.busy = true; this.liveOutput = 'Running your project against the managed live model…'; await this.refresh();
    try {
      const result = await runManagedProject(root, runner, question, controller.signal, engine,
        (messages, signal) => api.projectModel(runId, messages, signal));
      if (revision === this.revision) this.liveOutput = result.output + '\n' + (result.passed ? 'Run completed. Inspect the citations and trace; this is not an assessment.' : 'Run did not complete successfully. Inspect the output and retry explicitly.');
    } finally { if (revision === this.revision) { this.busy = false; this.request = undefined; await this.refresh(); } }
  }

  private async ask(text: string, curriculum: ProjectCurriculum, step: ProjectCurriculum['steps'][number]) {
    const revision = this.revision, environment = this.environment(), backend = this.service();
    const account = (await this.auth.session())?.user.id;
    if (revision !== this.revision) return;
    if (!account || account !== this.owner) throw new Error('Sign in to dhimantAI, then send your question again.');
    const snapshot = await this.snapshot(text), selected = snapshot.files[0];
    if (revision !== this.revision) return;
    if (!selected) throw new Error('Open an available project source file before asking Coach.');
    this.contextQuestion = text;
    const controller = this.request = new AbortController();
    const history = this.messages.slice(-8).map(m => ({role: m.role,
      text: ((m.digest && m.digest !== snapshot.digest ? '[Earlier project version] ' : '') + m.text).slice(0,1500)}));
    this.messages.push({role: 'learner', text, digest: snapshot.digest}); this.busy = true; this.status = 'Coach is reading the shared project context…'; void this.refresh();
    try {
      const api = new Api(this.auth, () => backend, account);
      const reply = await api.notebookCoach('/notebook-coach/project', {stage: 'guide', language: 'python',
        question: `${curriculum.title}: ${step.goal}\n${step.task}`, source: selected.text, message: text, history,
        project_context: {project_id: curriculum.id, milestone: step.title, goal: step.goal, task: step.task,
          selected_file: selected.path, files: snapshot.files, omitted: snapshot.omitted,
          omitted_count: snapshot.omitted_count, structure: snapshot.structure,
          ...(snapshot.git ? {git: snapshot.git} : {}),
          check: checkState(this.run, snapshot.digest, step.id), checkpoint: this.checkpoint?.note ?? '',
          checkpoint_step: this.checkpoint?.step ?? '', checkpoint_state: !this.checkpoint ? 'none'
            : this.checkpoint.step !== step.id ? 'other_milestone' : this.checkpoint.digest === snapshot.digest ? 'current' : 'changed'}}, controller.signal);
      const currentAccount = (await this.auth.session())?.user.id;
      const currentSnapshot = await this.snapshot();
      // New chat, account changes and edits can happen during either await above.
      if (revision !== this.revision || environment !== this.environment() || currentAccount !== account || controller.signal.aborted) return;
      if (currentSnapshot.digest !== snapshot.digest) { this.status = 'Files changed before Coach finished. Ask again with the current code.'; return; }
      this.messages.push({role: 'tutor', text: [reply.guidance, reply.prompt].filter(Boolean).join('\n\n'), digest: snapshot.digest});
      this.messages = this.messages.slice(-40); this.assistance++; this.status = ''; await this.persist();
    } catch (error) {
      // A cancelled/obsolete request must not repaint the new conversation with its error.
      if (revision === this.revision && !controller.signal.aborted) throw error;
    } finally { if (revision === this.revision) { this.busy = false; this.request = undefined; void this.refresh(); } }
  }
  dispose() { this.disposed = true; this.request?.abort(); this.watcher?.dispose(); this.surface.dispose(); this.subscriptions.forEach(s => s.dispose()); }
}
