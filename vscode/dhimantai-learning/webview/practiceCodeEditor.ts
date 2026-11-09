import { cellLanguage as codeLanguage, cellLanguages as codeLanguages, observedRun, validCellInputs } from '../src/roomCode';
import type { CodeAction, CodeResult, CodeSnapshot, Execution } from '../src/roomCode';
import { splitArgs } from '../src/practiceIpynb';
import { CodeBuffer } from './codeBuffer';
import { expandIcon, collapseIcon } from './icons';
import type { NotebookDraft } from '../src/tutorNotebook';
import { judgeVariation, predictionFeedback } from '../src/learningLoop';
import type { Variation } from '../src/learningLoop';
import type { LearnerTestCase, SkillStage } from '../src/skillPractice';
import { SkillPractice } from './skillPractice';
import { NativeDebugControls } from './nativeDebugControls';
import type { DebugEvidence, NativeDebugAction, NativeDebugReply, NativeDebugState } from '../src/debugEvidence';

// Unrequested hints interrupt thinking, so they are opt-in and wait for signs of being stuck.
export const STUCK_PAUSE_MS = 90000, FAILED_RUN_PAUSE_MS = 30000, HINT_GAP_MS = 120000;

type Hooks = {
  /** The assistant answering in this room right now (Instructor or Doubt Solver). */
  assistant?: () => string;
  post: (message: unknown) => void;
  observe: (snapshot: CodeSnapshot, run?: ReturnType<typeof observedRun>, guidance?: string) => void;
  submit: (text: string, display: string) => Promise<boolean>;
  tutor?: (snapshot: CodeSnapshot, run: ReturnType<typeof observedRun> | undefined, message: string, prediction: string, stage?: SkillStage, debuggerState?: DebugEvidence) => Promise<boolean>;
  changed?: () => void;
  debug?: (snapshot:CodeSnapshot, action:NativeDebugAction) => Promise<NativeDebugReply>;
  /** Practice tools that only run code: sample tests, a Python step-through and a new input. */
  tool?: (snapshot: CodeSnapshot, tool: PracticeTool, cases?: LearnerTestCase[]) => Promise<ToolReply>;
};
export type PracticeTool = 'tests' | 'trace' | 'variation' | 'my_tests' | 'test_code';
type TestRow = {id: string; verdict: string; stdin: string; expected: string; actual: string; stderr: string};
type TraceStepView = {line: number; event: string; function: string; output: number | null; locals: Record<string, string>; exception?: string};
export type ToolReply = {error?: string; tests?: TestRow[]; variation?: Variation; execution?:Execution;
  trace?: {steps: TraceStepView[]; stdout: string; stopped: string | null; error: string | null}};

