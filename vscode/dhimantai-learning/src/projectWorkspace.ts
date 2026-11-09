import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Keep the named VS Code workspace outside the learner's project repository. */
export async function projectWorkspace(storage: string, root: string, title: string): Promise<string> {
  const folder = resolve(root);
  const key = createHash('sha256').update(folder).digest('hex');
  const directory = join(storage, 'project-workspaces', key);
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '') || 'Course project';
  const file = join(directory, `${name}.code-workspace`);
  await mkdir(directory, {recursive: true});
  try {
    await writeFile(file, JSON.stringify({folders: [{name: title, path: folder}]}, null, 2) + '\n', {flag: 'wx'});
  } catch (error) {
    // Reopening preserves any workspace settings the learner has added.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return file;
}
