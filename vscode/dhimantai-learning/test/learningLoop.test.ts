import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkExplanation, comparePrediction, predictionFeedback, judgeVariation, sameValues, stepForOutput, ladder, makeVariation, summarize, wordCountOutput } from '../src/learningLoop';
import type { RunConfiguration } from '../src/api';

const wordCount = { preset: 'word_count', sample_files: [], arguments: [], protocol: 2, max_files: 5, max_file_bytes: 32000, max_total_bytes: 64000 } as RunConfiguration;

test('prediction comparison finds the first surprise', () => {
  assert.deepEqual(comparePrediction('a 1\nb 2\n', 'a 1\nb 2\n'), { matched: 2, total: 2, exact: true, firstSurprise: undefined });
  const result = comparePrediction('a 1\nb 1', 'a 1\nb 2\n');
  assert.equal(result.exact, false);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.firstSurprise, { line: 2, predicted: 'b 1', actual: 'b 2', offset: 4 });
  assert.deepEqual(comparePrediction('', '').exact, true, 'predicting no output for no output is exact');
  assert.equal(comparePrediction('', 'x\n').firstSurprise?.missing, 'prediction');
});

test('multiline predictions distinguish omitted lines, extra lines, blank lines and wrong values', () => {
  const out = 'Time 1: 10:30:00\nTime 2: 09:15:00\nTime difference in seconds: 4500\n';
  assert.equal(comparePrediction(out.replace(/\n/g, '\r\n'), out).exact, true);
  const missing = comparePrediction('Time 1: 10:30:00', out);
  assert.equal(missing.firstSurprise?.missing, 'prediction');
  assert.match(predictionFeedback(missing), /No prediction was supplied for output line 2/);
  assert.match(predictionFeedback(comparePrediction(out + 'extra', out)), /no output line there/);
  const blank = comparePrediction('first\n\nlast', 'first\nsecond\nlast');
  assert.equal(blank.firstSurprise?.missing, undefined);
  assert.match(predictionFeedback(blank), /\(blank line\)/);
  const wrong = comparePrediction(out.replace('4500', '4400'), out);
  assert.equal(wrong.firstSurprise?.missing, undefined);
  assert.match(predictionFeedback(wrong), /First different value at line 3/);
});

test('values written differently are not wrong guesses, and the first wrong value is the surprise', () => {
  assert.ok(sameValues('14', 'Sum: 14'));
  assert.ok(sameValues('sum 14', 'Sum: 14'));
  assert.ok(sameValues('2', 'Quotient: 2.0'));
  assert.ok(!sameValues('14', 'Difference: 6'));
  assert.ok(!sameValues('total 14', 'Sum: 14'), 'a word the learner wrote must be printed');
  const out = 'Sum: 14\nDifference: 6\nQuotient: 2.5\n';
  const almost = comparePrediction('14\n6\n2.5', out);
  assert.equal(almost.exact, false, 'evidence stays strict');
  assert.equal(almost.formatOnly, true);
  const wrong = comparePrediction('14\n14\n2.5', out);
  assert.equal(wrong.formatOnly, undefined);
  assert.deepEqual(wrong.firstSurprise, { line: 2, predicted: '14', actual: 'Difference: 6', offset: 8 },
    'a label difference on line 1 does not hide the wrong value on line 2');
  assert.equal(comparePrediction('14\n6\n2.5\n9', out).firstSurprise?.offset, undefined, 'nothing printed to locate');
  // Steps show output before each line runs: output first passes 8 after line 2 runs.
  const steps = [0, 0, 8, 22, 36].map(output => ({ output }));
  assert.equal(stepForOutput(steps, 8), 2);
  assert.equal(stepForOutput(steps, 0), 1);
  assert.equal(stepForOutput(steps, 99), undefined);
});

