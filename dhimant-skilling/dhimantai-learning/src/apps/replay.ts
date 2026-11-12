import {createRequire} from 'node:module';
import {join} from 'node:path';
import {CdpClient} from './inject';
import {AppServer, fieldsFor} from './types';
import {resolveTask, TaskVerifier, VerifiableTask} from './verifier';

/** A drafted task as the replayer needs it (the course JSON shape shared by every application). */
export interface ReplayTask extends VerifiableTask {
  title?: string;
  steps: {field: string; value: unknown; decide?: boolean}[];
  final?: boolean; finalAction?: string; finalButton?: string;
  source?: {task: string; action: string};
  record?: string;
}
export interface ReplayResult {
  task: string; ok: boolean; record?: string; reason?: string;
  /** For each decision field: a wrong value fails the check, so the task cannot pass by accident. */
  discriminates?: boolean;
}

/**
 * Proves an authored course can be completed: performs each task in the real application through the
 * page adapter (as a learner would), then re-checks the saved record through the application's server.
 * Nothing is published until every task passes.
 */
export class Replayer {
  private readonly equal: (actual: unknown, expected: unknown) => boolean;
  constructor(private readonly client: CdpClient, private readonly sessionId: string, private readonly server: AppServer,
      private readonly verifier: TaskVerifier, private readonly login: string, private readonly tag: string, playerDir: string,
      private readonly wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
      private readonly evaluate?: <T>(expression: string) => Promise<T>, private readonly signal?: AbortSignal) {
    this.equal = createRequire(__filename)(join(playerDir, 'guide.js')).equal;
  }
  /** Runs a function in the page with JSON arguments and returns its JSON result. */
  private async page<T>(fn: string, ...args: unknown[]): Promise<T> {
    this.signal?.throwIfAborted();
    if (this.evaluate) return this.evaluate<T>(`(${fn})(...${JSON.stringify(args)})`);
    const reply = await this.client.call('Runtime.evaluate', {expression: `(${fn})(...${JSON.stringify(args)})`,
      awaitPromise: true, returnByValue: true}, this.sessionId, 60000) as {result?: {value?: T}; exceptionDetails?: {exception?: {description?: string}; text?: string}};
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split('\n')[0] ?? reply.exceptionDetails.text ?? 'page error');
    return reply.result?.value as T;
  }
  private async until(fn: string, args: unknown[], what: string, timeoutMs = 30000) {
    for (const started = Date.now(); Date.now() - started < timeoutMs; await this.wait(400)) {
      this.signal?.throwIfAborted();
      if (await this.page<boolean>(fn, ...args).catch(() => false)) return;
    }
    throw new Error(`Timed out waiting for ${what}.`);
  }
  async run(lessons: ReplayTask[]): Promise<ReplayResult[]> {
    await this.until('() => !!window.dhimantaiApp?.ready()', [], 'the application to load', 60000);
    const records: Record<string, string> = {}, results: ReplayResult[] = [];
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    for (const lesson of lessons) {
      const task = JSON.parse(JSON.stringify(resolveTask(lesson, this.tag, records)).replaceAll('{{today}}', today)) as ReplayTask;
      const form = task.form ?? task.doctype ?? '';
      try {
        if (JSON.stringify(task).includes('\u0000missing')) throw new Error('An earlier task this one depends on did not pass.');
        if (task.record) await this.page('(f, id) => dhimantaiApp.openRecord(f, id)', form, task.record);
        else if (task.source) {
          const from = lessons.find(l => l.id === task.source!.task);
          await this.page('(f, id) => dhimantaiApp.openRecord(f, id)', from?.form ?? from?.doctype, records[task.source.task]);
          await this.until('(f, id) => dhimantaiApp.current()?.form === f && dhimantaiApp.current()?.id === id', [from?.form ?? from?.doctype, records[task.source.task]], 'the earlier record');
          await this.page('label => dhimantaiApp.create(label)', task.source.action);
        } else await this.page('f => dhimantaiApp.openNew(f)', form);
        await this.until('f => dhimantaiApp.current()?.form === f', [form], `the ${form} form`);
        if (!task.readOnly) {
          for (const step of task.steps) await this.page('(field, value) => dhimantaiApp.setValue(field, value)', step.field, step.value);
          await this.page('() => dhimantaiApp.save()');
          const errors = await this.page<string[]>('() => dhimantaiApp.errors?.() || []');
          if (errors.length && await this.page<boolean>('() => !!dhimantaiApp.current()?.dirty'))
            throw new Error('The application rejected this form: ' + errors.slice(0, 2).join(' ').slice(0, 600));
          await this.until('() => { const c = dhimantaiApp.current(); return !!c && !c.isNew && !c.dirty && !!c.id; }', [], 'the record to save');
          if (task.final || task.expected.docstatus === 1) {
            await this.page('name => dhimantaiApp.act(name)', task.finalButton ?? (task.expected.docstatus === 1 ? 'submit' : task.finalAction ?? 'Submit'));
            await this.until('() => !!dhimantaiApp.current()?.final', [], 'the final action');
          }
        }
        const record = await this.page<string>('() => dhimantaiApp.current()?.id');
        if (!await this.verifier.verify(task, record, this.login, this.tag, records)) throw new Error(await this.difference(task, form, record));
        records[task.id] = record;
        results.push({task: task.id, ok: true, record, discriminates: await this.discriminates(task, form, record)});
      } catch (error) {
        this.signal?.throwIfAborted();
        results.push({task: task.id, ok: false, reason: error instanceof Error ? error.message : String(error)});
      }
    }
    return results;
  }
  /** Which expected values the saved record does not hold, with what it holds instead: what a revision needs. */
  private async difference(task: ReplayTask, form: string, record: string): Promise<string> {
    const doc = await this.server.read(form, record, fieldsFor(task.expected));
    if (!doc) return `The saved ${form} ${record} could not be read back.`;
    const wrong = Object.entries(task.expected).filter(([key, value]) => !this.equal(doc[key], value))
      .map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, saved ${JSON.stringify(doc[key])}`.slice(0, 300));
    return wrong.length ? 'The saved record differs. ' + wrong.join('; ')
      : 'The saved record matches its values but failed ownership or a follow-up check.';
  }
  /** Changes each decision value in the saved record and confirms the check would then fail. */
  private async discriminates(task: ReplayTask, form: string, record: string): Promise<boolean> {
    if (task.steps.some(step => step.decide && !(step.field in task.expected))) return false;
    const decisions = task.steps.filter(step => step.decide && step.field in task.expected);
    if (!decisions.length) return true;
    const doc = await this.server.read(form, record, fieldsFor(task.expected));
    if (!doc) return false;
    return decisions.every(step => {
      const wrong = structuredClone(doc), value = wrong[step.field];
      if (Array.isArray(value) && value.length) {
        const row = value[0] as Record<string, unknown>, key = Object.keys((task.expected[step.field] as Record<string, unknown>[])[0]).reverse()
          .find(k => typeof row[k] === 'number') ?? Object.keys(row)[0];
        row[key] = typeof row[key] === 'number' ? (row[key] as number) + 1 : String(row[key]) + ' (changed)';
      } else wrong[step.field] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : String(value) + ' (changed)';
      return !this.equal(wrong, task.expected);
    });
  }
}
