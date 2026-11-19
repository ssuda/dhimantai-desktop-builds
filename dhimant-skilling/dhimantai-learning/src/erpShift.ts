import type {BrowserTask, VerifiedTask} from './browserLearning';
import type {DemoState} from './erpDemo';

export interface ShiftSituation {
  title: string; brief: string; documents: {title: string; text: string}[]; clue: string; explain: string;
}
export interface BusinessShift {
  id: 'first-business-shift'; title: string; minutes: number; brief: string;
  prepared: string[]; live: string[]; finale: string; handover: string;
  situations: Record<string, ShiftSituation>;
}
export interface ShiftLesson extends BrowserTask {
  title: string; expected: Record<string, unknown>; scenario?: string; guidance?: string;
  explain?: string; predict?: unknown; business?: ShiftSituation;
}
export const shiftKey = (environment: string, account: string) => `browser.erpnext.shift.${environment}.${account}`;

/** Resolve business evidence from the entitled course, never from a second set of training quantities. */
export function shiftTasks(lessons: ShiftLesson[], shift: BusinessShift): ShiftLesson[] {
  const ids = [...shift.prepared, ...shift.live];
  if (ids.some(id => !lessons.some(l => l.id === id))) throw new Error('This business shift needs the published purchasing and sales tasks.');
  const values = Object.fromEntries(lessons.map(l => [l.id, Object.fromEntries(l.steps.map(s => [s.field, s.value]))]));
  const resolve = (text: string): string => text.replace(/\{\{([a-z]+\.[a-z0-9_.]+)\}\}/g, (_, path: string) => {
    let value: any = values;
    for (const key of path.split('.')) value = value?.[key];
    if (!['string', 'number'].includes(typeof value)) throw new Error(`The published course is missing business evidence: ${path}.`);
    return String(value);
  });
  return ids.map(id => {
    const lesson = lessons.find(l => l.id === id)!;
    const situation = shift.situations[id];
    if (!situation) return {...lesson};
    const business = {...situation, documents: situation.documents.map(d => ({title: d.title, text: resolve(d.text)}))};
    // Preserve every real-record predicate and chapter. The business brief changes the teaching, not the evidence.
    return {...lesson, title: business.title, scenario: business.brief, guidance: 'goals', business,
      ...(['payables','receivables'].includes(id)?{expected:{...lesson.expected,update_stock:0}}:{}),
      explain: business.explain, ...(['stock', 'delivery'].includes(id) ? {} : {predict: undefined})};
  });
}

/** Kept separate from both the full course and the founder demo. */
export interface ShiftState extends DemoState {
  handover?: {text: string; recorded: string; at: string};
  actions?:Record<string,{calls:number;durationMs:number;failures:number}>;
}
export const shiftFinished = (state: ShiftState | undefined, shift: BusinessShift) =>
  !!state?.handover && shift.live.every(id => state.verified[id]?.explained);

/** A handover is retained only after the desktop rechecks all the live records. It is practice, not a grade. */
export async function checkShiftHandover(shift: BusinessShift, done: Record<string, VerifiedTask>,
    verify: (id: string, record: string) => Promise<boolean>): Promise<boolean> {
  for (const id of shift.live) if (!done[id]?.explained || !await verify(id, done[id].record)) return false;
  return true;
}
