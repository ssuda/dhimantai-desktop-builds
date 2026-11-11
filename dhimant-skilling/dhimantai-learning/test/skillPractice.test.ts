import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { investigationPrompt, learnerTests, testDesignPrompt, validSkillDraft, skillPrompts } from '../src/skillPractice';
import { runPublicTests } from '../src/localRunner';
import { emptyNotebook, readNotebook } from '../src/tutorNotebook';

test('learner cases require a reason, are bounded, and never become executable test expressions', () => {
  const c = {kind:'boundary' as const, reason:'Zero must remain zero', stdin:'0\n', expected:'0\n'};
  assert.deepEqual(learnerTests([{...c, call:'malicious()', files:[{}]}]),
    [{id:'learner-1',kind:'stdio',stdin:'0\n',expected:'0\n'}]);
  for (const input of [null, [], [null], [{...c,kind:'hidden'}], [{...c,reason:' '}],
    [{...c,stdin:'x'.repeat(1001)}], [{...c,expected:'x'.repeat(1001)}], Array(7).fill(c)])
    assert.throws(() => learnerTests(input));
  assert.equal(learnerTests([{...c,stdin:'',expected:''}])[0].expected, '', 'empty input and output are valid cases');
  assert.ok(testDesignPrompt({...c,reason:'x'.repeat(160),stdin:'x'.repeat(1000),expected:'x'.repeat(1000)}).length <= 600);
  assert.ok(testDesignPrompt({...c,reason:'x'.repeat(160),stdin:'x'.repeat(1000),expected:'x'.repeat(1000)},
    {verdict:'runtime_error',actual:'x'.repeat(1000),stderr:'x'.repeat(1000)}).length <= 600);
  assert.ok(Object.values(skillPrompts).every(prompt => prompt.length <= 600));
  const d = {expected:'x'.repeat(140),hypothesis:'x'.repeat(140),experiment:'x'.repeat(140),cases:[c]};
  assert.ok(investigationPrompt(d).length <= 600);
  assert.ok(validSkillDraft(d));
  assert.equal(validSkillDraft({...d,hypothesis:'x'.repeat(141)}), false);
  const notebook = emptyNotebook();
  notebook.drafts.push({key:'cell-1:0',snippet:'code-1',language:'python',source:'',stdin:'',prediction:'',explanation:'',helped:false,skills:d});
  assert.deepEqual(readNotebook(notebook).drafts[0].skills, d);
  assert.throws(() => readNotebook({...notebook,drafts:[{...notebook.drafts[0],skills:{...d,cases:Array(7).fill(c)}}]}));
});

test('a learner regression detects the original bug and matches after the fix without changing the expectation', async () => {
  const cases = learnerTests([
    {kind:'typical',reason:'Double a positive integer',stdin:'4\n',expected:'8\n'},
    {kind:'regression',reason:'Zero exposed the added one',stdin:'0\n',expected:'0\n'},
  ]);
  const run = (source: string) => runPublicTests('javascript', source, cases, resolve(__dirname,'../../media/pycall.py'));
  const buggy = await run('console.log(2 * Number(require("fs").readFileSync(0,"utf8")) + 1)');
  assert.deepEqual(buggy.map(r => r.verdict), ['wrong_answer','wrong_answer']);
  const fixed = await run('console.log(2 * Number(require("fs").readFileSync(0,"utf8")))');
  assert.deepEqual(fixed.map(r => r.verdict), ['passed','passed']);
  const failed = await run('console.log(0); process.exit(1)');
  assert.deepEqual(failed.map(r => r.verdict), ['runtime_error','runtime_error']);
});