test('changed meanings and distinct large numbers never receive values-right feedback', () => {
  for (const [prediction, output] of [
    ['equal 1', 'not equal 1'], ['cat 1', 'bobcat 1'], ['[1, 2]', '(1, 2)'],
    ['1', '[1]'], ['True', 'true'], ['-', '+'], ['<', '>'], ['-4500', '4500'],
    ['9007199254740992', '9007199254740993'], ['1e999', '2e999'],
    ['0.10000000000000001', '0.10000000000000002'], ['4500', 'seconds4500'],
  ]) {
    const result = comparePrediction(prediction, output);
    assert.equal(result.exact, false);
    assert.equal(result.formatOnly, undefined, `${prediction} differs from ${output}`);
    assert.doesNotMatch(predictionFeedback(result), /values are right/);
  }
  for (const [prediction, output] of [['2', 'Quotient: 2.0'], ['.5', '0.50'],
    ['sum +14', 'Sum: 1.4e1'], ['9007199254740993', '9007199254740993.0'], ['-0', '0.0']]) {
    assert.equal(comparePrediction(prediction, output).formatOnly, true);
  }
  const result = comparePrediction('14\nequal 1', 'Sum: 14\nnot equal 1');
  assert.equal(result.firstSurprise?.line, 2, 'a changed meaning outranks an omitted label');
});

test('a final newline is optional but an extra blank output line is observable', () => {
  assert.equal(comparePrediction('4500', '4500\n').exact, true);
  assert.equal(comparePrediction('4500\n', '4500\n\n').firstSurprise?.missing, 'prediction');
  assert.equal(comparePrediction('4500\n\n', '4500\n').firstSurprise?.missing, 'output');
  assert.equal(comparePrediction('4500\n\n', '4500\r\n\r\n').exact, true);
  assert.equal(comparePrediction('', '\n').firstSurprise?.missing, 'prediction');
  assert.equal(comparePrediction('\n', '\n').exact, true);
});

test('help ladder requires an attempt, then weaker help, then self-explanation', () => {
  const fresh = { attemptsSinceHelp: 0, received: [], independent: false };
  assert.deepEqual(ladder(fresh, 'hint'), { allowed: true, needsExplanation: false, marksAssisted: false }, 'a hint is always one click away');
  const tried = { ...fresh, attemptsSinceHelp: 1 };
  assert.equal(ladder(tried, 'statement').allowed, false, 'no line before a hint');
  const hinted = { attemptsSinceHelp: 0, received: ['hint' as const], independent: false };
  assert.equal(ladder(hinted, 'statement').allowed, false, 'must try the hint first');
  assert.deepEqual(ladder({ ...hinted, attemptsSinceHelp: 1 }, 'statement'), { allowed: true, needsExplanation: true, marksAssisted: false });
  assert.equal(ladder({ ...hinted, attemptsSinceHelp: 1 }, 'block').allowed, false, 'no block before a line or two hints');
  assert.equal(ladder({ attemptsSinceHelp: 1, received: ['hint', 'statement'], independent: false }, 'block').allowed, true);
  assert.equal(ladder({ attemptsSinceHelp: 1, received: ['hint', 'hint'], independent: false }, 'block').allowed, true);
  const decision = ladder({ attemptsSinceHelp: 1, received: [], independent: true }, 'hint');
  assert.ok(decision.allowed && decision.marksAssisted, 'help during a variation marks it assisted');
  assert.match(checkExplanation('idk')!, /20\+ characters/);
  assert.equal(checkExplanation('I think the file object is never read'), undefined);
  const source = 'totl = 0\nfor word in words:\n    total += 1\n';
  assert.match(checkExplanation('idk the code is wrong and not working', source)!, /something specific/);
  assert.equal(checkExplanation('line 3 adds to a name that does not exist', source), undefined);
  assert.equal(checkExplanation('total is never set before the loop starts', source), undefined);
  assert.equal(checkExplanation('python cannot find that name anywhere', source, "NameError: name 'total' is not defined"), undefined);
});

