import type { PublicTest } from './api';

export const skillStages = ['debug','test','unit_test','functional_test','read_code','requirements','design','refactor','git','research','security','performance'] as const;
export type SkillStage = typeof skillStages[number];
export const skillPrompts = {
  debug: 'Help me start debugging this cell in the shared notebook. Explain Debug in VS Code, help me choose a useful breakpoint and predict one variable before stepping. Guide one action at a time; do not fix it for me.',
  unit_test: 'Help me write one unit test for this code in the shared notebook. First ask what one function promises and what result I expect. Help with an assertion or a small test scaffold, then guide Run test code on a self-contained cell. Use its actual result to decide the next check.',
  functional_test: 'Help me write a functional test for this complete program in the shared notebook. Start from one observable requirement and expected result. Help me enter the case under Design your own tests and Run my tests, then interpret the actual comparison. Explain what remains untested.',
  read_code: 'Help me read this unfamiliar code before changing it. Start with its purpose and entry point, then trace one small input through calls, branches and data changes. Ask for my prediction and explanation. Separate visible facts from assumptions; ask for missing called code when needed.',
  requirements: 'Teach me to understand a requirement before coding. Help me identify who needs this, the inputs, observable result and constraints. Ask me to explain one acceptance example and one ambiguity in my own words. Do not invent requirements or implement the solution.',
  design: 'Teach me to break this problem into small parts before coding. Help me name each responsibility, its input and output, choose a simple data structure and explain one tradeoff. Ask me to walk one small example through my plan before implementing it.',
  refactor: 'Teach me to review and improve code safely. Explain refactoring first if it is new to me. Help me identify one concrete readability or design concern, protect current behavior with a test, make one small change myself and compare the result. Do not rewrite the solution for me.',
  git: 'Teach me to use Git and collaborate on a small change. Explain the working tree, staging and commits simply, then guide status and diff inspection before choosing related files. Help me explain the problem, change and tests for a reviewer. You have no repository state unless I share it.',
  research: 'Teach me to answer one coding question using official documentation. Help me form a precise question, identify the language or library version, find the relevant contract and try a tiny example. Ask me to explain how it applies. Distinguish verified documentation from a suggested lookup.',
  security: 'Teach me one security or reliability habit relevant to this code. Explain the idea simply, identify an input or failure boundary, and ask how I would validate it or handle failure. Use a small local test. Do not invent a vulnerability or claim an audit from one code cell.',
  performance: 'Teach me to investigate performance using evidence. Explain what measurement means, choose one realistic workload and metric, and establish a baseline before proposing an optimization. Help me reason about algorithmic cost, measure a small change and rerun correctness tests. Do not invent timings.',
} as const;
export const engineeringSkills: {id:Exclude<SkillStage,'test'>;title:string;meaning:string;firstStep:string}[] = [
  {id:'requirements',title:'Understand requirements',meaning:'Work out what someone needs the program to do and how you will know it works.',firstStep:'State the input and expected result for one example before writing code.'},
  {id:'design',title:'Break down a problem',meaning:'Split a problem into small responsibilities that fit together.',firstStep:'Name one part, what it receives and what it produces; trace a tiny example through your plan.'},
  {id:'read_code',title:'Read unfamiliar code',meaning:'Build an explanation of how existing code works before changing it.',firstStep:'Find its entry point and follow one input through a small section.'},
  {id:'debug',title:'Debug systematically',meaning:'Debugging means finding and fixing why actual behavior differs from expected behavior. If doubling 2 should give 4 but gives 5, debugging investigates the cause.',firstStep:'Reproduce one mismatch, propose a cause, and use a breakpoint to check that idea.'},
  {id:'unit_test',title:'Write unit tests',meaning:'Testing checks behavior against an explicit expectation. A unit test checks one small component, such as a function. A test that expects doubling 2 to give 4 fails if the function returns 5.',firstStep:'Choose an input, derive the expected result from the requirement, and write one assertion that compares them.'},
  {id:'functional_test',title:'Write functional tests',meaning:'A functional test checks what the program does from the outside against a requirement.',firstStep:'Describe a user-visible scenario and expected result, then run that exact case.'},
  {id:'refactor',title:'Refactor and review',meaning:'Refactoring improves code structure while preserving behavior. Review checks whether a change is understandable and justified.',firstStep:'Explain one concern, protect the behavior with a test, and review one small change.'},
  {id:'git',title:'Use Git and collaborate',meaning:'Git records versions of your work so people can inspect changes and work together.',firstStep:'Inspect status and diff, then explain which files belong in one focused commit.'},
  {id:'research',title:'Use documentation',meaning:'Find and verify how an API or tool behaves instead of relying on a guess.',firstStep:'Write one precise question, check the relevant version’s official documentation, and try a small example.'},
  {id:'security',title:'Build securely and reliably',meaning:'Protect data and handle invalid input or failures without unexpected harm.',firstStep:'Identify one boundary or failure case and explain a safe, testable behavior.'},
  {id:'performance',title:'Measure performance',meaning:'Measure where time or memory goes before trying to make a program faster.',firstStep:'Choose a workload and baseline metric; compare a change under the same conditions.'},
];
export const caseKinds = ['typical', 'boundary', 'invalid', 'regression'] as const;
export interface LearnerTestCase {
  kind: typeof caseKinds[number];
  reason: string;
  stdin: string;
  expected: string;
}
export interface SkillDraft {
  expected: string;
  hypothesis: string;
  experiment: string;
  cases: LearnerTestCase[];
}
export const MAX_LEARNER_TESTS = 6;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
export function validLearnerTests(value: unknown): value is LearnerTestCase[] {
  return Array.isArray(value) && value.length <= MAX_LEARNER_TESTS && value.every(c => c
    && caseKinds.includes(c.kind) && text(c.reason, 160) && text(c.stdin, 1000) && text(c.expected, 1000));
}
export function validSkillDraft(value: unknown): value is SkillDraft {
  const d = value as SkillDraft;
  return !!d && text(d.expected, 140) && text(d.hypothesis, 140) && text(d.experiment, 140) && validLearnerTests(d.cases);
}
/** Only learner-authored stdin/output comparisons, never executable test expressions or hidden cases. */
export function learnerTests(value: unknown): PublicTest[] {
  if (!validLearnerTests(value) || !value.length || value.some(c => !c.reason.trim()))
    throw new Error('Add up to six test cases and explain what each one checks.');
  return value.map((c, i) => ({id: 'learner-' + (i + 1), kind: 'stdio', stdin: c.stdin, expected: c.expected}));
}
export function investigationPrompt(d: SkillDraft) {
  return `Help me investigate one step at a time, without fixing the code for me.\nExpected: ${d.expected}\nHypothesis: ${d.hypothesis}\nNext experiment: ${d.experiment}`;
}
export function testDesignPrompt(c: LearnerTestCase, result?: {verdict:string;actual:string;stderr:string}) {
  const excerpt = (s: string) => s.length > 60 ? s.slice(0, 40) + ' [excerpt]' : s;
  return `Help me improve this ${c.kind} test. Check my expectation against the task; do not give the solution.\nReason: ${excerpt(c.reason)}\nInput: ${excerpt(c.stdin)}\nMy expected output: ${excerpt(c.expected)}`
    + (result ? `\nDevice result for this case: ${excerpt(result.verdict)}\nActual: ${excerpt(result.actual)}\nDiagnostics: ${excerpt(result.stderr)}` : '\nThis case has no current test result.');
}
