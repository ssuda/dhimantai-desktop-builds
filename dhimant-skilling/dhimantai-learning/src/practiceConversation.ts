import { sameSnapshot, type CodeSnapshot } from './roomCode';
import type { NotebookCell } from './tutorNotebook';

export type HelpGroup = 'Understand' | 'Fix' | 'See an example' | 'Practise' | 'Move on';
export const HELP_GROUPS: readonly HelpGroup[] = ['Understand', 'Fix', 'See an example', 'Practise', 'Move on'];

/** Shared by Practice, Instructor and Doubt Solver; matches Flutter's coaching strategies. */
export const notebookHelpActions = [
  {label:'Explain problem', message:'Explain this problem and its inputs and outputs.', strategy:'plan', stage:'question', group:'Understand' as HelpGroup, fullSolution:false},
  {label:'Explain code', message:'Explain what my code does, starting with the selected line.', strategy:'trace', stage:'guide', group:'Understand' as HelpGroup, fullSolution:false},
  {label:'Explain errors', message:'Help me understand the error in my latest run.', strategy:'read_error', stage:'error', group:'Fix' as HelpGroup, fullSolution:false},
  {label:'Explain failed tests', message:'Explain the first failing public test and guide my next debugging step.', strategy:'by_hand', stage:'review', group:'Fix' as HelpGroup, fullSolution:false},
  {label:'Next step', message:'Guide me through the next small step without giving the solution.', strategy:'small_steps', stage:'steps', group:'Move on' as HelpGroup, fullSolution:false},
  {label:'Explain simply', message:'Explain the current concept in simple language, using our current lesson or question as context.', strategy:'simplify', stage:'guide', group:'Understand' as HelpGroup, fullSolution:false},
  {label:'Give an example', message:'Give me a small, different example of the current concept without solving my unfinished task.', strategy:'walkthrough', stage:'guide', group:'See an example' as HelpGroup, fullSolution:false},
  {label:'Quiz me', message:'Ask me one question about the current concept and wait for my answer before explaining it.', strategy:'by_hand', stage:'question', group:'Practise' as HelpGroup, fullSolution:false},
  {label:'Summarise', message:'Summarise the key ideas from our current discussion and the next step I should practise.', strategy:'reflect', stage:'review', group:'Understand' as HelpGroup, fullSolution:false},
] as const;
export const practiceStrategies = ['plan','small_steps','predict','read_error','trace','walkthrough','by_hand','simplify','edge_cases','hypothesis','reflect','decompose'];
export const practiceStrategy = (value: unknown) => typeof value === 'string' && practiceStrategies.includes(value) ? value : 'decompose';
export function quickReplies(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((s): s is string => typeof s === 'string' && !!s.trim() && s.length <= 100).map(s => s.trim()))].slice(0, 3) : [];
}

/** A sentence starter ("…the value is at...", "It prints ___") is the learner's to finish, not an answer to send. */
export function replyStarter(text: string) {
  return /(\.{3}|…|_{2,})\s*$/.test(text.trim());
}

/** The editable draft a starter chip leaves in the message box: no ellipsis or blank, cursor after a space. */
export function starterDraft(text: string) {
  return text.trim().replace(/\s*(\.{3}|…|_{2,})\s*$/, '') + ' ';
}

// Reply chips name what the learner wants next. Sent bare beside the earlier reply, the coach
// re-reviewed the same code and repeated itself, so each chip says what it asks for.
const replyIntents: Record<string, string> = {
  'Show me where to start': 'Show me where to start: point to one place in my code or the task to begin with. Do not repeat your last reply.',
  'I have an idea': 'I have an idea I want to try myself. Do not explain or review the code again; ask me to share my idea in one sentence, or to try it and run it.',
  'I am stuck': 'I am stuck. Ask me one question that helps me find the next step myself. Do not repeat your last reply.',
};

/** The request a reply chip sends: its own intent first, the earlier reply only as context. */
export function replyRequest(label: string, message: string, previous: string) {
  const ask = replyIntents[label] ?? (message === label ? label.replace(/[.!]+$/, '') + '. Answer this request itself; do not repeat your last reply.' : message);
  return (ask + '\n\nYour last reply, for context only: ' + previous.replace(/\s+/g, ' ').trim()).slice(0, 600);
}

const replyStrategies: Record<string, string> = {'Show me where to start':'small_steps', 'I have an idea':'hypothesis', 'I am stuck':'decompose'};

/** A chip is a new request. It keeps the earlier reply's strategy only when that would not
 * re-run a code review: under a Summarise reply, every chip used to return the same review. */
export function replyStrategy(label: string, previous: unknown) {
  const strategy = replyStrategies[label] ?? practiceStrategy(previous);
  return notebookHelpActions.find(action => action.strategy === strategy)?.stage === 'review' ? 'decompose' : strategy;
}

/** The task, code, private notes and editor state survive conversation cleanup. */
export function conversationCell(cell: NotebookCell) {
  return ['message', 'board'].includes(cell.kind) && cell.id !== 'practice-question' && !cell.packet?.tutor_practice_editor;
}

export function replyChoices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const choices = [...new Set(value.filter((s): s is string => typeof s === 'string' && !!s.trim() && s.length <= 100).map(s => s.trim()))].slice(0, 3);
  return choices.length >= 2 ? choices : [];
}

export type TestRow = {id:string; call?:string; verdict:string; stdin:string; expected:string; actual:string; stderr:string};
type TestRun = {snapshot:CodeSnapshot; rows:TestRow[]; suite:'published'|'learner'};

/** Ordinary reviews refer to the published suite. Explain failed tests follows the last suite the learner ran. */
export class NotebookTestEvidence {
  private published?: TestRun;
  private latest?: TestRun;

  begin(suite: TestRun['suite']) {
    this.latest = undefined;
    if (suite === 'published') this.published = undefined;
  }

  record(run: TestRun) {
    this.latest = run;
    if (run.suite === 'published') this.published = run;
  }

  observation(snapshot: CodeSnapshot, latest: boolean) {
    const run = latest ? this.latest : this.published;
    if (!run) return {state:'not_run'};
    if (!sameSnapshot(run.snapshot, snapshot)) return {state:'changed', suite:run.suite};
    const failed = run.rows.find(row => row.verdict !== 'passed');
    const counts = {suite:run.suite, total:run.rows.length, passed:run.rows.filter(row => row.verdict === 'passed').length};
    return failed ? {...counts, state:'current', id:failed.id, input:failed.stdin, expected:failed.expected,
      actual:failed.actual, stderr:failed.stderr, verdict:failed.verdict} : {...counts, state:'passed'};
  }
}
