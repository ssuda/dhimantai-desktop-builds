import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { notebookHelpActions, replyRequest, replyStrategy } from '../src/practiceConversation';

const earlier = 'Your code is correct: lines 4-7 read both numbers.\nThe run shows "Stopped."';

test('each default reply chip asks for its own next step, not a repeat of the review', () => {
  const idea = replyRequest('I have an idea', 'I have an idea', earlier);
  const start = replyRequest('Show me where to start', 'Show me where to start', earlier);
  assert.match(idea, /^I have an idea I want to try myself\. Do not explain or review the code again/);
  assert.match(start, /^Show me where to start: point to one place/);
  assert.notEqual(idea.split('\n')[0], start.split('\n')[0]);
  assert.match(idea, /Your last reply, for context only: Your code is correct: lines 4-7 read both numbers\. The run shows/);
});

test('a suggested reply such as Summarise is sent as its own request', () => {
  assert.match(replyRequest('Summarise', 'Summarise', earlier), /^Summarise\. Answer this request itself; do not repeat your last reply\./);
});

test('a choice keeps its answer wording and the whole request fits the 600-character limit', () => {
  assert.match(replyRequest('B', 'My answer is: B', earlier), /^My answer is: B\n\n/);
  assert.equal(replyRequest('I am stuck', 'I am stuck', 'x'.repeat(2000)).length, 600);
});

test('a chip under a Summarise reply does not inherit the code-review stage', () => {
  const summarise = notebookHelpActions.find(action => action.label === 'Summarise')!;
  const stage = (strategy: string) => notebookHelpActions.find(action => action.strategy === strategy)?.stage ?? 'guide';
  assert.equal(stage(summarise.strategy), 'review', 'Summarise itself is a review of the selected cell');
  for (const label of ['I have an idea', 'Show me where to start', 'I am stuck', 'Explain more'])
    assert.notEqual(stage(replyStrategy(label, summarise.strategy)), 'review', label);
  assert.equal(replyStrategy('I have an idea', 'reflect'), 'hypothesis');
  assert.equal(replyStrategy('Explain more', 'trace'), 'trace', 'a non-review strategy carries over');
});
