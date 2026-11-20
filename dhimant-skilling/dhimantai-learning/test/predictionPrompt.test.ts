import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { predictionPrompt } from '../src/roomCode';

test('learners predict what they will see: printed output or the result', () => {
  assert.equal(predictionPrompt('python', 'print(sum([2, 5, 3]))'), 'I expect it to print');
  assert.equal(predictionPrompt('javascript', 'console.log(total)'), 'I expect it to print');
  assert.equal(predictionPrompt('java', 'System.out.println(x);'), 'I expect it to print');
  assert.equal(predictionPrompt('python', 'def new_requirements(old, new):\n    return sorted(set(new) - set(old))'), 'I expect the result to be');
  assert.equal(predictionPrompt('python', 'printer = make()'), 'I expect the result to be', 'a name that only starts with print is not output');
  assert.equal(predictionPrompt('sql', 'select 1'), 'Prediction (not executed)');
});
