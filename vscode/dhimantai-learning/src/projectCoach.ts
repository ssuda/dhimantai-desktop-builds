import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';
import { Api } from './api';
import { Auth } from './auth';
import { CoachSurface, CoachRenderer } from './coachSurface';
import { CourseWorkspaces } from './courseWorkspace';
import { courseTerminalOptions } from './courseTerminal';
import { Environment, EnvironmentName } from './environments';
import { checkState, isProject, projectIdentity, loadProjectCurriculum, trackedProjectFiles, ProjectCheckpoint, ProjectCurriculum, ProjectRun,
  projectSnapshot, publicProjectFile, runProjectCheck } from './projectCore';

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
  private assistance = 0;
  private owner = '';
  private messages: {role: 'learner' | 'tutor'; text: string; digest?: string}[] = [];
  private refreshSequence = 0;
  private disposed = false;
  private watcher?: vscode.FileSystemWatcher;

  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: Auth,
    private readonly environment: () => EnvironmentName, private readonly service: () => Environment,
    private readonly courses: CourseWorkspaces) {
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
    this.checkpoint = undefined; this.assistance = 0;
    const revision = this.revision;
    const owner = (await this.auth.session().catch(() => undefined))?.user.id ?? 'local';
    if (revision !== this.revision || this.disposed) return;
    this.owner = owner;
    const saved = this.context.workspaceState.get<{checkpoint?: ProjectCheckpoint; assistance?: number; step?: number}>(this.key());
    this.checkpoint = saved?.checkpoint; this.assistance = saved?.assistance ?? 0;
    const curriculum = await this.curriculum;
    this.step = Math.max(0, Math.min(saved?.step ?? 0, curriculum.steps.length - 1));
    void this.refresh();
  }
  private persist() {
    return this.context.workspaceState.update(this.key(), {checkpoint: this.checkpoint, assistance: this.assistance, step: this.step});
  }
  private invalidate(message: string) {
    this.revision++; this.request?.abort(); this.request = undefined; this.busy = false; this.status = message;
    void this.refresh();
  }
  async hide() { this.invalidate(''); await this.surface.hide(); }

  async restore() {
    const roots = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
    for (const folder of roots) if (await isProject(folder.uri.fsPath)) { await this.open(folder.uri.fsPath); break; }
  }
  async open(root?: string) {
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
      this.invalidate(''); this.root = root; this.messages = []; this.run = undefined;
      this.curriculum = Promise.resolve(curriculum);
      this.watcher?.dispose();
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
      const changed = async (uri: vscode.Uri) => {
        const path = this.path(uri);
        if (path && trackedProjectFiles(await this.curriculum).includes(path)) this.invalidate('Project files changed. Check again to use this version.');
      };
      this.watcher.onDidChange(changed); this.watcher.onDidCreate(changed); this.watcher.onDidDelete(changed);
      await this.resetOwner();
      await vscode.commands.executeCommand('setContext', 'dhimantai.projectOpen', true);
      if (!this.path(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse('untitled:')))
        await vscode.window.showTextDocument(vscode.Uri.file(join(root, curriculum.mode === 'reading' ? 'READING.md' : 'README.md')), {preview: true});
      this.surface.select(this.render);
      await this.surface.show(true);
      await this.refresh();
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not open Project Coach.'); }
  }

  private dirty(onlyDirty = true) {
    const dirty = new Map<string, string>();
    for (const document of vscode.workspace.textDocuments) {
      const path = this.path(document.uri);
      if (path && (!onlyDirty || document.isDirty)) dirty.set(path, document.getText());
    }
    return dirty;
  }
  private async snapshot() {
    const curriculum = await this.curriculum, step = curriculum.steps[this.step];
    const selected = vscode.window.activeTextEditor && this.path(vscode.window.activeTextEditor.document.uri);
    const locations: Record<string, number | string> = {...step.anchors};
    if (selected) locations[selected] = vscode.window.activeTextEditor!.selection.active.line + 1;
    return projectSnapshot(this.root!, curriculum, [...(selected && curriculum.files.includes(selected) ? [selected] : []), ...step.files], this.dirty(false), locations);
  }
  private async refresh() {
    if (!this.root || this.disposed) return;
    const sequence = ++this.refreshSequence;
    try {
      const curriculum = await this.curriculum, snapshot = await this.snapshot();
      if (sequence !== this.refreshSequence || this.disposed) return;
      const step = curriculum.steps[this.step];
      void this.surface.webviewFor(this.render)?.postMessage({type: 'state', revision: this.revision, title: curriculum.title,
        scope: this.key(), reading: curriculum.mode === 'reading',
        steps: curriculum.steps.map(s => s.title), step: this.step, current: step, busy: this.busy, status: this.status,
        messages: this.messages, checkpoint: this.checkpoint, runtime: 'course',
        courseAvailable: !!this.courses.recordFor(vscode.Uri.file(this.root)),
        check: checkState(this.run, snapshot.digest, step.id),
        sharedFiles: snapshot.files.map(f => f.path + ' · line ' + f.start_line + (f.truncated ? ' (excerpt)' : '')), omitted: snapshot.omitted,
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
<div class="runtime-row"><label for="runtime">Runtime</label><select id="runtime"><option value="course">Course container</option><option value="setup">Set up course…</option><option value="terminal">Open terminal</option></select></div>
<label for="step">Project milestone</label><select id="step"></select><div id="projectContent"><p id="goal"></p><p id="task"></p>
<details><summary>Why this step</summary><p id="opening"></p></details>
<div id="files" class="row"></div><div class="row"><button id="check">Check this step</button><button id="hint" class="secondary">I’m stuck</button></div><p id="expected" class="muted"></p>
<details><summary id="checkSummary">Current check</summary><p id="checkState"></p><pre id="output"></pre></details>
<details><summary>Files shared when you ask Coach</summary><p>Only these public files and the current check are sent. Context is temporary.</p><pre id="shared"></pre></details>
<div id="conversation" class="log" role="log" aria-live="polite"></div><p id="status" role="status"></p>
<details><summary>Explain your approach (optional)</summary><p id="reflection"></p><p>Share your explanation in the conversation when you are ready.</p></details>
<details><summary>Save a local checkpoint</summary><label for="note">Your decision, evidence and next step</label><textarea id="note" rows="3" maxlength="1000"></textarea>
<label for="externalHelp">Other assistance</label><select id="externalHelp"><option value="unknown">Not reported</option><option value="reported">I used other help</option><option value="none_reported">No other help reported</option></select>
<button id="checkpoint">Save checkpoint</button><p id="saved" class="muted"></p><p class="muted">Local progress and assistance only. This does not submit work, award a grade or establish mastery.</p></details></div>
<form id="composer"><label for="message">Ask, predict or explain</label><textarea id="message" rows="2" maxlength="600" placeholder="Ask about your project…"></textarea><div class="row"><button id="ask" type="submit">Send</button><button id="newChat" type="button" class="secondary">New chat</button></div></form>
</main><script nonce="${nonce}" src="${asset('coachMarkdown.js')}"></script><script nonce="${nonce}" src="${asset('projectCoach.js')}"></script></body></html>`;
    return vscode.Disposable.from(webview.onDidReceiveMessage(message => { void this.handle(message).catch(error => {
      this.status = error instanceof Error ? error.message : 'Project action failed. Retry explicitly.'; void this.refresh();
    }); }));
  };

  private async handle(message: any): Promise<void> {
    if (message?.type === 'ready') return this.refresh();
    if (!this.root || message?.scope !== this.key() || message?.step !== this.step) return;
    const curriculum = await this.curriculum, step = curriculum.steps[this.step];
    if (message.scope !== this.key() || message.step !== this.step) return;
    if (message.type === 'step' && Number.isInteger(message.index) && curriculum.steps[message.index]) {
      this.invalidate(''); this.step = message.index; this.messages = []; await this.persist(); return this.refresh();
    }
    if (message.type === 'newChat') { this.invalidate(''); this.messages = []; return this.refresh(); }
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
      if (this.messages.some(m => m.role === 'tutor' && m.text === step.hint)
          && vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true) && this.owner !== 'local')
        return this.handle({...message, type: 'ask', text: 'I am still stuck after the hint. Explain this step with a smaller example and help me choose one next action.'});
      this.messages.push({role: 'tutor', text: step.hint}); this.messages = this.messages.slice(-40);
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
      const snapshot = await this.snapshot();
      if (message.scope !== this.key() || message.step !== this.step) return;
      this.checkpoint = {step: step.id, note: message.note, digest: snapshot.digest, at: new Date().toISOString(), assistance: this.assistance, externalHelp: message.help};
      await this.persist(); this.status = 'Checkpoint saved on this computer.'; return this.refresh();
    }
    if (this.busy) return;
    if (message.type === 'check') {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running its Python checks.');
      if ([...this.dirty().keys()].some(path => trackedProjectFiles(curriculum).includes(path))) throw new Error('Save your project files before checking this step.');
      const revision = this.revision;
      const controller = this.request = new AbortController(); this.busy = true; this.status = curriculum.mode === 'reading' ? 'Running the reading example or focused tests…' : 'Running public checks…'; void this.refresh();
      try {
        const snapshot = await this.snapshot();
        if (revision !== this.revision) return;
        const engine = await this.courses.forFile(vscode.Uri.file(this.root), 'python');
        if (!engine) throw new Error('Set up a course runtime and open a project inside its course folder. Project execution requires the container.');
        const run = await runProjectCheck(this.root, step, snapshot.digest, controller.signal, engine);
        if (this.revision === revision) { this.run = run; this.status = run.status === 'passed'
          ? (curriculum.mode === 'reading' ? 'Command finished successfully. Compare its output with your prediction; this is not an assessment.' : 'Container checks passed for this snapshot.')
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

  private async ask(text: string, curriculum: ProjectCurriculum, step: ProjectCurriculum['steps'][number]) {
    const revision = this.revision, environment = this.environment(), backend = this.service();
    const account = (await this.auth.session())?.user.id;
    if (revision !== this.revision) return;
    if (!account || account !== this.owner) throw new Error('Sign in to dhimantAI, then send your question again.');
    const snapshot = await this.snapshot(), selected = snapshot.files[0];
    if (revision !== this.revision) return;
    if (!selected) throw new Error('Open an available project source file before asking Coach.');
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
          check: checkState(this.run, snapshot.digest, step.id), checkpoint: this.checkpoint?.note ?? ''}}, controller.signal);
      if (revision !== this.revision || environment !== this.environment() || (await this.auth.session())?.user.id !== account) return;
      if ((await this.snapshot()).digest !== snapshot.digest) { this.status = 'Files changed before Coach finished. Ask again with the current code.'; return; }
      this.messages.push({role: 'tutor', text: [reply.guidance, reply.prompt].filter(Boolean).join('\n\n'), digest: snapshot.digest});
      this.messages = this.messages.slice(-40); this.assistance++; await this.persist(); this.status = '';
    } finally { if (revision === this.revision) { this.busy = false; this.request = undefined; void this.refresh(); } }
  }
  dispose() { this.disposed = true; this.request?.abort(); this.watcher?.dispose(); this.surface.dispose(); this.subscriptions.forEach(s => s.dispose()); }
}
