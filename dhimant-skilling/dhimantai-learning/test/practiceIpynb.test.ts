import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {layout, scaffold, toCell, toMirror} from '../src/cellLayout';
import {inputMarkdown, parseRunInput, sampleFiles, splitArgs, withoutStarter, learnerSource, parsePrediction, practiceFileName, practiceIpynb, practiceLink, predictionMarkdown, samplesMarkdown, tutorMarkdown, learnerMarkdown, noticeMarkdown,
  safeMarkdown, gradingMarkdown, taskChanged, practiceMetadata, taskMarkdown, parseReflection, reflectionMarkdown, ladderNote} from '../src/practiceIpynb';

const practice = {id:'9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a', language:'python', question:'# Sum\nPrint the sum.', starter:'print(1)',
  title:'Sum two numbers!', assistance:true, path:'/practice-code/9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a/notebook-coach', account:'acct-1',
  tests:[{id:'t1', kind:'stdio' as const, stdin:'1 2\n', expected:'3'}]};

test('a Practice task becomes a notebook with task, code and prediction cells and a checked link', () => {
  const nb = practiceIpynb(practice, 'staging') as any;
  // Its example reads typed input, so a Run with cell sits between the code and the prediction.
  assert.deepEqual(nb.cells.map((c: any) => c.cell_type), ['markdown', 'code', 'markdown', 'markdown']);
  assert.equal(parseRunInput(nb.cells[2].source).stdin, '1 2\n');
  assert.equal(nb.cells[1].source, 'print(1)');
  assert.equal(nb.metadata.kernelspec.language, 'python');
  assert.equal(nb.metadata.dhimantai_coach.path, practice.path);
  const link = practiceLink(nb.metadata, ['production', 'staging']);
  assert.equal(link?.questionId, practice.id);assert.equal(link?.tests.length, 1);
  // A notebook cannot point help at an unknown service, language or exercise.
  assert.equal(practiceLink({...nb.metadata, dhimantai_practice: {...nb.metadata.dhimantai_practice, environment: 'evil'}}, ['production', 'staging']), undefined);
  assert.equal(practiceLink({...nb.metadata, dhimantai_practice: {...nb.metadata.dhimantai_practice, question_id: '../x'}}, ['staging']), undefined);
  assert.equal(practiceFileName(practice), 'sum-two-numbers-9d6ba91a.ipynb');
  assert.throws(() => practiceIpynb({...practice, language: 'cobol'}, 'staging'));
});

test('predictions, replies and sample results are readable markdown that cannot break out of their blocks', () => {
  assert.equal(parsePrediction(predictionMarkdown()), undefined);
  assert.equal(parsePrediction(predictionMarkdown('3\n4')), '3\n4');
  assert.match(tutorMarkdown('Step 1 *of* 4', 'Ask yourself why.'), /\\\*of\\\*/);
  const question = 'Explain this without truncating my question. '.repeat(8);
  assert.ok(learnerMarkdown(question).includes(question));
  assert.doesNotMatch(learnerMarkdown('<img src=x onerror=alert(1)>'), /(^|[^\\])<img/);
  assert.doesNotMatch(noticeMarkdown('<script>bad</script>'), /(^|[^\\])<script/);
  const md = samplesMarkdown([{id:'t1', verdict:'wrong_answer', given:'1 2', expected:'3', actual:'```\n4', stderr:''}]);
  assert.match(md, /0 of 1 passed/);assert.doesNotMatch(md, /\n  ```\n4/);
  assert.equal(learnerSource([{code:true, helper:false, text:'a'}, {code:false, helper:false, text:'note'}, {code:true, helper:true, text:'h'}, {code:true, helper:false, text:'b'}]), 'a\n\nb');
});

test('mirror lines map to the right cell and back, including separators', () => {
  const {text, segments} = layout([{uri:'c1', text:'package main\n'}, {uri:'c2', text:'func main() {\n}'}]);
  assert.equal(text, 'package main\n\n\nfunc main() {\n}\n');
  assert.deepEqual(toCell(segments, 3), {cell:'c2', line:0});
  assert.deepEqual(toCell(segments, 2), {cell:'c1', line:1});
  assert.equal(toMirror(segments, 'c2', 1), 4);
  assert.equal(scaffold('java', 'public class Solver {}').main, 'Solver.java');
  assert.match(scaffold('rust', '').files['Cargo.toml'], /edition = "2021"/);
});

test('the task cell does not repeat the starter code the learner already has below it', () => {
  const question = 'Implement it.\n\nStarter code:\n\n```python\nprint(1)\n```\n\nExample:\n\n```text\n1\n```';
  const task = withoutStarter(question, 'print(1)\n');
  assert.doesNotMatch(task, /print\(1\)|Starter code/);assert.match(task, /Example:\n\n```text\n1/);
  assert.equal(withoutStarter(question, 'print(2)'), question);
});

