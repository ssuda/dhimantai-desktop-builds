import {readFile, writeFile, rename, mkdir, stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {validSnapshot} from './roomCode';
import type {CodeSnapshot} from './roomCode';

export type LessonRun = CodeSnapshot & {executedAt:string};
/** Host-owned receipts, separate from imported notebooks and editable webview history. */
export class LessonRuntimeJournal {
  runs: LessonRun[] = [];
  private static writes = new Map<string,Promise<void>>();
  private known:string | null = null;
  private async revision() {
    try {const info = await stat(this.file); return `${info.ino}:${info.size}:${info.mtimeMs}`;}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
  }
  constructor(readonly file:string) {}
  get restoreBlockReason(): string | undefined {
    if (this.runs.some(run => run.interactive))
      return 'This history includes interactive input and cannot be restored. Choose Start fresh to run your saved cells.';
  }
  get nonInteractiveRuns(): LessonRun[] {
    return this.runs.filter(run => !run.interactive);
  }
  async load() {
    await LessonRuntimeJournal.writes.get(this.file);
    try {
      const revision = await this.revision();
      const raw = await readFile(this.file, 'utf8');
      if (raw.length > 8_000_000) throw new Error('Saved runtime history is too large.');
      const data = JSON.parse(raw);
      if (!Array.isArray(data) || data.length > 200 || data.some(r => typeof r?.executedAt !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(r.executedAt) || !validSnapshot(r) || r.language !== 'python'))
        throw new Error('Saved runtime history is invalid.');
      this.runs = data;
      this.known = revision;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async assertCurrent() {
    await LessonRuntimeJournal.writes.get(this.file);
    if (await this.revision() !== this.known) throw new Error('Session history changed in another window. Reopen the lesson before restoring it.');
  }
  async record(snapshot:CodeSnapshot) {
    if (snapshot.language !== 'python') return;
    const run:LessonRun = {...snapshot, executedAt:new Date().toISOString()};
    // Keep execution order, including intentional reruns; removing duplicates changes state.
    await this.save(runs => {
      if (runs.length >= 200) throw new Error('Runtime history is full. Save the lesson script and start a fresh session history.');
      return [...runs, run];
    });
  }
  async clear() { await this.save(()=>[]); }
  private async save(update:(runs:LessonRun[])=>LessonRun[]) {
    const work = (LessonRuntimeJournal.writes.get(this.file) ?? Promise.resolve()).then(async () => {
      if (await this.revision() !== this.known) throw new Error('Session history changed in another window. Reopen the lesson before restoring it.');
      const next = update(this.runs);
      const content = JSON.stringify(next);
      if (content.length > 8_000_000) throw new Error('Runtime history is full. Save the lesson script before starting fresh.');
      await mkdir(dirname(this.file), {recursive:true});
      await writeFile(this.file + '.tmp', content, {mode:0o600});
      await rename(this.file + '.tmp', this.file); this.runs = next; this.known = await this.revision();
    });
    const pending = work.catch(() => {}); LessonRuntimeJournal.writes.set(this.file,pending);
    void pending.then(()=>{if(LessonRuntimeJournal.writes.get(this.file)===pending)LessonRuntimeJournal.writes.delete(this.file);});
    await work;
  }
}

export function lessonScript(runs:LessonRun[]):string {
  return '# Executed lesson code, in execution order. Review side effects before rerunning.\n'
    + '# Notebook input, arguments and attached files are recorded in the saved session history.\n'
    + runs.map((run, index) => {
      // Notebook magics need IPython; keep ordinary cells as clean Python.
      const code = /^\s*[%!]/m.test(run.source)
        ? 'from IPython.core.interactiveshell import InteractiveShell\n_dhimantai_result = InteractiveShell.instance(user_ns=globals()).run_cell(' + JSON.stringify(run.source) + ')\nif not _dhimantai_result.success:\n    raise RuntimeError("Notebook cell failed; stop before dependent cells")'
        : run.source;
      return `\n# %% ${index + 1} · ${run.snippet} · ${run.executedAt}\n${code}\n`;
    }).join('');
}
