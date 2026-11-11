import {createRequire} from 'node:module';
import {join} from 'node:path';
import {AppServer, fieldsFor} from './types';

/** The task fields needed to re-check a learner's claim, for any application. */
export interface VerifiableTask {
  id: string;
  /** The application form (ERPNext courses name it doctype). */
  form?: string; doctype?: string;
  expected: Record<string, unknown>; readOnly?: boolean;
  also?: {doctype?: string; form?: string; record: string; expected: Record<string, unknown>}[];
}

/** Placeholders shared by every application course. */
export function resolveTask<T>(value: T, tag: string, earlier: Record<string, string>): T {
  return JSON.parse(JSON.stringify(value).replaceAll('{{tag}}', tag).replaceAll('{{company}}', 'Training ' + tag)
    .replace(/\{\{ref:([a-z0-9-]+)\}\}/g, (_, id: string) => JSON.stringify(earlier[id] ?? '\u0000missing').slice(1, -1)));
}

/**
 * Re-reads a claimed record through the application's own server and applies the same predicate as
 * the in-page player. Progress never rests on what the page reports: a record that does not exist,
 * was created by another login, or does not match is not counted.
 */
export class TaskVerifier {
  private readonly equal: (actual: unknown, expected: unknown) => boolean;
  constructor(private readonly server: AppServer, playerDir: string) {
    // One predicate for page and desktop: the player exports it for CommonJS callers.
    this.equal = createRequire(__filename)(join(playerDir, 'guide.js')).equal;
  }
  async verify(task: VerifiableTask, record: string, login: string, tag: string, earlier: Record<string, string>): Promise<boolean> {
    const expected = resolveTask(task.expected, tag, earlier);
    if (JSON.stringify(expected).includes('\u0000missing')) return false;
    const doc = await this.server.read(task.form ?? task.doctype ?? '', record, fieldsFor(expected, ['owner']));
    if (!doc || !this.equal(doc, expected)) return false;
    // A learner's work is their own record; only a read-only task inspects a prepared one.
    if (!task.readOnly && !await this.server.createdBy(doc, login)) return false;
    for (const extra of resolveTask(task.also ?? [], tag, earlier)) {
      const linked = await this.server.read(extra.form ?? extra.doctype ?? '', extra.record, fieldsFor(extra.expected));
      if (!linked || !this.equal(linked, extra.expected)) return false;
    }
    return true;
  }
}