test('Run arguments split like a terminal and round-trip through the Run with cell', () => {
  assert.deepEqual(splitArgs('--count "my words.txt" it\\\'s \'a b\' ""'), ['--count', 'my words.txt', "it's", 'a b', '']);
  const md = inputMarkdown(['--name', 'Asha Rao', "it's"], 'line one\nline two\n');
  assert.deepEqual(parseRunInput(md), {argv: ['--name', 'Asha Rao', "it's"], stdin: 'line one\nline two\n'});
  assert.deepEqual(parseRunInput(inputMarkdown()), {argv: [], stdin: ''});
  assert.deepEqual(sampleFiles([{id:'a', kind:'cli', expected:'', files:[{name:'w.txt', content:'1'}]}, {id:'b', kind:'cli', expected:'', files:[{name:'w.txt', content:'2'}]}]), [{name:'w.txt', content:'1'}]);
  const nb = practiceIpynb({...practice, tests:[{id:'t1', kind:'cli', argv:['--count', 'w.txt'], expected:'x'}]}, 'staging') as any;
  assert.equal(nb.cells[2].metadata.dhimantai_practice_role, 'input');
  assert.deepEqual(parseRunInput(nb.cells[2].source).argv, ['--count', 'w.txt']);
  assert.equal((practiceIpynb({...practice, tests: []}, 'staging') as any).cells.length, 3);
});