type TextbookTask = {question_id: string; checkpoint_id: string; language: string; starter: string; question: string; source: string};
function textbookTask(value: any): value is TextbookTask {
  return value && ['question_id', 'checkpoint_id'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 100)
    && typeof value.language === 'string' && !!codeLanguage(value.language)
    && typeof value.starter === 'string' && value.starter.length <= 12000
    && typeof value.question === 'string' && !!value.question.trim() && value.question.length <= 6000
    && ['Textbook exercise', 'Practice exercise'].includes(value.source);
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
  solution() { return this.editors.find(editor => editor.task?.source === 'Practice exercise')?.context(); }
  context(id: string) { return this.editors.find(editor => editor.id === id)?.context(); }
  selection() { return (this.focused ?? this.editors.find(editor => !!editor.task) ?? this.editors[0])?.context(); }
  contexts() { return this.editors.map(editor => editor.context()); }
  focusLine(id: string, line: number) { this.editors.find(editor => editor.id === id)?.focusLine(line); }
  drafts() { return this.editors.map(editor => editor.draft()); }
  removeCell(cellId: string) {
    const removed = this.editors.filter(editor => editor.key.startsWith(cellId + ':'));
    for (const editor of removed) {
      editor.cancelPending(); editor.destroy(); this.restored.delete(editor.key);
      if (this.focused === editor) this.focused = undefined;
    }
    this.editors = this.editors.filter(editor => !removed.includes(editor));
  }
  restore(drafts: NotebookDraft[]) {
    this.clear();
    this.restored = new Map(drafts.map(draft => [draft.key, draft]));
    this.counter = Math.max(0, ...drafts.map(draft => Number(draft.snippet.slice(5))));
  }
  invalidateRuns() { for (const editor of this.editors) editor.invalidateRun(); }
  restartRuntime() { for (const editor of this.editors) { editor.cancelPending(); editor.update(); } }
  add(body: HTMLElement, key: string, language = 'python', source = '') {
    const saved = this.restored.get(key);
    const editor = new PracticeCodeEditor(this, saved?.snippet ?? 'code-' + ++this.counter,
      saved?.language ?? language, saved?.source ?? source, 'My notebook experiment', undefined, key, saved);
    this.editors.push(editor); body.append(editor.element);
  }
  connected = false;
  tutorBusy = false;
  aiEnabled = true;
  runtime = 'Local language tools';
  following = true;
  stuckHints = false;
  attempt = 0;
  activeCheckpoint = '';
  /** What the open Practice exercise offers; set when Practice is ready. */
  practiceTools = {tests: 0, trace: false};
  constructor(readonly hooks: Hooks) {}
  focus(editor: PracticeCodeEditor) { this.focused = editor; }
  markHelped(id: string) { this.editors.find(editor => editor.id === id)?.markHelped(); }
  flushObservation() { this.focused?.observe(); }
  checkpoint(id: string) {
    this.activeCheckpoint = id;
    for (const editor of this.editors) editor.update();
  }
  mount(body: HTMLElement, question: string, task?: unknown, cellId = 'cell-' + this.counter) {
    if (textbookTask(task)) {
      // Replaying a question moves its existing editor, preserving the learner's draft.
      const saved = this.editors.find(editor => editor.task?.checkpoint_id === task.checkpoint_id && editor.born === this.attempt);
      const key = 'checkpoint:' + task.checkpoint_id, draft = this.restored.get(key);
      const editor = saved ?? new PracticeCodeEditor(this, draft?.snippet ?? 'code-' + ++this.counter,
        codeLanguage(task.language)!, draft?.source ?? task.starter, task.question, task, key, draft);
      if (!saved) this.editors.push(editor);
      body.append(editor.element);
      return; // Public examples stay read-only; exactly one solution editor, even without a fence.
    }
    let index = 0;
    for (const code of body.querySelectorAll<HTMLElement>('pre > code')) {
      const label = Array.from(code.classList).find(c => c.startsWith('language-'))?.slice(9) ?? '';
      const language = codeLanguage(label);
      if (!language || !code.textContent?.trim() || code.textContent.length > 12000) continue;
      const key = cellId + ':' + index++, draft = this.restored.get(key);
      const editor = new PracticeCodeEditor(this, draft?.snippet ?? 'code-' + ++this.counter, language, draft?.source ?? code.textContent, question.slice(0, 6000), undefined, key, draft);
      this.editors.push(editor);
      code.parentElement!.replaceWith(editor.element);
    }
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
  clear() { this.editors.forEach(e => e.destroy()); this.editors = []; this.focused = undefined; this.activeCheckpoint = ''; }
  receiveDebug(message: {snippet:string;revision:number;state:NativeDebugState}) {
    this.editors.find(e => e.id === message.snippet)?.receiveDebug(message.revision,message.state);
  }
  receive(message: CodeResult) {
    if (message.attempt === this.attempt) this.editors.find(e => e.id === message.snippet)?.receive(message);
  }
  canGuide() {
    if (!this.connected || !this.aiEnabled || !this.following || !this.stuckHints
        || Date.now() - this.lastGuidance < HINT_GAP_MS) return false;
    this.lastGuidance = Date.now(); return true;
  }
}

class PracticeCodeEditor {
  readonly element = document.createElement('section');
  private code: CodeBuffer;
  private input = document.createElement('textarea');
  private args = document.createElement('input');
  private interactive = document.createElement('input');
  private files:{name:string;content:string}[]=[];
  private rich = document.createElement('div');
  private liveInput = document.createElement('input');
  private inputControls = document.createElement('div');
  private prediction = document.createElement('textarea');
  private skipPrediction = -1;
  private output = document.createElement('pre');
  private feedback = document.createElement('div');
  private status = document.createElement('p');
  private resizeButton = document.createElement('button');
  private actions: HTMLButtonElement[] = [];
  private revision = 0;
  private request = 0;
  private busy?: CodeAction['action'];
  private execution?: Execution;
  private observationTimer?: ReturnType<typeof setTimeout>;
  private guidanceTimer?: ReturnType<typeof setTimeout>;
  readonly born: number;
  private submitButton?: HTMLButtonElement;
  private explanation = document.createElement('textarea');
  private submitting = false;
  private submitted = false;
  private historical = document.createElement('details');
  private helped = false;
  private reflection = document.createElement('details');
  private tools = document.createElement('div');
  private toolButtons: Record<Exclude<PracticeTool, 'my_tests' | 'test_code'>, HTMLButtonElement> | undefined;
  private toolOutput = document.createElement('div');
  private toolBusy = false;
  private testsPassed = -1;
  private cleanRun = -1;
  private skills: SkillPractice;
  private nativeDebug: NativeDebugControls;
  private debugBusy = false;
  private attemptVariation?: {variation: Variation; previousStdin: string; assisted: boolean};
  private bar!: HTMLElement;
  private debugging = false;
  private assistant() { return this.owner.hooks.assistant?.() ?? 'Instructor'; }
  constructor(private owner: PracticeCodeEditors, readonly id: string, private language: string,
      source: string, private question: string, readonly task?: TextbookTask, readonly key = id, draft?: NotebookDraft) {
    this.born = owner.attempt;
    this.element.className = 'practice-code-editor';
    this.element.setAttribute('aria-label', codeLanguages[language] + ' practice editor');
    const title = document.createElement('strong'); title.textContent = codeLanguages[language] + ' · Code cell';
    const heading = document.createElement('div'); heading.className = 'practice-editor-heading';
    heading.append(title, this.resizeButton);
    const note = document.createElement('small'); note.textContent = owner.runtime + (language === 'python' ? '. Python cells share variables until the runtime restarts.' : '. Cells share files. Use shell cells for project builds and package setup.');
    const buffer = document.createElement('div'); buffer.className = 'practice-buffer';
    buffer.id = id + '-buffer';
    this.resizeButton.type = 'button'; this.resizeButton.innerHTML = expandIcon;
    this.resizeButton.className = 'editor-resize';
    this.resizeButton.title = 'Enlarge editor';
    this.resizeButton.setAttribute('aria-label', 'Enlarge editor');
    this.resizeButton.setAttribute('aria-controls', buffer.id);
    this.resizeButton.setAttribute('aria-expanded', 'false');
    this.resizeButton.onclick = () => {
      const expanded = buffer.classList.toggle('is-enlarged');
      this.resizeButton.innerHTML = expanded ? collapseIcon : expandIcon;
      this.resizeButton.title = expanded ? 'Shrink editor' : 'Enlarge editor';
      this.resizeButton.setAttribute('aria-label', this.resizeButton.title);
      this.resizeButton.setAttribute('aria-expanded', String(expanded));
      this.code.view.requestMeasure();
    };
    this.code = new CodeBuffer(buffer, source, language, () => this.changed(), () => this.owner.focus(this),(source,offset)=>this.owner.complete(this.language,source,offset));
    this.input.onfocus = () => this.owner.focus(this);
    this.input.rows = 2; this.input.maxLength = 4000; this.input.oninput = () => this.changed();
    const inputLabel = document.createElement('label'); inputLabel.textContent = 'Standard input (stdin)'; inputLabel.append(this.input);
    const inputs = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Program input';
    this.args.maxLength=4000;this.args.placeholder = 'Arguments, for example --count "two words"'; this.args.oninput=()=>this.changed();
    this.interactive.type='checkbox'; this.interactive.checked=draft?.interactive??true; this.interactive.onchange=()=>this.changed();
    const interactiveLabel=document.createElement('label');interactiveLabel.append(this.interactive,'Accept input while running');
    const upload=document.createElement('input');upload.type='file';upload.multiple=true;upload.setAttribute('aria-label','Program files');
    const fileNames=document.createElement('small');
    this.files=draft?.files??[]; fileNames.textContent=this.files.map(f=>f.name).join(', ');
    upload.onchange=async()=>{const files=Array.from(upload.files??[]);if(files.length>20 || files.some(f=>f.size>128000) || files.reduce((n,f)=>n+f.size,0)>1000000){this.status.textContent='Choose up to 20 text/code files, each up to 128 KB and 1 MB total.';return;}
      this.files=await Promise.all(files.map(async f=>({name:f.name,content:await f.text()})));fileNames.textContent=this.files.map(f=>f.name).join(', ');this.changed();};
    const help=document.createElement('small');help.textContent='Cells share a notebook folder. Use %%writefile path/to/file to save a project file, then a Bash or Zsh cell to build, install packages, or run project tests.';
    this.liveInput.placeholder='Input for the running program';this.liveInput.setAttribute('aria-label','Live program input');
    const send=document.createElement('button');send.type='button';send.textContent='Send input';
    send.onclick=()=>{this.owner.hooks.post({type:'cellControl',attempt:this.born,action:'input',value:this.liveInput.value});this.liveInput.value='';};
    this.liveInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();send.click();}};
    const eof=document.createElement('button');eof.type='button';eof.textContent='End input';eof.onclick=()=>this.owner.hooks.post({type:'cellControl',attempt:this.born,action:'input',value:null});
    this.inputControls.append(this.liveInput,send,eof);this.inputControls.hidden=true;
    this.args.value=(draft?.argv??[]).map(a=>JSON.stringify(a)).join(' ');
    const browse=document.createElement('button');browse.type='button';browse.textContent='Notebook files…';browse.onclick=()=>this.owner.hooks.post({type:'cellFiles',attempt:this.born});
    inputs.append(summary,browse,inputLabel,this.args,interactiveLabel,upload,fileNames,help,this.inputControls);
    const bar = document.createElement('div'); bar.className = 'practice-actions';
    const practiceTask = task?.source === 'Practice exercise';
    const extraActions = document.createElement('div'); extraActions.className = 'practice-actions';
    for (const [action, label] of [['run', 'Run'], ['check', 'Review with ' + this.assistant()], ['coach', 'Explain code']] as const) {
      if (action === 'check' && task) continue; // Task feedback is available from its review action.
      if (action === 'coach' && practiceTask) continue; // Practice asks in one place: the assistant box below the task.
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.dataset.action = action; button.onclick = () => {if(action==='run' && this.busy){this.owner.hooks.post({type:'cellControl',attempt:this.born,action:'stop'});return;}this.act(action);}; this.actions.push(button);
      // Lesson and Doubt Solver cells keep Review and Explain beside Run; task cells ask from their own review action.
      (action === 'run' || !task ? bar : extraActions).append(button);
    }
    this.prediction.rows = 1; this.prediction.maxLength = 600; this.prediction.className = 'practice-prediction';
    this.prediction.onfocus = () => this.owner.focus(this);
    // Predicting before running is the habit that turns runs into learning, so it stays in view above Run.
    const predictionLabel = document.createElement('label'); predictionLabel.className = 'predict-row';
    predictionLabel.textContent = 'I expect it to print'; this.prediction.placeholder = 'Your prediction, before you run';
    predictionLabel.append(this.prediction);
    this.status.className = 'practice-status'; this.status.setAttribute('role', 'status');
    this.output.className = 'practice-output'; this.output.hidden = true;
    this.feedback.className = 'practice-feedback'; this.feedback.setAttribute('aria-live', 'polite'); this.feedback.hidden = true;
    const reflectionTitle = document.createElement('summary');
    reflectionTitle.textContent = 'More';
    this.reflection.className = 'practice-more';
    this.reflection.append(reflectionTitle);
    if (extraActions.childElementCount) this.reflection.append(extraActions);
    this.element.append(heading, note, buffer, inputs, predictionLabel, bar, this.reflection, this.status, this.output, this.rich, this.feedback);
    this.bar = bar;
    if (task) {
      title.textContent = codeLanguages[language] + ' · ' + task.source;
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
      this.element.insertBefore(this.toolOutput, this.status.nextSibling);
    }
    this.skills = new SkillPractice({
      changed: () => this.owner.hooks.changed?.(),
      useInput: stdin => {
        if (!this.current() || this.busy || this.toolBusy) return;
        this.input.value = stdin; this.changed(); this.input.closest('details')!.open = true;
        this.input.focus(); this.status.textContent = 'Test input copied. Predict the result, then Run or Step through to investigate.';
      },
      ask: (stage, message) => {
        if (!this.current() || this.busy || this.toolBusy || !this.owner.aiEnabled || !this.owner.hooks.tutor) return;
        this.owner.focus(this); this.busy = 'coach'; this.update(); void this.askTutor(stage, message);
      },
      run: async cases => {
        if (!this.owner.hooks.tool || !this.current() || this.busy || this.toolBusy) return {error:'Wait for the current action to finish.'};
        this.toolBusy = true; this.update();
        try { return await this.owner.hooks.tool(this.snapshot(), 'my_tests', cases); }
        finally { this.toolBusy = false; this.update(); }
      },
      runCode: () => { void this.runTestCode(); },
    }, true, draft?.skills);
    this.nativeDebug = new NativeDebugControls(action => { void this.debug(action); });
    this.skills.tools.append(this.nativeDebug.element);
    this.reflection.append(this.skills.element);
    this.historical.hidden = true;
    const historyLabel = document.createElement('summary'); historyLabel.textContent = 'Earlier run and feedback';
    this.historical.append(historyLabel); this.element.append(this.historical);
    if (draft) {
      this.input.value = draft.stdin; this.prediction.value = draft.prediction;
      this.explanation.value = draft.explanation; this.helped = draft.helped;
    }
    this.prediction.oninput = this.explanation.oninput = () => this.owner.hooks.changed?.();
    this.update();
  }
  context() { return {snapshot:this.snapshot(), run:this.execution && observedRun(this.execution), prediction:this.prediction.value,
    focusLine:this.code.view.state.doc.lineAt(this.code.view.state.selection.main.head).number}; }
  focusLine(line: number) {
    if (!Number.isSafeInteger(line) || line < 1 || line > this.code.view.state.doc.lines) return;
    const target = this.code.view.state.doc.line(line);
    this.code.view.dispatch({selection:{anchor:target.from,head:target.to},scrollIntoView:true});
    this.element.scrollIntoView({block:'center'}); this.code.view.focus();
  }
  draft(): NotebookDraft {
    return {key:this.key, snippet:this.id, language:this.language, source:this.code.value, stdin:this.input.value,argv:splitArgs(this.args.value),files:this.files,interactive:this.interactive.checked,
      prediction:this.prediction.value, explanation:this.explanation.value, helped:this.helped, skills:this.skills.snapshot()};
  }
  invalidateRun() {
    this.skills.invalidate();
    this.execution = undefined;
    if (!this.output.hidden) this.status.textContent = 'Notebook code or runtime changed. This is an earlier output; run the required cells again.';
  }
  markHelped() {
    this.helped = true;
    if (this.attemptVariation) this.attemptVariation.assisted = true;
    this.owner.hooks.changed?.();
  }
  private async askTutor(stage?: SkillStage, skillMessage?: string, debuggerState?: DebugEvidence) {
    if (!this.owner.hooks.tutor) return;
    const revision = this.revision;
    this.helped = true; this.owner.hooks.changed?.();
    if (this.attemptVariation) this.attemptVariation.assisted = true;
    try {
      const ok = await this.owner.hooks.tutor(this.snapshot(), this.execution && observedRun(this.execution),
        skillMessage || (this.busy === 'check' ? 'Review my current attempt using this run. Help me reason about what to try next.' : 'Help me understand this code. Give me one focused hint or question.'), this.prediction.value, stage, debuggerState);
      if (this.revision === revision) this.status.textContent = ok ? `${this.assistant()} will respond here in the notebook.` : `Your request was not sent. Ask ${this.assistant()} again.`;
    } finally { if (this.revision === revision) { this.busy = undefined; this.update(); } }
  }
  receiveDebug(revision:number,state:NativeDebugState) {
    this.nativeDebug.receive(revision,state);
    // A live debug session keeps its controls beside Run, even if More is collapsed.
    const live = ['starting','running','paused'].includes(state.phase);
    if (live !== this.debugging) { this.debugging = live; if (live) this.bar.after(this.nativeDebug.element); else this.skills.tools.append(this.nativeDebug.element); }
    this.update();
  }
  private async runTestCode() {
    if (!this.owner.hooks.tool || !this.current() || this.busy || this.toolBusy || this.debugBusy) return;
    const revision = this.revision, request = ++this.request;
    this.owner.focus(this); this.toolBusy = true; this.execution = undefined; this.output.hidden = true; this.output.textContent=''; this.rich.replaceChildren(); this.update();
    this.status.textContent = 'Running this cell’s test program in a fresh process…';
    try {
      const reply = await this.owner.hooks.tool(this.snapshot(),'test_code');
      if (!this.current() || revision !== this.revision || request !== this.request) return;
      if (reply.error) { this.status.textContent = reply.error; return; }
      if (reply.execution) {
        const run = this.execution = reply.execution;
        this.output.textContent = (run.status === 'exited' ? `Exited with code ${run.exit_code}.` : run.status.replace(/_/g,' ') + '.')
          + '\n' + (run.stdout || '(No standard output)') + (run.stderr ? '\n' + run.stderr : '') + (run.truncated ? '\nOutput was truncated.' : '');
        this.output.hidden = false;
        this.status.textContent = 'Read the test runner’s summary and any assertion failure. A clean exit alone does not prove tests ran. Ask for unit-test help to discuss this result.';
      }
    } finally { this.toolBusy = false; this.update(); }
  }
  private async debug(action:NativeDebugAction) {
    if (!this.owner.hooks.debug || !this.current() || this.debugBusy || this.busy || this.toolBusy || (action === 'inspect' && !this.owner.aiEnabled)) return;
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
  private async submit() {
    if (!this.task || this.submitButton?.disabled) return;
    this.submitting = true; this.update();
    const source = this.code.value, explanation = this.explanation.value;
    try {
      this.submitted = await this.owner.hooks.submit((this.task.source === 'Practice exercise' ? 'PRACTICE_NOTEBOOK_SUBMISSION\n' : 'TUTOR_TEXTBOOK_SUBMISSION\n') + JSON.stringify({
        checkpoint_id: this.task.checkpoint_id, question_id: this.task.question_id,
        source, explanation, helped: this.helped,
      }), (this.task.source === 'Practice exercise' ? 'Review my code\n\n' : 'Submitted solution\n\n') + source + (explanation.trim() ? '\n\n' + explanation : ''));
      this.status.textContent = this.task.source === 'Practice exercise'
        ? (this.submitted ? 'Feedback is in your notebook.' : `${this.assistant()} could not reply. Your code is still here; try again.`)
        : (this.submitted ? `Solution sent to ${this.assistant()}. Waiting for feedback.` : 'Solution was not sent. Your draft is still here; try again.');
    } finally { this.submitting = false; this.update(); }
  }
  private current() { return this.owner.connected && this.owner.attempt === this.born; }
  private snapshot(): CodeSnapshot {
    return {snippet: this.id, revision: this.revision, language: this.language,
      source: this.code.value, stdin: this.input.value, question: this.question,argv:splitArgs(this.args.value),files:this.files,interactive:this.interactive.checked};
  }
  private changed() {
    this.owner.focus(this);
    if (this.task?.source === 'Practice exercise') this.submitted = false;
    ++this.revision; ++this.request; this.busy = undefined; this.execution = undefined;
    if (!this.output.hidden || !this.feedback.hidden || this.rich.childElementCount) {
      const earlier = document.createElement('div');
      if (!this.output.hidden) earlier.append(this.output.cloneNode(true));
      if (!this.feedback.hidden) earlier.append(this.feedback.cloneNode(true));
      if(this.rich.childElementCount)earlier.append(this.rich.cloneNode(true));
      this.historical.append(earlier); this.historical.hidden = false;
      while (this.historical.children.length > 6) this.historical.children[1].remove();
    }
    this.owner.invalidateRuns();
    this.owner.hooks.changed?.();
    this.output.hidden = true; this.output.textContent = ''; this.rich.replaceChildren(); this.feedback.hidden = true; this.feedback.replaceChildren();
    this.status.textContent = 'Edited. Predict, then Run to see a current result.';
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
    if(!validCellInputs(this.snapshot())){this.status.textContent='Use at most 32 arguments and up to 1 MB of input files.';return;}
    this.owner.focus(this);
    // Predict before Check, as in Practice. A second press skips, so it never blocks.
    if (action === 'check' && !this.prediction.value.trim() && this.skipPrediction !== this.revision) {
      this.skipPrediction = this.revision;
      this.status.textContent = `Write your prediction before reviewing. Or press Review with ${this.assistant()} again to skip.`;
      this.prediction.focus();
      return;
    }
    if (action === 'run' && this.attemptVariation && !this.prediction.value.trim()) {
      this.status.textContent = 'New input: write exactly what you expect your program to print, then Run.';
      this.prediction.focus();
      return;
    }
    clearTimeout(this.guidanceTimer); clearTimeout(this.observationTimer);
    this.busy = action; ++this.request;
    this.feedback.hidden = true; this.feedback.replaceChildren();
    if (action === 'run' || action === 'check') { this.execution = undefined; this.output.hidden = true; this.output.textContent=''; this.rich.replaceChildren(); }
    this.status.textContent = action === 'run' ? 'Running…' : action === 'check' ? `Running, then asking ${this.assistant()}…` : `Asking ${this.assistant()}…`;
    this.observe(undefined, action === 'coach' || action === 'check');
    if (this.owner.hooks.tutor && (action === 'coach' || action === 'observe')) { void this.askTutor(); return; }
    this.owner.hooks.post({type: 'codeAction', attempt: this.born, request: this.request,
      action: this.owner.hooks.tutor ? 'run' : action, message: '', prediction: action === 'run' ? '' : this.prediction.value.trim(),
      ...this.snapshot()} satisfies CodeAction);
    this.update();
  }
  receive(result: CodeResult) {
    if (!this.current() || result.revision !== this.revision || result.request !== this.request || !this.busy) return;
    if (result.event) {
      const event=result.event;
      if(event.kind==='stream'){this.output.hidden=false;this.output.textContent=(this.output.textContent+event.text).slice(-200000);}
      if(event.kind==='input'){this.inputControls.hidden=false;this.inputControls.closest('details')!.open=true;this.liveInput.focus();}
      if(event.kind==='display'){
        const data=event.data;
        if(data['image/png'] || data['image/jpeg']){const mime=data['image/png']?'image/png':'image/jpeg';const img=document.createElement('img');img.src='data:'+mime+';base64,'+data[mime];img.alt='Cell output';img.style.maxWidth='100%';this.rich.append(img);}
        else if(data['text/html'] || data['image/svg+xml']){const frame=document.createElement('iframe');frame.setAttribute('sandbox','');frame.title='Cell display';frame.style.width='100%';frame.style.minHeight='12em';frame.srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`+(data['text/html']??data['image/svg+xml']);this.rich.append(frame);}
        else if(data['text/plain']){const pre=document.createElement('pre');pre.textContent=data['text/plain'];this.rich.append(pre);}
      }
      return;
    }
    if (result.execution) {
      this.execution = result.execution;
      const run = result.execution;
      const label = run.status === 'exited' ? `Exited with code ${run.exit_code}.` : run.status.replace(/_/g, ' ') + '.';
      this.output.textContent = label + '\n' + (run.stdout || '(No standard output)')
        + (run.stderr ? '\n' + run.stderr : '') + (run.truncated ? '\nOutput was truncated.' : '');
      this.output.hidden = false;
      this.observe();
      if (this.busy === 'check' && this.owner.hooks.tutor) { void this.askTutor(); return; }
      if (this.busy === 'run') {
        this.busy = undefined;
        const failed = run.status !== 'exited' || run.exit_code !== 0;
        this.status.textContent = run.status==='cancelled' ? 'Stopped. You can edit or run another cell.' : failed ? `Run failed. Read the error below or ask ${this.assistant()} for help.`
          : run.truncated ? 'Run completed with truncated output. The full result is unavailable.'
          : `Run completed successfully. Ask ${this.assistant()} to discuss this result.`;
        if (run.status === 'exited' && run.exit_code === 0 && !run.truncated) this.cleanRun = this.revision;
        if (this.attemptVariation) this.finishVariation(run);
        // Only a failed run that sits untouched suggests being stuck; first give time to read the error.
        if (failed && this.owner.following && this.owner.stuckHints) this.offerHintAfter(FAILED_RUN_PAUSE_MS);
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
    if (result.error) { this.busy = undefined; this.status.textContent = result.error; }
    this.update();
  }
  update() {
    const active = this.current();
    const note = this.element.querySelector(':scope > small');
    if (note) note.textContent = this.owner.runtime + (this.language === 'python' ? '. Python cells share variables until the runtime restarts.' : '. Cells share files; SQL and DBA cells keep database state until Restart runtime.');
    const writable = this.owner.attempt === this.born;
    if (!this.owner.following && this.busy === 'observe') { ++this.request; this.busy = undefined; this.status.textContent = 'Automatic guidance is paused.'; }
    // A document-change callback runs inside CodeMirror's update; reconfigure only on a state change.
    this.code.disabled = !writable; this.input.disabled = this.prediction.disabled = !writable;
    this.inputControls.hidden=!(this.busy==='run'||this.busy==='check') || !this.interactive.checked;
    for (const button of this.actions) {
      const running=button.dataset.action==='run' && (this.busy==='run'||this.busy==='check');
      if(button.dataset.action==='run')button.textContent=running?'Stop':'Run';
      button.disabled = !active || (!running && (!!this.busy || this.toolBusy))
        || (button.dataset.action !== 'run' && (!this.owner.aiEnabled || this.owner.tutorBusy)) || (button.dataset.action !== 'coach' && !this.code.value.trim());
    }
    this.explanation.disabled = !writable || this.submitting;
    if (this.toolButtons) {
      const tools = this.owner.practiceTools, idle = active && !this.busy && !this.toolBusy && !!this.code.value.trim();
      this.toolButtons.tests.hidden = false;
      this.toolButtons.tests.textContent = tools.tests ? `Run sample tests (${tools.tests})` : 'Sample tests unavailable';
      this.toolButtons.tests.title = tools.tests ? 'Run the published sample tests on this code' : 'No runnable sample tests are supplied for this exercise.';
      const availability = this.element.querySelector<HTMLElement>('.sample-availability')!;
      availability.textContent = tools.tests ? '' : 'No runnable sample tests are supplied. Use Run or your own tests under More tools.';
      availability.hidden = !!tools.tests;
      this.toolButtons.trace.hidden = !tools.trace;
      this.toolButtons.tests.disabled = !idle || !tools.tests; this.toolButtons.trace.disabled = !idle;
      // A new input comes after the sample tests pass (or a clean run when there are none).
      const ready = tools.tests ? this.testsPassed === this.revision : this.cleanRun === this.revision;
      this.toolButtons.variation.disabled = !idle || !ready || !!this.attemptVariation;
      this.toolButtons.variation.hidden = !ready && !this.attemptVariation;
      this.toolButtons.variation.title = ready ? 'Predict what your program prints for new input, with no help'
        : tools.tests ? 'Pass the sample tests on this version first' : 'Run this version cleanly first';
    }
    this.nativeDebug.update(this.revision,active,this.owner.aiEnabled && !this.owner.tutorBusy,this.debugBusy || !!this.busy || this.toolBusy,!!this.code.value.trim());
    this.skills.update(active && !this.busy && !this.toolBusy && !!this.code.value.trim(), this.owner.aiEnabled && !this.owner.tutorBusy && !!this.owner.hooks.tutor, writable,
      active && !this.busy && !this.toolBusy && !this.debugBusy);
    if (this.submitButton) this.submitButton.disabled = !active || !this.owner.aiEnabled || !!this.busy || this.toolBusy
      || this.owner.tutorBusy || this.submitting || (this.submitted && this.task?.source !== 'Practice exercise') || this.task?.checkpoint_id !== this.owner.activeCheckpoint
      || !this.code.value.trim() || this.code.value.length > 12000;
    if (!active) { this.skills.invalidate(); this.dispose(); this.busy = undefined; this.status.textContent = 'This session is inactive.'; }
    else if (this.status.textContent === 'This session is inactive.') this.status.textContent = 'Ready. Write code, predict what it prints, then Run.';
    if (!this.owner.aiEnabled || !this.owner.following) this.dispose();
    else if (!this.owner.stuckHints) clearTimeout(this.guidanceTimer);
  }
  private async runTool(tool: PracticeTool) {
    if (!this.owner.hooks.tool || this.toolBusy || this.busy || !this.current()) return;
    const revision = this.revision;
    this.toolBusy = true; this.update();
    this.status.textContent = tool === 'tests' ? 'Running the sample tests…' : tool === 'trace' ? 'Recording each step…' : 'Making a new input…';
    try {
      const reply = await this.owner.hooks.tool(this.snapshot(), tool);
      if (this.revision !== revision || !this.current()) return;
      if (reply.error) { this.status.textContent = reply.error; return; }
      if (reply.tests) this.showTests(reply.tests);
      if (reply.trace) this.showTrace(reply.trace);
      if (reply.variation) this.startVariation(reply.variation);
    } finally { this.toolBusy = false; this.update(); }
  }
  private showTests(rows: TestRow[]) {
    const passed = rows.filter(r => r.verdict === 'passed').length;
    if (rows.length && passed === rows.length) this.testsPassed = this.revision;
    const list = document.createElement('ul'); list.className = 'test-results';
    rows.forEach((row, i) => {
      const item = document.createElement('li'), ok = row.verdict === 'passed';
      item.textContent = `${ok ? '✓' : '✗'} Sample ${i + 1}: ${ok ? 'passed' : row.verdict.replace(/_/g, ' ')}`;
      if (!ok) {
        const detail = document.createElement('pre');
        detail.textContent = (row.stdin ? 'Input:\n' + row.stdin + '\n' : '') + 'Expected:\n' + row.expected + '\nYour program printed:\n' + (row.actual || '(nothing)')
          + (row.stderr ? '\n' + row.stderr : '');
        item.append(detail);
      }
      list.append(item);
    });
    const title = document.createElement('strong'); title.textContent = `Sample tests: ${passed} of ${rows.length} passed`;
    this.toolOutput.replaceChildren(title, list); this.toolOutput.hidden = false;
    this.status.textContent = passed === rows.length ? 'All sample tests pass. Try a new input, with no help, to check your understanding.' : 'Compare what you expected with what your program printed.';
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
    this.status.textContent = 'Predict exactly what your program prints for this input, then Run.';
  }
  private finishVariation(run: Execution) {
    const current = this.attemptVariation!;
    this.attemptVariation = undefined;
    const outcome = judgeVariation(current.variation, this.prediction.value, run, current.assisted);
    const title = document.createElement('strong');
    title.textContent = outcome.prediction.exact && outcome.clean && !current.assisted ? 'You predicted it exactly, on your own.' : 'Not quite yet.';
    const detail = document.createElement('p');
    detail.textContent = predictionFeedback(outcome.prediction) + (current.assisted ? ' You asked for help during this attempt, so it does not count as independent.' : '')
      + (!outcome.clean ? ' The program did not finish cleanly.' : '');
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'quiet'; restore.textContent = 'Restore my input';
    restore.onclick = () => { this.input.value = current.previousStdin; this.changed(); };
    this.toolOutput.replaceChildren(title, detail, restore); this.toolOutput.hidden = false;
  }
  cancelPending() {
    this.skills.invalidate();
    ++this.request; this.busy = undefined; this.execution = undefined;
    this.output.hidden = this.feedback.hidden = true;
    this.status.textContent = 'Assistance settings changed. Run again for a current result.';
    this.dispose();
  }
  dispose() { clearTimeout(this.observationTimer); clearTimeout(this.guidanceTimer); }
  destroy() {
    this.skills.invalidate(); this.skills.update(false, false, false);
    this.nativeDebug.update(this.revision,false,false,false,false);
    this.dispose();
    this.resizeButton.disabled = true; this.resizeButton.onclick = null;
    const saved = document.createElement('pre'); saved.textContent = this.code.value;
    this.code.view.dom.replaceWith(saved); this.code.destroy();
  }
}
