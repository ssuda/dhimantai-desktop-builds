import * as vscode from 'vscode';
import { ladderToken, rememberLadderToken } from './ladderTokens';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { Api } from './api';
import { Auth } from './auth';
import { Environment, EnvironmentName } from './environments';
import { contextFor, jupyterMetadata, learnerCell } from './notebookCommands';
import { CoachAudio, audioControls, audioPolicy } from './coachAudio';
import { CoachSurface, CoachRenderer } from './coachSurface';
import { comparePrediction, predictionFeedback } from './learningLoop';
import { teachBackInvitation } from './teachBack';
import { notebookRuntimeControls } from './notebookRuntime';
import { skillStages } from './skillPractice';
import { ENVIRONMENTS } from './environments';
import { practiceLink } from './practiceIpynb';
import { NotebookCoachConversation } from './notebookCoachConversation';

const stages = ['guide', 'question', 'logic', 'syntax', 'steps', 'run', 'error', 'compare', 'review', 'teach_back', ...skillStages] as const;
type Stage = typeof stages[number];
const enabled = () => vscode.workspace.getConfiguration('dhimantai').get<boolean>('aiAssistance', true);

export function cellRun(cell: vscode.NotebookCell, success: boolean) {
  let output = '', stderr = '', error = '', incomplete = false;
  for (const group of cell.outputs) {
    // A display may offer HTML, an image and a plain-text version of the same value.
    const items = group.items.filter(i => i.mime.startsWith('application/vnd.code.notebook.'));
    if (!items.length) {
      const plain = group.items.find(i => i.mime === 'text/plain');
      if (plain) items.push(plain);
    }
    if (!items.length) incomplete = true;
    for (const item of items) {
      if (item.mime === 'application/vnd.code.notebook.error') {
        try {
          if (item.data.length > 256_000) { incomplete = true; continue; }
          const value = JSON.parse(Buffer.from(item.data).toString());
          if (typeof value.name === 'string' && typeof value.message === 'string') error = (value.name + ': ' + value.message).slice(0, 1200);
        } catch { incomplete = true; }
        continue;
      }
      const diagnostic = item.mime === 'application/vnd.code.notebook.stderr';
      const display = item.mime === 'text/plain';
      if (!diagnostic && !display && item.mime !== 'application/vnd.code.notebook.stdout') { incomplete = true; continue; }
      const remaining = diagnostic ? 1200 - stderr.length : 4000 - output.length;
      const bytes = item.data.subarray(0, remaining * 4);
      const chunk = Buffer.from(bytes).toString('utf8') + (display ? '\n' : '');
      incomplete ||= bytes.length !== item.data.length || chunk.length > remaining;
      if (diagnostic) stderr += chunk.slice(0, remaining);
      else output += chunk.slice(0, remaining);
    }
  }
  return { success, output, stderr, error, incomplete };
}

const kernelSetup = 'For a local Python kernel, install the Microsoft Python and Jupyter extensions. In a terminal with your chosen Python environment active, run python -m pip install ipykernel. In the notebook, choose Select Kernel → Python Environments, select that same environment, and rerun the cell.';

export class NotebookCoach implements vscode.Disposable {
  private editor?: vscode.NotebookEditor;
  private runs = new WeakMap<vscode.TextDocument, ReturnType<typeof cellRun> & { prediction?: string }>();
  private predictions = new WeakMap<vscode.TextDocument, {text: string; at: number; runStart?: number}>();
  private readonly started = Date.now();
  private readonly lastEdit = new WeakMap<vscode.TextDocument, number>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private revision = 0;
  private cellKey = '';
  private busy = false;
  private account?: string;
  private authCheck = 0;
  private conversations = new WeakMap<vscode.NotebookDocument, NotebookCoachConversation>();
  private conversation = new NotebookCoachConversation();
  private lastTurn?: { id: string; stage: Stage; text: string; account: string };