test('Instructor replies lose images, raw HTML and unsafe links before they reach a markdown cell', () => {
  const reply = 'See ![diagram](http://tracker.example/x.png) and <img src=x onerror=alert(1)> <b>bold</b>.\n' +
    '[run this](command:workbench.action.terminal.sendSequence?%7B%7D) [open](vscode://file/etc/passwd) [docs](https://docs.python.org/3/) ' +
    '[plain](http://example.com) ![ref][logo]\n[logo]: http://tracker.example/logo.png\n[ok]: https://example.com\n' +
    '<!-- hidden --> Use `a<b` here.\n```python\nif a < b:\n    print("<b>")\n```';
  const out = safeMarkdown(reply);
  assert.doesNotMatch(out, /!\[|<img|<b>bold|command:|vscode:|http:\/\/|hidden/);
  assert.match(out, /\[docs\]\(https:\/\/docs\.python\.org\/3\/\)/, 'https links stay');
  assert.match(out, /run this/); assert.match(out, /diagram/);
  assert.match(out, /\[ok\]: https:\/\/example\.com/);
  assert.match(out, /`a<b`/, 'inline code is untouched');
  assert.match(out, /if a < b:\n {4}print\("<b>"\)/, 'code blocks are untouched');
  assert.doesNotMatch(tutorMarkdown('Hint', '<script>alert(1)</script> ![x](https://a.example/p.png)'), /<script>|!\[/);
});

test('a graded result names failed hidden cases by kind only, and the next exercise after a full pass', () => {
  const secret = {id: 'h1', visibility: 'hidden' as const, verdict: 'wrong_answer' as const, label: 'Wrong answer', category: 'empty input',
    input: {stdin: 'SECRET-INPUT'}, expected: 'SECRET-EXPECTED', actual: 'SECRET-ACTUAL'};
  const report = {suite_version: 1, passed: 2, total: 4, all_passed: false, public: {passed: 1, total: 2},
    cases: [{id: 'p1', visibility: 'public' as const, verdict: 'passed' as const, label: 'Passed'},
      {id: 'p2', visibility: 'public' as const, verdict: 'runtime_error' as const, label: 'Runtime error'}, secret,
      {id: 'h2', visibility: 'hidden' as const, verdict: 'timeout' as const, label: 'Time limit exceeded', category: 'made-up <b>'} as any,
      {id: 'h3', visibility: 'hidden' as const, verdict: 'passed' as const, label: 'Passed'}]};
  report.passed = 2; report.total = 5;
  const md = gradingMarkdown(report, {next: 'Ignored until solved'});
  assert.match(md, /2 of 5 tests passed/);
  assert.match(md, /Hidden tests: 1 of 3/);
  assert.match(md, /Hidden test 1 · Wrong answer · an empty input/);
  assert.match(md, /Hidden test 2 · Time limit exceeded · another case/, 'an unknown category is never echoed');
  assert.match(md, /Sample p2 failed/);
  assert.doesNotMatch(md, /SECRET|made-up|h1|h2|Next exercise|solved/);
  const passed = gradingMarkdown({...report, passed: 5, all_passed: true, public: {passed: 2, total: 2},
    cases: report.cases.map(c => ({...c, verdict: 'passed' as const}))}, {next: 'Reverse *words*', earlier: true});
  assert.match(passed, /This problem is solved/);
  assert.match(passed, /\*\*Next exercise:\*\* Reverse \\\*words\\\*/);
  assert.match(passed, /for your earlier code/);
});

test('sample results say when the code changed while they ran', () => {
  const rows = [{id: 't1', verdict: 'passed', given: '', expected: '3', actual: '3', stderr: ''}];
  assert.doesNotMatch(samplesMarkdown(rows), /earlier/);
  assert.match(samplesMarkdown(rows, true), /1 of 1 passed for your earlier code/);
});

test('a stored task is compared with the service so a changed exercise is refreshed, not reported as a conflict', () => {
  const nb = practiceIpynb(practice, 'staging') as any;
  assert.equal(nb.cells[0].metadata.dhimantai_practice_role, 'task');
  assert.equal(nb.cells[0].source, taskMarkdown(practice));
  assert.equal(taskChanged(nb.metadata, practice, 'staging'), false);
  assert.equal(taskChanged(nb.metadata, {...practice, question: '# Sum\nPrint the sum of three numbers.'}, 'staging'), true);
  assert.equal(taskChanged(nb.metadata, {...practice, tests: [{...practice.tests[0], expected: '4'}]}, 'staging'), true);
  assert.equal(taskChanged(nb.metadata, {...practice, starter: 'print(2)'}, 'staging'), false, 'learner code is never compared');
  const fresh = practiceMetadata({...practice, title: 'New title'}, 'staging');
  assert.equal(practiceLink(fresh, ['staging'])?.title, 'New title');
});

test('the reflection cell holds the learner explanation', () => {
  assert.equal(parseReflection(reflectionMarkdown()), undefined);
  assert.equal(parseReflection(reflectionMarkdown().replace('```text\n', '```text\nIt handles empty lists first.')), 'It handles empty lists first.');
});

test('a held help rung is a short plain notice', () => {
  assert.equal(ladderNote('  Run   changed code\nfirst. '), 'Run changed code first.');
  assert.equal(ladderNote(''), undefined); assert.equal(ladderNote(null), undefined); assert.equal(ladderNote(3), undefined);
  assert.match(noticeMarkdown(ladderNote('Try <b>it</b> *first*')!), /\\<b\\>it\\<\/b\\> \\\*first\\\*/);
});
