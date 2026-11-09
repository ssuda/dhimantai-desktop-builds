// Practice inside one real Jupyter notebook: the task, the learner's code, their prediction, sample-test
// results and every Instructor reply are cells in the same .ipynb. Help comes from the notebook toolbar and the
// cell status bar; there is no side panel. VS Code's notebook editor and the official language extensions
// provide editing, completion and diagnostics; the kernel picker chooses where code runs.
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { Api, PublicTest } from './api';
import { Auth } from './auth';
import { ENVIRONMENTS, Environment, EnvironmentName } from './environments';
import { HELP_LEVELS, HelpEvent, MAX_HELP_LEVEL, nextLevel, ProblemRecord } from './helpRecord';
import { ladderToken, rememberLadderToken } from './ladderTokens';
import { comparePrediction, predictionFeedback } from './learningLoop';
import type { LocalTestResult } from './localRunner';
import { cellRun } from './notebookCoach';
import { EXTENSIONS, MAX_FILES, PracticeAttachment, attachmentNote, loadAttachments } from './practiceAttachments';
import { contextFor, jupyterMetadata, learnerCell } from './notebookCommands';
import type { PracticeNotebook } from './practiceNotebook';
import { NotebookCoachConversation } from './notebookCoachConversation';
import { inputMarkdown, parseRunInput, learnerSource, parsePrediction, practiceFileName, practiceIpynb, practiceLink, PracticeCellRole, PracticeLink,
  predictionMarkdown, samplesMarkdown, tutorMarkdown, learnerMarkdown, noticeMarkdown } from './practiceIpynb';

export interface PracticeHost {
  secrets: vscode.SecretStorage;
  service(name: EnvironmentName): Environment;
  records(account: string): ProblemRecord[];
  note(account: string, event: HelpEvent): Promise<ProblemRecord[]>;
  tests(doc: vscode.NotebookDocument, language: string, source: string, cases: PublicTest[]): Promise<LocalTestResult[]>;
}

const environments = Object.keys(ENVIRONMENTS);
const linkOf = (doc: vscode.NotebookDocument) => practiceLink(jupyterMetadata(doc), environments);
// The ipynb serializer keeps a Jupyter cell's own metadata under metadata.metadata.
const jupyterCell = (cell: vscode.NotebookCell) => cell.metadata?.metadata ?? {};
const roleOf = (cell: vscode.NotebookCell): PracticeCellRole | undefined => jupyterCell(cell).dhimantai_practice_role;
const assistantFor = (path: string) => path.startsWith('/doubt-practice/') ? 'Doubt Solver' : 'Instructor';
const stillAnswering = (assistant: string) => void vscode.window.showInformationMessage(`Still answering your last question. ${assistant} will reply in this notebook.`);
const aiEnabled = () => vscode.workspace.getConfiguration('dhimantai').get<boolean>('aiAssistance', true);

type Run = ReturnType<typeof cellRun> & {prediction?: string};
interface State { run?: Run; runCell?: string; runStart?: number; lastEditAt?: number; prediction?: string; samples?: string; busy?: boolean; lastReply?: {stage: string; text: string};
  conversation: NotebookCoachConversation; context?: string; revision: number }

/** Write the task notebook once, then open it. An existing file is the learner's work and is never replaced. */
export async function openPracticeFile(practice: PracticeNotebook, environment: EnvironmentName, folder: vscode.Uri, kernel?: string) {
  const file = vscode.Uri.joinPath(folder, practiceFileName(practice));
  const exists = await vscode.workspace.fs.stat(file).then(() => true, () => false);
  if (!exists) {
    await vscode.workspace.fs.createDirectory(folder);
    await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(practiceIpynb(practice, environment), null, 1) + '\n'));
  }
  const doc = await vscode.workspace.openNotebookDocument(file);
  const link = linkOf(doc);
  if (!link || link.questionId !== practice.id || link.account !== practice.account || link.environment !== environment)
    throw new Error(`${file.fsPath} belongs to another exercise or account. Move it, then open the exercise again.`);
  const editor = await vscode.window.showNotebookDocument(doc, {viewColumn: vscode.ViewColumn.One});
  // A new task runs on its first Run with no kernel prompt; later the learner's own kernel choice stands.
  if (!exists && kernel) await vscode.commands.executeCommand('notebook.selectKernel', {notebookEditor: editor, id: kernel, extension: 'optficial.dhimantai-learning'});
  await vscode.commands.executeCommand('setContext', 'dhimantai.practiceNotebook', true);
  return doc;
}

