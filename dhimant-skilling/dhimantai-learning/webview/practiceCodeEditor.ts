import {deliveryBillFeedback, type BillSample} from '../src/deliveryBillPractice';
import type { TestRow } from '../src/practiceConversation';
import {pythonCompleteness} from '../src/pythonCompleteness';
import { cellLanguage as codeLanguage, cellLanguages as codeLanguages, cellLanguageMismatch, observedRun, predictionPrompt, validCellInputs } from '../src/roomCode';
import type { CodeAction, CodeResult, CodeSnapshot, Execution } from '../src/roomCode';
import { splitArgs } from '../src/practiceIpynb';
import { insertNewlineAndIndent } from '@codemirror/commands';
import { CellTerminal } from './cellTerminal';
import { InstructorCodeCell } from './instructorCodeCell';
import type { NotebookDraft } from '../src/tutorNotebook';
import { judgeVariation, predictionFeedback } from '../src/learningLoop';
import type { Variation } from '../src/learningLoop';
import type { LearnerTestCase, SkillStage } from '../src/skillPractice';
import { lessonPrediction } from './lessonPrediction';
import { SkillPractice } from './skillPractice';
import { NativeDebugControls } from './nativeDebugControls';
import type { DebugEvidence, NativeDebugAction, NativeDebugReply, NativeDebugState } from '../src/debugEvidence';
import { runInputs } from './lessonOutput';
import { matchesExpectedError } from '../src/lessonExecution';

// Unrequested hints interrupt thinking, so they are opt-in and wait for signs of being stuck.
export const STUCK_PAUSE_MS = 90000, FAILED_RUN_PAUSE_MS = 30000, HINT_GAP_MS = 120000;

type Hooks = {
  lessonSkills?: () => SkillStage[] | undefined;
  /** The assistant answering in this room right now (Instructor or Doubt Solver). */
  assistant?: () => string;
  post: (message: unknown) => void;
  observe: (snapshot: CodeSnapshot, run?: ReturnType<typeof observedRun>, guidance?: string) => void;
  submit: (text: string, display: string) => Promise<boolean>;
  tutor?: (snapshot: CodeSnapshot, run: ReturnType<typeof observedRun> | undefined, message: string, prediction: string, stage?: SkillStage, debuggerState?: DebugEvidence, review?: boolean) => Promise<boolean>;
  changed?: () => void;
  /** A cell started or finished running code; read PracticeCodeEditors.running. */
  runChanged?: () => void;
  executionFinished?: (key: string, snapshot: CodeSnapshot, run?: Execution, error?: string, expectedError?: string) => void;
  debug?: (snapshot:CodeSnapshot, action:NativeDebugAction) => Promise<NativeDebugReply>;
  /** Practice tools that only run code: sample tests, a Python step-through and a new input. */
  tool?: (snapshot: CodeSnapshot, tool: PracticeTool, cases?: LearnerTestCase[]) => Promise<ToolReply>;
};
export type PracticeTool = 'grade' | 'tests' | 'trace' | 'variation' | 'my_tests' | 'test_code';
type TraceStepView = {line: number; event: string; function: string; output: number | null; locals: Record<string, string>; exception?: string};
export type ToolReply = {error?: string; tests?: TestRow[]; variation?: Variation; execution?:Execution;
  trace?: {steps: TraceStepView[]; stdout: string; stopped: string | null; error: string | null}};

type TextbookTask = {question_id: string; checkpoint_id: string; language: string; starter: string; question: string; source: string};

function textbookTask(value: any): value is TextbookTask {
  return value && ['question_id', 'checkpoint_id'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 100)
    && typeof value.language === 'string' && !!codeLanguage(value.language)
    && typeof value.starter === 'string' && value.starter.length <= 12000
    && typeof value.question === 'string' && !!value.question.trim() && value.question.length <= 6000
    && ['Textbook exercise', 'Practice exercise', 'Your turn'].includes(value.source);
}