test('word count variation is reproducible and its expected output follows the course rules', () => {
  const a = makeVariation(wordCount, 42, []);
  const b = makeVariation(wordCount, 42, []);
  assert.deepEqual(a, b);
  assert.notDeepEqual(makeVariation(wordCount, 43, []).file.content, a.file.content);
  assert.equal(a.expected, wordCountOutput(a.file.content, a.argv[0]));
  assert.equal(a.argv[1], a.file.name);
  assert.equal(wordCountOutput('B a b\n', '--count'), 'a 1\nb 2\n');
  assert.equal(wordCountOutput('x y y z z z\n', '--topcount'), 'z 3\ny 2\nx 1\n');
  assert.equal(wordCountOutput('a b\n', '--topcount'), 'a 1\nb 1\n', 'ties keep first-seen order (Counter.most_common)');
});

test('a variation passes only when clean, predicted exactly, correct and unassisted', () => {
  const v = makeVariation(wordCount, 7, []);
  const ok = (stdout: string) => ({ status: 'exited', exit_code: 0, stdout, truncated: false });
  assert.equal(judgeVariation(v, v.expected!, ok(v.expected!), false).passed, true);
  assert.equal(judgeVariation(v, v.expected!, ok(v.expected!), true).passed, false, 'help makes it assisted');
  assert.equal(judgeVariation(v, 'guess\n', ok(v.expected!), false).passed, false, 'wrong prediction');
  assert.equal(judgeVariation(v, 'wrong\n', ok('wrong\n'), false).passed, false, 'consistent but incorrect program');
  // Review finding 6: printing the right output and then crashing is not a pass.
  const crash = judgeVariation(v, v.expected!, { status: 'exited', exit_code: 1, stdout: v.expected!, truncated: false }, false);
  assert.equal(crash.passed, false);
  assert.equal(crash.clean, false);
  assert.equal(crash.prediction.exact, true, 'prediction feedback is still given');
  assert.equal(judgeVariation(v, v.expected!, { status: 'timeout', exit_code: null, stdout: v.expected!, truncated: false }, false).passed, false);
  assert.equal(judgeVariation(v, v.expected!, { ...ok(v.expected!), truncated: true }, false).passed, false, 'incomplete output');
  const open = makeVariation(undefined, 7, ['x']);
  assert.equal(open.expected, undefined);
  const unchecked = judgeVariation(open, 'out\n', ok('out\n'), false);
  assert.equal(unchecked.passed, false, 'predicting a program without a reference cannot establish correctness');
  assert.equal(unchecked.prediction.exact, true, 'preserve the useful prediction observation');
});

test('a crashing run that prints the sample output does not unlock or close an episode', async () => {
  const { ladderFrom } = await import('../src/learningLoop');
  const at = '2026-10-23T00:00:00Z';
  const crashed = { type: 'run' as const, at, status: 'exited', clean: false, expected: 'match' as const };
  assert.equal(summarize([crashed]).solvedWithSamples, false);
  assert.equal(summarize([{ ...crashed, clean: true }]).solvedWithSamples, true);
  assert.deepEqual(ladderFrom([{ type: 'help', at, mode: 'hint', duringVariation: false }, crashed], false).received, ['hint']);
});

test('progress summary separates assisted and independent work', () => {
  const at = '2026-10-23T00:00:00Z';
  const p = summarize([
    { type: 'run', at, status: 'exited', predicted: comparePrediction('a', 'b'), expected: 'differs' },
    { type: 'help', at, mode: 'hint', duringVariation: false },
    { type: 'help', at, mode: 'statement', explanation: 'file is not read', applied: true, duringVariation: false },
    { type: 'run', at, status: 'exited', clean: true, predicted: comparePrediction('a', 'a'), expected: 'match' },
    { type: 'trace', at, steps: 20 },
    { type: 'variation', at, seed: 1, outcome: { prediction: comparePrediction('x', 'x'), correctness: { result: 'match' }, independent: true, clean: true, passed: true } },
  ]);
  assert.deepEqual(p, { runs: 2, predictions: 2, exactPredictions: 1, skippedPredictions: 0, traces: 1, help: { hint: 1, statement: 1, block: 0, coach: 0 }, applied: 1, solvedWithSamples: true, independent: { attempts: 1, passed: 1 } });
});

