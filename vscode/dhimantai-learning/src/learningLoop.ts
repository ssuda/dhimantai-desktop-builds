// The learning loop, independent of VS Code: PRIMM (Predict → Run → Investigate → Modify → Make),
// a graduated help ladder (the assistance dilemma: help only after an attempt, stronger help only after
// weaker help and a self-explanation), and an independent variation recorded separately from help.
import type { HelpMode, RunConfiguration } from './api';
import { compareOutput, Comparison } from './learning';

// ---- Predict ------------------------------------------------------------------------------

export interface PredictionResult {
  /** Lines of the actual output the learner predicted exactly, in order. */
  matched: number;
  total: number;
  exact: boolean;
  /** Every value was right; only the writing differs (a label left out, 2 for 2.0). Not exact. */
  formatOnly?: boolean;
  /**
   * First line where belief and behaviour diverge: the most useful thing to look at. A wrong value
   * comes before a formatting difference. `offset` is where that printed line starts in stdout.
   */
  firstSurprise?: { line: number; predicted: string; actual: string; offset?: number; missing?: 'prediction' | 'output' };
}

const clean = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(l => l.replace(/\s+$/, ''));

const SCALAR = /^(?:([\p{L}][\p{L} _-]*?)(?:\s*:\s*|\s+))?([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/iu;

function scalar(text: string) {
  const match = SCALAR.exec(text.trim());
  if (!match) return;
  const [, label, sign, decimal, power] = match;
  const fraction = decimal.split('.')[1] ?? '';
  const digits = decimal.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  const trailing = decimal.replace('.', '').match(/0+$/)?.[0].length ?? 0;
  // Compare decimal spellings without rounding Python integers or overflowing to Infinity.
  const value = digits ? `${sign === '-' ? '-' : ''}${digits}e${BigInt(power ?? 0) - BigInt(fraction.length) + BigInt(trailing)}` : '0';
  return { label: label?.trim().replace(/\s+/g, ' ').toLowerCase(), value };
}

/**
 * Recognize unambiguous scalar formatting: "14" for "Sum: 14", "sum 14" for "Sum: 14", or 2 for 2.0.
 * Other text and compound values stay literal: changed words, signs or container types can change meaning.
 */
export function sameValues(predicted: string, actual: string): boolean {
  if (predicted === actual) return true;
  const p = scalar(predicted), a = scalar(actual);
  return !!p && !!a && (!p.label || p.label === a.label) && p.value === a.value;
}

export function comparePrediction(prediction: string, actual: string): PredictionResult {
  const p = prediction === '' ? [] : clean(prediction);
  const a = actual === '' ? [] : clean(actual);
  let matched = 0;
  let firstDifference = -1;
  let firstWrong = -1;
  for (let i = 0; i < Math.max(p.length, a.length); i++) {
    if (p[i] === a[i]) { matched++; continue; }
    if (firstDifference < 0) firstDifference = i;
    if (firstWrong < 0 && (p[i] === undefined || a[i] === undefined || !sameValues(p[i], a[i]))) firstWrong = i;
  }
  const i = firstWrong >= 0 ? firstWrong : firstDifference;
  const offset = a.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0);
  const firstSurprise = i < 0 ? undefined
    : { line: i + 1, predicted: p[i] ?? '', actual: a[i] ?? '', ...(a[i] !== undefined ? { offset } : {}),
      ...(p[i] === undefined ? { missing: 'prediction' as const } : a[i] === undefined ? { missing: 'output' as const } : {}) };
  return { matched: Math.min(matched, a.length), total: a.length, exact: !firstSurprise,
    ...(firstSurprise && firstWrong < 0 ? { formatOnly: true } : {}), firstSurprise };
}

export function predictionFeedback(result: PredictionResult): string {
  const line = result.firstSurprise;
  const quote = (text: string) => text === '' ? '(blank line)' : `“${text.slice(0, 120)}”`;
  if (!line) return 'Your prediction matches the output for this run.';
  if (line.missing === 'prediction') return `No prediction was supplied for output line ${line.line}. It printed ${quote(line.actual)}. Predict every output line, in order, on the next run.`;
  if (line.missing === 'output') return `You predicted ${quote(line.predicted)} at line ${line.line}, but the program produced no output line there.`;
  if (result.formatOnly) return `Your values are right; the output is written differently. Line ${line.line}: you wrote ${quote(line.predicted)}, it printed ${quote(line.actual)}.`;
  return `Your prediction matched ${result.matched} of ${result.total} output line(s). First different value at line ${line.line}: you expected ${quote(line.predicted)}, it printed ${quote(line.actual)}.`;
}

/** The trace step that printed the output starting at `offset`: the last step before output passed it. */
export function stepForOutput(steps: { output: number | null }[], offset: number): number | undefined {
  const i = steps.findIndex(s => s.output !== null && s.output > offset);
  return i < 0 ? undefined : Math.max(0, i - 1);
}

// ---- Help ladder --------------------------------------------------------------------------

export interface LadderState {
  /** Runs of the current code since the learner last asked for help. */
  attemptsSinceHelp: number;
  /** Help received in the current stuck episode (reset when output matches expected). */
  received: HelpMode[];
  /** True while an independent variation is in progress. */
  independent: boolean;
}

export const EXPLANATION_MIN = 20;

export type LadderDecision =
  | { allowed: true; needsExplanation: boolean; marksAssisted: boolean }
  | { allowed: false; reason: string };

/**
 * Hint: always, with nothing to type first — a stuck learner who cannot get a small nudge here will avoid
 * help or get a full answer elsewhere. Line suggestion: after a hint and another run. Selection change: after
 * a line suggestion or two hints. Code-level help needs the learner's own explanation of where the problem is;
 * the server enforces the same order. Asking during an independent variation is allowed but marks it assisted.
 */
export function ladder(state: LadderState, mode: HelpMode): LadderDecision {
  const marksAssisted = state.independent;
  if (mode === 'hint') return { allowed: true, needsExplanation: false, marksAssisted };
  const hints = state.received.filter(m => m === 'hint').length;
  if (mode === 'statement') {
    if (!hints) return { allowed: false, reason: 'Ask for a hint first, then try it.' };
    if (state.attemptsSinceHelp < 1) return { allowed: false, reason: 'Try the hint and run your code before asking for a line.' };
    return { allowed: true, needsExplanation: true, marksAssisted };
  }
  if (!state.received.includes('statement') && hints < 2) {
    return { allowed: false, reason: 'Use a hint and a line suggestion first. Bigger changes come last.' };
  }
  if (state.attemptsSinceHelp < 1) return { allowed: false, reason: 'Run your code after the last suggestion before asking for more.' };
  return { allowed: true, needsExplanation: true, marksAssisted };
}

// Words that appear in code or errors but say nothing about where the problem is (agent/course_projects/help_ladder.py).
const VAGUE = new Set(['the', 'and', 'for', 'not', 'but', 'with', 'this', 'that', 'code', 'line', 'lines', 'error', 'errors',
  'wrong', 'work', 'works', 'working', 'program', 'output', 'value', 'values', 'know', 'dont', 'idk', 'help', 'fix', 'bug',
  'problem', 'issue', 'thing', 'something', 'none', 'true', 'false', 'def', 'return', 'import', 'from', 'class', 'else',
  'elif', 'while', 'try', 'except', 'pass', 'traceback', 'most', 'recent', 'call', 'last', 'file']);
const WORD = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

/** An explanation names a place: a line number, a name in the code, or a word from the error. */
export function specificExplanation(text: string, source: string, error = ''): boolean {
  if (/\d/.test(text)) return true;
  const known = new Set([...(source + '\n' + error).matchAll(WORD)].map(m => m[0].toLowerCase()).filter(w => !VAGUE.has(w)));
  return [...text.matchAll(WORD)].some(m => known.has(m[0].toLowerCase()));
}

/** Length, and — when the code is known — that it points somewhere specific, as the server checks. */
export function checkExplanation(text: string, source?: string, error?: string): string | undefined {
  if (text.trim().length < EXPLANATION_MIN) return `In a sentence (${EXPLANATION_MIN}+ characters), what do you think is going wrong?`;
  if (source !== undefined && !specificExplanation(text, source, error)) {
    return 'Point to something specific: a line number, a name from your code, or a word from the error message.';
  }
}

// ---- Make: an unseen variation, done alone -----------------------------------------------

const VOCABULARY = ['river', 'stone', 'lamp', 'cloud', 'tiger', 'mango', 'paper', 'bridge', 'violin', 'orbit', 'salt', 'garden', 'echo', 'pixel', 'harbor', 'maple'];

/** Largest seed the extension generates; the backend accepts up to 2^32 - 1 (learning_events.SEED_MAX). */
export const SEED_MAX = 999_999_999;

export function newVariationSeed(): number {
  return Math.floor(Math.random() * (SEED_MAX + 1));
}

/** Small deterministic PRNG so a variation can be reproduced from its seed. */
function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export interface Variation {
  seed: number;
  file: { name: string; content: string };
  argv: string[];
  /** Replaces the run's standard input when the exercise reads its data from stdin. */
  stdin?: string;
  expected?: string;
  prompt: string;
}

/** Word Count rules from agent/course_projects/practice.py learning_sample: lowercase, whitespace split. */
export function wordCountOutput(content: string, option: string): string {
  const counts = new Map<string, number>();
  for (const word of content.toLowerCase().split(/\s+/).filter(Boolean)) counts.set(word, (counts.get(word) ?? 0) + 1);
  const pairs = [...counts];
  const ordered = option === '--count'
    ? pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    : pairs.sort((a, b) => b[1] - a[1]).slice(0, 20); // stable, like Python's sorted(reverse=True)
  return ordered.map(([w, c]) => `${w} ${c}\n`).join('');
}

/** Same shape, new values: numbers keep their digit count and sign, words become other words of the same case. */
export function perturb(content: string, seed: number): string {
  const next = random(seed ^ 0x5bd1e995);
  return content.replace(/-?\d+(?:\.\d+)?|[A-Za-z]+/g, token => {
    if (/^[A-Za-z]+$/.test(token)) {
      const word = VOCABULARY[Math.floor(next() * VOCABULARY.length)];
      return token === token.toUpperCase() && token.length > 1 ? word.toUpperCase()
        : token[0] === token[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
    }
    const [whole, fraction] = token.replace('-', '').split('.');
    const digits = (n: number, first: boolean) => Array.from({ length: n }, (_, i) =>
      String(i === 0 && first && n > 1 ? 1 + Math.floor(next() * 9) : Math.floor(next() * 10))).join('');
    return (token.startsWith('-') ? '-' : '') + digits(whole.length, true) + (fraction !== undefined ? '.' + digits(fraction.length, false) : '');
  });
}

/** The exercise's own data, varied: a sample file named in the arguments, else non-empty stdin. */
export interface VariationSource { files: { name: string; content: string }[]; stdin: string }

export function makeVariation(config: RunConfiguration | undefined, seed: number, currentArgv: string[], source?: VariationSource): Variation {
  const next = random(seed);
  if (config?.preset === 'word_count') {
    const words = Array.from({ length: 9 + Math.floor(next() * 8) }, () => {
      const word = VOCABULARY[Math.floor(next() * 7)];
      return next() < 0.3 ? word[0].toUpperCase() + word.slice(1) : word;
    });
    const lines: string[] = [];
    for (let i = 0; i < words.length; i += 4) lines.push(words.slice(i, i + 4).join(' '));
    const content = lines.join('\n') + '\n';
    const option = next() < 0.5 ? '--count' : '--topcount';
    const name = `variation-${seed % 1000}.txt`;
    return { seed, file: { name, content }, argv: [option, name], expected: wordCountOutput(content, option),
      prompt: `New, unseen data. Predict exactly what your program prints for ${option} ${name}, then run it. No help during this attempt.` };
  }
  // Without a reference answer, the variation checks the learner's model of their own program on new data
  // shaped like the exercise's own: they must predict exactly what it prints, alone.
  const name = `variation-${seed % 1000}.txt`;
  const sample = source?.files.find(f => currentArgv.includes(f.name) && /\S/.test(f.content));
  if (sample) {
    return { seed, file: { name, content: perturb(sample.content, seed) }, argv: currentArgv.map(a => (a === sample.name ? name : a)),
      prompt: `New data in the same shape as ${sample.name}. Predict exactly what your program prints for ${name}, then run it. No help during this attempt.` };
  }
  if (source?.stdin.trim()) {
    return { seed, file: { name, content: perturb(source.stdin, seed) }, argv: currentArgv, stdin: perturb(source.stdin, seed),
      prompt: 'New input in the same shape as yours (shown in the inputs file). Predict exactly what your program prints, then run it. No help during this attempt.' };
  }
  return { seed, file: { name: `variation-${seed % 1000}.txt`, content: VOCABULARY.slice(0, 3 + Math.floor(next() * 5)).join('\n') + '\n' },
    argv: currentArgv, prompt: 'Change one input yourself, predict exactly what your program will print, then run it. No help during this attempt.' };
}

export interface VariationOutcome {
  prediction: PredictionResult;
  correctness?: Comparison;
  independent: boolean;
  /** The program finished normally: exit code 0, not stopped, output complete. */
  clean: boolean;
  /** Passed = clean run, predicted exactly, matched expected output where known, and no help during the attempt. */
  passed: boolean;
}

/** What a run must look like to count as finished work (output alone is not enough). */
export interface RunResult {
  status: string;
  exit_code: number | null;
  stdout: string;
  truncated: boolean;
}

export function cleanRun(run: RunResult): boolean {
  return run.status === 'exited' && run.exit_code === 0 && !run.truncated;
}

export function judgeVariation(variation: Variation, prediction: string, run: RunResult, assisted: boolean): VariationOutcome {
  const predicted = comparePrediction(prediction, run.stdout);
  const correctness = variation.expected !== undefined ? compareOutput(run.stdout, variation.expected) : undefined;
  // Without a reference answer the prediction is still checked, but an exact prediction of a wrong program
  // must not count as an independent pass.
  const correct = correctness?.result === 'match';
  const clean = cleanRun(run);
  // Prediction feedback stays useful even for a crash; completion needs a clean run.
  return { prediction: predicted, correctness, independent: !assisted, clean, passed: clean && predicted.exact && correct && !assisted };
}

// ---- Evidence ---------------------------------------------------------------------------

/** `id` makes each event idempotent on the server; `sent` marks it delivered (kept locally until then). */
interface Envelope { id?: string; sent?: boolean; rejected?: string }

export type EvidenceEvent = Envelope & (
  | { type: 'run'; at: string; draftVersion?: number; status: string; clean?: boolean; predicted?: PredictionResult; expected?: Comparison['result']; predictionSkipped?: boolean }
  | { type: 'trace'; at: string; steps: number }
  | { type: 'help'; at: string; mode: HelpMode | 'coach'; explanation?: string; applied?: boolean; duringVariation: boolean }
  | { type: 'applied'; at: string; mode: HelpMode }
  | { type: 'variation'; at: string; seed: number; outcome: VariationOutcome });

export interface Progress {
  runs: number;
  predictions: number;
  exactPredictions: number;
  /** Runs where the learner chose to skip predicting (recorded, not hidden). */
  skippedPredictions: number;
  traces: number;
  help: Record<HelpMode | 'coach', number>;
  applied: number;
  solvedWithSamples: boolean;
  independent: { attempts: number; passed: number };
}

export function summarize(events: EvidenceEvent[]): Progress {
  const progress: Progress = { runs: 0, predictions: 0, exactPredictions: 0, skippedPredictions: 0, traces: 0, help: { hint: 0, statement: 0, block: 0, coach: 0 }, applied: 0, solvedWithSamples: false, independent: { attempts: 0, passed: 0 } };
  for (const e of events) {
    if (e.type === 'run') {
      progress.runs++;
      if (e.predicted) { progress.predictions++; if (e.predicted.exact) progress.exactPredictions++; }
      if (e.predictionSkipped) progress.skippedPredictions++;
      if (e.expected === 'match' && e.clean === true) progress.solvedWithSamples = true;
    } else if (e.type === 'trace') progress.traces++;
    else if (e.type === 'help') { progress.help[e.mode]++; if (e.applied) progress.applied++; }
    else if (e.type === 'applied') progress.applied++;
    else if (e.type === 'variation') {
      progress.independent.attempts++;
      if (e.outcome.passed && e.outcome.clean && e.outcome.independent && e.outcome.prediction.exact && e.outcome.correctness?.result === 'match') progress.independent.passed++;
    }
  }
  return progress;
}

/** Rebuild the ladder from recorded evidence, so reopening an exercise cannot reset the help gating. */
export function ladderFrom(events: EvidenceEvent[], independent: boolean): LadderState {
  const state: LadderState = { attemptsSinceHelp: 0, received: [], independent };
  for (const e of events) {
    if (e.type === 'run') {
      state.attemptsSinceHelp++;
      if (e.expected === 'match' && e.clean === true) state.received = []; // a solved episode closes; the next one starts small
    } else if (e.type === 'help') {
      state.received.push(e.mode === 'coach' ? 'hint' : e.mode);
      state.attemptsSinceHelp = 0;
    }
  }
  return state;
}
