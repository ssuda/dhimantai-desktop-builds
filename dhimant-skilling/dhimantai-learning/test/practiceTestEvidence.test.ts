import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type {Execution} from '../src/api';
import {deliveryBillFeedback, deliveryBillSamples} from '../src/deliveryBillPractice';
import { NotebookTestEvidence } from '../src/practiceConversation';
import { practiceDocument } from '../src/practiceNotebook';
import { gradingMarkdown, samplesMarkdown } from '../src/practiceIpynb';

test('ordinary questions keep published results when a learner-designed test runs', () => {
  const tests = new NotebookTestEvidence();
  const snapshot = {snippet:'code-1', revision:0, language:'python', source:'def bill(q, p, d): return q*p+d', stdin:'', question:'Calculate a bill.'};
  const sample = {id:'t1', verdict:'passed', stdin:'Call: bill(3, 20, 5)', expected:'65', actual:'65', stderr:''};
  assert.deepEqual(tests.observation(snapshot, false), {state:'not_run'});
  tests.record({snapshot, suite:'published', rows:[sample, {...sample, id:'t2'}]});
  tests.record({snapshot, suite:'learner', rows:[{...sample, id:'learner-1', verdict:'wrong_answer'}]});
  assert.deepEqual(tests.observation(snapshot, false), {suite:'published', state:'passed', passed:2, total:2});
  assert.equal(tests.observation(snapshot, true).suite, 'learner');
  assert.equal(tests.observation(snapshot, true).state, 'current');
  for (const change of [{revision:1}, {source:'# changed'}, {stdin:'0'}, {snippet:'code-2'}, {argv:['--other']},
    {files:[{name:'input.txt',content:'5'}]}, {interactive:true}]) {
    assert.deepEqual(tests.observation({...snapshot, ...change}, false), {suite:'published', state:'changed'});
  }
  tests.begin('published');
  assert.deepEqual(tests.observation(snapshot, false), {state:'not_run'}, 'an interrupted rerun retires the previous pass');
});

test('manual bill checks require observed correct returns on both public inputs and a distinct legal boundary', () => {
  const samples = deliveryBillSamples('75141e8f-b5ce-56c8-befc-c325019517bf', [
    {id:'t1',kind:'function',call:'bill(3, 20, 5)',expected:'65'},
    {id:'t2',kind:'function',call:'bill(1, 4, 0)',expected:'4'},
  ])!;
  const publicCalls = samples.map(sample => ({args:sample.args, result:sample.expected}));
  const feedback = (calls: typeof publicCalls) => {
    const run:Execution = {status:'exited',exit_code:0,stdout:'65\n4\n5\n',stderr:'',truncated:false,command:'python',duration_seconds:0,
      lessonTrace:{steps:[],outputAligned:true,limited:false,functionCalls:calls}};
    return deliveryBillFeedback(samples, run);
  };
  assert.match(feedback([]), /incomplete.*print\(bill\(3, 20, 5\)\)/);
  assert.match(feedback([...publicCalls, publicCalls[1]]), /checked the public examples.*zero items/);
  assert.match(feedback([...publicCalls, {args:['0','20','5'], result:'0'}]), /incomplete.*returned 0/);
  assert.match(feedback([...publicCalls, {args:['-1','0','5'], result:'5'}]), /incomplete/);
  assert.match(feedback([...publicCalls, {args:['0','20','5'], result:'5'}]), /^Practice checks complete/);
});

test('delivery bill practice card includes labelled edge case and sample-test disclaimer, and grading names hidden categories', () => {
  const doc = practiceDocument({
    id:'75141e8f-b5ce-56c8-befc-c325019517bf', language:'python', title:'Calculate a delivery bill',
    question:'Return total cost.', starter:'def bill(q, p, d):\n  pass', assistance:true, path:'/p', account:'a',
    tests:[{id:'t1',kind:'function',call:'bill(3, 20, 5)',expected:'65'}],
  });
  const card = doc.cells[0].text;
  assert.match(card, /Edge case/);
  assert.match(card, /bill\(0, 20, 5\)/);
  assert.match(card, /Sample tests are a quick check/);
  assert.match(samplesMarkdown([{id:'t1',verdict:'passed',given:'bill(3, 20, 5)',expected:'65',actual:'65',stderr:''}]),
    /Sample tests are a quick check/);
  const report = gradingMarkdown({
    suite_version:1, passed:3, total:3, all_passed:true,
    public:{passed:1, total:1},
    cases:[
      {id:'t1', visibility:'public', verdict:'passed'},
      {id:'h1', visibility:'hidden', verdict:'passed', category:'edge case'},
      {id:'h2', visibility:'hidden', verdict:'passed', category:'large input'},
    ] as any,
  });
  assert.match(report, /Hidden tests also checked: edge case, large input/);
});
