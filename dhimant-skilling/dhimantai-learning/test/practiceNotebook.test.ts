import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { GeneratedExercise, Workspace } from '../src/api';
import { checkGeneratedLocally, LOCAL_EXAMPLE_FAILED, retryableGeneration, withGenerationRetry, practiceContext, practiceDocument, generatedPractice, savedPractice } from '../src/practiceNotebook';

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

test('a generated example opens only after its reference passes in the local course container', async () => {
  const sample = {id:'example', kind:'stdio' as const, stdin:'7 5\n', expected:'12'};
  const result: GeneratedExercise = {exercise:{title:'Sum', task:'Print the sum.', example_input:sample.stdin, expected_output:'12'},
    course:'Python', chapter:'Variables', language:'python', kernel:'python3', difficulty:'easy',
    validation:'local_reference', tests:[sample], reference:{language:'python', source:'print(sum(map(int, input().split())))'}};
  const calls: unknown[] = [];
  const passed = async (language: string, source: string, tests: unknown) => {
    calls.push({language, source, tests});
    return [{id:'example', verdict:'passed' as const, actual:'12\n', stderr:'', duration_seconds:0.1}];
  };
  const checked = await checkGeneratedLocally(result, passed);
  assert.deepEqual(calls, [{language:'python', source:'print(sum(map(int, input().split())))', tests:[sample]}]);
  assert.equal(checked.validation, 'reference_execution');
  assert.equal('reference' in checked, false, 'the reference is never kept');
  const practice = generatedPractice(checked, 'generated-' + 'b'.repeat(24), 'learner');
  assert.deepEqual(practice.tests, [{...sample, expected:'12\n'}]);
  assert.equal(JSON.stringify(practiceDocument(practice)).includes('input().split'), false);

  for (const verdict of ['wrong_answer', 'runtime_error', 'timeout', 'compile_error', 'not_run'] as const) {
    await assert.rejects(checkGeneratedLocally(result, async () => [{id:'example', verdict, actual:'13\n', stderr:'', duration_seconds:0}]),
      /did not check out/);
  }
  await assert.rejects(checkGeneratedLocally({...result, reference:undefined}, passed), /did not check out/);
  await assert.rejects(checkGeneratedLocally({...result, reference:{language:'java', source:'class Main {}'}}, passed), /did not check out/);
  await assert.rejects(checkGeneratedLocally({...result, tests:[]}, passed), /did not check out/);
  await assert.rejects(checkGeneratedLocally(result, async () => { throw new Error('Set up the course runtime'); }), /course runtime/);
});

test('an exercise already checked by an older service opens without a local run', async () => {
  const sample = {id:'example', kind:'stdio' as const, stdin:'', expected:'12\n'};
  const result: GeneratedExercise = {exercise:{title:'Sum', task:'Print 7 + 5.', example_input:'', expected_output:'12'},
    course:'Python', chapter:'Variables', language:'python', kernel:'python3', difficulty:'easy',
    validation:'reference_execution', tests:[sample]};
  const checked = await checkGeneratedLocally(result, async () => { throw new Error('must not run'); });
  assert.deepEqual(checked, result);
});

test('a rejected or mismatched generated example is drafted again, other failures are not', async () => {
  const status = (code: number) => Object.assign(new Error('Request failed'), {status: code});
  for (const error of [status(503), status(502), status(504), status(0), new Error(LOCAL_EXAMPLE_FAILED)])
    assert.equal(retryableGeneration(error), true);
  for (const error of [status(422), status(400), status(404), status(429), status(403),
      new Error('Set up the course runtime to generate exercises'), 'text'])
    assert.equal(retryableGeneration(error), false);

  let calls = 0;
  assert.equal(await withGenerationRetry(async n => { calls++; if (n < 3) throw status(503); return 'opened'; }), 'opened');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withGenerationRetry(async () => { calls++; throw new Error(LOCAL_EXAMPLE_FAILED); }), /did not check out/);
  assert.equal(calls, 3, 'stops after three attempts');
  calls = 0;
  await assert.rejects(withGenerationRetry(async () => { calls++; throw status(422); }), /Request failed/);
  assert.equal(calls, 1, 'a selection that does not fit the chapter is not retried');
});

test('an exercise from a service this app does not know tells the learner to update dhimantAI', () => {
  const result = {exercise:{title:'Sum', task:'t', example_input:'1', expected_output:'1'}, course:'C', chapter:'c', language:'python',
    kernel:'python3', difficulty:'easy', validation:'future_kind'} as unknown as GeneratedExercise;
  assert.throws(() => generatedPractice(result, id, 'learner'), /Update dhimantAI/);
});
