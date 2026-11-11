import type { NotebookCell } from './tutorNotebook';

/** Shared by Practice, Instructor and Doubt Solver; matches Flutter's coaching strategies. */
export const notebookHelpActions = [
  {label:'Explain problem', message:'Explain this problem and its inputs and outputs.', strategy:'plan', stage:'question'},
  {label:'Explain code', message:'Explain what my code does, starting with the selected line.', strategy:'trace', stage:'guide'},
  {label:'Explain errors', message:'Help me understand the error in my latest run.', strategy:'read_error', stage:'error'},
  {label:'Explain failed tests', message:'Explain the first failing public test and guide my next debugging step.', strategy:'by_hand', stage:'review'},
  {label:'Next step', message:'Guide me through the next small step without giving the solution.', strategy:'small_steps', stage:'steps'},
] as const;
export const practiceStrategies = ['plan','small_steps','predict','read_error','trace','walkthrough','by_hand','simplify','edge_cases','hypothesis','reflect','decompose'];
export const practiceStrategy = (value: unknown) => typeof value === 'string' && practiceStrategies.includes(value) ? value : 'decompose';
export function quickReplies(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((s): s is string => typeof s === 'string' && !!s.trim() && s.length <= 100).map(s => s.trim()))].slice(0, 3) : [];
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