/** Where a task notebook lives without a course folder: per service and account, outside any workspace. */
export function fallbackFolder(storage: vscode.Uri, environment: EnvironmentName, account: string) {
  // A plain file path: language servers and kernels only work with file: notebooks.
  return vscode.Uri.joinPath(vscode.Uri.file(storage.fsPath), 'practice-notebooks', environment, createHash('sha256').update(account).digest('hex').slice(0, 16));
}

export function registerPracticeInNotebook(host: PracticeHost): vscode.Disposable {
  const states = new WeakMap<vscode.NotebookDocument, State>();
  const state = (doc: vscode.NotebookDocument) => { let s = states.get(doc); if (!s) states.set(doc, s = {conversation: new NotebookCoachConversation(), revision: 0}); return s; };
  const changed = new vscode.EventEmitter<void>();

  const active = (anyNotebook = false) => {
    const editor = vscode.window.activeNotebookEditor, doc = editor?.notebook;
    if (!editor || !doc || !doc.cellCount) return;
    const practice = linkOf(doc);
    const cells = doc.getCells(), selected = cells[editor.selection.start];
    const cell = selected && learnerCell(selected) && !roleOf(selected) ? selected
      : cells.find(c => learnerCell(c) && jupyterCell(c).dhimantai_coach_entry) ?? cells.find(learnerCell);
    if (!cell) return;
    const selectedLanguage = cell.document.languageId;
    const environment = vscode.workspace.getConfiguration('dhimantai').get<EnvironmentName>('environment', 'production');
    const coach = contextFor(doc) ?? (anyNotebook ? {environment, path:'/notebook-coach/tutor',
      question:'Help the learner understand their notebook code. No course question is attached.', language:selectedLanguage ?? 'python'} : undefined);
    if (!coach || (!practice && !anyNotebook)) return;
    const link: PracticeLink = practice ?? {version:1, environment:coach.environment, account:'',
      questionId:'generated-' + createHash('sha256').update(doc.uri.toString()).digest('hex').slice(0,24),
      title:'Notebook question', language:coach.language, tests:[], dataset:''};
    return cell && {editor, doc, link, coach, cell, practice:!!practice};
  };
  const require = (anyNotebook = false) => {
    const target = active(anyNotebook);
    if (!target) throw new Error(anyNotebook ? 'Open a notebook with a code cell first.' : 'Open a Practice notebook first.');
    return target;
  };
  const session = async (link: PracticeLink) => {
    const environment = host.service(link.environment);
    const auth = new Auth(host.secrets, () => link.environment, () => environment);
    const user = await auth.session() ?? await auth.signIn();
    if (!user) throw new Error('Sign in to ask Instructor.');
    if (link.account && user.user.id !== link.account) throw new Error('Sign in with the account that opened this Practice task.');
    return {auth, environment, account: user.user.id};
  };
  const source = (doc: vscode.NotebookDocument) => learnerSource(doc.getCells().map(cell => ({
    code: cell.kind === vscode.NotebookCellKind.Code, helper: !learnerCell(cell) || !!roleOf(cell), text: cell.document.getText()})));

  /**
   * Add or replace one of our cells directly under the code and the prediction, so help sits next to the
   * work it is about. Conversation turns follow in order, each reply beneath its own prompt.
   */
  const write = async (doc: vscode.NotebookDocument, role: PracticeCellRole, markdown: string, after?: vscode.NotebookCell) => {
    if (doc.isClosed || (after && !doc.getCells().includes(after))) return;
    const id = randomUUID();
    const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, markdown, 'markdown');
    data.metadata = {metadata: {dhimantai_practice_role: role, dhimantai_coach_helper: role !== 'prediction', dhimantai_message_id: id}};
    const cells = doc.getCells(), existing = role === 'samples' || role === 'input' ? cells.find(c => roleOf(c) === role) : undefined;
    const entry = cells.find(c => jupyterCell(c).dhimantai_coach_entry) ?? cells.find(c => c.kind === vscode.NotebookCellKind.Code);
    const prediction = cells.find(c => roleOf(c) === 'prediction');
    const runWith = cells.find(c => roleOf(c) === 'input');
    const anchor = Math.max(entry?.index ?? -1, runWith?.index ?? -1, prediction?.index ?? -1) + 1;
    const samples = cells.find(c => roleOf(c) === 'samples');
    const lastTurn = role === 'learner' ? cells.filter(c => ['learner', 'tutor', 'notice'].includes(roleOf(c) ?? '')).at(-1) : undefined;
    const index = existing ? existing.index : after ? after.index + 1 : lastTurn ? lastTurn.index + 1
      : anchor > 0 ? anchor + (samples && samples.index === anchor ? 1 : 0) : doc.cellCount;
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, [existing ? vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [data])
      : vscode.NotebookEdit.insertCells(index, [data])]);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not add the conversation to this notebook.');
    // Only Practice notebooks are ours to save; any other notebook keeps the learner's unsaved state.
    if (linkOf(doc)) await doc.save();
    const editor = vscode.window.visibleNotebookEditors.find(e => e.notebook === doc);
    editor?.revealRange(new vscode.NotebookRange(index, index + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    return doc.getCells().find(c => jupyterCell(c).dhimantai_message_id === id);
  };

  const ask = async (stage: string, message: string, heading: string, helpLevel?: number, attachments: PracticeAttachment[] = [], target = require()) => {
    if (!aiEnabled()) throw new Error('AI assistance is off in dhimantAI settings.');
    const {doc, link, coach, cell} = target;
    const assistant = assistantFor(coach.path);
    const s = state(doc);
    if (s.busy) return stillAnswering(assistant);
    s.busy = true; changed.fire();
    let promptCell: vscode.NotebookCell | undefined;
    try {
      message = message.slice(0, 600);
      promptCell = await write(doc, 'learner', learnerMarkdown(message, heading));
      if (!promptCell) return;
      const {auth, environment, account} = await session(link);
      s.conversation.forAccount(account);
      if (s.conversation.forScope(JSON.stringify([account, link.environment, link.questionId, coach.path, coach.question]))) {
        s.context = undefined; s.lastReply = undefined;
      }
      const currentSource = () => target.practice ? source(doc) : cell.document.getText();
      const code = currentSource();
      const selectedLines = cell.document.getText().split(/\r?\n/), runStart = s.runStart;
      if ([...code].length > 12000) throw new Error('Keep your code under 12,000 characters.');
      const api = new Api(auth, () => environment, account);
      const run = s.run && (target.practice || s.runCell === cell.document.uri.toString()) && s.runStart && s.runStart > (s.lastEditAt ?? 0) ? s.run : undefined;
      const {error = '', ...observation} = run ?? {};
      const context = JSON.stringify([code, run]);
      if (s.context !== context) { s.context = context; s.revision++; s.lastReply = undefined; }
      const cellId = cell.document.uri.toString(), revision = s.revision;
      const history = s.conversation.history(cellId, revision);
      const asked = {id: randomUUID(), role: 'learner' as const, text: message, cell: cellId, revision};
      s.conversation.messages.push(asked);
      const reply = await vscode.window.withProgress({location: vscode.ProgressLocation.Window, title: `Asking ${assistant}…`},
        () => api.notebookCoach(coach.path, {stage, language: link.language, question: coach.question, source: code,
          ladder_token: ladderToken(coach.path), ...(run ? {observed_run: observation} : {}), error,
          message, history, previous: s.lastReply?.stage === stage ? s.lastReply.text : '',
          ...(helpLevel ? {help_level: helpLevel} : {}), ...(attachments.length ? {attachments} : {})}));
      if ((await auth.session())?.user.id !== account || doc.isClosed) {
        // Unanswered: never resend it as history, and say why the reply is missing.
        const index = s.conversation.messages.indexOf(asked);
        if (index >= 0) s.conversation.messages.splice(index, 1);
        await write(doc, 'notice', noticeMarkdown('The signed-in account changed. Ask again.', assistant), promptCell);
        return;
      }
      rememberLadderToken(coach.path, reply.ladder_token ?? ladderToken(coach.path));
      if (target.practice) await host.note(account, helpLevel ? {type: 'help', id: link.questionId, level: reply.help_level ?? helpLevel} : {type: 'ask', id: link.questionId});
      const prose = [reply.guidance, reply.prompt].filter(v => typeof v === 'string' && v.trim() && !/^(null|undefined)$/i.test(v.trim())).join('\n\n');
      // Quote the line Instructor points at, but never an empty box for a blank line.
      const quoted = typeof reply.line === 'number' && reply.line >= 1 && reply.line <= selectedLines.length
        ? selectedLines[reply.line - 1].trim() : '';
      const where = quoted ? `Line ${reply.line}: ${quoted}` : '';
      const currentContext = currentSource() === code && s.runStart === runStart;
      s.lastReply = currentContext ? {stage, text: prose.slice(0, 1500)} : undefined;
      const level = helpLevel ? reply.help_level ?? helpLevel : undefined;
      const response = prose || `${assistant} returned no guidance. Try asking again.`;
      const saved = await write(doc, 'tutor', tutorMarkdown(level ? `Step ${level} of ${MAX_HELP_LEVEL} · ${HELP_LEVELS[level - 1].label}` : heading,
        response, [!currentContext && 'This explanation refers to the code and run when you asked. They have since changed.', where].filter(Boolean).join('\n'), assistant), promptCell);
      if (saved) s.conversation.messages.push({id: randomUUID(), role: 'tutor', text: response, cell: cellId, revision});
    } catch (error) {
      if (promptCell) await write(doc, 'notice', noticeMarkdown(error instanceof Error ? error.message : `Could not reach ${assistant}. Try asking again.`, assistant), promptCell);
      else throw error;
    } finally { s.busy = false; changed.fire(); }
  };

  const stuck = async () => {
    const {link} = require();
    const {level} = nextLevel(host.records(link.account).find(r => r.id === link.questionId));
    await ask(level === 2 ? 'steps' : 'guide', HELP_LEVELS[level - 1].message, HELP_LEVELS[level - 1].label, level);
  };

  const check = async () => {
    const {doc, link} = require();
    const s = state(doc);
    if (s.busy) return;
    if (!link.tests.length) throw new Error('This exercise has no sample tests yet.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this VS Code workspace before running code.');
    const {account} = await session(link);
    s.busy = true; changed.fire();
    try {
      const results = await vscode.window.withProgress({location: vscode.ProgressLocation.Window, title: 'Running sample tests…'},
        () => host.tests(doc, link.language, source(doc), link.tests));
      const rows = results.map(r => {
        const test = link.tests.find(t => t.id === r.id);
        const given = test?.kind === 'cli' ? 'Arguments: ' + (test.argv ?? []).join(' ') : test?.kind === 'function' ? 'Call: ' + (test.call ?? '') : test?.stdin ?? '';
        return {id: r.id, verdict: r.verdict, given: given.slice(0, 500), expected: (test?.expected ?? '').slice(0, 1000),
          actual: r.actual.slice(0, 1000), stderr: r.stderr.slice(-600)};
      });
      const passed = rows.filter(r => r.verdict === 'passed').length;
      s.samples = `${passed} of ${rows.length} sample tests passed`;
      await host.note(account, {type: 'samples', id: link.questionId, total: rows.length, passed});
      await write(doc, 'samples', samplesMarkdown(rows));
    } finally { s.busy = false; changed.fire(); }
  };

  const predict = async () => {
    const {doc, cell} = require();
    const existing = doc.getCells().find(c => roleOf(c) === 'prediction');
    if (!existing) await write(doc, 'prediction', predictionMarkdown(), doc.getCells().find(c => roleOf(c) === 'input') ?? cell);
    const target = doc.getCells().find(c => roleOf(c) === 'prediction')!;
    const editor = vscode.window.activeNotebookEditor;
    if (editor?.notebook === doc) {
      editor.selections = [new vscode.NotebookRange(target.index, target.index + 1)];
      editor.revealRange(new vscode.NotebookRange(target.index, target.index + 1));
      await vscode.commands.executeCommand('notebook.cell.edit');
    }
  };

  /** Choose what Run passes to the program: a sample's arguments and input, or the learner's own. */
  const input = async (choice?: {example?: string}) => {
    const {doc, link, cell} = require();
    const examples = link.tests.filter(t => t.argv?.length || t.stdin);
    const describe = (argv: string[] = [], stdin = '') => [argv.length ? argv.join(' ') : '', stdin ? 'input: ' + stdin.replace(/\n/g, ' ⏎ ').slice(0, 60) : ''].filter(Boolean).join(' · ') || 'nothing';
    let picked: {argv: string[]; stdin: string} | 'edit' | undefined;
    if (choice?.example) {
      const test = examples.find(t => t.id === choice.example);
      if (!test) throw new Error('No sample test named ' + choice.example + '.');
      picked = {argv: test.argv ?? [], stdin: test.stdin ?? ''};
    } else {
      const item = await vscode.window.showQuickPick([
        ...examples.map(t => ({label: '$(beaker) Use sample ' + t.id, description: describe(t.argv, t.stdin), value: {argv: t.argv ?? [], stdin: t.stdin ?? ''} as typeof picked})),
        {label: '$(edit) Write my own arguments and input', description: 'Opens the Run with cell', value: 'edit' as typeof picked},
        {label: '$(circle-slash) Run with nothing', description: 'No arguments and no typed input', value: {argv: [], stdin: ''} as typeof picked},
      ], {title: 'What should Run give your program?', placeHolder: 'Arguments and typed input for the next Run'});
      picked = item?.value;
    }
    if (!picked) return;
    const current = doc.getCells().find(c => roleOf(c) === 'input');
    if (picked !== 'edit' || !current) await write(doc, 'input', inputMarkdown(picked === 'edit' ? [] : picked.argv, picked === 'edit' ? '' : picked.stdin), cell);
    if (picked === 'edit') {
      const target = doc.getCells().find(c => roleOf(c) === 'input')!;
      const editor = vscode.window.activeNotebookEditor;
      if (editor?.notebook === doc) {
        editor.selections = [new vscode.NotebookRange(target.index, target.index + 1)];
        await vscode.commands.executeCommand('notebook.cell.edit');
      }
    }
    changed.fire();
  };

  const pickAttachments = async () => {
    const chosen = await vscode.window.showOpenDialog({canSelectMany: true, openLabel: 'Attach',
      title: `Attach up to ${MAX_FILES} photos or PDFs (2 MB each)`, filters: {'Photos and PDFs': EXTENSIONS}});
    return chosen?.length ? loadAttachments(chosen.map(uri => uri.fsPath)) : [];
  };
  const askQuestion = async (anyNotebook = false) => {
    const target = require(anyNotebook);
    const assistant = assistantFor(target.coach.path);
    if (state(target.doc).busy) return stillAnswering(assistant);
    // One box: type a question, and optionally attach photos or PDFs (an error on screen, handwritten working).
    const box = vscode.window.createInputBox();
    const attach = {iconPath: new vscode.ThemeIcon('attach'), tooltip: 'Attach a photo or PDF'};
    const prompt = `${assistant} guides you; it does not write the solution.`;
    let files: PracticeAttachment[] = [], picking = false;
    Object.assign(box, {title: `Ask ${assistant} about this notebook`, prompt, buttons: [attach], ignoreFocusOut: true,
      placeholder: 'For example: why does my loop stop early? Use the paperclip to attach a photo or PDF.'});
    const answer = await new Promise<string | undefined>(resolve => {
      box.onDidChangeValue(v => { box.validationMessage = v.length > 600 ? 'Keep it under 600 characters.' : undefined; });
      box.onDidTriggerButton(async () => {
        picking = true;
        try {
          const picked = await pickAttachments();
          if (picked.length) files = picked;
          box.prompt = [attachmentNote(files), prompt].filter(Boolean).join(' · ');
          box.validationMessage = undefined;
        } catch (error) { box.validationMessage = error instanceof Error ? error.message : String(error); }
        picking = false;
        box.show();
      });
      box.onDidAccept(() => {
        if (box.value.length > 600 || (!box.value.trim() && !files.length)) return;
        resolve(box.value.trim()); box.hide();
      });
      box.onDidHide(() => { if (!picking) resolve(undefined); });
      box.show();
    });
    box.dispose();
    if (answer === undefined) return;
    const message = answer || 'Look at what I attached and help me with my next step.';
    const heading = 'Your question';
    await ask('guide', message, files.length ? heading + ' · ' + attachmentNote(files) : heading, undefined, files, target);
  };
  const review = async () => ask('review', 'Review my code against the task and help me decide what to improve.', 'Code review');
  const more = async () => {
    const {link} = require();
    const {level, waiting} = nextLevel(host.records(link.account).find(r => r.id === link.questionId));
    const item = await vscode.window.showQuickPick([
      {label:HELP_LEVELS[level - 1].label, description:`Help step ${level} of ${MAX_HELP_LEVEL}`,
        detail:waiting ? 'Change and run your code first; until then help stays at this step.' : undefined, command:'dhimantai.practice.stuck'},
      {label:'Predict the output', description:'Write what you expect before running', command:'dhimantai.practice.predict'},
      {label:'Run with arguments or input', description:'Use a sample or your own input', command:'dhimantai.practice.input'},
      {label:'Review my code', description:'Ask Instructor for feedback in this notebook', command:'dhimantai.practice.submit'},
    ], {title:'More notebook actions', placeHolder:'Choose an action'});
    if (item) await vscode.commands.executeCommand(item.command);
  };

  const guard = (action: () => Promise<unknown>) => async () => {
    try { await action(); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
  };

  const context = () => {
    const doc = vscode.window.activeNotebookEditor?.notebook;
    void vscode.commands.executeCommand('setContext', 'dhimantai.practiceNotebook', !!doc && !!linkOf(doc));
  };

  const statusBar: vscode.NotebookCellStatusBarItemProvider = {
    onDidChangeCellStatusBarItems: changed.event,
    provideCellStatusBarItems(cell) {
      const doc = cell.notebook, link = linkOf(doc);
      if (!link) return [];
      const s = state(doc), items: vscode.NotebookCellStatusBarItem[] = [];
      if (roleOf(cell) === 'prediction') {
        const item = new vscode.NotebookCellStatusBarItem(s.prediction ?? 'Write what you expect, then run your code', vscode.NotebookCellStatusBarAlignment.Left);
        items.push(item);
      } else if (cell.kind === vscode.NotebookCellKind.Code && learnerCell(cell) && jupyterCell(cell).dhimantai_coach_entry) {
        const action = (text: string, command: string, tooltip: string) => {
          const item = new vscode.NotebookCellStatusBarItem(text, vscode.NotebookCellStatusBarAlignment.Left);
          item.command = command; item.tooltip = tooltip; items.push(item);
        };
        if (link.tests.length) action('$(beaker) Check samples', 'dhimantai.practice.check', 'Run the published examples in your selected runtime.');
        action('$(comment-discussion) Ask Instructor', 'dhimantai.practice.ask', 'Ask a question about your code. Feedback stays in this notebook.');
        action('$(ellipsis) More', 'dhimantai.practice.more', 'Hints, predictions, run input and code review');
        // What the next Run gives the program, when it gives anything.
        const runWith = doc.getCells().find(c => roleOf(c) === 'input');
        const given = runWith ? parseRunInput(runWith.document.getText()) : {argv: [], stdin: ''};
        const summary = [given.argv.join(' '), given.stdin ? 'typed input' : ''].filter(Boolean).join(' + ');
        if (summary) {
          const item = new vscode.NotebookCellStatusBarItem('$(terminal) Run with: ' + (summary.length > 40 ? summary.slice(0, 39) + '…' : summary),
            vscode.NotebookCellStatusBarAlignment.Right);
          item.tooltip = 'Arguments and typed input Run gives your program. Change them from More.'; items.push(item);
        }
        if (s.samples) items.push(new vscode.NotebookCellStatusBarItem('$(beaker) ' + s.samples, vscode.NotebookCellStatusBarAlignment.Right));
        if (s.busy) items.push(new vscode.NotebookCellStatusBarItem('$(sync~spin) Working…', vscode.NotebookCellStatusBarAlignment.Right));
      }
      return items;
    },
  };

  const subscriptions = [
    changed,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', statusBar),
    vscode.commands.registerCommand('dhimantai.practice.stuck', guard(stuck)),
    vscode.commands.registerCommand('dhimantai.practice.check', guard(check)),
    vscode.commands.registerCommand('dhimantai.practice.predict', guard(predict)),
    vscode.commands.registerCommand('dhimantai.practice.ask', guard(askQuestion)),
    vscode.commands.registerCommand('dhimantai.notebook.ask', guard(() => askQuestion(true))),
    vscode.commands.registerCommand('dhimantai.practice.submit', guard(review)), // compatibility command ID
    vscode.commands.registerCommand('dhimantai.practice.more', guard(more)),
    vscode.commands.registerCommand('dhimantai.practice.input', (choice?: {example?: string}) => guard(() => input(choice))()),
    vscode.window.onDidChangeActiveNotebookEditor(context),
    vscode.workspace.onDidChangeNotebookDocument(event => {
      const link = linkOf(event.notebook);
      if (event.notebook.notebookType !== 'jupyter-notebook') return;
      const s = state(event.notebook);
      for (const change of event.cellChanges) {
        const cell = change.cell, summary = change.executionSummary;
        if (change.document && learnerCell(cell) && !roleOf(cell)) s.lastEditAt = Date.now();
        if (!summary?.timing || typeof summary.success !== 'boolean' || !learnerCell(cell) || roleOf(cell)) continue;
        // VS Code reports one execution in several events; count it once.
        const start = summary.timing.startTime, first = s.runStart !== start;
        const predictionCell = event.notebook.getCells().find(c => roleOf(c) === 'prediction');
        const prediction = predictionCell && parsePrediction(predictionCell.document.getText());
        s.run = {...cellRun(cell, summary.success), prediction};
        s.runStart = start; s.runCell = cell.document.uri.toString();
        s.prediction = prediction === undefined ? undefined : summary.success && !s.run.incomplete
          ? predictionFeedback(comparePrediction(prediction, s.run.output)) : 'The run failed, so the prediction was not compared.';
        if (first && link) void host.note(link.account, {type: 'run', id: link.questionId});
      }
      changed.fire();
    }),
  ];
  context();
  return vscode.Disposable.from(...subscriptions);
}

