// A Practice task as a real Jupyter notebook, so VS Code's own editor and the official language extensions
// (Pylance, rust-analyzer, Go, Java, C/C++) give completion, errors and navigation in its cells.
// Pure functions only: the host writes and opens the file; nothing here touches VS Code.
import type { PublicTest } from './api';
import type { EnvironmentName } from './environments';
import { questionMarkdown, type PracticeNotebook } from './practiceNotebook';

const KERNELS: Record<string, {name: string; display_name: string; extension: string}> = {
  python: {name: 'python3', display_name: 'Python 3', extension: '.py'},
  javascript: {name: 'javascript', display_name: 'JavaScript', extension: '.js'},
  typescript: {name: 'typescript', display_name: 'TypeScript', extension: '.ts'},
  rust: {name: 'rust', display_name: 'Rust', extension: '.rs'},
  java: {name: 'java', display_name: 'Java', extension: '.java'},
  c: {name: 'c', display_name: 'C', extension: '.c'},
  go: {name: 'go', display_name: 'Go', extension: '.go'},
  sql: {name: 'sql', display_name: 'PostgreSQL', extension: '.sql'},
  // Administration labs are bash scripts; their cells use VS Code's shell language.
  pglab: {name: 'bash', display_name: 'PostgreSQL lab (bash)', extension: '.sh'},
};
const CELL_LANGUAGE: Record<string, string> = {pglab: 'shellscript'};

export interface PracticeLink {
  version: 1;
  questionId: string;
  account: string;
  environment: EnvironmentName;
  title: string;
  language: string;
  /** Published sample tests only. Hidden tests never leave the service. */
  tests: PublicTest[];
  /** SQL: the exercise dataset loaded before each Run. */
  dataset: string;
}

/** One file per task, named so a learner recognises it in the Explorer. */
export function practiceFileName(practice: Pick<PracticeNotebook, 'id' | 'title'>): string {
  const slug = practice.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'practice';
  return `${slug}-${practice.id.replace(/^generated-/, 'g').slice(0, 8)}.ipynb`;
}

export function practiceIpynb(practice: PracticeNotebook, environment: EnvironmentName) {
  const kernel = KERNELS[practice.language];
  if (!kernel) throw new Error('This exercise needs a supported programming language.');
  const tests = practice.tests.slice(0, 20);
  return {
    nbformat: 4, nbformat_minor: 5,
    metadata: {
      kernelspec: {name: kernel.name, display_name: kernel.display_name, language: CELL_LANGUAGE[practice.language] ?? practice.language},
      language_info: {name: CELL_LANGUAGE[practice.language] ?? practice.language, file_extension: kernel.extension},
      // Read by the Instructor panel (notebookCommands.contextFor): which service and Instructor path help comes from.
      dhimantai_coach: {version: 1, environment, question: practice.question.slice(0, 6000), path: practice.path},
      dhimantai_practice: {version: 1, question_id: practice.id, account: practice.account, environment,
        code_assistance_allowed: practice.assistance,
        title: practice.title, language: practice.language, tests, ...(practice.dataset ? {dataset: practice.dataset.slice(0, 64000)} : {})},
    },
    cells: [
      {id: 'task', cell_type: 'markdown', metadata: {dhimantai_coach_helper: true},
        source: questionMarkdown(withoutStarter(practice.question, practice.starter), practice.title)},
      {id: 'solution', cell_type: 'code', metadata: {dhimantai_coach_entry: true}, execution_count: null, outputs: [],
        source: practice.starter || ''},
      // Arguments and typed input for Run, shown only when the task's examples use them.
      ...(tests.some(t => t.argv?.length || t.stdin) ? [{id: 'input', cell_type: 'markdown', metadata: {dhimantai_practice_role: 'input'},
        source: inputMarkdown(tests.find(t => t.argv?.length || t.stdin)?.argv ?? [], tests.find(t => t.argv?.length || t.stdin)?.stdin ?? '')}] : []),
      // Predict before Run: the run is compared with this cell, and Instructor sees both.
      {id: 'prediction', cell_type: 'markdown', metadata: {dhimantai_practice_role: 'prediction'}, source: predictionMarkdown()},
    ],
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Practice link a notebook carries, or undefined. A notebook file cannot point help at another service. */
export function practiceLink(metadata: any, environments: readonly string[]): PracticeLink | undefined {
  const link = metadata?.dhimantai_practice;
  if (link?.version !== 1 || typeof link.question_id !== 'string'
      || !(uuid.test(link.question_id) || /^generated-[0-9a-f]{24}$/.test(link.question_id))
      || typeof link.account !== 'string' || !link.account || link.account.length > 100
      || !environments.includes(link.environment) || typeof link.title !== 'string'
      || !Object.hasOwn(KERNELS, link.language) || !Array.isArray(link.tests)) return;
  const tests = (link.tests as any[]).slice(0, 20).filter(t => t && typeof t.id === 'string' && typeof t.expected === 'string'
    && ['stdio', 'cli', 'function', 'sql', 'lab'].includes(t.kind));
  return {version: 1, questionId: link.question_id, account: link.account, environment: link.environment,
    title: link.title.slice(0, 180), language: link.language, tests,
    dataset: typeof link.dataset === 'string' ? link.dataset.slice(0, 64000) : ''};
}

/** The learner's program: every code cell in order, as the Practice panel ran it. */
export function learnerSource(cells: {code: boolean; helper: boolean; text: string}[]): string {
  return cells.filter(cell => cell.code && !cell.helper).map(cell => cell.text).join('\n\n');
}

/** Cells this extension writes into a Practice notebook, told apart by metadata. */
export type PracticeCellRole = 'prediction' | 'samples' | 'tutor' | 'input' | 'learner' | 'notice';

export const INPUT_HEADING = '**Run with:**';

/** Arguments and typed input for Run, in two boxes the learner edits. */
export function inputMarkdown(argv: string[] = [], stdin = ''): string {
  return `${INPUT_HEADING} _Double-click to change. Arguments are split like a terminal command; typed input is what your program reads._\n\n` +
    '```args\n' + argv.map(quoteArg).join(' ') + '\n```\n\n```stdin\n' + stdin.replace(/\n$/, '') + '\n```\n';
}

export function parseRunInput(markdown: string): {argv: string[]; stdin: string} {
  const box = (name: string) => new RegExp('```' + name + '[ \\t]*\\n([\\s\\S]*?)\\n?```').exec(markdown)?.[1] ?? '';
  const stdin = box('stdin');
  return {argv: splitArgs(box('args').trim()), stdin: stdin ? stdin.replace(/\n?$/, '\n') : ''};
}

const quoteArg = (arg: string) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'";

/** POSIX-style word splitting: quotes group words, a backslash escapes the next character. */
export function splitArgs(line: string): string[] {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === '\\' && i + 1 < line.length) { word += line[++i]; started = true; }
    else if (/\s/.test(c)) { if (started) words.push(word); word = ''; started = false; }
    else { word += c; started = true; }
  }
  if (started) words.push(word);
  return words.slice(0, 50);
}

