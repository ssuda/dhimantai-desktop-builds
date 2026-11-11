import { caseKinds, investigationPrompt, MAX_LEARNER_TESTS, testDesignPrompt, skillPrompts, engineeringSkills } from '../src/skillPractice';
import type { LearnerTestCase, SkillDraft, SkillStage } from '../src/skillPractice';

export type SkillTestResult = {id: string; verdict: string; stdin: string; expected: string; actual: string; stderr: string};
type Hooks = {
  changed: () => void;
  ask: (stage: SkillStage, message: string) => void;
  useInput: (stdin: string) => void;
  run: (cases: LearnerTestCase[]) => Promise<{tests?: SkillTestResult[]; error?: string}>;
  runCode: () => void;
};

/** Local reasoning and test design; results are temporary and never become assessment evidence. */
export class SkillPractice {
  readonly element = document.createElement('details');
  readonly tools = document.createElement('details');
  private draft: SkillDraft;
  private cases = document.createElement('div');
  private results = document.createElement('div');
  private status = document.createElement('p');
  private controls: HTMLButtonElement[] = [];
  private pending = false;
  private generation = 0;
  private available = false;
  private ai = false;
  private writable = true;
  private canLearn = false;
  private currentResults: SkillTestResult[] = [];
  constructor(private hooks: Hooks, tests: boolean, saved?: SkillDraft) {
    this.draft = saved ? {...saved, cases:saved.cases.map(c => ({...c}))} : {expected:'', hypothesis:'', experiment:'', cases:[]};
    this.element.className = 'skill-practice';
    const title = document.createElement('summary'); title.textContent = 'More tools: debugger, your own tests, engineering skills';
    const welcome = document.createElement('p');
    welcome.textContent = 'Start by understanding the task, then reading, debugging and testing. Build toward small, reliable changes you can explain. Choose one skill; Instructor will explain unfamiliar terms, guide one experiment and discuss its result. These activities do not award mastery automatically.';
    const choice = document.createElement('select'), picker = document.createElement('details'), label = document.createElement('summary');
    picker.className = 'skill-picker'; choice.setAttribute('aria-label','Skill to practise'); choice.dataset.skillPicker = ''; choice.size = 5;
    const search = document.createElement('input'), empty = document.createElement('small');
    search.type = 'search'; search.placeholder = 'Search skills…'; search.setAttribute('aria-label','Search engineering skills');
    empty.textContent = 'No matching skills. Try another search.'; empty.setAttribute('role','status');
    let selectedId: SkillStage = engineeringSkills[0].id;
    const filter = () => {
      const query = search.value.trim().toLowerCase(); choice.replaceChildren();
      for (const skill of engineeringSkills.filter(skill => (skill.title + ' ' + skill.meaning).toLowerCase().includes(query))) {
        const option = document.createElement('option'); option.value = skill.id; option.textContent = skill.title; choice.append(option);
      }
      choice.value = selectedId; empty.hidden = choice.options.length > 0; choice.hidden = !empty.hidden;
    };
    search.oninput = filter; filter();
    const definition = document.createElement('p'), exercise = document.createElement('p');
    definition.dataset.skillDefinition = ''; definition.setAttribute('aria-live','polite');
    const selected = () => engineeringSkills.find(skill => skill.id === selectedId)!;
    const describe = () => { label.textContent = 'Skill to practise: ' + selected().title; definition.textContent = selected().meaning; exercise.textContent = 'First practice: ' + selected().firstStep; };
    choice.onchange = () => { if (engineeringSkills.some(skill => skill.id === choice.value)) { selectedId = choice.value as SkillStage; describe(); } };
    picker.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); picker.open = false; label.focus(); } };
    describe(); picker.append(label,search,choice,empty);
    this.element.append(title,welcome,picker,definition,exercise,
      this.button('Practise this skill with Instructor', () => this.hooks.ask(selected().id,skillPrompts[selected().id]),'ask-skill'));
    const toolsTitle = document.createElement('summary'); toolsTitle.textContent = 'Debugging and test tools';
    this.tools.className = 'skill-tools'; this.tools.append(toolsTitle); this.element.append(this.tools);
    const reading = document.createElement('p');
    reading.textContent = 'Read unfamiliar code before editing: identify its purpose and entry point, follow one input through calls and branches, and note side effects. Use Go to Definition and Find All References in native VS Code files. Explain what you think happens; use Run or a breakpoint to check it.';
    this.tools.append(reading,this.button('Help me read this code', () => this.hooks.ask('read_code',skillPrompts.read_code),'ask-reading'));
    const intro = document.createElement('p');
    intro.textContent = 'Debugging means finding and fixing why actual behavior differs from expected behavior. A bug may produce a wrong result without crashing. Reproduce it with a small input, predict the result, then use Run or the debugger to check one possible cause. A breakpoint pauses execution so you can inspect values. Keep the failing case as a regression test after your fix.';
    this.tools.append(intro,this.button('Help me start debugging', () => this.hooks.ask('debug',skillPrompts.debug),'ask-start-debug'));
    for (const [key, label] of [['expected','What should happen, according to the task?'],
      ['hypothesis','What might cause the difference?'], ['experiment','What will you inspect or change to test that idea?']] as const) {
      this.tools.append(this.field(label, this.draft[key], 140, value => { this.draft[key] = value; this.hooks.changed(); }, key));
    }
    this.tools.append(this.button('Discuss my investigation', () => this.hooks.ask('debug', investigationPrompt(this.draft)), 'ask-investigation'));
    const privacy = document.createElement('small'); privacy.textContent = 'Your notes and cases save with this notebook. Discuss shares them with Instructor and marks the attempt as assisted.';
    this.tools.append(privacy);
    const unit = document.createElement('p');
    unit.textContent = 'Testing checks behavior against an explicit expectation. An assertion compares the actual result with the expected one and reports a failure when they differ. A unit test checks one function or small component. Arrange its inputs, call it, and assert the required result. Write the definitions, tests and runner in a separate, complete code cell, then Run test code there. This runs that cell in a fresh process; other cells are not included. Check the runner’s test count and failures, not just the exit code.';
    this.tools.append(unit,
      this.button('Help me write a unit test', () => this.hooks.ask('unit_test',skillPrompts.unit_test),'ask-unit-test'),
      this.button('Run test code', () => this.hooks.runCode(),'run-test-code'));
    if (tests) {
      const heading = document.createElement('h4'); heading.textContent = 'Design your own tests';
      const note = document.createElement('p');
      note.textContent = 'A functional test checks observable program behavior against a requirement. These cases test the whole cell through standard input and printed output. Choose a typical case, a boundary, and a bug regression. Use invalid inputs only if the task defines their behavior. Derive each expected output from the task before running. Each case runs this cell alone; include needed definitions and print the result. Empty output means nothing should print. Trailing whitespace is ignored.';
      this.tools.append(heading, note, this.cases,
        this.button('Help me write a functional test', () => this.hooks.ask('functional_test',skillPrompts.functional_test),'ask-functional-test'),
        this.button('Add a test case', () => this.addCase(), 'add-case'),
        this.button('Run my tests', () => { void this.run(); }, 'run-cases'));
      this.renderCases();
    }
    this.status.setAttribute('role', 'status'); this.results.className = 'skill-test-results';
    this.tools.append(this.status, this.results);
  }
  snapshot(): SkillDraft { return {...this.draft, cases:this.draft.cases.map(c => ({...c}))}; }
  private field(label: string, value: string, max: number, change: (value: string) => void, name: string) {
    const field = document.createElement('label'), input = document.createElement('textarea');
    field.textContent = label; input.value = value; input.rows = 2; input.maxLength = max;
    input.dataset.skillField = name; input.setAttribute('aria-label', label);
    input.oninput = () => change(input.value.slice(0, max)); field.append(input); return field;
  }
  private button(label: string, action: () => void, name: string) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet';
    b.textContent = label; b.dataset.skill = name; b.onclick = action; this.controls.push(b); return b;
  }
  private addCase() {
    if (this.draft.cases.length >= MAX_LEARNER_TESTS) return;
    this.draft.cases.push({kind:'typical', reason:'', stdin:'', expected:''});
    this.edited(); this.renderCases();
    this.cases.lastElementChild?.querySelector('textarea')?.focus();
  }
  private edited() { this.invalidate(); this.hooks.changed(); this.update(this.available, this.ai, this.writable, this.canLearn); }
  private renderCases() {
    this.controls = this.controls.filter(b => !this.cases.contains(b)); this.cases.replaceChildren();
    this.draft.cases.forEach((c, index) => {
      const row = document.createElement('fieldset'), legend = document.createElement('legend');
      legend.textContent = 'My case ' + (index + 1); row.append(legend);
      const kindLabel = document.createElement('label'), kind = document.createElement('select');
      kindLabel.textContent = 'Case type'; kind.setAttribute('aria-label', 'Case type');
      for (const value of caseKinds) { const option = document.createElement('option'); option.value = value; option.textContent = value; kind.append(option); }
      kind.value = c.kind; kind.onchange = () => { c.kind = kind.value as LearnerTestCase['kind']; this.edited(); };
      kindLabel.append(kind); row.append(kindLabel);
      for (const [key, label, max] of [['reason','What requirement or bug does this check?',160], ['stdin','Test input (stdin)',1000], ['expected','My expected output',1000]] as const)
        row.append(this.field(label, c[key], max, value => { c[key] = value; this.edited(); }, 'case-' + key));
      row.append(this.button('Use this input in Run', () => this.hooks.useInput(c.stdin), 'use-input'),
        this.button('Discuss this case', () => this.hooks.ask('test', testDesignPrompt(c,this.currentResults.find(r => r.id === 'learner-' + (index + 1)))), 'ask-case'),
        this.button('Remove case', () => { this.draft.cases.splice(index, 1); this.edited(); this.renderCases(); }, 'remove-case'));
      this.cases.append(row);
    });
    this.update(this.available, this.ai, this.writable, this.canLearn);
  }
  update(available: boolean, ai: boolean, writable: boolean, canLearn = available) {
    this.available = available; this.ai = ai; this.writable = writable; this.canLearn = canLearn;
    for (const b of this.controls) {
      const name = b.dataset.skill!;
      b.disabled = name === 'ask-skill' ? !canLearn || !ai || this.pending : name.startsWith('ask-') ? !available || !ai || this.pending
        : ['use-input','run-test-code'].includes(name) ? !available || this.pending
        : name === 'run-cases' ? !available || this.pending || !this.draft.cases.length || this.draft.cases.some(c => !c.reason.trim())
        : !writable || this.pending || (name === 'add-case' && this.draft.cases.length >= MAX_LEARNER_TESTS);
    }
    for (const field of this.element.querySelectorAll<HTMLTextAreaElement | HTMLSelectElement>('textarea, select')) field.disabled = !writable;
  }
  invalidate() {
    ++this.generation;
    this.currentResults = [];
    if (this.results.childElementCount || this.pending) this.status.textContent = 'Code, runtime or test cases changed. Run my tests again for current results.';
    this.results.replaceChildren();
  }
  private async run() {
    if (!this.available || this.pending) return;
    const generation = ++this.generation, cases = this.draft.cases.map(c => ({...c}));
    this.pending = true; this.currentResults = []; this.results.replaceChildren(); this.status.textContent = 'Running your cases…';
    this.update(this.available, this.ai, this.writable, this.canLearn);
    try {
      const reply = await this.hooks.run(cases);
      if (generation !== this.generation) return;
      if (reply.error) { this.status.textContent = reply.error; return; }
      const rows = reply.tests ?? [];
      this.currentResults = rows;
      for (const [i, c] of cases.entries()) {
        const result = rows.find(r => r.id === 'learner-' + (i + 1));
        const item = document.createElement('details'), title = document.createElement('summary'), detail = document.createElement('pre');
        title.textContent = `My case ${i + 1} (${c.kind}): ` + (!result ? 'not run' : result.verdict === 'passed'
          ? 'matches your expectation' : result.verdict === 'wrong_answer' ? 'differs from your expectation' : result.verdict.replace(/_/g, ' '));
        detail.textContent = c.reason + '\nInput:\n' + (c.stdin || '(empty)') + '\nYour expectation:\n' + (c.expected || '(no output)')
          + '\nObserved:\n' + (result?.actual || '(no output)') + (result?.stderr ? '\n' + result.stderr : '');
        item.append(title, detail); item.open = result?.verdict !== 'passed'; this.results.append(item);
      }
      this.status.textContent = 'Compared with your expectations. Check those expectations against the task; matching cases do not prove correctness or mastery.';
    } catch { if (generation === this.generation) this.status.textContent = 'Could not run your tests. Try again.'; }
    finally { this.pending = false; this.update(this.available, this.ai, this.writable, this.canLearn); }
  }
}
