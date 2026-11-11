import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { courseAllowsCopilot } from '../src/courseCopilot';

test('only the reviewed AI-assisted coding course opts into Copilot', () => {
  assert.equal(courseAllowsCopilot('Use AI Coding Help with Verification'), true);
  assert.equal(courseAllowsCopilot(' use ai coding help with verification '), true);
  for (const course of [undefined, '', 'Python', 'Agentic AI Applications', 'LLM APIs, Tool Calling & MCP',
    'Build an LLM from Scratch', 'Use AI Coding Help with Verification Advanced']) {
    assert.equal(courseAllowsCopilot(course), false, String(course));
  }
});