test('ladder state is rebuilt from evidence and resets after a solved episode', async () => {
  const { ladderFrom } = await import('../src/learningLoop');
  const at = '2026-10-23T00:00:00Z';
  const run = (expected?: 'match' | 'differs') => ({ type: 'run' as const, at, status: 'exited', clean: true, expected });
  const help = (mode: 'hint' | 'statement') => ({ type: 'help' as const, at, mode, duringVariation: false });
  assert.deepEqual(ladderFrom([run('differs'), help('hint'), run('differs')], false), { attemptsSinceHelp: 1, received: ['hint'], independent: false });
  assert.deepEqual(ladderFrom([run(), help('hint'), help('statement')], true), { attemptsSinceHelp: 0, received: ['hint', 'statement'], independent: true });
  assert.deepEqual(ladderFrom([help('hint'), run('match')], false).received, []);
});

test('contract fixture matches what the extension records (the backend test validates the same file)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { SEED_MAX, newVariationSeed } = await import('../src/learningLoop');
  const { events } = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/learning-events.json'), 'utf8'));
  const fields: Record<string, string[]> = {
    run: ['id', 'type', 'at', 'draftVersion', 'status', 'clean', 'predicted', 'expected'],
    trace: ['id', 'type', 'at', 'steps'],
    help: ['id', 'type', 'at', 'mode', 'explanation', 'duringVariation'],
    applied: ['id', 'type', 'at', 'mode'],
    variation: ['id', 'type', 'at', 'seed', 'outcome'],
  };
  for (const e of events) {
    const extra = Object.keys(e).filter(k => !fields[e.type]?.includes(k));
    assert.deepEqual(extra, [], `${e.type} has fields the extension does not send`);
  }
  // The fixture covers the generator's full range, so the backend test checks the real maximum.
  assert.ok(events.some((e: any) => e.type === 'variation' && e.seed === SEED_MAX));
  for (let i = 0; i < 1000; i++) {
    const seed = newVariationSeed();
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX);
  }
  const outcome = judgeVariation(makeVariation(wordCount, 1, []), 'x', { status: 'exited', exit_code: 0, stdout: 'x', truncated: false }, false);
  assert.deepEqual(Object.keys(outcome).sort(), ['clean', 'correctness', 'independent', 'passed', 'prediction']);
});

test('variations use new data shaped like the exercise, from a named sample file or stdin', async () => {
  const { makeVariation, perturb } = await import('../src/learningLoop');
  const varied = perturb('Ravi 42\nmeera -3.50\nTOTAL 7\n', 5);
  assert.match(varied, /^[A-Z][a-z]+ [1-9]\d\n[a-z]+ -\d\.\d\d\n[A-Z]+ \d\n$/);
  assert.notEqual(varied, 'Ravi 42\nmeera -3.50\nTOTAL 7\n');
  assert.equal(perturb('a 1', 9), perturb('a 1', 9), 'reproducible from the seed');
  const files = { files: [{ name: 'scores.txt', content: 'asha 90\nbo 75\n' }], stdin: '' };
  const fromFile = makeVariation(undefined, 12, ['--top', 'scores.txt'], files);
  assert.deepEqual(fromFile.argv, ['--top', fromFile.file.name]);
  assert.match(fromFile.file.content, /^[a-z]+ \d\d\n[a-z]+ \d\d\n$/);
  assert.equal(fromFile.expected, undefined, 'no invented reference answer');
  const fromStdin = makeVariation(undefined, 3, [], { files: [], stdin: '4\n10 20 30 40\n' });
  assert.match(fromStdin.stdin!, /^\d\n\d\d \d\d \d\d \d\d\n$/);
  assert.match(makeVariation(undefined, 3, [], { files: [], stdin: '' }).prompt, /Change one input yourself/);
});
