import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NotebookCoachConversation } from '../src/notebookCoachConversation';

test('conversation retains visible messages while bounding and scoping model history to the selected cell', () => {
  const conversation = new NotebookCoachConversation();
  for (let i = 0; i < 12; i++) conversation.messages.push({id: String(i), role: i % 2 ? 'tutor' : 'learner', text: 'x'.repeat(2000), cell: 'a', revision: 1});
  conversation.messages.push({id: 'other', role: 'tutor', text: 'Private other cell', cell: 'b', revision: 2});
  conversation.messages.push({id: 'failed', role: 'status', text: 'Network failure', cell: 'a', revision: 2});
  conversation.messages.push({id: 'current', role: 'learner', text: 'My current question', cell: 'a', revision: 2});
  const history = conversation.history('a', 2, 'current');
  assert.equal(history.length, 8);
  assert.ok(history.every(item => item.text.length === 1500 && item.text.startsWith('[Earlier cell version')));
  assert.ok(!JSON.stringify(history).includes('Private other cell'));
  assert.ok(!JSON.stringify(history).includes('Network failure'));
  assert.ok(!JSON.stringify(history).includes('My current question'));
  assert.equal(conversation.messages.length, 15, 'displayed history is not truncated to the API window');
});

test('sign-in preserves the pending prompt; account changes and new chat clear history', () => {
  const conversation = new NotebookCoachConversation();
  conversation.forAccount('');
  conversation.messages.push({id: '1', role: 'learner', text: 'Explain this', cell: 'a', revision: 1});
  conversation.forAccount('first');
  assert.equal(conversation.messages.length, 1);
  conversation.forAccount('first');
  assert.equal(conversation.messages.length, 1);
  const id = conversation.id;
  conversation.forAccount('second');
  assert.equal(conversation.messages.length, 0);
  assert.notEqual(conversation.id, id);
  conversation.messages.push({id: '2', role: 'tutor', text: 'Explanation', cell: 'a', revision: 1});
  conversation.forAccount('');
  assert.equal(conversation.messages.length, 0);
  conversation.clear();
  assert.deepEqual(conversation.history('a', 1), []);
});

test('changing a notebook service or exercise clears its previous conversation', () => {
  const conversation = new NotebookCoachConversation();
  assert.equal(conversation.forScope('production/question-one'), false);
  conversation.messages.push({id: '1', role: 'learner', text: 'Private question', cell: 'a', revision: 1});
  assert.equal(conversation.forScope('production/question-one'), false);
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.forScope('staging/question-one'), true);
  assert.equal(conversation.messages.length, 0);
});
