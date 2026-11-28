import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {isSkipAnswer, pendingRetry, pendingSkip, retryRequest, skippedChecks, unassessedSkips} from '../src/skippedChecks';
import {unfinishedQuestion} from '../src/notebookContinuity';
import {emptyNotebook} from '../src/tutorNotebook';
import type {NotebookCell} from '../src/tutorNotebook';

test('only the learner\'s own short skip counts as a skip, never an answer that mentions skipping', () => {
  for (const text of ['skip', 'Skip', ' SKIP. ', 'skip it', 'Skip this one', 'please skip', 'pass', "I'll skip"]) assert.equal(isSkipAnswer(text), true, text);
  for (const text of ['skip the gcc line because it is in the builder', 'Skipping makes the image smaller', 'the second FROM', 'skip?', '']) assert.equal(isSkipAnswer(text), false, text);
});

test('a skip is pending only until Instructor reveals the answer or moves to a new question', () => {
  const question: NotebookCell = {id: 'q', kind: 'board', text: 'Your turn: which FROM?', packet: {is_question_prompt: true, tutor_checkpoint_id: 'c1', skipped_check: true, active_subtopic: 'Multi-stage builds'}};
  const cells: NotebookCell[] = [question, {id: 'm', kind: 'message', text: 'Skip', packet: {skip_answer_for: 'q'}}];
  assert.equal(pendingSkip(cells), question);
  assert.equal(pendingSkip([...cells, {id: 'n', kind: 'board', text: 'Next?', packet: {is_question_prompt: true}}]), undefined);
  const revealed = [...cells, {id: 'r', kind: 'board' as const, text: 'Answer', packet: {skip_resolution: 'q'}}];
  assert.equal(pendingSkip(revealed), undefined);
  assert.deepEqual(skippedChecks(revealed).map(check => [check.questionId, check.resolutionId, check.section]), [['q', 'r', 'Multi-stage builds']]);
  assert.equal(unassessedSkips(revealed).length, 1);
});

test('a retry is assessed by the first feedback after it and asks for a fresh question', () => {
  const question: NotebookCell = {id: 'q', kind: 'board', text: 'Which FROM?', packet: {is_question_prompt: true, skipped_check: true, tutor_question_prompt: 'Which FROM does gcc sit under?'}};
  const cells: NotebookCell[] = [question, {id: 'retry', kind: 'message', text: 'Retry', packet: {skip_retry_for: 'q'}},
    {id: 'q2', kind: 'board', text: 'New question', packet: {is_question_prompt: true}}, {id: 'a', kind: 'message', text: 'Builder'}];
  assert.equal(pendingRetry(cells), question);
  assert.equal(pendingRetry([...cells, {id: 'f', kind: 'board', text: 'Correct', packet: {tutor_feedback: true}}]), undefined);
  question.packet!.skip_retry_outcome = 'correct';
  assert.equal(unassessedSkips(cells).length, 0);
  const request = retryRequest(skippedChecks(cells)[0]);
  assert.match(request, /fresh question/); assert.match(request, /Do not reuse the same question/); assert.match(request, /Which FROM does gcc sit under\?/);
});

test('resume does not treat a skipped check as awaiting an answer', () => {
  const book = emptyNotebook();
  book.cells.push({id: 'q', kind: 'board', text: 'Your turn: which FROM?', packet: {is_question_prompt: true, tutor_checkpoint_id: 'c1', student_answer: 'Skip', skipped_check: true}});
  assert.equal(unfinishedQuestion(book), undefined);
});
