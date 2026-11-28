import * as assert from 'node:assert/strict';
import {test} from 'node:test';
import {freshEvidence, levelOffer, nextEvidence, recommendedLevel, verdictOf} from '../webview/levelAdaptation';

test('verdicts come from the agent field, with the legacy boolean as a fallback', () => {
  assert.equal(verdictOf({tutor_verdict:'partial'}), 'partial');
  assert.equal(verdictOf({is_correct:true}), 'correct');
  assert.equal(verdictOf({tutor_feedback:true}), undefined);
  assert.equal(verdictOf({tutor_verdict:'great'}), undefined);
});

test('only independent correct answers step up; struggles step down; unclear is not evidence', () => {
  let e = freshEvidence();
  for (let i = 0; i < 2; i++) e = nextEvidence(e, 'correct', false);
  e = nextEvidence(e, 'correct', true);
  e = nextEvidence(e, 'unclear', undefined);
  assert.equal(levelOffer('beginner', e), undefined);
  e = nextEvidence(e, 'correct', undefined);
  assert.deepEqual(levelOffer('beginner', e), {to:'practitioner', direction:'up'});
  assert.equal(levelOffer('expert', e), undefined);
  for (let i = 0; i < 3; i++) e = nextEvidence(e, i ? 'incorrect' : 'partial', false);
  assert.equal(e.independent, 0);
  assert.deepEqual(levelOffer('expert', e), {to:'practitioner', direction:'down'});
  assert.equal(levelOffer('beginner', e), undefined);
});

test('a diagnostic recommendation is read only when it names one level', () => {
  assert.equal(recommendedLevel('I recommend **Intermediate Level** for you.'.replaceAll('**', '')), 'practitioner');
  assert.equal(recommendedLevel('My recommendation: Expert Level.'), 'expert');
  assert.equal(recommendedLevel('Entry Level, Intermediate Level and Expert Level are available.'), undefined);
  assert.equal(recommendedLevel('I recommend Entry Level, or Expert Level if you prefer.'), 'beginner');
});