/** Sample files the published tests use, so a run with their arguments finds them beside the program. */
export function sampleFiles(tests: PublicTest[]): {name: string; content: string}[] {
  const files = new Map<string, string>();
  for (const test of tests) for (const file of test.files ?? []) if (!files.has(file.name)) files.set(file.name, file.content);
  return [...files].slice(0, 20).map(([name, content]) => ({name, content}));
}

export const PREDICTION_HEADING = '**I expect it to print:**';

/** An editable cell the learner fills in before Run. The fenced block holds the predicted output. */
export function predictionMarkdown(text = ''): string {
  return `${PREDICTION_HEADING} _Double-click here and write each line you expect inside the box, then run your code._\n\n\`\`\`text\n${text}\n\`\`\`\n`;
}

/** The task without the starter code block, which the learner already has in the code cell below it. */
export function withoutStarter(question: string, starter: string): string {
  const code = starter.trim();
  if (!code) return question;
  return question.replace(/(?:^[#*\s]*starter code[*:\s]*\n+)?```[^\n]*\n([\s\S]*?)```\n?/gim,
    (block, body: string) => body.trim() === code ? '' : block).replace(/\n{3,}/g, '\n\n').trim();
}

/** The prediction a learner typed, or undefined while the cell is still the empty template. */
export function parsePrediction(markdown: string): string | undefined {
  const fenced = /```[^\n]*\n([\s\S]*?)\n?```/.exec(markdown);
  // Without the box, everything after the heading line is the prediction.
  const text = (fenced ? fenced[1] : markdown.split('\n').slice(markdown.startsWith(PREDICTION_HEADING) ? 1 : 0).join('\n')).replace(/^\n+|\s+$/g, '');
  return text ? text.slice(0, 600) : undefined;
}

const quote = (text: string) => text.replace(/[\\`*_[\]<>#|]/g, char => '\\' + char);
const block = (text: string) => '```text\n' + text.replace(/```/g, '`​``') + '\n```';

export function tutorMarkdown(heading: string, reply: string, context = '', assistant: 'Instructor' | 'Doubt Solver' = 'Instructor'): string {
  return `**${assistant} · ${quote(heading)}**\n\n${context ? block(context) + '\n\n' : ''}${reply.trim()}\n`;
}

export function learnerMarkdown(message: string, context = ''): string {
  return `**You${context ? ' · ' + quote(context) : ''}**\n\n${quote(message)}\n`;
}

export function noticeMarkdown(message: string, assistant: 'Instructor'|'Doubt Solver' = 'Instructor'): string {
  return `**${assistant} notice**\n\n${quote(message)}\n`;
}

export function samplesMarkdown(rows: {id: string; verdict: string; given: string; expected: string; actual: string; stderr: string}[]): string {
  const passed = rows.filter(r => r.verdict === 'passed').length;
  const label = (verdict: string) => ({passed: 'Passed', wrong_answer: 'Wrong answer', runtime_error: 'Runtime error',
    timeout: 'Time limit exceeded', compile_error: 'Compilation error', not_run: 'Not run'} as Record<string, string>)[verdict] ?? verdict;
  return [`**Sample tests · ${passed} of ${rows.length} passed**`, '',
    'These are the published examples. Hidden tests may check more cases.', '',
    ...rows.map(r => `- ${r.verdict === 'passed' ? '✅' : '❌'} **${quote(r.id)}** · ${label(r.verdict)}\n\n` +
      block([r.given && 'Input: ' + r.given, 'Expected: ' + r.expected, r.verdict === 'passed' ? '' : 'Actual: ' + (r.actual || '(empty)'),
        r.stderr && r.verdict !== 'passed' ? 'Error: ' + r.stderr : ''].filter(Boolean).join('\n')).replace(/^/gm, '  '))].join('\n') + '\n';
}
