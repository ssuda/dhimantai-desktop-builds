import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadProjectCurriculum, projectIdentity, publicProjectFile, trackedProjectFiles } from './projectCore';

const git = (cwd: string, args: string[]) => promisify(execFile)('git', args, {cwd, timeout: 15000, windowsHide: true});
const editorExcludes = ['/.vscode/', '/.idea/'];
const capstoneFiles = ['README.md', 'CAPSTONE.md', 'ISSUE.md', 'check.py', 'books.json',
  'shelf/__init__.py', 'shelf/__main__.py', 'shelf/cli.py', 'shelf/models.py', 'shelf/storage.py',
  'shelf/search.py', 'shelf/report.py', 'tests/__init__.py', 'tests/test_models.py',
  'tests/test_storage.py', 'tests/test_search.py', 'tests/test_report.py'];

/** Check both new and reopened destinations without resetting or overwriting learner work. */
export async function validateProjectWorkspace(media: string, id: string, root: string): Promise<void> {
  if (!['shelf', 'course-agent', 'shelf-reading', 'rich-reading'].includes(id)) throw new Error('Unknown course project.');
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(top) !== await realpath(root)) throw new Error('The folder does not have its own Git repository.');
    await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!(await git(root, ['ls-files'])).stdout.trim()) throw new Error('No project files are checked out.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Install Git to prepare the project repository.');
    throw new Error('The project repository is not initialized and checked out.');
  }

  if (id !== 'shelf' && await projectIdentity(root) !== id)
    throw new Error('The project guide is missing or belongs to a different project.');
  const required = id === 'shelf' ? capstoneFiles : trackedProjectFiles(await loadProjectCurriculum(media, id));
  const missing: string[] = [];
  for (const path of required) {
    try { await publicProjectFile(root, path); }
    catch { missing.push(path); }
  }
  if (missing.length) throw new Error('Required project files are missing or unreadable: '
    + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ` (and ${missing.length - 5} more)` : '') + '.');

  // Local editor settings are not learner work. Keep exclusions out of tracked files so reopening
  // an older project does not itself make its working tree dirty. Tracked edits remain visible.
  const exclude = resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim());
  const existing = await readFile(exclude, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const additions = editorExcludes.filter(pattern => !existing.split(/\r?\n/).includes(pattern));
  if (additions.length) {
    await mkdir(dirname(exclude), {recursive: true});
    await appendFile(exclude, '\n# Local editor settings\n' + additions.join('\n') + '\n');
  }
}

export function projectSetupError(root: string, error: unknown): string {
  return `Could not prepare the project at "${root}". ${error instanceof Error ? error.message : String(error)} `
    + 'The workspace was not opened. Existing files were kept. Restore the missing files, or choose another course folder and start the project again.';
}
