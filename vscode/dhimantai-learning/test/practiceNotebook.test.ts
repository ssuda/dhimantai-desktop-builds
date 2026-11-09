import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { GeneratedExercise, Workspace } from '../src/api';
import { practiceContext, practiceDocument, generatedPractice, savedPractice } from '../src/practiceNotebook';

const id = '10000000-0000-0000-0000-000000000001';
function workspace(title = 'Programming exercise', brief = '## Question\n\nIn this chapter I said that tuples can be keys in dictionaries.'): Workspace {
  return {project:{question_id:id, title, brief, languages:['python'], code_assistance_allowed:true},
    draft:{payload:{language:'python', notebook:{cells:[{cell_type:'code', source:'print(42)'}]}}}} as Workspace;
}

test('Practice uses the clicked question label for the notebook, even with an older workspace response', () => {
  const practice = practiceContext(workspace(), 'learner', 'Python', 'Tuples and Hashability');
  assert.equal(practice.title, 'Tuples and Hashability');
  assert.equal(practiceDocument(practice).title, practice.title);
  assert.equal(practice.starter, 'print(42)');
  assert.equal(practice.question, workspace().project.brief);
  assert.equal(practice.course, 'Python');
});

test('direct opens keep authored titles and derive distinct labels from legacy question prompts', () => {
  assert.equal(practiceContext(workspace('Tuples and Hashability'), 'learner').title, 'Tuples and Hashability');
  const first = practiceContext(workspace(), 'learner');
  const second = practiceContext(workspace('Programming exercise', '### Task:\r\n\r\n**Dictionaries and Tuples**\nUse items().'), 'learner');
  assert.equal(first.title, 'In this chapter I said that tuples can be keys in dictionaries.');
  assert.equal(second.title, 'Dictionaries and Tuples');
  assert.notEqual(first.title, second.title);
  for (const placeholder of ['', '  ', 'Coding exercise', 'PROGRAMMING EXERCISE']) {
    assert.equal(practiceContext(workspace(placeholder), 'learner').title, first.title);
  }
});

test('Practice labels stay bounded and retain a question identity if the prompt has no label', () => {
  assert.equal(practiceContext(workspace('', '# ' + 'x'.repeat(250)), 'learner').title, 'x'.repeat(180));
  assert.equal(practiceContext(workspace('', '## Question\n\n### Exercise:'), 'learner').title, 'Coding exercise · ' + id);
  assert.equal(practiceContext(workspace(), 'learner', undefined, '  Compare < & >\noperators  ').title, 'Compare < & > operators');
});

test('generated examples become runnable samples only with explicit validation metadata', () => {
  const result: GeneratedExercise = {exercise:{title:'Sum', task:'Return the sum.', example_input:'add(7, 5)', expected_output:'15'},
    course:'Python', chapter:'Variables', language:'python', kernel:'python3', difficulty:'easy'};
  assert.throws(() => generatedPractice(result, id, 'learner'), /validated exercise sample/);
  const sample = {id:'example',kind:'stdio' as const,stdin:'7 5\n',expected:'12\n'};
  const checked = generatedPractice({...result, exercise:{...result.exercise, example_input:sample.stdin, expected_output:sample.expected},
    validation:'reference_execution',tests:[sample]}, 'generated-' + 'a'.repeat(24), 'learner');
  assert.throws(() => generatedPractice({...result, validation:'reference_execution',tests:[sample]}, id, 'learner'), /validated exercise sample/);
  assert.throws(() => generatedPractice({...result, exercise:{...result.exercise, example_input:sample.stdin},
    validation:'reference_execution',tests:[sample]}, id, 'learner'), /validated exercise sample/);
  assert.deepEqual(checked.tests, [sample]);
  assert.deepEqual(savedPractice(practiceDocument(checked), 'learner'), checked);
  const old = practiceDocument(checked); delete old.cells[0].packet!.practice_tests;
  assert.deepEqual(savedPractice(old, 'learner')!.tests, []);
});
