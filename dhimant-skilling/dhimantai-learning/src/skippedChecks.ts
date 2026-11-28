import type {NotebookCell} from './tutorNotebook';

/**
 * A learner who types "skip" to an open Instructor check chooses to leave it unassessed.
 * The learner's own words are the signal: a skip is never inferred from the Instructor's reply,
 * and it is never evidence of a wrong answer, mastery or XP.
 */
const SKIP_ANSWER = /^\s*(?:please\s+)?(?:skip|pass|skip (?:it|this(?: one| check| question| practice)?)|i(?:'|’)?ll skip(?: (?:it|this))?)\s*[.!]?\s*$/i;

export function isSkipAnswer(text: string): boolean {
  return text.length <= 40 && SKIP_ANSWER.test(text);
}

export type RetryOutcome = 'correct' | 'partial' | 'incorrect' | 'unclear';
export interface SkippedCheck {
  /** The question cell the learner skipped. */
  questionId: string;
  /** The Instructor reply that revealed the answer, when one arrived. */
  resolutionId?: string;
  prompt: string;
  section: string;
  retried: boolean;
  outcome?: RetryOutcome;
}

/** Every check skipped in this notebook, oldest first. */
export function skippedChecks(cells: NotebookCell[]): SkippedCheck[] {
  return cells.filter(cell => cell.kind === 'board' && cell.packet?.skipped_check === true).map(cell => {
    const resolution = cells.find(other => other.packet?.skip_resolution === cell.id);
    const outcome = cell.packet?.skip_retry_outcome;
    return {
      questionId: cell.id,
      ...(resolution ? {resolutionId: resolution.id} : {}),
      prompt: questionPrompt(cell),
      section: typeof cell.packet?.active_subtopic === 'string' ? cell.packet.active_subtopic : '',
      retried: cell.packet?.skip_retry_requested === true,
      ...(outcome === 'correct' || outcome === 'partial' || outcome === 'incorrect' || outcome === 'unclear' ? {outcome} : {}),
    };
  });
}

/** Checks that were skipped and not yet answered on a retry. */
export const unassessedSkips = (cells: NotebookCell[]) => skippedChecks(cells).filter(item => !item.outcome);

/** The question a pending skip is waiting to resolve: the latest learner message was a skip, with no reveal after it yet. */
export function pendingSkip(cells: NotebookCell[]): NotebookCell | undefined {
  let index = cells.length - 1;
  while (index >= 0 && cells[index].kind !== 'message') {
    // Instructor already moved on to a new question or revealed the answer: nothing is pending.
    if (cells[index].packet?.skip_resolution || cells[index].packet?.is_question_prompt) return;
    index--;
  }
  const id = index >= 0 ? cells[index].packet?.skip_answer_for : undefined;
  return typeof id === 'string' ? cells.find(cell => cell.id === id && cell.packet?.skipped_check === true) : undefined;
}

/** The skipped check a retry is waiting to assess: retry was requested and no outcome is recorded yet. */
export function pendingRetry(cells: NotebookCell[]): NotebookCell | undefined {
  let index = cells.length - 1;
  while (index >= 0 && !(cells[index].kind === 'message' && typeof cells[index].packet?.skip_retry_for === 'string')) index--;
  if (index < 0) return;
  // Only the first assessed answer after the retry request counts for it.
  if (cells.slice(index + 1).some(cell => cell.packet?.tutor_feedback)) return;
  const question = cells.find(cell => cell.id === cells[index].packet?.skip_retry_for);
  return question?.packet?.skipped_check === true && !question.packet.skip_retry_outcome ? question : undefined;
}

export function questionPrompt(cell: NotebookCell): string {
  const prompt = typeof cell.packet?.tutor_question_prompt === 'string' && cell.packet.tutor_question_prompt.trim()
    ? cell.packet.tutor_question_prompt : cell.text;
  return prompt.trim().slice(0, 1500);
}

/** A retry asks for a fresh question: the skipped one's answer has already been shown, so answering it again proves nothing. */
export function retryRequest(check: Pick<SkippedCheck, 'prompt' | 'section'>): string {
  const prompt = check.prompt.replace(/\s+/g, ' ').slice(0, 600);
  return 'I skipped this practice check and saw its answer. Give me a fresh question that checks the same idea'
    + (check.section ? ` (${check.section.slice(0, 120)})` : '')
    + ', so my answer can be assessed. Do not reuse the same question or reveal the answer.\n\nThe check I skipped: ' + prompt;
}

export const SKIP_STATUS_NOTE = 'Not counted toward mastery or XP. Retry with a fresh question any time to have this idea assessed.';
