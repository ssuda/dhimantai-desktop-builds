import type {NotebookCell, TutorNotebook} from './tutorNotebook';

/** Local history is a stopping point, never execution or assessment evidence. */
export function unfinishedQuestion(book: TutorNotebook): NotebookCell | undefined {
  const question = [...book.cells].reverse().find(cell => cell.kind === 'board' && cell.packet?.is_question_prompt);
  // A skipped check is closed by the learner's choice: resume never treats it as awaiting an answer.
  if (!question || question.packet?.feedback_received || question.packet?.skipped_check) return;
  const id = question.packet?.tutor_checkpoint_id;
  const later = book.cells.slice(book.cells.indexOf(question) + 1);
  if (later.some(cell => cell.packet?.tutor_feedback && (!id || cell.packet.tutor_checkpoint_id === id))) return;
  return question;
}

export function notebookResume(book: TutorNotebook) {
  const question = unfinishedQuestion(book);
  const last = [...book.cells].reverse().find(cell => cell.kind === 'board' && !cell.packet?.notebook_help);
  if (!question && last?.packet?.session_summary && last.packet.lesson_completion === 'complete') return undefined;
  if (!last && !book.drafts.length) return undefined;
  const result = {
    section: String((question ?? last)?.packet?.active_subtopic ?? '').slice(0, 250),
    question: question ? {id: String(question.packet?.tutor_checkpoint_id ?? '').slice(0, 100),
      text: String(question.packet?.tutor_question_prompt ?? question.text).slice(0, 6000), submitted: typeof question.packet?.student_answer === 'string'} : null,
    last_card: last?.text.slice(0, 900) ?? '',
    // Drafts have no execution receipts. Never label them completed or runnable state.
    drafts: book.drafts.slice(-4).map(d => ({snippet:d.snippet, language:d.language, source:d.source.slice(0, 700)})),
    kernel: 'unverified',
  };
  const fits = () => new TextEncoder().encode(JSON.stringify(result)).length <= 11500;
  while (!fits() && result.drafts.length) result.drafts.shift();
  if (!fits()) result.last_card = '';
  // Never send a cut-off question as if it were exact: it cannot match a server receipt.
  if (!fits() && result.question) result.question.text = '';
  return result;
}
