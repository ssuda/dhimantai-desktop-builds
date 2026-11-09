// How much help each Practice problem took, kept on this computer. A strong engineer needs less help over
// time, so the measure a learner sees is a trend: problems solved without help, and how far up the help
// ladder the rest needed. It holds counts and times only, never code, questions or Instructor replies.

/** The help ladder: a question, a hint, where to look, then a worked example on a different problem. */
export const HELP_LEVELS = [
  {level: 1, label: 'Ask me a guiding question', short: 'question',
    message: 'I am stuck. Ask me one question that helps me find the next step myself.'},
  {level: 2, label: 'Give me a hint', short: 'hint',
    message: 'Give me one hint about the next step, in words. I will write the code.'},
  {level: 3, label: 'Show me where to look', short: 'where',
    message: 'Show me which line or step needs attention and why. Do not write the fix.'},
  {level: 4, label: 'Show a similar example', short: 'example',
    message: 'Show the same idea on a different, smaller problem so I can apply it to mine.'},
] as const;
export const MAX_HELP_LEVEL = 4;

export interface ProblemRecord {
  id: string;
  title: string;
  language: string;
  /** Written challenges have no samples to pass, so they never count as solved; studies can leave them out. */
  kind?: 'written';
  opened: number;
  firstRun?: number;
  runs: number;
  /** Ladder requests by level: index 0 is level 1. */
  ladder: [number, number, number, number];
  /** Free questions and guided explanations: still help, but not on the ladder. */
  asks: number;
  /** Highest ladder level used in the current stuck episode, and runs since the last help. */
  level: number;
  runsSinceHelp: number;
  /** First time every sample test passed, and the help used before it. */
  solved?: {at: number; help: number; maxLevel: number};
}

export type HelpEvent =
  | {type: 'open'; id: string; title: string; language: string; kind?: 'written'}
  | {type: 'run'; id: string}
  | {type: 'help'; id: string; level: number}
  | {type: 'ask'; id: string}
  | {type: 'samples'; id: string; passed: number; total: number};

export const MAX_RECORDS = 200;
const help = (r: ProblemRecord) => r.asks + r.ladder.reduce((a, b) => a + b, 0);

export function record(records: ProblemRecord[], event: HelpEvent, now = Date.now()): ProblemRecord[] {
  const found = records.find(x => x.id === event.id);
  if (!found && event.type !== 'open') return records;
  const p: ProblemRecord = found ? {...found, ladder: [...found.ladder], ...(found.solved ? {solved: {...found.solved}} : {})}
    : {id: event.id, title: (event as {title: string}).title.slice(0, 120), language: (event as {language: string}).language,
      ...((event as {kind?: string}).kind === 'written' ? {kind: 'written' as const} : {}), opened: now, runs: 0, ladder: [0, 0, 0, 0], asks: 0, level: 0, runsSinceHelp: 0};
  records = [...records.filter(x => x !== found), p].slice(-MAX_RECORDS);
  if (event.type === 'run') { p.runs++; p.runsSinceHelp++; p.firstRun ??= now; }
  if (event.type === 'help' && event.level >= 1 && event.level <= MAX_HELP_LEVEL) {
    p.ladder[event.level - 1]++; p.level = Math.max(p.level, event.level); p.runsSinceHelp = 0;
  }
  if (event.type === 'ask') p.asks++;
  if (event.type === 'samples' && event.total > 0 && event.passed === event.total) {
    p.solved ??= {at: now, help: help(p), maxLevel: p.level};
    p.level = 0; p.runsSinceHelp = 0; // the stuck episode is over; the next one starts with a question
  }
  return records;
}

/**
 * The next rung for this problem. Stronger help comes only after the learner tried the last one: with no run
 * since the last help, the same rung is offered again (reworded by Instructor), never a bigger one.
 */
export function nextLevel(r: ProblemRecord | undefined): {level: number; waiting: boolean} {
  if (!r || r.level === 0) return {level: 1, waiting: false};
  if (r.runsSinceHelp === 0) return {level: r.level, waiting: r.level < MAX_HELP_LEVEL};
  return {level: Math.min(MAX_HELP_LEVEL, r.level + 1), waiting: false};
}

export interface Trend {
  /** The most recent solved problems, newest last, and how many of them needed no help at all. */
  solved: number;
  independent: number;
  /** Highest ladder rung used, per recent solved problem: the curve a learner wants to fall. */
  levels: number[];
  medianMinutesToSolve?: number;
}

export function trend(records: ProblemRecord[], window = 5): Trend {
  const recent = records.filter(r => r.solved).sort((a, b) => a.solved!.at - b.solved!.at).slice(-window);
  const minutes = recent.map(r => (r.solved!.at - r.opened) / 60000).sort((a, b) => a - b);
  return {solved: recent.length, independent: recent.filter(r => r.solved!.help === 0).length,
    levels: recent.map(r => r.solved!.maxLevel),
    ...(minutes.length ? {medianMinutesToSolve: Math.round(minutes[Math.floor((minutes.length - 1) / 2)] * 10) / 10} : {})};
}

export function trendText(t: Trend): string {
  if (!t.solved) return 'Solve a problem with passing samples to start your record.';
  return `Last ${t.solved} solved: ${t.independent} without help.`;
}

/** What a learner may share for a study: counts and times, no code or conversation. */
export function exportRecords(records: ProblemRecord[]) {
  return {format: 'dhimantai-practice-record/1', exported: new Date().toISOString(),
    problems: records.map(r => ({id: r.id, title: r.title, language: r.language, ...(r.kind ? {kind: r.kind} : {}), opened: new Date(r.opened).toISOString(),
      secondsToFirstRun: r.firstRun ? Math.round((r.firstRun - r.opened) / 1000) : null, runs: r.runs,
      ladder: {question: r.ladder[0], hint: r.ladder[1], where: r.ladder[2], example: r.ladder[3]}, otherAsks: r.asks,
      solved: r.solved ? {secondsToSolve: Math.round((r.solved.at - r.opened) / 1000), helpBeforeSolve: r.solved.help,
        highestLevel: r.solved.maxLevel, independent: r.solved.help === 0} : null})),
    trend: trend(records)};
}

export function validRecords(value: unknown): ProblemRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is ProblemRecord => !!r && typeof r.id === 'string' && typeof r.opened === 'number'
    && Array.isArray(r.ladder) && r.ladder.length === 4 && typeof r.runs === 'number').slice(-MAX_RECORDS);
}
