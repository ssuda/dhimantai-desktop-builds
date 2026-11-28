/**
 * Instructor pacing from real answer outcomes. The agent sends `tutor_verdict`
 * and `tutor_assisted` with each feedback card; these counters only decide which
 * offer to show. The learner always chooses, and nothing here is a mastery record.
 */
export type Level = 'beginner' | 'practitioner' | 'expert';
export type Verdict = 'correct' | 'partial' | 'incorrect' | 'unclear';
export interface Evidence { independent: number; struggles: number }
export interface LevelOffer { to: Level; direction: 'up' | 'down' }

export const LEVEL_LABELS: Record<Level, string> = {
  beginner: 'Entry Level', practitioner: 'Intermediate Level', expert: 'Expert Level',
};
const ORDER: Level[] = ['beginner', 'practitioner', 'expert'];
/** Correct answers without help before offering the next level. */
export const STEP_UP_AFTER = 3;
/** Wrong or partial answers in a row before offering a gentler level. */
export const STEP_DOWN_AFTER = 3;

export const freshEvidence = (): Evidence => ({independent: 0, struggles: 0});

export function verdictOf(packet: Record<string, unknown>): Verdict | undefined {
  const v = packet.tutor_verdict;
  if (v === 'correct' || v === 'partial' || v === 'incorrect' || v === 'unclear') return v;
  if ([packet.correct, packet.is_correct, packet.answer_correct].includes(true)) return 'correct';
  return undefined;
}

/** An unknown or unclear verdict changes nothing: it is not evidence either way. */
export function nextEvidence(e: Evidence, verdict: Verdict | undefined, assisted: unknown): Evidence {
  if (verdict === 'correct') return {independent: assisted === true ? e.independent : e.independent + 1, struggles: 0};
  if (verdict === 'partial' || verdict === 'incorrect') return {independent: 0, struggles: e.struggles + 1};
  return e;
}

export function levelOffer(level: Level, e: Evidence): LevelOffer | undefined {
  const i = ORDER.indexOf(level);
  if (e.independent >= STEP_UP_AFTER && i < ORDER.length - 1) return {to: ORDER[i + 1], direction: 'up'};
  if (e.struggles >= STEP_DOWN_AFTER && i > 0) return {to: ORDER[i - 1], direction: 'down'};
  return undefined;
}

export function offerText(offer: LevelOffer): string {
  return offer.direction === 'up'
    ? `You solved ${STEP_UP_AFTER} in a row on your own. Switch to ${LEVEL_LABELS[offer.to]}?`
    : `Want a gentler pace? Switch to ${LEVEL_LABELS[offer.to]}`;
}

/** The level a Quick Diagnostic reply recommends, if it names exactly one. */
export function recommendedLevel(text: string): Level | undefined {
  const found = new Set<Level>();
  for (const m of text.matchAll(/recommend[^.\n]{0,80}?\b(Entry|Intermediate|Expert)\s+Level/gi)) {
    found.add(m[1].toLowerCase() === 'entry' ? 'beginner' : m[1].toLowerCase() === 'intermediate' ? 'practitioner' : 'expert');
  }
  return found.size === 1 ? [...found][0] : undefined;
}
