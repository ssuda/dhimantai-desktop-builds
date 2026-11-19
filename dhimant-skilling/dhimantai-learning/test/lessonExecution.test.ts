import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {recordExecutionIssue, lessonCompletion} from '../src/lessonExecution';
import {emptyNotebook, exportNotebook, importNotebook, readNotebook} from '../src/tutorNotebook';
import type {Execution} from '../src/roomCode';

const run = (exit_code: number, truncated = false) => ({status:'exited', exit_code, stdout:'', stderr:exit_code ? "ModuleNotFoundError: No module named 'transformers'" : '', truncated}) as Execution;

test('execution follow-up survives export without granting execution evidence and clears only for its own complete rerun', () => {
  const book = emptyNotebook();
  book.cells.push({id:'recap', kind:'recap', text:'Lesson recap', packet:{session_summary:true}});
  book.executionIssues = recordExecutionIssue([], 'cell-1:0', 'code-1', run(1));
  const exported = exportNotebook(book);
  assert.match((exported.cells[0] as any).source, /Coding follow-up pending.*transformers/s);
  const restored = importNotebook(new TextEncoder().encode(JSON.stringify(exported)));
  assert.deepEqual(restored.executionIssues, book.executionIssues);
  assert.equal(restored.drafts.length, 0, 'a follow-up note does not restore run evidence');
  const unrelated = recordExecutionIssue(restored.executionIssues!, 'cell-2:0', 'code-2', run(0));
  assert.deepEqual(unrelated, book.executionIssues);
  const incomplete = recordExecutionIssue(unrelated, 'cell-1:0', 'code-1', run(0, true));
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0].detail, /Output incomplete/);
  assert.deepEqual(recordExecutionIssue(incomplete, 'cell-1:0', 'code-1', run(0)), []);
  assert.throws(() => readNotebook({...book, executionIssues:[{key:'x', snippet:'<script>', detail:'bad'}]}), /follow-up/);
});

test('a recap or partial session cannot claim lesson completion', () => {
  assert.equal(lessonCompletion({}), 'unverified');
  assert.equal(lessonCompletion({is_complete:true}), 'unverified');
  assert.equal(lessonCompletion({is_complete:true, partial_session:true, summary_scope:'full'}), 'partial');
  assert.equal(lessonCompletion({is_complete:true, partial_session:false, summary_scope:'full'}), 'complete');
});
