import type {BrowserTask, VerifiedTask} from './browserLearning';
import {resolveTask} from './apps/verifier';

/**
 * The ERPNext demo: one chapter of the published course, about seven minutes. The parties, the item and both
 * orders are prepared as the demo learner in a fresh company, so the presenter starts where ERPNext gets
 * interesting: goods arrive, the bill clears the clearing account, delivery posts the cost, the invoice posts
 * the sale, and the books show profit without cash.
 */
export const ERP_DEMO = {
  prepared: ['customer', 'supplier', 'item', 'buying', 'selling'],
  live: ['stock', 'payables', 'delivery', 'receivables'],
  finale: 'You received, billed, delivered and invoiced in {{company}}. Here are the books those four documents wrote.',
} as const;

export interface DemoLesson extends BrowserTask {title: string; expected?: {docstatus?: number}}
/** The demo learner of one account and service, and what the demo has prepared and verified so far. */
export interface DemoState {learner: string; verified: Record<string, VerifiedTask>}
export const demoKey = (environment: string, account: string) => `browser.erpnext.demo.${environment}.${account}`;
export const demoFinished = (state: DemoState | undefined) => !!state && ERP_DEMO.live.every(id => state.verified[id]?.explained);

/** The demo chapter from the published lessons: prepared tasks first, renumbered, so the player opens on the first live task. */
export function demoTasks<T extends DemoLesson>(lessons: T[]): T[] {
  const ids: string[] = [...ERP_DEMO.prepared, ...ERP_DEMO.live];
  const missing = ids.filter(id => !lessons.some(l => l.id === id));
  if (missing.length) throw new Error('The ERPNext demo needs these published tasks: ' + missing.join(', ') + '.');
  return ids.map((id, i) => {
    const lesson = lessons.find(l => l.id === id)!;
    const title = lesson.title.replace(/^\d+\.\s*/, '');
    return {...lesson, title: `${i + 1}. ${title}${(ERP_DEMO.prepared as readonly string[]).includes(id) ? ' (prepared)' : ''}`};
  });
}

/**
 * Creates the prepared records as the demo learner, with the values the course itself asks for, and returns
 * them as finished tasks. Tasks already prepared are skipped, so an interrupted preparation resumes.
 */
export async function prepareDemo(server: {insert(form: string, values: Record<string, unknown>): Promise<string>},
    lessons: DemoLesson[], tag: string, today: string, done: Record<string, VerifiedTask>,
    saved: (task: string, entry: VerifiedTask) => Promise<void>) {
  const records: Record<string, string> = Object.fromEntries(Object.entries(done).map(([id, entry]) => [id, entry.record]));
  for (const id of ERP_DEMO.prepared) {
    if (done[id]) continue;
    const lesson = lessons.find(l => l.id === id)!;
    const values = JSON.parse(JSON.stringify(resolveTask(Object.fromEntries(lesson.steps.map(s => [s.field, s.value])), tag, records))
      .replaceAll('{{today}}', today)) as Record<string, unknown>;
    if (lesson.expected?.docstatus === 1) values.docstatus = 1;
    records[id] = await server.insert(lesson.doctype, values);
    await saved(id, {record: records[id], checkedAt: new Date().toISOString(), assisted: false, explained: true});
  }
}
