import { execFile } from 'node:child_process';

/**
 * The capstone is a real repository, not a notebook cell: a teammate's history, a bug report, and a judge
 * (check.py) that confirms the learner's own test fails on the buggy code. See scripts/capstone/build_shelf.py.
 */
export function cloneCapstone(bundle: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => execFile('git', ['clone', '-q', '--origin', 'team', bundle, destination],
    {timeout: 60000}, error => {
      if (!error) return resolve();
      reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Install Git to start the capstone. It is part of the work: you will read history, branch and commit.'
        : 'Could not create the capstone repository: ' + error.message));
    }));
}
