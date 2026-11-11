import { spawn } from 'node:child_process';

/** Where the lab's runtime lives inside the course container (the course folder is mounted at /course). */
export const LAB_SCRIPT = '/course/.datalab/data_lab.py';

export type LabRequest =
  | {op: 'open'; dataset: string; source: LabSource}
  | {op: 'query'; dataset: string; source: LabSource; sql: string}
  | {op: 'drop'; dataset: string}
  | {op: 'xlsx'; data: string};
export type LabSource = {kind: 'sample' | 'import'; path: string};

export function labExecArgs(container: string, script = LAB_SCRIPT, python = 'python') {
  return ['exec', '-i', '--workdir', '/course', container, python, script];
}

/** One request to media/course/data_lab.py in the course container: JSON in on stdin, JSON out on stdout. */
export function runLab<T>(bin: string, args: string[], request: LabRequest, maxBytes = 96 * 1024 * 1024): Promise<T> {
  const child = spawn(bin, args, {windowsHide: true});
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, error = '';
    child.on('error', reject);
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size <= maxBytes) chunks.push(b);
      else { child.kill(); reject(new Error('The lab returned more data than expected.')); }
    });
    child.stderr.on('data', (b: Buffer) => { error = (error + b.toString()).slice(-1500); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(error.trim().split('\n').pop() || 'PostgreSQL did not start in the course container.'));
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof reply?.fatal === 'string') reject(new Error(reply.fatal));
        else resolve(reply as T);
      } catch { reject(new Error('Incomplete response from the course container.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
