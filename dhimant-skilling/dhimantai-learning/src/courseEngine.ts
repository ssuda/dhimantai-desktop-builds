import { spawn } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import type { Execution, PublicTest } from './api';
import type { LocalRun, LocalTestResult, Trace } from './localRunner';

/** SQL results: same columns and rows; row order counts only when the exercise asks for it (as code_tests.py). */
export function sameRows(expected: string, actual: string, ordered: boolean): boolean {
  try {
    const want = JSON.parse(expected), got = JSON.parse(actual);
    if (JSON.stringify(want.columns) !== JSON.stringify(got.columns)) return false;
    // Numerics arrive as text with their scale ('0' or '0.00'); equal values compare equal, as on the server.
    const number = (cell: unknown) => typeof cell === 'string' && /^-?\d+(\.\d+)?$/.test(cell)
      ? (cell.includes('.') ? cell.replace(/0+$/, '').replace(/\.$/, '') : cell).replace(/^(-?)0+(?=\d)/, '$1').replace(/^-0$/, '0') : cell;
    const clean = (rows: unknown[]) => rows.map(row => Array.isArray(row) ? row.map(number) : row);
    const key = (rows: unknown[]) => (ordered ? clean(rows) : clean(rows).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)).map(r => JSON.stringify(r));
    return JSON.stringify(key(want.rows ?? [])) === JSON.stringify(key(got.rows ?? []));
  } catch { return false; }
}

export class CourseEngine {
  constructor(
    readonly bin: string,
    readonly name: string,
    readonly root: string,
    readonly published = false,
    readonly target = 'Course',
    readonly serviceDatabase = false
  ) {}

  get execUser(): string[] {
    return this.published ? ['--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`] : [];
  }

  path(local: string) {
    const rel = relative(this.root, local);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
      throw new Error('The file is outside this course folder.');
    return '/course' + (rel ? '/' + rel.split(sep).join('/') : '');
  }

  execArgs(cwd: string, command: string, args: string[]) {
    return ['exec', '-i', ...this.execUser, '--workdir', this.path(cwd), this.name, command, ...args];
  }

  private async invoke<T>(operation: string, language: string, input: LocalRun, tests?: PublicTest[]): Promise<T> {
    const child = spawn(this.bin, this.execArgs(this.root, 'node', ['/opt/dhimantai/runner.cjs']), {
      windowsHide: true
    });
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0,
        error = '';
      child.on('error', reject);
      child.stdout.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes <= 16 * 1024 * 1024) chunks.push(b);
        else {
          child.kill();
          reject(new Error('Course runtime output is too large.'));
        }
      });
      child.stderr.on('data', (b) => {
        error = (error + b.toString()).slice(-1500);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(error || 'The course runtime stopped. Reopen the course to retry.'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error('Incomplete course runtime response.'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ operation, language, input, tests }));
    });
  }

  run(language: string, input: LocalRun) {
    if (language === 'sql' || language === 'pglab') return this.sqlRun(input, language);
    return this.invoke<Execution>('run', language, input);
  }
  tests(language: string, input: LocalRun, tests: PublicTest[]) {
    if (language === 'sql' || language === 'pglab') return this.sqlTests(input, tests, language);
    return this.invoke<LocalTestResult[]>('tests', language, input, tests);
  }

  /** SQL uses the same runtime as Practice's hidden tests (sql_runtime.py), with its cluster in the learner's home. */
  private sql<T>(request: object): Promise<T> {
    const child = spawn(this.bin, ['exec', '-i', ...this.execUser, '--workdir', '/course',
      this.name, 'python', '/opt/dhimantai/sql_runtime.py'], { windowsHide: true });
    return new Promise((resolve, reject) => {
      let out = '', error = '';
      child.on('error', reject);
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { error = (error + b.toString()).slice(-1500); });
      child.on('close', code => {
        if (code !== 0) return reject(new Error(error.trim().split('\n').pop() || 'PostgreSQL did not start in the course container.'));
        try { resolve(JSON.parse(out)); } catch { reject(new Error('Incomplete PostgreSQL response.')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }

  private async sqlRun(input: LocalRun, language: string): Promise<Execution> {
    const started = Date.now(), lab = language === 'pglab';
    const setup = input.files.filter(f => f.name.endsWith(lab ? '.sh' : '.sql')).map(f => f.content).join('\n');
    const result = await this.sql<{exit_code: number; stdout: string; stderr: string}>({mode: lab ? 'image_lab' : 'run', source: input.source, setup});
    return {status: 'exited', exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, command: lab ? 'bash' : 'psql',
      duration_seconds: (Date.now() - started) / 1000, truncated: false};
  }

  private async sqlTests(input: LocalRun, tests: PublicTest[], language: string): Promise<LocalTestResult[]> {
    const results = await this.sql<{tests: {id: string; status: string; exit_code: number | null; stdout: string; stderr: string; duration_seconds: number; truncated: boolean}[]}>(
      {mode: language === 'pglab' ? 'lab_tests' : 'tests', source: input.source,
        tests: tests.map(t => ({id: t.id, kind: language === 'pglab' ? 'lab' : 'sql', setup: t.setup ?? '', check: t.check ?? '', ordered: !!t.ordered}))});
    const byId = new Map(results.tests.map(r => [r.id, r]));
    return tests.map<LocalTestResult>(test => {
      const r = byId.get(test.id);
      if (!r) return {id: test.id, verdict: 'not_run', actual: '', stderr: 'The runtime did not return this test result.', duration_seconds: 0};
      const verdict = r.status === 'timeout' ? 'timeout' : r.status !== 'exited' ? 'not_run'
        : r.exit_code !== 0 ? 'runtime_error' : r.truncated ? 'wrong_answer'
        : sameRows(test.expected, r.stdout, !!test.ordered) ? 'passed' : 'wrong_answer';
      return {id: r.id, verdict, actual: r.stdout, stderr: r.stderr, duration_seconds: r.duration_seconds};
    });
  }
  trace(input: LocalRun) {
    return this.invoke<Trace>('trace', 'python', input);
  }
}
