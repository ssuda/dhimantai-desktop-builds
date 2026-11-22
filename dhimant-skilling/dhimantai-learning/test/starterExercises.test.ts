import * as assert from 'node:assert/strict';
import {test} from 'node:test';
import {starterExercises} from '../src/starterExercises';

test('every wrong first-exercise answer gets its own feedback that ends in a question and never gives the answer away', () => {
  for (const starter of starterExercises) {
    const answer = starter.choices[starter.correct];
    assert.notEqual(starter.correct, 0, `${starter.courseId}: guessing the first choice should not pass`);
    starter.choices.forEach((choice, index) => {
      const why = starter.why[index];
      if (index === starter.correct) { assert.equal(why, '', `${starter.courseId}: the correct choice uses the full feedback`); return; }
      assert.ok(why.trim().endsWith('?'), `${starter.courseId}/${choice}: leaves the learner a question`);
      assert.ok(!new RegExp(`(^|[^\\w])${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(why), `${starter.courseId}/${choice}: does not reveal ${answer}`);
    });
  }
});