/** Embedded Practice surface. Edits, input, run output and guidance live only in this panel. */
export class PracticeCodeEditors {
  private editors: PracticeCodeEditor[] = [];
  private counter = 0;
  private completionId=0;
  private completions=new Map<number,(items:any[])=>void>();
  complete(language:string,source:string,offset:number):Promise<any[]>{
    const request=++this.completionId;return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.completions.delete(request);resolve([]);},1800);
      this.completions.set(request,items=>{clearTimeout(timer);resolve(items);});
      this.hooks.post({type:'cellCompletion',attempt:this.attempt,request,language,source,offset});
    });
  }
  completed(message:any){this.completions.get(message.request)?.(message.items??[]);this.completions.delete(message.request);}
  private lastGuidance = 0;
  private focused?: PracticeCodeEditor;
  private restored = new Map<string, NotebookDraft>();
  runPracticeTool(tool: 'tests' | 'grade') {
    const editor = this.editors.find(item => item.task?.source === 'Practice exercise' && item.born === this.attempt);
    if (editor) void editor.runTool(tool);
  }
  solution() { return this.editors.find(editor => editor.task?.source === 'Practice exercise')?.context(); }
  /** The open Instructor exercise whose solution editor holds code the learner has not sent yet. */
  unsentExercise() { return this.editors.find(editor => editor.hasUnsentSolution()); }
  context(id: string) { return this.editors.find(editor => editor.id === id)?.context(); }
  elementForKey(key: string) { return this.editors.find(editor => editor.key === key)?.element; }
  selection() { return (this.focused ?? this.editors.find(editor => !!editor.task) ?? this.editors[0])?.context(); }
  contexts() { return this.editors.map(editor => editor.context()); }
  focusLine(id: string, line: number) { this.editors.find(editor => editor.id === id)?.focusLine(line); }
  // Written checkpoints may have code drafts from older versions of the notebook.
  private writtenDrafts = new Map<string, NotebookDraft>();
  drafts() {
    const drafts = new Map(this.writtenDrafts);
    for (const editor of this.editors) drafts.set(editor.key, editor.draft());
    return [...drafts.values()];
  }
  writtenQuestion(body: HTMLElement, cellId: string, checkpoint: string) {
    // A verified resume (or a repeated checkpoint) can correct a mounted legacy editor.
    for (const editor of [...this.editors]) {
      if (editor.key !== 'checkpoint:' + checkpoint && !editor.key.startsWith(cellId + ':')) continue;
      this.restored.set(editor.key, editor.draft());
      editor.cancelPending(); editor.destroy(); editor.element.remove();
      this.editors.splice(this.editors.indexOf(editor), 1);
      if (this.focused === editor) this.focused = undefined;
    }
    for (const [key, draft] of this.restored) {
      if (key !== 'checkpoint:' + checkpoint && !key.startsWith(cellId + ':')) continue;
      this.writtenDrafts.set(key, draft);
      if (!(draft.source.trim() || draft.explanation.trim() || draft.prediction.trim())) continue;
      const saved = document.createElement('details'), title = document.createElement('summary');
      title.textContent = 'Previously saved work';
      const text = document.createElement('pre');
      text.textContent = [draft.source, draft.prediction, draft.explanation].filter(Boolean).join('\n');
      saved.append(title, text); body.append(saved);
    }
  }
  removeCell(cellId: string) {
    const removed = this.editors.filter(editor => editor.key.startsWith(cellId + ':'));
    for (const editor of removed) {
      editor.cancelPending(); editor.destroy(); this.restored.delete(editor.key);
      if (this.focused === editor) this.focused = undefined;
    }
    this.editors = this.editors.filter(editor => !removed.includes(editor));
    if (removed.length) this.hooks.runChanged?.();
  }
  restore(drafts: NotebookDraft[]) {
    this.clear();
    this.restored = new Map(drafts.map(draft => [draft.key, draft]));
    this.counter = Math.max(0, ...drafts.map(draft => Number(draft.snippet.slice(5))));
  }
  invalidateRuns() { for (const editor of this.editors) editor.invalidateRun(); }
  restartRuntime() { for (const editor of this.editors) { editor.cancelPending('Run this cell for a current result.'); editor.update(); } }
  add(body: HTMLElement, key: string, language = 'python', source = '') {
    const saved = this.restored.get(key);
    const editor = new PracticeCodeEditor(this, saved?.snippet ?? 'code-' + ++this.counter,
      saved?.language ?? language, saved?.source ?? source, 'My notebook experiment', undefined, key, saved);
    this.editors.push(editor); body.append(editor.element);
  }
  dedicatedSqlTerminal = false;
  commandPrompt(language: string) {
    if (language === 'sql') return this.dedicatedSqlTerminal ? '' : 'sql>';
    return ['bash', 'zsh', 'pglab'].includes(language) ? '$' : '';
  }
  connected = false;
  tutorBusy = false;
  aiEnabled = true;
  private runtimeName = 'Course runtime';
  get runtime() { return this.runtimeName; }
  set runtime(value: string) { this.runtimeName = value; for (const editor of this.editors) editor.update(); }
  following = true;
  stuckHints = false;
  attempt = 0;
  activeCheckpoint = '';
  /** What the open Practice exercise offers; set when Practice is ready. */
  practiceTools: {tests:number; trace:boolean; boundaryPractice:boolean; billSamples?:BillSample[]} = {tests:0, trace:false, boundaryPractice:false};
  constructor(readonly hooks: Hooks) {}
  focus(editor: PracticeCodeEditor) { this.focused = editor; }
  markHelped(id: string) { this.editors.find(editor => editor.id === id)?.markHelped(); }
  flushObservation() { this.focused?.observe(); }
  checkpoint(id: string) {
    this.activeCheckpoint = id;
    for (const editor of this.editors) editor.update();
  }
  mount(body: HTMLElement, question: string, task?: unknown, cellId = 'cell-' + this.counter, options?: { teachingExample?: boolean; instructorCommands?: boolean; db2Lab?: boolean; postgresCell?: {mount(parent:HTMLElement,key:string,source:string):void} }) {
    if (textbookTask(task)) {
      // Replaying a question moves its existing editor, preserving the learner's draft.
      const saved = this.editors.find(editor => editor.task?.checkpoint_id === task.checkpoint_id && editor.born === this.attempt);
      const key = 'checkpoint:' + task.checkpoint_id, draft = this.restored.get(key);
      const editor = saved ?? new PracticeCodeEditor(this, draft?.snippet ?? 'code-' + ++this.counter,
        codeLanguage(task.language)!, draft?.source ?? task.starter, task.question, task, key, draft);
      if (!saved) this.editors.push(editor);
      const instructions = document.createElement('details');
      instructions.className = 'exercise-instructions';
      instructions.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Exercise instructions';
      instructions.append(summary, ...Array.from(body.childNodes));
      const solution = document.createElement('div');
      solution.className = 'exercise-solution';
      solution.append(editor.element);
      body.classList.add('exercise-workspace');
      body.append(instructions, solution);
      return; // Public examples stay read-only; exactly one solution editor, even without a fence.
    }
    let index = 0;
    const cardHasOutput = !!body.querySelector('.lesson-output-heading, code.language-output');
    for (const code of body.querySelectorAll<HTMLElement>('pre > code')) {
      const label = Array.from(code.classList).find(c => c.startsWith('language-'))?.slice(9) ?? '';
      const language = codeLanguage(label);
      if (code.closest('.code-reading-only'))continue;
      if (!language || !code.textContent?.trim() || code.textContent.length > 12000) continue;
      const key = cellId + ':' + index++, draft = this.restored.get(key);
      // Keep edited legacy work accessible when the same source is now shown as a reference.
      if (options?.instructorCommands && (language === 'bash' || language === 'zsh'
          || language === 'sql' && (options.db2Lab || this.dedicatedSqlTerminal))
          && (!draft || draft.source === code.textContent && !draft.prediction && !draft.explanation && !draft.stdin
            && !draft.files?.length && !draft.argv?.length && !draft.commandHistory?.length && !draft.promptSubmitted)) {
        if (draft) this.writtenDrafts.set(key,draft);
        continue;
      }
      // Db2 examples target the learner’s external instance, including its OS utilities.
      if (options?.db2Lab && !draft && ['sql','bash','zsh'].includes(language)) continue;
      if (options?.postgresCell && options.teachingExample && language === 'sql' && (!draft || draft.language === 'sql')) {
        const card = code.closest<HTMLElement>('.code-block-card') ?? code.parentElement!;
        const container = document.createElement('div'); card.replaceWith(container);
        if (draft) this.writtenDrafts.set(key,draft);
        options.postgresCell.mount(container,key,draft?.source ?? code.textContent); continue;
      }
      const expected = code.parentElement!.dataset.demoError;
      const source = code.textContent;
      const mountEditor = (target: Element) => {
        const hidePrediction = !!options?.teachingExample && (!!expected || cardHasOutput || this.commandPrompt(language) === '$');
        const editor = new PracticeCodeEditor(this, draft?.snippet ?? 'code-' + ++this.counter, draft?.language ?? language, draft?.source ?? source, question.slice(0, 6000), undefined, key, draft, !hidePrediction);
        if (expected) editor.demonstration = {source, language, error:expected};
        this.editors.push(editor);
        target.replaceWith(editor.element);
        return editor;
      };
      const card = code.closest('.code-block-card') ?? code.parentElement!;
      // An excerpt of a larger program (it reads names that neither it nor an earlier cell defines) fails with
      // NameError, so show it as reading code. Saved drafts and intended-error demonstrations stay runnable.
      // Doubt Solver keeps such code editable and blocks Run until the missing setup is added.
      const gap = !draft && !expected && !code.dataset.expectedError && language === 'python'
        && this.hooks.assistant?.() !== 'Doubt Solver' ? this.excerptGap(source) : '';
      if (gap) excerptCard(card, gap, () => mountEditor(card).code.view.focus());
      else mountEditor(card);
    }
  }
  /** Why a Python block cannot run in the shared kernel by itself, or '' when it can. */
  private excerptGap(source: string) {
    // Jupyter kernels also provide display() and get_ipython().
    const available = ['display', 'get_ipython', ...this.editors.flatMap(editor => editor.pythonDefinitions())];
    const result = pythonCompleteness(source, available);
    if (!result.syntax) return 'This is part of a larger program and is not complete Python on its own.';
    if (!result.missing.length) return '';
    const names = result.missing.slice(0, 4).join(', ') + (result.missing.length > 4 ? ', …' : '');
    return `This is part of a larger program: it uses ${names}, which ${result.missing.length > 1 ? 'are' : 'is'} defined elsewhere, so running it alone would raise NameError.`;
  }
  update(connected: boolean, attempt: number, aiEnabled = this.aiEnabled) {
    if (this.aiEnabled !== aiEnabled) this.editors.forEach(editor => editor.cancelPending());
    this.connected = connected; this.attempt = attempt; this.aiEnabled = aiEnabled;
    for (const editor of this.editors) editor.update();
  }
  follow(value: boolean) {
    this.following = value;
    for (const editor of this.editors) editor.update();
  }
  offerHints(value: boolean) {
    this.stuckHints = value;
    for (const editor of this.editors) editor.update();
  }
  clear() { this.writtenDrafts.clear(); this.editors.forEach(e => e.destroy()); this.editors = []; this.focused = undefined; this.activeCheckpoint = ''; this.hooks.runChanged?.(); }
  receiveDebug(message: {snippet:string;revision:number;state:NativeDebugState}) {
    this.editors.find(e => e.id === message.snippet)?.receiveDebug(message.revision,message.state);
  }
  /** Whether any cell is running or checking code right now. */
  get running() { return this.editors.some(e => e.running); }
  receive(message: CodeResult) {
    if (message.attempt === this.attempt) this.editors.find(e => e.id === message.snippet)?.receive(message);
  }
  canGuide() {
    if (!this.connected || !this.aiEnabled || !this.following || !this.stuckHints
        || Date.now() - this.lastGuidance < HINT_GAP_MS) return false;
    this.lastGuidance = Date.now(); return true;
  }
}

/** Turn a rendered code card into a read-only excerpt with a way to open it as an editable cell anyway. */
function excerptCard(card: Element, reason: string, open: () => void) {
  card.classList.add('code-reading-only', 'code-excerpt');
  const header = card.querySelector('.code-block-header');
  const badge = document.createElement('small');
  badge.className = 'code-block-badge';
  badge.textContent = 'Excerpt · not runnable on its own';
  header?.querySelector('.code-block-lang')?.after(badge);
  const note = document.createElement('p');
  note.className = 'code-excerpt-note';
  note.textContent = reason + ' Run the complete lab cell for this step, or open this as a code cell and add what it needs.';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet';
  button.textContent = 'Open as code cell';
  button.onclick = open;
  note.append(' ', button);
  card.append(note);
}

