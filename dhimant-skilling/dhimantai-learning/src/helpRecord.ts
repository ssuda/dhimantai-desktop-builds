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
  /** Total help seen at the last full grading attempt; keeps later independent attempts possible. */
  assessedHelp?: number;
  /** Highest ladder level used in the current stuck episode, and runs of changed code since the last help. */
  level: number;
  runsSinceHelp: number;
  /** First time every published sample passed. Samples alone never make a problem solved. */
  samplesPassed?: number;
  /** First graded submission that passed every test, hidden ones included, and the help used before it. */
  solved?: {at: number; help: number; maxLevel: number};
  /** Spaced re-practice after the first graded pass: the next review dates, earliest first. */
  reviewDue?: number[];
}

export type HelpEvent =
  | {type: 'open'; id: string; title: string; language: string; kind?: 'written'}
  /** edited: false when the code is unchanged since the last run; such a run does not unlock stronger help. */
  | {type: 'run'; id: string; edited?: boolean}
  | {type: 'help'; id: string; level: number}
  | {type: 'ask'; id: string}
  | {type: 'samples'; id: string; passed: number; total: number}
  /** A server check against every test, hidden cases included. */
  | {type: 'graded'; id: string; passed: number; total: number};

const DAY = 86_400_000;
/** Re-practice a solved problem after one, three and seven days. */
export const REVIEW_DAYS = [1, 3, 7] as const;

export const MAX_RECORDS = 200;
const help = (r: ProblemRecord) => r.asks + r.ladder.reduce((a, b) => a + b, 0);

export function record(records: ProblemRecord[], event: HelpEvent, now = Date.now()): ProblemRecord[] {
  const found = records.find(x => x.id === event.id);
  if (!found && event.type !== 'open') return records;
  const p: ProblemRecord = found ? {...found, ladder: [...found.ladder], ...(found.solved ? {solved: {...found.solved}} : {}),
    ...(found.reviewDue ? {reviewDue: [...found.reviewDue]} : {})}
    : {id: event.id, title: (event as {title: string}).title.slice(0, 120), language: (event as {language: string}).language,
      ...((event as {kind?: string}).kind === 'written' ? {kind: 'written' as const} : {}), opened: now, runs: 0, ladder: [0, 0, 0, 0], asks: 0, level: 0, runsSinceHelp: 0};
  records = [...records.filter(x => x !== found), p].slice(-MAX_RECORDS);
  if (event.type === 'run') { p.runs++; if (event.edited !== false) p.runsSinceHelp++; p.firstRun ??= now; }
  if (event.type === 'help' && event.level >= 1 && event.level <= MAX_HELP_LEVEL) {
    p.ladder[event.level - 1]++; p.level = Math.max(p.level, event.level); p.runsSinceHelp = 0;
  }
  if (event.type === 'ask') p.asks++;
  if (event.type === 'graded') p.assessedHelp = help(p);
  if (event.type === 'samples' && event.total > 0 && event.passed === event.total) p.samplesPassed ??= now;
  if (event.type === 'graded' && event.total > 0 && event.passed === event.total) {
    if (!p.solved) {
      p.solved = {at: now, help: help(p), maxLevel: p.level};
      p.reviewDue = REVIEW_DAYS.map(days => now + days * DAY);
    } else if (p.reviewDue?.length && p.reviewDue[0] <= now) {
      // A review done on time moves on to the next interval; an early pass changes nothing.
      p.reviewDue = p.reviewDue.slice(1);
    }
    p.level = 0; p.runsSinceHelp = 0; // the stuck episode is over; the next one starts with a question
  }
  return records;
}

export function helpSinceAssessment(r: ProblemRecord | undefined) {
  return r ? help(r) > (r.assessedHelp ?? 0) : false;
}

/**
 * The next rung for this problem. Stronger help comes only after the learner tried the last one: with no run of
 * changed code since the last help, the same rung is offered again (reworded by Instructor), never a bigger one.
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
  if (!t.solved) return 'Pass every graded test on a problem to start your record.';
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

/** Solved problems due for re-practice now, earliest first. */
export function dueReviews(records: ProblemRecord[], now = Date.now()): ProblemRecord[] {
  return records.filter(r => r.solved && r.reviewDue?.length && r.reviewDue[0] <= now).sort((a, b) => a.reviewDue![0] - b.reviewDue![0]);
}

/** Total solved and solved without help, for a progress line. */
export function progressText(records: ProblemRecord[]): string {
  const solved = records.filter(r => r.solved), independent = solved.filter(r => r.solved!.help === 0).length;
  if (!solved.length) return 'No problems solved yet';
  return `${solved.length} solved · ${independent} without help`;
}

export interface Exercise { id: string; title: string; difficulty?: string }
const RANK: Record<string, number> = {easy: 0, medium: 1, hard: 2};
const rank = (difficulty?: string) => RANK[(difficulty ?? '').toLowerCase()] ?? 1;

/** A topic's exercises easiest first; the authored order stands within one difficulty. */
export function byDifficulty<T extends Exercise>(questions: T[]): T[] {
  return questions.map((q, i) => ({q, i})).sort((a, b) => rank(a.q.difficulty) - rank(b.q.difficulty) || a.i - b.i).map(x => x.q);
}

/** Hard exercises are a stretch: suggested after two Medium ones solved without help. Never a hard lock. */
export function hardReady(questions: Exercise[], records: ProblemRecord[]): boolean {
  const solo = new Set(records.filter(r => r.solved?.help === 0).map(r => r.id));
  return questions.filter(q => rank(q.difficulty) === 1 && solo.has(q.id)).length >= 2;
}

/** The first unsolved exercise in a topic after the current one, in difficulty order. */
export function nextExercise<T extends Exercise>(questions: T[], records: ProblemRecord[], current: string): T | undefined {
  const solved = new Set(records.filter(r => r.solved).map(r => r.id));
  return byDifficulty(questions).find(q => q.id !== current && !solved.has(q.id));
}

/** A topic's exercise list as last shown in the Practice tree, so a solved notebook can name the next one. */
const topics = new Map<string, {course?: string; questions: Exercise[]}>();
export function rememberTopic(questions: Exercise[], course?: string) {
  const entry = {course, questions: questions.map(({id, title, difficulty}) => ({id, title, difficulty}))};
  for (const q of questions) topics.set(q.id, entry);
}
export function topicOf(id: string) { return topics.get(id); }

/** Listeners for a solved or reviewed problem, so the Practice tree can update its ticks and review list. */
const recordListeners = new Set<() => void>();
let recordSource: ((account: string) => ProblemRecord[]) | undefined;
export function shareRecords(source: (account: string) => ProblemRecord[]) { recordSource = source; }
export function sharedRecords(account: string): ProblemRecord[] { return recordSource?.(account) ?? []; }
export function onRecordsChanged(listener: () => void) { recordListeners.add(listener); return {dispose: () => recordListeners.delete(listener)}; }
export function recordsChanged() { for (const listener of recordListeners) listener(); }
