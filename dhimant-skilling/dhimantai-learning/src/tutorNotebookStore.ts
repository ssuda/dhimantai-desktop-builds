import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyNotebook, NOTEBOOK_LIMIT, readNotebook, TutorNotebook } from './tutorNotebook';

/** Another window (or VS Code instance) saved this notebook after this window last read or wrote it. */
export class NotebookConflictError extends Error {
  constructor() { super('This notebook changed in another window. Your latest edits here are not saved yet.'); }
}

/** Account/environment isolation, serialized atomic writes, no background network storage.
 * Saves compare-and-swap on the file's identity: each atomic rename makes a new inode, so a
 * write from another window is detected and never silently overwritten. */
export class TutorNotebookStore {
  private static writes = new Map<string, Promise<void>>();
  readonly file: string;
  /** The saved file this store last read or wrote; null means it did not exist. */
  private known: string | null | undefined;
  constructor(private directory: string, environment: string, account: string) {
    this.file = join(directory, createHash('sha256').update(environment + '\0' + account).digest('hex') + '.json');
  }
  private async revision() {
    try { const info = await stat(this.file); return `${info.ino}:${info.mtimeMs}:${info.size}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async load() {
    await TutorNotebookStore.writes.get(this.file);
    try {
      const known = await this.revision();
      const content = await readFile(this.file, 'utf8');
      if (content.length > NOTEBOOK_LIMIT) throw new Error('The saved notebook is too large.');
      const notebook = readNotebook(JSON.parse(content));
      this.known = known;
      return notebook;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.known = null; return emptyNotebook(); }
      throw error;
    }
  }
  static async practiceHistory(directory: string, environment: string, account: string) {
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const found: {notebook: TutorNotebook; modified: number}[] = [];
    for (const file of files.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
      try {
        const path = join(directory, file), info = await stat(path);
        if (info.size > NOTEBOOK_LIMIT * 4) continue; // UTF-8 bytes; readNotebook applies the character limit.
        const notebook = readNotebook(JSON.parse(await readFile(path, 'utf8')));
        if (!notebook.exerciseId) continue;
        const owner = new TutorNotebookStore(directory, environment, account + '\0practice:' + notebook.exerciseId);
        if (owner.file !== path) continue;
        found.push({notebook:await owner.load(), modified:info.mtimeMs});
      } catch { /* One damaged or concurrently removed notebook must not hide other saved work. */ }
    }
    return found.sort((a, b) => b.modified - a.modified);
  }
  /** Rejects with NotebookConflictError when the file changed since this store's last load or save,
   * unless the learner explicitly chose to replace it (force). */
  save(value: TutorNotebook, force = false) {
    const content = JSON.stringify(readNotebook(value));
    const write = async () => {
      const current = await this.revision();
      if (!force && current !== (this.known ?? null)) throw new NotebookConflictError();
      await mkdir(this.directory, {recursive: true});
      await writeFile(this.file + '.tmp', content, {mode: 0o600});
      await rename(this.file + '.tmp', this.file);
      this.known = await this.revision();
    };
    const result = (TutorNotebookStore.writes.get(this.file) ?? Promise.resolve()).then(write, write);
    const pending = result.catch(() => {});
    TutorNotebookStore.writes.set(this.file, pending);
    void pending.then(() => { if (TutorNotebookStore.writes.get(this.file) === pending) TutorNotebookStore.writes.delete(this.file); });
    return result;
  }
}