class PracticeCodeEditor extends InstructorCodeCell {
  private readonly prompt = document.createElement('span');
  private readonly transcript = document.createElement('pre');
  private commands: string[] = [];
  private historyPosition = 0;
  private pendingInput = '';
  private submittedSource?: string;
  private clearingPrompt = false;
  private promptRequest?: number;
  private get source() { return this.submittedSource ?? this.code.value; }
  private input = document.createElement('textarea');
  private args = document.createElement('input');
  private interactive = document.createElement('input');
  private files:{name:string;content:string}[]=[];
  private terminal?: CellTerminal;
  private programInputs = document.createElement('details');
  private prediction = document.createElement('textarea');
  private runPrediction = '';
  private get predictionLabel() {
    const label = predictionPrompt(this.language, this.code?.value ?? '');
    return this.predictFirst && label === 'I expect the result to be' ? 'I expect this cell to display' : label;
  }
  private readonly lessonSkills?: SkillStage[];
  private get predictFirst() { return this.language === 'python' && !!this.lessonSkills; }
  private get showPredictionRow() { return this.predictFirst || this.allowPrediction; }
  private get missingPrediction() { return this.predictFirst && !this.prediction.value.trim(); }
  private readonly comparison = document.createElement('div');
  private skipPrediction = -1;
  private runCount = 0;
  private feedback = document.createElement('div');
  private completeness = document.createElement('p');
  private mismatch = document.createElement('div');
  private mismatchText = document.createElement('span');
  private switchLanguage = document.createElement('button');
  private actions: HTMLButtonElement[] = [];
  private revision = 0;
  private request = 0;
  private busy?: CodeAction['action'];
  private execution?: Execution;
  private observationTimer?: ReturnType<typeof setTimeout>;
  private guidanceTimer?: ReturnType<typeof setTimeout>;
  readonly born: number;
  demonstration?: {source:string; language:string; error:string};
  private submitButton?: HTMLButtonElement;
  private explanation = document.createElement('textarea');
  private submitting = false;
  private submitted = false;
  private historical = document.createElement('details');
  private helped = false;
  private reflection = document.createElement('details');
  private tools = document.createElement('div');
  private toolButtons: Record<Exclude<PracticeTool, 'grade' | 'my_tests' | 'test_code'>, HTMLButtonElement> | undefined;
  private toolOutput = document.createElement('div');
  private manualChecks = document.createElement('p');
  private toolBusy = false;
  private testsPassed = -1;
  private cleanRun = -1;
  private skills: SkillPractice;
  private nativeDebug: NativeDebugControls;
  private debugBusy = false;
  private attemptVariation?: {variation: Variation; previousStdin: string; assisted: boolean};
  private debugging = false;
  private assistant() { return this.owner.hooks.assistant?.() ?? 'Instructor'; }
  /** Names this cell can leave in the shared Python kernel, for judging whether a later block is an excerpt. */
  pythonDefinitions() { return this.language === 'python' ? pythonCompleteness(this.code.value).definitions : []; }
  constructor(private owner: PracticeCodeEditors, readonly id: string, private language: string,
      source: string, private question: string, readonly task?: TextbookTask, readonly key = id, draft?: NotebookDraft, private readonly allowPrediction = true) {
    const submitted = !!owner.commandPrompt(language) && draft?.promptSubmitted;
    super({id, key, language, languages: codeLanguages, source:submitted ? '' : source,
      title: task ? 'Your solution' : undefined,
      note: owner.runtime + (language === 'python' ? '. Python cells share variables until the runtime restarts.' : '. Cells share files. Use shell cells for project builds and package setup.'),
      changed: () => this.changed(), focused: () => owner.focus(this),
      changeLanguage: value => this.setLanguage(value),
      complete: (text, offset) => owner.complete(this.language, text, offset),
      run: () => {
        if (this.busy) owner.hooks.post({type:'cellControl', attempt:this.born, action:'stop'});
        else this.act('run');
      },
    });
    const {heading, note, buffer, bar} = this;
    this.prompt.className = 'command-prompt';
    this.prompt.setAttribute('aria-hidden', 'true');
    this.transcript.className = 'command-transcript';
    this.transcript.setAttribute('aria-label', 'Previous commands and output');
    this.commands = [...(draft?.commandHistory ?? [])];
    if (submitted) this.submittedSource = source;
    if (this.commands.length) this.transcript.textContent = this.commands.map(cmd => owner.commandPrompt(language) + ' ' + cmd).join('\n') + '\n';
    this.historyPosition = this.commands.length;
    buffer.prepend(this.transcript, this.prompt);
    this.code.view.dom.addEventListener('keydown', event => this.consoleKey(event), true);
    this.born = owner.attempt;
    this.lessonSkills = owner.hooks.lessonSkills?.();
    this.resultBlock.append(this.comparison);
    this.actions.push(this.runButton);
    this.input.onfocus = () => this.owner.focus(this);
    this.input.rows = 2; this.input.maxLength = 4000; this.input.oninput = () => this.changed();
    const inputLabel = document.createElement('label'); inputLabel.textContent = 'Standard input (stdin)'; inputLabel.append(this.input);
    const inputs = this.programInputs; inputs.className = 'program-inputs'; const summary = document.createElement('summary'); summary.textContent = 'Program input';
    this.args.maxLength=4000;this.args.className='program-field';this.args.placeholder = 'Arguments, for example --count "two words"'; this.args.oninput=()=>this.changed();
    const argsLabel=document.createElement('label');argsLabel.className='program-field-label';argsLabel.append('Command-line arguments',this.args);
    this.interactive.type='checkbox'; this.interactive.checked=draft?.interactive??true; this.interactive.onchange=()=>this.changed();
    const interactiveLabel=document.createElement('label');interactiveLabel.append(this.interactive,'Accept input while running');
    const upload=document.createElement('input');upload.type='file';upload.multiple=true;upload.setAttribute('aria-label','Program files');
    const fileNames=document.createElement('small');
    this.files=draft?.files??[]; fileNames.textContent=this.files.map(f=>f.name).join(', ');
    upload.onchange=async()=>{const files=Array.from(upload.files??[]);if(files.length>20 || files.some(f=>f.size>128000) || files.reduce((n,f)=>n+f.size,0)>1000000){this.status.textContent='Choose up to 20 text/code files, each up to 128 KB and 1 MB total.';return;}
      this.files=await Promise.all(files.map(async f=>({name:f.name,content:await f.text()})));fileNames.textContent=this.files.map(f=>f.name).join(', ');this.changed();};
    const help=document.createElement('small');help.textContent='Cells share a notebook folder. Use %%writefile path/to/file to save a project file, then a Bash or Zsh cell to build, install packages, or run project tests.';
    this.args.value=(draft?.argv??[]).map(a=>JSON.stringify(a)).join(' ');
    const browse=document.createElement('button');browse.type='button';browse.textContent='Notebook files…';browse.onclick=()=>this.owner.hooks.post({type:'cellFiles',attempt:this.born});
    inputs.append(summary,browse,inputLabel,argsLabel,interactiveLabel,upload,fileNames,help);
    const practiceTask = task?.source === 'Practice exercise';
    const extraActions = document.createElement('div'); extraActions.className = 'practice-actions';
    for (const [action, label] of [['check', 'Review with ' + this.assistant()], ['coach', 'Explain code']] as const) {
      if (action === 'check' && task) continue; // Task feedback is available from its review action.
      if (action === 'coach' && practiceTask) continue; // Practice asks in one place: the assistant box below the task.
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.dataset.action = action; button.onclick = () => this.act(action); this.actions.push(button);
      // Lesson and Doubt Solver cells keep Review and Explain beside Run; task cells ask from their own review action.
      (!task ? bar : extraActions).append(button);
    }
    this.prediction.rows = 1; this.prediction.maxLength = 600; this.prediction.className = 'practice-prediction';
    this.prediction.onfocus = () => this.owner.focus(this);
    // Predicting before running is the habit that turns runs into learning, so it stays in view above Run.
    const predictionLabel = document.createElement('label'); predictionLabel.className = 'predict-row';
    predictionLabel.hidden = !this.showPredictionRow;
    predictionLabel.textContent = this.predictionLabel;
    this.prediction.placeholder = 'Your prediction, before you run';
    predictionLabel.append(this.prediction);
    this.feedback.className = 'practice-feedback'; this.feedback.setAttribute('aria-live', 'polite'); this.feedback.hidden = true;
    const reflectionTitle = document.createElement('summary');
    reflectionTitle.textContent = 'More';
    this.reflection.className = 'practice-more';
    this.reflection.append(reflectionTitle);
    if (extraActions.childElementCount) this.reflection.append(extraActions);
    this.mismatch.className = 'cell-language-mismatch'; this.mismatch.setAttribute('role', 'status');
    this.switchLanguage.type = 'button'; this.switchLanguage.className = 'quiet';
    this.switchLanguage.onclick = () => {
      const language = cellLanguageMismatch(this.language, this.code.value);
      if (language) this.setLanguage(language);
    };
    this.mismatch.append(this.mismatchText, this.switchLanguage);
    this.completeness.className='code-completeness';this.completeness.setAttribute('role','status');
    this.element.append(heading, note, this.completeness, this.mismatch, buffer, inputs, predictionLabel, bar, this.reflection, this.status, this.resultBlock, this.feedback);
    if (task) {
      this.explanation.rows = 2; this.explanation.maxLength = 600;
      const label = document.createElement('label'); label.textContent = practiceTask ? 'In a sentence or two, how does your solution work?' : 'Explain your approach (optional)'; label.append(this.explanation);
      this.submitButton = document.createElement('button'); this.submitButton.type = 'button';
      this.submitButton.textContent = practiceTask ? 'Review my code' : 'Submit to ' + this.assistant(); this.submitButton.dataset.action = 'submit';
      this.submitButton.onclick = () => { void this.submit(); };
      this.reflection.append(label);
      (practiceTask ? this.reflection : bar).append(this.submitButton);
    }
    if (task?.source === 'Practice exercise') {
      this.tools.className = 'practice-tools';
      const make = (tool: PracticeTool, label: string, title: string) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = label; b.title = title;
        b.dataset.tool = tool; b.onclick = () => { void this.runTool(tool); }; this.tools.append(b); return b;
      };
      this.toolButtons = {
        tests: make('tests', 'Run sample tests', 'Run the published sample tests on this code'),
        trace: make('trace', 'Step through', 'Watch your program run one line at a time'),
        variation: make('variation', 'Try a new input', 'Predict what your program prints for new input, with no help'),
      };
      // Run and samples stay at hand; optional investigations and review share More.
      bar.append(this.toolButtons.tests);
      this.reflection.insertBefore(this.tools, this.submitButton ?? null);
      const availability = document.createElement('small'); availability.className = 'sample-availability';
      bar.after(availability);
      this.toolOutput.className = 'practice-tool-output'; this.toolOutput.hidden = true;
      this.manualChecks.hidden = true; this.manualChecks.setAttribute('role', 'status');
      this.status.after(this.manualChecks, this.toolOutput);
    }
    this.skills = new SkillPractice({
      canExecute: () => !this.missingPrediction,
      changed: () => this.owner.hooks.changed?.(),
      useInput: stdin => {
        if (!this.current() || this.busy || this.toolBusy) return;
        this.input.value = stdin; this.changed(); this.input.closest('details')!.open = true;
        this.input.focus(); this.status.textContent = `Test input copied. Enter your prediction in “${this.predictionLabel}”, then Run or Step through.`;
      },
      ask: (stage, message) => {
        if (!this.current() || this.busy || this.toolBusy || !this.owner.aiEnabled || !this.owner.hooks.tutor) return;
        this.owner.focus(this); this.busy = 'coach'; this.update(); void this.askTutor(stage, message);
      },
      run: async cases => {
        if (!this.owner.hooks.tool || !this.current() || this.busy || this.toolBusy) return {error:'Wait for the current action to finish.'};
        if (!this.languageMatches()) return {error:this.mismatchText.textContent ?? 'Check the cell language.'};
        this.toolBusy = true; this.update();
        try { return await this.owner.hooks.tool(this.snapshot(), 'my_tests', cases); }
        finally { this.toolBusy = false; this.update(); }
      },
      runCode: () => { void this.runTestCode(); },
    }, true, draft?.skills, this.lessonSkills);
    this.nativeDebug = new NativeDebugControls(action => { void this.debug(action); });
    if (!this.lessonSkills || this.lessonSkills.includes('debug')) this.skills.tools.append(this.nativeDebug.element);
    this.reflection.append(this.skills.element);
    this.historical.hidden = true;
    const historyLabel = document.createElement('summary'); historyLabel.textContent = 'Earlier run and feedback';
    this.historical.append(historyLabel); this.element.append(this.historical);
    if (draft) {
      this.input.value = draft.stdin; this.prediction.value = draft.prediction;
      this.explanation.value = draft.explanation; this.helped = draft.helped;
    }
    this.explanation.oninput = () => this.owner.hooks.changed?.();
    this.prediction.oninput = () => { this.update(); this.owner.hooks.changed?.(); };
    this.update();
  }
  private consoleKey(event: KeyboardEvent) {
    if (!this.owner.commandPrompt(this.language) || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.shiftKey) {
      if (event.key === 'Enter' && !this.busy && this.current()) {
        event.preventDefault(); event.stopPropagation(); insertNewlineAndIndent(this.code.view);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || this.busy || this.runButton.disabled || !this.code.value.trim()) return;
      this.act('run');
      if (this.busy === 'run') this.promptRequest = this.request;
      return;
    }
    if (this.busy || !this.current() || !this.commands.length || !['ArrowUp','ArrowDown'].includes(event.key)) return;
    const state = this.code.view.state;
    const line = state.doc.lineAt(state.selection.main.head).number;
    const up = event.key === 'ArrowUp';
    if (up ? line !== 1 || this.historyPosition === 0 : line !== state.doc.lines || this.historyPosition >= this.commands.length) return;
    event.preventDefault(); event.stopPropagation();
    if (this.historyPosition === this.commands.length) this.pendingInput = this.code.value;
    const next = this.historyPosition + (up ? -1 : 1);
    const value = this.commands[next] ?? this.pendingInput;
    this.code.view.dispatch({changes:{from:0,to:state.doc.length,insert:value},selection:{anchor:value.length}});
    this.historyPosition = next;
  }

  private finishPrompt(source: string, run: Execution) {
    const prefix = this.owner.commandPrompt(this.language);
    const output = [run.stdout.trimEnd(), run.stderr.trimEnd(), run.exit_code ? 'Exit ' + run.exit_code : '',
      run.truncated ? 'Output truncated.' : ''].filter(Boolean).join('\n');
    this.transcript.textContent = ((this.transcript.textContent || '') + prefix + ' ' + source + '\n' + (output ? output + '\n' : '')).slice(-32000);
    this.commands = [...this.commands, source].slice(-30);
    while (this.commands.join('\n').length > 24000) this.commands.shift();
    this.historyPosition = this.commands.length;
    this.pendingInput = '';
    this.submittedSource = source;
    this.resultBlock.hidden = true;
    this.transcript.hidden = false;
    this.transcript.scrollTop = this.transcript.scrollHeight;
    this.clearingPrompt = true;
    try { this.code.view.dispatch({changes:{from:0,to:this.code.value.length,insert:''}}); }
    finally { this.clearingPrompt = false; }
    this.owner.hooks.changed?.();
  }

  context() { return {snapshot:this.snapshot(), run:this.execution && observedRun(this.execution), prediction:this.execution ? this.runPrediction : this.prediction.value,
    focusLine:this.code.view.state.doc.lineAt(this.code.view.state.selection.main.head).number}; }
  focusLine(line: number) {
    if (!Number.isSafeInteger(line) || line < 1 || line > this.code.view.state.doc.lines) return;
    const target = this.code.view.state.doc.line(line);
    this.code.view.dispatch({selection:{anchor:target.from,head:target.to},scrollIntoView:true});
    this.element.scrollIntoView({block:'center'}); this.code.view.focus();
  }
  draft(): NotebookDraft {
    return {key:this.key, snippet:this.id, language:this.language, source:this.source, ...(this.submittedSource !== undefined ? {promptSubmitted:true as const} : {}), ...(this.commands.length ? {commandHistory:this.commands} : {}), stdin:this.input.value,argv:splitArgs(this.args.value),files:this.files,interactive:this.interactive.checked,
      prediction:this.prediction.value, explanation:this.explanation.value, helped:this.helped, skills:this.skills.snapshot()};
  }
  invalidateRun() {
    this.manualChecks.hidden = true;
    this.skills.invalidate();
    this.execution = undefined;
    if (!this.resultBlock.hidden) {
      this.markEarlierRun();
      this.status.textContent = 'Notebook code or runtime changed. This is an earlier output; run the required cells again.';
    }
  }
  markHelped() {
    this.helped = true;
    if (this.attemptVariation) this.attemptVariation.assisted = true;
    this.owner.hooks.changed?.();
  }
  private async askTutor(stage?: SkillStage, skillMessage?: string, debuggerState?: DebugEvidence, review = false) {
    if (!this.owner.hooks.tutor) return;
    const request = this.request;
    this.helped = true; this.owner.hooks.changed?.();
    if (this.attemptVariation) this.attemptVariation.assisted = true;
    try {
      const {snapshot, run, prediction} = this.context();
      const ok = await this.owner.hooks.tutor(snapshot, run,
        skillMessage || 'Explain what this code does, starting with the selected line.', prediction, stage, debuggerState, review);
      if (this.request === request) this.status.textContent = ok ? `Request sent to ${this.assistant()}.` : `Your request was not sent. Ask ${this.assistant()} again.`;
    } finally { if (this.request === request) { this.busy = undefined; this.update(); } }
  }
  private reviewRun() {
    this.busy = 'coach';
    this.status.textContent = `Asking ${this.assistant()} about this run…`;
    this.update();
    void this.askTutor(undefined, 'Review the result shown for this run and suggest one new case to test or one next debugging step.', undefined, true);
  }
  receiveDebug(revision:number,state:NativeDebugState) {
    this.nativeDebug.receive(revision,state);
    // A live debug session keeps its controls beside Run, even if More is collapsed.
    const live = ['starting','running','paused'].includes(state.phase);
    if (live !== this.debugging) { this.debugging = live; if (live) this.bar.after(this.nativeDebug.element); else this.skills.tools.append(this.nativeDebug.element); }
    this.update();
  }
  private async runTestCode() {
    if (this.missingPrediction || !this.owner.hooks.tool || !this.current() || this.busy || this.toolBusy || this.debugBusy) return;
    if (!this.languageMatches()) return;
    const revision = this.revision, request = ++this.request;
    this.owner.focus(this); this.toolBusy = true; this.beginRun(); this.update();
    this.status.textContent = 'Running this cell’s test program in a fresh process…';
    try {
      const reply = await this.owner.hooks.tool(this.snapshot(),'test_code');
      if (!this.current() || revision !== this.revision || request !== this.request) return;
      if (reply.error) { this.status.textContent = reply.error; return; }
      if (reply.execution) {
        const run = this.execution = reply.execution;
        this.output.textContent = (run.status === 'exited' ? `Exited with code ${run.exit_code}.` : run.status.replace(/_/g,' ') + '.')
          + '\n' + (run.stdout || '(No standard output)') + (run.stderr ? '\n' + run.stderr : '') + (run.truncated ? '\nOutput was truncated.' : '');
        this.resultBlock.hidden = this.output.hidden = false;
        this.status.textContent = 'Read the test runner’s summary and any assertion failure. A clean exit alone does not prove tests ran. Ask for unit-test help to discuss this result.';
      }
    } finally { this.toolBusy = false; this.update(); }
  }
  private async debug(action:NativeDebugAction) {
    if (!this.owner.hooks.debug || !this.current() || this.debugBusy || this.busy || this.toolBusy || (action === 'inspect' && !this.owner.aiEnabled)) return;
    if (action === 'start' && this.missingPrediction) return;
    if ((action === 'start' || action === 'open') && !this.languageMatches()) return;
    const revision = this.revision;
    this.debugBusy = true; this.owner.focus(this); this.update();
    try {
      const reply = await this.owner.hooks.debug(this.snapshot(),action);
      if (!this.current() || revision !== this.revision) return;
      if (reply.error) { this.nativeDebug.message(reply.error); return; }
      if (action === 'import' && typeof reply.source === 'string') {
        this.code.view.dispatch({changes:{from:0,to:this.code.value.length,insert:reply.source}});
        this.nativeDebug.message('Changes copied into this cell. Run your tests again to check the fix.');
      }
      if (action === 'inspect' && reply.evidence && this.owner.aiEnabled) {
        this.busy = 'coach';
        await this.askTutor('debug','Help me reason about this captured pause. Ask what I expect to change before I step.',reply.evidence);
      }
    } finally { this.debugBusy = false; this.update(); }
  }
  /** A lesson exercise (not Practice) whose current code differs from its starter and could be submitted now. */
  hasUnsentSolution() {
    return !!this.task && this.task.source !== 'Practice exercise' && this.born === this.owner.attempt
      && !!this.submitButton && !this.submitButton.disabled && this.source.trim() !== this.task.starter.trim();
  }
  /** The message bar sends this editor's code with the learner's message, as one submission. */
  async submitWithMessage(message: string) {
    if (!this.hasUnsentSolution()) return false;
    await this.submit(message);
    return this.submitted;
  }
  private async submit(message = '') {
    if (!this.task || this.submitButton?.disabled) return;
    this.submitting = true; this.update();
    const source = this.source, explanation = [this.explanation.value.trim(), message.trim()].filter(Boolean).join('\n\n').slice(0, 600);
    try {
      this.submitted = await this.owner.hooks.submit((this.task.source === 'Practice exercise' ? 'PRACTICE_NOTEBOOK_SUBMISSION\n' : 'TUTOR_TEXTBOOK_SUBMISSION\n') + JSON.stringify({
        checkpoint_id: this.task.checkpoint_id, question_id: this.task.question_id,
        source, explanation, helped: this.helped,
      }), (this.task.source === 'Practice exercise' ? 'Review my code\n\n' : 'Submitted solution\n\n') + source + (explanation.trim() ? '\n\n' + explanation : ''));
      this.status.textContent = this.task.source === 'Practice exercise'
        ? (this.submitted ? 'Feedback is in your notebook.' : `${this.assistant()} could not reply. Your code is still here; try again.`)
        : (this.submitted ? `Solution sent to ${this.assistant()}. Waiting for feedback.` : 'Solution was not sent. Your draft is still here; try again.');
    } catch (error) {
      this.submitted = false;
      this.status.textContent = (error instanceof Error ? error.message : this.assistant() + ' could not reply.')
        + ' Your code is still here; try again.';
    } finally { this.submitting = false; this.update(); }
  }
  private current() { return this.owner.connected && this.owner.attempt === this.born; }
  private snapshot(): CodeSnapshot {
    return {snippet: this.id, revision: this.revision, language: this.language,
      source: this.source, stdin: this.input.value, question: this.question,argv:splitArgs(this.args.value),files:this.files,interactive:this.interactive.checked};
  }
  private setLanguage(language: string) {
    if (this.languagePicker.disabled || !codeLanguage(language) || language === this.language) {
      this.languagePicker.value = this.language; return;
    }
    this.commands = []; this.historyPosition = 0; this.submittedSource = undefined; this.transcript.textContent = '';
    this.language = language; this.languagePicker.value = language;
    this.code.setLanguage(language);
    this.element.setAttribute('aria-label', codeLanguages[language] + ' practice editor');
    this.element.querySelector('.predict-row')!.firstChild!.textContent = this.predictionLabel;
    this.changed();
    this.status.textContent = 'Cell language changed to ' + codeLanguages[language] + '. Run to see a current result.';
  }
  private incompleteCode() {
    if(this.assistant()!=='Doubt Solver' || this.language!=='python' || this.task || this.question==='My notebook experiment')return '';
    const result=pythonCompleteness(this.code.value);
    return !result.syntax ? 'Complete the Python syntax before running this example.' : result.missing.length
      ? 'Missing setup: '+result.missing.join(', ')+'. Include the required definitions and inputs in this cell before running.' : '';
  }
  private languageMatches() {
    if (!cellLanguageMismatch(this.language, this.code.value)) return true;
    this.status.textContent = this.mismatchText.textContent;
    (this.task ? this.languagePicker : this.switchLanguage).focus();
    return false;
  }
  private markEarlierRun() {
    if (this.runTitle.textContent?.startsWith('Live run'))
      this.runTitle.textContent = this.runTitle.textContent.replace('Live run', 'Earlier run');
  }
  private archiveResult() {
    this.closeTerminal();
    if (!this.resultBlock.hidden || !this.feedback.hidden) {
      const earlier = document.createElement('div');
      this.markEarlierRun();
      if (!this.resultBlock.hidden) {
        const result = this.resultBlock.cloneNode(true) as HTMLElement;
        result.querySelectorAll('.lesson-trace, .lesson-prediction button').forEach(node => node.remove());
        earlier.append(result);
      }
      if (!this.feedback.hidden) earlier.append(this.feedback.cloneNode(true));
      this.historical.append(earlier); this.historical.hidden = false;
      while (this.historical.children.length > 6) this.historical.children[1].remove();
    }
    this.resultBlock.hidden = this.output.hidden = this.feedback.hidden = true;
    this.comparison.replaceChildren();
    this.output.textContent = ''; this.rich.replaceChildren(); this.feedback.replaceChildren();
  }
  private closeTerminal() {
    if (!this.terminal) return;
    this.terminal.dispose();
    this.terminal = undefined;
  }
  private beginRun() {
    this.archiveResult();
    this.manualChecks.hidden = true;
    this.cleanRun = -1; this.execution = undefined;
    this.runPrediction = this.predictFirst ? this.prediction.value : this.prediction.value.trim();
    this.runTitle.textContent = `Live run · ${this.id} #${++this.runCount}`;
    this.runInput.textContent = runInputs(this.snapshot());
    this.runInput.hidden = !this.runInput.textContent;
  }
  private changed() {
    if (this.clearingPrompt) return;
    this.submittedSource = undefined;
    this.promptRequest = undefined;
    this.historyPosition = this.commands.length;
    this.owner.focus(this);
    if (this.predictFirst) this.prediction.value = '';
    if (this.task?.source === 'Practice exercise') this.submitted = false;
    this.toolOutput.hidden = true;
    ++this.revision; ++this.request; this.busy = undefined; this.execution = undefined;
    this.archiveResult();
    this.owner.invalidateRuns();
    this.owner.hooks.changed?.();
    const row = this.element.querySelector('.predict-row');
    if (row?.firstChild) row.firstChild.textContent = this.predictionLabel; // Follows the code: print vs result.
    this.status.textContent = this.owner.commandPrompt(this.language) ? 'Enter to run. Shift+Enter adds a line.' : `Edited. Enter your prediction in “${this.predictionLabel}”, then Run.`;
    this.update();
    if (!this.current()) return;
    this.owner.hooks.post({type: 'codeChanged', attempt: this.born, ...this.snapshot()});
    clearTimeout(this.observationTimer); clearTimeout(this.guidanceTimer);
    if (this.owner.following && this.owner.aiEnabled) {
      this.observationTimer = setTimeout(() => this.observe(), 750);
      if (this.owner.stuckHints) this.offerHintAfter(STUCK_PAUSE_MS);
    }
  }
  private offerHintAfter(delay: number) {
    clearTimeout(this.guidanceTimer);
    this.guidanceTimer = setTimeout(() => {
      if (this.current() && !this.busy && this.owner.canGuide()) this.act('observe');
    }, delay);
  }
  observe(guidance?: string, explicit = false) {
    if (this.current() && this.owner.aiEnabled && (explicit || this.owner.following))
      this.owner.hooks.observe(this.snapshot(), this.execution && observedRun(this.execution), guidance);
  }
  private act(action: CodeAction['action']) {
    if (!this.current() || this.busy || this.toolBusy || (action !== 'run' && (!this.owner.aiEnabled || this.owner.tutorBusy))) return;
    if ((action === 'run' || action === 'check') && !this.languageMatches()) return;
    const incomplete=this.incompleteCode();
    if(incomplete && action==='run'){this.status.textContent=incomplete;return;}
    if(incomplete && action==='check') {
      this.busy='coach';void this.askTutor(undefined,'This lesson example is missing setup. '+incomplete+' Supply a complete runnable version using the exact lesson definitions. Preserve the exercise and do not reveal its answer.');return;
    }
    if(!validCellInputs(this.snapshot())){this.status.textContent='Use at most 32 arguments and up to 1 MB of input files.';return;}
    this.owner.focus(this);
    clearTimeout(this.guidanceTimer); clearTimeout(this.observationTimer);
    if (action === 'check' && this.execution && this.owner.hooks.tutor) {
      ++this.request;
      this.reviewRun();
      return;
    }
    if (this.missingPrediction && (action === 'run' || action === 'check')) {
      this.status.textContent = 'Enter your prediction before running this cell.';
      this.prediction.focus();
      return;
    }
    // Predict before Check, as in Practice. A second press skips, so it never blocks.
    if (this.showPredictionRow && action === 'check' && !this.prediction.value.trim() && this.skipPrediction !== this.revision) {
      this.skipPrediction = this.revision;
      this.status.textContent = `Enter your prediction in “${this.predictionLabel}” before running, or press Review with ${this.assistant()} again to skip.`;
      this.prediction.focus();
      return;
    }
    if (action === 'run' && this.attemptVariation && !this.prediction.value.trim()) {
      this.status.textContent = `Enter your prediction for the new input in “${this.predictionLabel}”, then Run.`;
      this.prediction.focus();
      return;
    }
    this.busy = action; ++this.request;
    if (action === 'run' || action === 'check') this.beginRun();
    else { this.feedback.hidden = true; this.feedback.replaceChildren(); }
    this.status.textContent = action === 'run' || action === 'check'
      ? `Preparing container… ${codeLanguages[this.language]} · ${this.owner.runtime}` : `Asking ${this.assistant()}…`;
    this.observe(undefined, action === 'coach' || action === 'check');
    if (this.owner.hooks.tutor && (action === 'coach' || action === 'observe')) { void this.askTutor(); return; }
    this.owner.hooks.post({type: 'codeAction', attempt: this.born, request: this.request,
      action: this.owner.hooks.tutor ? 'run' : action, message: '', prediction: action === 'run' && !this.predictFirst ? '' : this.prediction.value.trim(),
      ...this.snapshot()} satisfies CodeAction);
    this.update();
  }
  receive(result: CodeResult) {
    if (!this.current() || result.revision !== this.revision || result.request !== this.request || !this.busy) return;
    if (result.event?.kind === 'phase') {
      this.status.textContent = `${result.event.phase === 'preparing' ? 'Preparing container… You can keep working in the lesson.' : 'Running code…'} ${codeLanguages[this.language]} · ${this.owner.runtime}`;
      return;
    }
    if (result.event) {
      const event=result.event;
      if (event.kind === 'terminal') {
        if (!this.terminal) {
          const focus = document.activeElement;
          const focusTerminal = focus === this.code.view.contentDOM || focus === this.runButton
            || focus === document.body;
          this.output.hidden = true;
          this.resultBlock.hidden = !this.rich.childElementCount;
          const initialText = event.mode === 'stdin' ? this.output.textContent ?? ''
            : (this.transcript.textContent ?? '') + '$ ' + this.code.value + '\n';
          this.terminal = new CellTerminal(this.buffer, initialText, control => {
            this.owner.hooks.post({type:'cellControl', attempt:this.born, action:'terminal', id:event.id, control});
          });
          this.note.textContent = this.owner.runtime;
          if (this.busy === 'run' && this.owner.commandPrompt(this.language)) this.promptRequest = this.request;
          if (focusTerminal) this.terminal.focus();
        }
        if (event.data) this.terminal.write(event.data);
        return;
      }
      if (event.kind === 'stream') {
        if (this.terminal) this.terminal.write(event.text.replace(/\r?\n/g, '\r\n'));
        else {
          this.resultBlock.hidden = this.output.hidden = false;
          this.output.textContent = (this.output.textContent + event.text).slice(-200000);
        }
      }
      if(event.kind==='display'){
        this.resultBlock.hidden=false;
        const data=event.data;
        if(data['image/png'] || data['image/jpeg']){const mime=data['image/png']?'image/png':'image/jpeg';const img=document.createElement('img');img.src='data:'+mime+';base64,'+data[mime];img.alt='Cell output';img.style.maxWidth='100%';this.rich.append(img);}
        else if(data['text/html'] || data['image/svg+xml']){const frame=document.createElement('iframe');frame.setAttribute('sandbox','');frame.title='Cell display';frame.style.width='100%';frame.style.minHeight='12em';frame.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`+(data['text/html']??data['image/svg+xml']);this.rich.append(frame);}
        else if(data['text/plain']){const pre=document.createElement('pre');pre.textContent=data['text/plain'];this.rich.append(pre);}
      }
      return;
    }
    const returnToCommand = this.terminal?.element.contains(document.activeElement);
    this.closeTerminal();
    const entered = this.promptRequest === result.request;
    this.promptRequest = undefined;
    const demo = this.demonstration;
    const expected = demo && this.code.value.trimEnd() === demo.source.trimEnd() && this.language === demo.language
      ? demo.error : undefined;
    const demonstrated = matchesExpectedError(result.execution, expected);
    if ((this.busy === 'run' || this.busy === 'check') && (result.execution || result.error))
      this.owner.hooks.executionFinished?.(this.key, this.snapshot(), result.execution, result.error, expected);
    if (result.execution) {
      this.execution = result.execution;
      const run = result.execution;
      this.showManualChecks();
      const failed = run.status !== 'exited' || run.exit_code !== 0;
      if (run.runtime_target) this.runTitle.append(' · ' + run.runtime_target + ' · ' + this.language);
      const label = run.status === 'compile_error' ? `Compilation failed (exit code ${run.exit_code}).`
        : run.status === 'exited' ? `Exited with code ${run.exit_code}.` : run.status.replace(/_/g, ' ') + '.';
      const outputHeading = this.language === 'sql' ? (failed ? 'SQL execution failed\n' : 'Executed SQL output\n') : '';
      this.output.textContent = outputHeading + label + '\n' + (run.stdout || (this.language === 'sql' ? '(No query results)' : '(No standard output)'))
        + (run.stderr ? '\n' + run.stderr : '') + (run.truncated ? '\nOutput was truncated.' : '');
      this.resultBlock.hidden = this.output.hidden = false;
      if (this.predictFirst && this.runPrediction.trim()) {
        this.comparison.replaceChildren(lessonPrediction(this.code.value, this.runPrediction, run));
        this.output.hidden = !failed && !run.truncated && !run.stderr;
      }
      this.observe();
      if (this.busy === 'check' && this.owner.hooks.tutor) { this.reviewRun(); return; }
      if (this.busy === 'run') {
        this.busy = undefined;
        this.status.textContent = run.status==='cancelled' ? 'Stopped. You can edit or run another cell.'
          : run.status === 'compile_error' ? 'Compilation failed. Fix the compiler errors below, then run again.'
          : demonstrated ? `This example raised the expected ${expected}.`
          : failed ? `Run failed. Read the error below or ask ${this.assistant()} for help.`
          : run.truncated ? 'Run completed with truncated output. The full result is unavailable.'
          : !run.stdout.trim() && !run.stderr.trim() && !this.rich.childElementCount
            ? 'Run completed successfully with no output. Definitions, assignments and passing assertions can be silent. This confirms execution, not that every requirement was tested.'
          : `Run completed successfully. Ask ${this.assistant()} to discuss this result.`;
        if (failed && this.language === 'sql' && this.prediction.value.trim()) this.status.textContent += ' Your prediction has not been verified.';
        if (run.status === 'exited' && run.exit_code === 0 && !run.truncated) this.cleanRun = this.revision;
        if (this.attemptVariation) this.finishVariation(run);
        // Only a failed run that sits untouched suggests being stuck; first give time to read the error.
        if (failed && !demonstrated && this.owner.following && this.owner.stuckHints) this.offerHintAfter(FAILED_RUN_PAUSE_MS);
      }
    }
    if (result.feedback) {
      this.helped = true;
      this.feedback.hidden = false;
      const title = document.createElement('strong'); title.textContent = this.busy === 'check' ? 'Review feedback' : this.assistant();
      const body = document.createElement('p'); body.textContent = result.feedback.guidance;
      const prompt = document.createElement('p'); prompt.textContent = result.feedback.prompt;
      this.feedback.replaceChildren(title, body, prompt);
      this.observe(result.feedback.guidance, this.busy === 'check' || this.busy === 'coach');
      this.busy = undefined; this.status.textContent = 'Guidance for this version. This is practice feedback, not a mastery score.';
    }
    if (result.error) {
      this.busy = undefined;
      if (result.failureStage === 'preparing') {
        this.runTitle.textContent = `Setup attempt · ${this.id} #${this.runCount}`;
        this.status.textContent = 'Code did not run. Your work is here. You can continue the lesson and retry Run after setup.';
        this.output.textContent = result.error + '\n\nLesson diagrams and predicted output are lesson content, not output from this run.';
        this.resultBlock.hidden = this.output.hidden = false;
      } else {
        this.status.textContent = this.language === 'sql' ? 'SQL execution failed. No current query result. ' + result.error
          + (this.prediction.value.trim() ? ' Your prediction has not been verified.' : '') : result.error;
      }
    }
    if (entered && result.execution && result.execution.status === 'exited') {
      this.finishPrompt(this.code.value, result.execution);
      this.status.textContent = (result.execution.exit_code ? 'Command exited with code ' + result.execution.exit_code + '. ' : '')
        + 'Enter the next command. ↑ recalls a previous command.';
    }
    this.update();
    if (returnToCommand && !this.busy) this.code.view.focus();
  }
  get running() { return this.busy === 'run' || this.busy === 'check'; }
  update() {
    this.owner.hooks.runChanged?.();
    const active = this.current();
    const prompt = this.owner.commandPrompt(this.language);
    this.buffer.classList.toggle('command-buffer', !!prompt);
    this.prompt.textContent = prompt;
    this.prompt.hidden = !prompt;
    this.transcript.hidden = !prompt || !this.transcript.textContent;
    this.note.textContent = this.terminal ? this.owner.runtime : codeLanguages[this.language] + ' · ' + this.owner.runtime
      + (prompt ? '. Enter runs the command. Shift+Enter adds a line.' : this.language === 'python' ? '. Python cells share variables until the runtime restarts.' : '. Cells share files; SQL and DBA cells keep database state until Restart runtime.');
    if (!this.terminal && this.predictFirst) this.note.append(' Enter a prediction and run the cell to step through its lines.');
    const writable = this.owner.attempt === this.born;
    this.languagePicker.disabled = !writable || !!this.task || !!this.busy || this.toolBusy || this.debugBusy || this.debugging;
    this.switchLanguage.disabled = this.languagePicker.disabled;
    const incomplete=this.incompleteCode();this.completeness.hidden=!incomplete;
    this.completeness.textContent=incomplete ? incomplete+' Choose Review with Doubt Solver to request the complete example.' : '';
    const mismatch = cellLanguageMismatch(this.language, this.code.value);
    this.mismatch.hidden = !mismatch;
    if (mismatch) {
      this.mismatchText.textContent = `This looks like ${codeLanguages[mismatch]} code, but this cell is set to ${codeLanguages[this.language]}. `
        + (this.task ? `This exercise requires ${codeLanguages[this.language]}; use a separate ${codeLanguages[mismatch]} cell for this code.` : 'Switch the cell language before running.');
      this.switchLanguage.textContent = 'Switch to ' + codeLanguages[mismatch];
      this.switchLanguage.hidden = !!this.task;
    }
    if (!this.owner.following && this.busy === 'observe') { ++this.request; this.busy = undefined; this.status.textContent = 'Automatic guidance is paused.'; }
    // A document-change callback runs inside CodeMirror's update; reconfigure only on a state change.
    this.code.disabled = !writable || !!prompt && (this.busy === 'run' || this.busy === 'check'); this.input.disabled = !writable;
    this.prediction.disabled = !writable || this.predictFirst && (this.busy === 'run' || this.busy === 'check');
    this.prediction.placeholder = this.predictFirst ? 'Predict the output, or enter “no output”' : 'Your prediction, before you run';
    const predictRow = this.element.querySelector<HTMLElement>('.predict-row');
    if (predictRow) predictRow.hidden = !this.showPredictionRow;
    if (!active) this.closeTerminal();
    for (const button of this.actions) {
      const running=button.dataset.action==='run' && (this.busy==='run'||this.busy==='check');
      if(button.dataset.action==='run')button.textContent=running?'Stop':'Run';
      const needsPrediction = this.missingPrediction && !running
        && (button.dataset.action === 'run' || button.dataset.action === 'check' && !this.execution && !incomplete);
      button.disabled = needsPrediction || (button.dataset.action==='run' && !running && !!incomplete) || !active || (!running && (!!this.busy || this.toolBusy))
        || (button.dataset.action !== 'run' && (!this.owner.aiEnabled || this.owner.tutorBusy)) || (button.dataset.action !== 'coach' && !(button.dataset.action === 'check' ? this.source : this.code.value).trim());
    }
    this.explanation.disabled = !writable || this.submitting;
    if (this.toolButtons) {
      const tools = this.owner.practiceTools, idle = active && !this.busy && !this.toolBusy && !!this.code.value.trim();
      this.toolButtons.tests.hidden = false;
      this.toolButtons.tests.textContent = tools.tests ? `Run sample tests (${tools.tests})` : 'Sample tests unavailable';
      this.toolButtons.tests.title = tools.tests ? 'Run the published sample tests on this code' : 'No runnable sample tests are supplied for this exercise.';
      const availability = this.element.querySelector<HTMLElement>('.sample-availability')!;
      availability.textContent = tools.tests ? '' : 'No runnable sample tests are supplied. You can still Run, Review my code, or use your own tests under More tools.';
      availability.hidden = !!tools.tests;
      this.toolButtons.trace.hidden = !tools.trace;
      this.toolButtons.tests.disabled = !idle || !tools.tests; this.toolButtons.trace.disabled = !idle;
      // A new input comes after the sample tests pass (or a clean run when there are none).
      const ready = !tools.boundaryPractice && (tools.tests ? this.testsPassed === this.revision : this.cleanRun === this.revision);
      this.toolButtons.variation.disabled = !idle || !ready || !!this.attemptVariation;
      this.toolButtons.variation.hidden = !ready && !this.attemptVariation;
      this.toolButtons.variation.title = ready ? 'Predict what your program prints for new input, with no help'
        : tools.tests ? 'Pass the sample tests on this version first' : 'Run this version cleanly first';
    }
    this.nativeDebug.update(this.revision,active,this.owner.aiEnabled && !this.owner.tutorBusy,this.debugBusy || !!this.busy || this.toolBusy,!!this.code.value.trim() && !this.missingPrediction);
    this.skills.update(active && !this.busy && !this.toolBusy && !!this.code.value.trim(), this.owner.aiEnabled && !this.owner.tutorBusy && !!this.owner.hooks.tutor, writable,
      active && !this.busy && !this.toolBusy && !this.debugBusy);
    if (this.submitButton) this.submitButton.disabled = !active || !this.owner.aiEnabled || !!this.busy || this.toolBusy
      || this.owner.tutorBusy || this.submitting || (this.submitted && this.task?.source !== 'Practice exercise') || this.task?.checkpoint_id !== this.owner.activeCheckpoint
      || !this.source.trim() || this.source.length > 12000;
    if (!active) { this.skills.invalidate(); this.dispose(); this.busy = undefined; this.status.textContent = 'This session is inactive.'; }
    else if (this.status.textContent === 'This session is inactive.') this.status.textContent = `Ready. Enter your prediction in “${this.predictionLabel}”, then Run.`;
    if (!this.owner.aiEnabled || !this.owner.following) this.dispose();
    else if (!this.owner.stuckHints) clearTimeout(this.guidanceTimer);
  }
  async runTool(tool: PracticeTool) {
    if (!this.owner.hooks.tool || this.toolBusy || this.busy || !this.current()) return;
    if (!this.languageMatches()) return;
    if (!this.code.value.trim()) { this.status.textContent = 'Write your solution first.'; return; }
    const revision = this.revision;
    if (tool === 'tests') {
      this.testsPassed = -1;
      this.toolOutput.hidden = true;
    }
    this.toolBusy = true; this.update();
    this.status.textContent = tool === 'grade' ? 'Submitting for grading…' : tool === 'tests' ? 'Running the sample tests…' : tool === 'trace' ? 'Recording each step…' : 'Making a new input…';
    try {
      const reply = await this.owner.hooks.tool(this.snapshot(), tool);
      if (this.revision !== revision || !this.current()) return;
      if (reply.error) { this.status.textContent = reply.error; return; }
      if (tool === 'grade') this.status.textContent = '';
      if (reply.tests) this.showTests(reply.tests);
      if (reply.trace) this.showTrace(reply.trace);
      if (reply.variation) this.startVariation(reply.variation);
    } finally { this.toolBusy = false; this.update(); }
  }
  private showManualChecks() {
    const samples = this.owner.practiceTools.billSamples;
    if (this.task?.source !== 'Practice exercise' || !samples?.length) return;
    this.manualChecks.textContent = deliveryBillFeedback(samples, this.execution);
    this.manualChecks.hidden = false;
  }
  private showTests(rows: TestRow[]) {
    this.showManualChecks();
    const passed = rows.filter(r => r.verdict === 'passed').length;
    const allPassed = rows.length > 0 && passed === rows.length;
    this.testsPassed = allPassed ? this.revision : -1;
    const list = document.createElement('ul'); list.className = 'test-results';
    rows.forEach((row, i) => {
      const item = document.createElement('li'), ok = row.verdict === 'passed';
      item.textContent = `${ok ? '✓' : '✗'} Sample ${i + 1}: ${ok ? 'passed' : row.verdict.replace(/_/g, ' ')}`;
      if (ok && row.call) item.append(' · ' + row.call + ' → ' + row.actual.trim());
      if (!ok) {
        const detail = document.createElement('pre');
        detail.textContent = (row.stdin ? 'Input:\n' + row.stdin + '\n' : '') + 'Expected:\n' + row.expected + (row.call ? '\nYour function returned:\n' : '\nYour program printed:\n') + (row.actual || '(nothing)')
          + (row.stderr ? '\n' + row.stderr : '');
        item.append(detail);
      }
      list.append(item);
    });
    const title = document.createElement('strong'); title.textContent = `Sample tests: ${passed} of ${rows.length} passed`;
    const scope = document.createElement('p');
    scope.textContent = 'Sample tests are a quick check. They do not prove the whole solution is correct. Submit for grading to run hidden tests.';
    this.toolOutput.replaceChildren(title, scope, list); this.toolOutput.hidden = false;
    if (allPassed && this.owner.practiceTools.boundaryPractice) {
      this.status.textContent = 'Your function returned the expected values when the sample runner called it.';
      if (!this.owner.practiceTools.billSamples) {
        const next = document.createElement('p');
        next.textContent = 'Check the public calls and a boundary call of your own below the function. Print each result, choose Run, and compare it with your prediction.';
        this.toolOutput.append(next);
      }
      const grade = document.createElement('button');
      grade.type = 'button'; grade.className = 'quiet'; grade.textContent = 'Submit for grading';
      grade.onclick = () => { void this.runTool('grade'); };
      this.toolOutput.append(grade);
      return;
    }
    this.status.textContent = allPassed ? 'All sample tests pass. Try a new input, with no help, to check your understanding.' : 'Compare what you expected with what your program printed.';
  }
  private showTrace(trace: NonNullable<ToolReply['trace']>) {
    const lines = this.code.value.split('\n');
    let index = 0;
    const header = document.createElement('strong'), line = document.createElement('pre'), values = document.createElement('dl'), printed = document.createElement('pre');
    const prev = document.createElement('button'), next = document.createElement('button');
    prev.type = next.type = 'button'; prev.className = next.className = 'quiet'; prev.textContent = '← Previous'; next.textContent = 'Next →';
    const show = () => {
      const step = trace.steps[index];
      header.textContent = `Step ${index + 1} of ${trace.steps.length} · line ${step.line}${step.function !== '<module>' ? ' in ' + step.function : ''}`;
      line.textContent = `${step.line} | ${lines[step.line - 1] ?? ''}` + (step.exception ? '\n' + step.exception : '');
      values.replaceChildren(...Object.entries(step.locals).flatMap(([name, value]) => {
        const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; return [dt, dd];
      }));
      printed.textContent = 'Printed so far:\n' + (trace.stdout.slice(0, step.output ?? 0) || '(nothing yet)');
      prev.disabled = index === 0; next.disabled = index === trace.steps.length - 1;
    };
    prev.onclick = () => { index--; show(); }; next.onclick = () => { index++; show(); };
    const nav = document.createElement('div'); nav.className = 'trace-nav'; nav.append(prev, next);
    values.className = 'trace-values'; line.className = 'trace-line';
    const note = document.createElement('small');
    note.textContent = 'Before each step, guess which value will change.' + (trace.stopped === 'limit' ? ' Only the first steps were recorded.' : '');
    this.toolOutput.replaceChildren(header, line, values, printed, nav, note); this.toolOutput.hidden = false;
    show();
    this.status.textContent = 'Step through your program with Next.';
  }
  private startVariation(variation: Variation) {
    this.attemptVariation = {variation, previousStdin: this.input.value, assisted: false};
    this.input.value = variation.stdin ?? this.input.value;
    this.prediction.value = '';
    this.changed();
    this.input.closest('details')?.setAttribute('open', '');
    this.reflection.open = true; this.prediction.focus();
    const note = document.createElement('p'); note.textContent = variation.prompt;
    this.toolOutput.replaceChildren(note); this.toolOutput.hidden = false;
    this.status.textContent = `Enter your prediction for the new input in “${this.predictionLabel}”, then Run.`;
  }
  private finishVariation(run: Execution) {
    const current = this.attemptVariation!;
    this.attemptVariation = undefined;
    const outcome = judgeVariation(current.variation, this.runPrediction, run, current.assisted);
    const title = document.createElement('strong');
    title.textContent = outcome.prediction.exact && outcome.clean && !current.assisted ? 'You predicted it exactly, on your own.' : 'Not quite yet.';
    const detail = document.createElement('p');
    detail.textContent = predictionFeedback(outcome.prediction) + (current.assisted ? ' You asked for help during this attempt, so it does not count as independent.' : '')
      + (!outcome.clean ? ' The program did not finish cleanly.' : '');
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'quiet'; restore.textContent = 'Restore my input';
    restore.onclick = () => { this.input.value = current.previousStdin; this.changed(); };
    this.toolOutput.replaceChildren(title, detail, restore); this.toolOutput.hidden = false;
  }
  cancelPending(message = 'Assistance settings changed. Run again for a current result.') {
    this.closeTerminal();
    this.skills.invalidate();
    this.testsPassed = -1; this.toolOutput.hidden = this.manualChecks.hidden = true;
    ++this.request; this.busy = undefined; this.execution = undefined;
    this.resultBlock.hidden = this.output.hidden = this.feedback.hidden = true;
    this.status.textContent = message;
    this.dispose();
  }
  dispose() { clearTimeout(this.observationTimer); clearTimeout(this.guidanceTimer); }
  destroy() {
    this.closeTerminal();
    this.skills.invalidate(); this.skills.update(false, false, false);
    this.nativeDebug.update(this.revision,false,false,false,false);
    this.dispose();
    this.resizeButton.disabled = true; this.resizeButton.onclick = null;
    this.languagePicker.disabled = this.switchLanguage.disabled = true;
    const saved = document.createElement('pre'); saved.textContent = this.code.value;
    this.code.view.dom.replaceWith(saved); this.code.destroy();
  }
}