  constructor(private readonly secrets: vscode.SecretStorage, private readonly service: (name: EnvironmentName) => Environment,
      private readonly media: vscode.Uri, private readonly surface: CoachSurface,
      private readonly audio: CoachAudio, private readonly showExercise: (standaloneNotebook: boolean) => void) {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveNotebookEditor(editor => {
        // Older hosts focus an editor tab when interacting with the Instructor itself.
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (!editor && tab instanceof vscode.TabInputWebview && tab.viewType.includes('dhimantai.coach')) return;
        this.follow(editor);
      }),
      vscode.window.onDidChangeNotebookEditorSelection(event => {
        if (event.notebookEditor === this.editor) this.refresh();
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length && event.document.uri.scheme === 'vscode-notebook-cell') {
          this.runs.delete(event.document);
          this.predictions.delete(event.document);
          this.lastEdit.set(event.document, Date.now());
          if (this.editor) this.refresh();
        }
      }),
      vscode.workspace.onDidChangeNotebookDocument(event => {
        if (!contextFor(event.notebook)) return;
        for (const change of event.cellChanges) {
          const doc = change.cell.document;
          const summary = change.executionSummary;
          if (change.outputs || change.executionSummary) {
            this.runs.delete(doc);
            if (enabled() && typeof summary?.success === 'boolean' && summary.timing &&
                summary.timing.startTime >= this.started && summary.timing.startTime > (this.lastEdit.get(doc) ?? 0) &&
                learnerCell(change.cell)) {
              const pending = this.predictions.get(doc);
              const start = summary.timing.startTime;
              // VS Code can deliver several output/summary changes for the same execution.
              if (pending && pending.at <= start) pending.runStart ??= start;
              this.runs.set(doc, { ...cellRun(change.cell, summary.success),
                prediction: pending?.runStart === start ? pending.text : undefined });
            }
          }
        }
        if (event.notebook === this.editor?.notebook) this.refresh();
      }),
      vscode.workspace.onDidCloseNotebookDocument(doc => {
        this.conversations.delete(doc);
        if (doc === this.editor?.notebook) this.follow(undefined);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('dhimantai.aiAssistance')) this.clearEvidence();
      }),
      secrets.onDidChange(event => {
        const link = this.editor && contextFor(this.editor.notebook);
        if (link && event.key === 'dhimantai.session.' + link.environment) void this.checkAccount(link.environment);
      }),
    );
    this.follow(vscode.window.activeNotebookEditor);
  }

  private follow(editor: vscode.NotebookEditor | undefined) {
    // A Practice notebook carries its own help inside the notebook (practiceInNotebook.ts); no side panel.
    if (editor && practiceLink(jupyterMetadata(editor.notebook), Object.keys(ENVIRONMENTS))) { editor = undefined; void this.surface.hide(); }
    const switched = this.editor?.notebook !== editor?.notebook;
    this.editor = editor;
    const linked = editor && contextFor(editor.notebook);
    if (switched) {
      this.cancelPending('The notebook changed before Instructor finished. Send your question again to continue.');
      this.conversation = editor && this.conversations.get(editor.notebook) || new NotebookCoachConversation();
      if (editor) this.conversations.set(editor.notebook, this.conversation);
      this.account = undefined;
      this.reset();
      this.authCheck++;
      if (linked) void this.checkAccount(linked.environment);
    }
    if (linked) {
      this.surface.select(this.render);
    } else if (editor || !vscode.window.activeNotebookEditor) this.showExercise(!!editor);
    this.refresh();
  }

  private async checkAccount(environment: EnvironmentName) {
    const check = ++this.authCheck;
    const auth = new Auth(this.secrets, () => environment, () => this.service(environment));
    const user = (await auth.session().catch(() => undefined))?.user.id ?? '';
    if (check !== this.authCheck) return;
    const changed = this.account && user !== this.account;
    this.account = user;
    this.conversation.forAccount(user);
    if (changed) this.clearEvidence();
    else this.refresh();
  }

  show(editor: vscode.NotebookEditor): boolean {
    if (!contextFor(editor.notebook)) return false;
    this.follow(editor);
    void this.surface.show(true);
    return true;
  }

  private readonly render: CoachRenderer = webview => {
    webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    const nonce = randomBytes(16).toString('base64');
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.media, file));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; connect-src ${audioPolicy}; media-src blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}">
<link rel="stylesheet" href="${asset('coachMarkdown.css')}"><link rel="stylesheet" href="${asset('coach.css')}"></head><body>${notebookRuntimeControls(webview, this.media, nonce)}<main class="notebook-coach"><h2>dhimantAI Instructor</h2>
<details><summary>Notebook context and tools</summary><div class="notebook-tools"><div id="question" class="markdown"></div><p id="cell"></p>
<p id="run-status" role="status"></p><p id="run-hint" class="plain-text"></p><details id="kernel-help" hidden><summary>Python kernel setup</summary><p>${kernelSetup}</p></details>
<details><summary>Predict the output of your next run</summary><p>Include every output line in order, including labels. Press Enter between lines.</p><label>Expected text output <textarea maxlength="600" id="prediction"></textarea></label><button id="save-prediction">Save prediction for next Run Cell</button></details>
<button id="wrap-settings" class="secondary">Notebook output wrapping settings</button></div></details>
<div class="chat-heading"><span class="muted">Conversation</span><button id="new-chat" class="link">New chat</button></div>
<p id="empty-chat" class="empty">Ask about your code, an error, or an idea. Instructor uses the selected cell and its latest run when you ask.</p>
<div id="conversation" class="log" role="log" aria-label="Conversation with Instructor" aria-live="polite" aria-relevant="additions"></div>
<p id="turn-status" role="status"></p>
<div class="coach-composer"><textarea maxlength="600" id="message" aria-label="Your question, prediction or explanation" placeholder="Message…" rows="1"></textarea>
<div class="composer-actions">${audioControls(webview, this.media, nonce)}<button id="ask" class="composer-send" title="Ask Instructor" aria-label="Ask Instructor"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div></div>
</main><script nonce="${nonce}" src="${asset('coachMarkdown.js')}"></script><script nonce="${nonce}" src="${asset('notebookCoach.js')}"></script></body></html>`;
    return vscode.Disposable.from(this.surface.bindRuntime(webview), this.audio.bind(webview, () => this.spokenReply()), webview.onDidReceiveMessage(m => {
      if (m?.type === 'ready') this.refresh();
      if (m?.type === 'wrapSettings') void vscode.commands.executeCommand('workbench.action.openSettings', '@id:notebook.output.wordWrap');
      if (m?.type === 'predict' && m.revision === this.revision && typeof m.text === 'string') this.predict(m.text);
      if (m?.type === 'newChat' && m.revision === this.revision && m.conversationId === this.conversation.id) { this.startNewChat(); return; }
      if (m?.type !== 'ask') return;
      this.refresh();
      if (m.revision === this.revision && typeof m.message === 'string' && m.message.trim()) void this.ask('guide', m.message);
    }));
  };

  predict(text: string) {
    const target = this.selection();
    if (!target || !enabled()) return;
    this.predictions.set(target.cell.document, {text: text.slice(0, 600), at: Date.now()});
    this.refresh();
  }

  private spokenReply() {
    const link = this.editor && contextFor(this.editor.notebook), last = this.lastTurn;
    if (!link || !last || !enabled() || this.busy || last.account !== this.account) return;
    return {id: last.id, text: last.text, account: last.account, environment: link.environment, path: link.path};
  }

  private selection() {
    const editor = this.editor;
    if (!editor || editor.notebook.isClosed || !editor.notebook.cellCount) return;
    const link = contextFor(editor.notebook);
    if (!link) return;
    const cells = editor.notebook.getCells();
    const selection = editor.selection;
    const selected = selection && cells[selection.start];
    const cell = selected && learnerCell(selected) ? selected : cells.find(c => learnerCell(c) && c.metadata.metadata?.dhimantai_coach_entry) ?? cells.find(learnerCell);
    if (cell) return { link, cell };
  }

  private clearEvidence() {
    this.runs = new WeakMap();
    this.predictions = new WeakMap();
    this.conversations = new WeakMap();
    this.conversation = new NotebookCoachConversation();
    if (this.editor) this.conversations.set(this.editor.notebook, this.conversation);
    this.reset();
  }

  private startNewChat() {
    this.conversation.clear();
    this.reset();
  }

  private cancelPending(text: string) {
    if (!this.busy) return;
    const last = this.conversation.messages.at(-1);
    if (last) this.conversation.messages.push({id: randomBytes(12).toString('hex'), role: 'status',
      text, cell: last.cell, revision: last.revision});
  }

  private reset() {
    this.lastTurn = undefined;
    this.cellKey = '';
    this.revision++;
    this.busy = false;
    this.refresh();
  }

  private refresh() {
    const webview = this.surface.webviewFor(this.render);
    if (!webview) return;
    const target = this.selection();
    if (target && this.conversation.forScope(JSON.stringify([target.link.environment, target.link.path, target.link.question]))) {
      this.account = undefined;
      void this.checkAccount(target.link.environment);
    }
    const run = target && this.runs.get(target.cell.document);
    const error = run?.error || run?.stderr || '';
    const key = target ? JSON.stringify([target.link, target.cell.document.uri.toString(), target.cell.document.version,
      target.cell.index, run]) : '';
    if (key !== this.cellKey) {
      this.cancelPending('The selected cell or its output changed before Instructor finished. Send your question again to use the latest context.');
      this.cellKey = key;
      this.revision++;
      this.busy = false;
      this.lastTurn = undefined;
    }
    const missing = /^NameError: name '([^']+)' is not defined/.exec(error);
    const python = target?.link.language === 'python';
    const pending = target && this.predictions.get(target.cell.document);
    let runStatus = 'No current run for this cell.';
    if (run) {
      runStatus = run.success ? 'Cell finished.' : 'Cell failed.';
      if (run.incomplete) runStatus += ' Only part of its output is available.';
      else if (run.success && run.prediction !== undefined) {
        runStatus += ' ' + predictionFeedback(comparePrediction(run.prediction, run.output));
      } else runStatus += run.output ? ' Text output is ready to review.' : ' No text output.';
      if (run.success) runStatus += ' This run does not verify overall correctness.';
    }
    const hint = python && run?.success === false && /ipykernel/i.test(error) ? kernelSetup :
      missing ? `Python could not find “${missing[1]}” here. Check its spelling and scope, then run the cell that assigns its value before this one.` : error;
    void webview.postMessage({ audioId: this.spokenReply()?.id ?? null, revision: this.revision, question: target?.link.question ?? '',
      cell: target ? `${basename(target.cell.notebook.uri.fsPath)} · Cell ${target.cell.index + 1} · ${target.link.environment} · ${this.account === undefined ? 'Checking sign-in…' : this.account ? 'Signed in' : 'Sign in to ask'}` : 'Select a code cell.',
      python, runStatus: pending && pending.runStart === undefined ? 'Prediction saved. Use Run Cell to check it.' : runStatus,
      runHint: hint, conversationId: this.conversation.id, messages: enabled() && this.account !== undefined ? this.conversation.messages : [],
      turnStatus: !enabled() ? 'AI assistance is off in dhimantAI settings.' : this.busy ? 'Waiting for an Instructor reply…' : '',
      busy: this.busy || !target || !enabled() });
  }

  async ask(stage: Stage, message: string) {
    this.refresh();
    const target = this.selection();
    if (!this.surface.webviewFor(this.render) || !target || this.busy || !enabled()) return;
    const { link, cell } = target;
    const conversation = this.conversation;
    const cellId = cell.document.uri.toString();
    const addMessage = (role: 'learner' | 'tutor' | 'status', text: string, context?: string) => {
      const item = {id: randomBytes(12).toString('hex'), role, text, context, cell: cellId, revision: this.revision};
      conversation.messages.push(item);
      return item.id;
    };
    if (stage === 'teach_back' && !message.trim()) {
      addMessage('tutor', teachBackInvitation);
      this.lastTurn = undefined;
      this.refresh();
      return;
    }
    const revision = this.revision;
    const current = () => revision === this.revision && !!this.surface.webviewFor(this.render) && enabled();
    message = message.slice(0, 600);
    let promptId = addMessage('learner', message || 'Help me with this cell.', `Cell ${cell.index + 1}`);
    this.busy = true;
    this.refresh();
    void this.surface.webviewFor(this.render)?.postMessage({type: 'accepted', revision, message});
    try {
      // A staging notebook uses its staging sign-in even alongside a production exercise.
      const environment = this.service(link.environment);
      const auth = new Auth(this.secrets, () => link.environment, () => environment);
      const session = await auth.session() ?? await auth.signIn();
      if (!current()) return;
      if (!session) { addMessage('status', 'Sign in to ask Instructor, then send your question again.'); return; }
      conversation.forAccount(session.user.id);
      this.account = session.user.id;
      if (!conversation.messages.some(item => item.id === promptId)) promptId = addMessage('learner', message || 'Help me with this cell.', `Cell ${cell.index + 1}`);
      const history = conversation.history(cellId, revision, promptId);
      const usesCode = ['guide', 'steps', 'run', 'error', 'review', 'teach_back', ...skillStages].includes(stage);
      const source = usesCode ? cell.document.getText() : '';
      if ([...source].length > 12000) throw new Error('Select a shorter code cell (up to 12,000 characters).');
      const api = new Api(auth, () => {
        if (!current()) throw new Error('The selected cell changed.');
        return environment;
      }, session.user.id);
      const run = this.runs.get(cell.document);
      const { error = '', ...observation } = run ?? {};
      const reply = await api.notebookCoach(link.path, { stage, language: link.language, question: link.question, source, ladder_token: ladderToken(link.path),
        ...(run && ['guide', 'run', 'error', 'review', 'teach_back', ...skillStages].includes(stage) ? { observed_run: observation } : {}),
        error: ['guide', 'run', 'error', 'review', 'teach_back', ...skillStages].includes(stage) ? error : '', message, history,
        previous: this.lastTurn?.stage === stage && this.lastTurn.account === session.user.id ? this.lastTurn.text : '' });
      if (!current() || (await auth.session())?.user.id !== session.user.id || !current()) return;
      rememberLadderToken(link.path, reply.ladder_token ?? ladderToken(link.path));
      const line = reply.line;
      const where = typeof line === 'number' && Number.isInteger(line) && line >= 1 && line <= cell.document.lineCount
        ? `Cell ${cell.index + 1}, line ${line} · ${cell.document.lineAt(line - 1).text.trim()}\n` : '';
      const sample = reply.published_comparison;
      const check = sample && run ? `Published example · ${sample.call}\nExpected: ${sample.expected}\nObserved: ${run.output.trimEnd() || '(empty)'}\n${sample.matches ? 'Output matches this example.' : 'Output differs for this example.'}\n\n` : '';
      const prose = [reply.guidance, reply.prompt].filter(value =>
        typeof value === 'string' && value.trim() && !/^(null|undefined)$/i.test(value.trim())).join('\n').trim();
      const id = addMessage(prose ? 'tutor' : 'status', prose || 'Instructor returned no guidance. Try asking again.',
        prose ? `${check}${where}`.trim() : undefined);
      this.lastTurn = prose ? { stage, id, account: session.user.id, text: prose.slice(0, 1500) } : undefined;
    } catch (error) {
      if (current()) { this.lastTurn = undefined; addMessage('status', error instanceof Error ? error.message : 'Could not reach the Instructor. Try again.'); }
    } finally {
      if (current()) { this.busy = false; this.refresh(); }
    }
  }

  dispose() {
    this.subscriptions.forEach(d => d.dispose());
  }
}
