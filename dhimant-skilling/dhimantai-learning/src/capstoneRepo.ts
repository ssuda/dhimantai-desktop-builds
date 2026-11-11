import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const git = (cwd: string, args: string[]) => promisify(execFile)('git', args, {cwd, timeout: 60000, windowsHide: true});

/**
 * The capstone is a real repository, not a notebook cell: a teammate's history, a bug report, and a judge
 * (check.py) that confirms the learner's own test fails on the buggy code. See scripts/capstone/build_shelf.py.
 */
export function cloneCapstone(bundle: string, destination: string): Promise<void> {
  // Bundles may advertise main without HEAD. Select it explicitly, independent of the user's Git default.
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.hooksPath=', 'clone', '-q', '--branch', 'main', '--origin', 'team', bundle, destination],
    {timeout: 60000}, error => {
      if (!error) return resolve();
      reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Install Git to start the capstone. It is part of the work: you will read history, branch and commit.'
        : 'Could not create the capstone repository: ' + error.message));
    }));
}

/** Recover only the untouched, un-checked-out bundle clone produced by older versions. */
export async function restoreEmptyCapstone(bundle: string, destination: string): Promise<boolean> {
  try {
    if (!(await lstat(destination)).isDirectory()) return false;
    const entries = await readdir(destination);
    if (entries.length !== 1 || entries[0] !== '.git' || !(await lstat(join(destination, '.git'))).isDirectory()) return false;
    if ((await git(destination, ['rev-parse', '--is-bare-repository'])).stdout.trim() !== 'false') return false;
    if ((await git(destination, ['ls-files'])).stdout.trim()) return false;
    const hasCommit = await git(destination, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
    if (hasCommit) return false;
    const bundled = (await git(destination, ['bundle', 'list-heads', bundle, 'refs/heads/main'])).stdout.trim().split(/\s+/)[0];
    const cloned = (await git(destination, ['rev-parse', '--verify', 'refs/remotes/team/main'])).stdout.trim();
    if (!bundled || bundled !== cloned) return false;
  } catch { return false; } // Anything other than the known empty clone stays untouched.
  // Normal checkout refuses conflicting files or an existing branch; never force or reset learner work.
  await git(destination, ['checkout', '-b', 'main', '--track', 'team/main']);
  return true;
}
