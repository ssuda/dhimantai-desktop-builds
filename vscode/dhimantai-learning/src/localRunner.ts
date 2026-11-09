// Runs learner programs on the learner's own computer, mirroring the sandbox contract
// (agent/course_projects/runtime/program.py): fixed file names, argv without a shell,
// input files beside the program in a fresh temporary folder, and a 45-second limit.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { Execution } from './api';
import { entryFile } from './learning';

export const RUN_TIMEOUT_MS = 45_000;
const COMPILE_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 200_000;

export type Toolchains = Partial<Record<'python' | 'node' | 'cc' | 'rustc' | 'javac' | 'java' | 'go' | 'tsc' | 'shell', string>>;

export interface LocalRun {
  source: string;
  argv: string[];
  stdin: string;
  files: { name: string; content: string }[];
}

interface Step {
  tool: keyof Toolchains;
  candidates: string[];
  args: string[];
}

const windows = process.platform === 'win32';
const exe = windows ? 'main.exe' : './main';

/** Compile (optional) and run steps per language. Tool names are resolved on PATH unless overridden. */
export function plan(language: string): { compile?: Step; run: Step; install: string } {
  switch (language) {
    case 'bash': case 'zsh':
      return {run:{tool:'shell',candidates:[language],args:['main.sh']},install:'Use the course runtime for Bash and Zsh.'};
    case 'python':
      return { run: { tool: 'python', candidates: windows ? ['python', 'py'] : ['python3', 'python'], args: ['-I', 'main.py'] }, install: 'Install Python 3 from python.org.' };
    case 'javascript':
      return { run: { tool: 'node', candidates: ['node'], args: ['main.js'] }, install: 'Install Node.js from nodejs.org.' };
    case 'typescript':
      return {
        // Type roots for @types/node are added at run time next to the resolved tsc (see typeRoots).
        compile: { tool: 'tsc', candidates: ['tsc'], args: ['main.ts', '--strict', '--noEmitOnError', '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node'] },
        run: { tool: 'node', candidates: ['node'], args: ['main.js'] },
        install: 'Install Node.js, then run: npm install -g typescript @types/node',
      };
    case 'c':
      return {
        compile: { tool: 'cc', candidates: ['gcc', 'clang', 'cc'], args: ['-std=c17', '-Wall', '-Wextra', 'main.c', '-o', windows ? 'main.exe' : 'main', '-lm'] },
        run: { tool: 'cc', candidates: [exe], args: [] },
        install: windows ? 'Install a C compiler (MSYS2 gcc or LLVM clang) and add it to PATH.' : 'Install a C compiler (Xcode Command Line Tools on macOS: xcode-select --install; gcc on Linux).',
      };
    case 'rust':
      return {
        compile: { tool: 'rustc', candidates: ['rustc'], args: ['--edition=2021', 'main.rs', '-o', windows ? 'main.exe' : 'main'] },
        run: { tool: 'rustc', candidates: [exe], args: [] },
        install: 'Install Rust from rustup.rs.',
      };
    case 'go':
      return {
        compile: { tool: 'go', candidates: ['go'], args: ['build', '-o', windows ? 'main.exe' : 'main', 'main.go'] },
        run: { tool: 'go', candidates: [exe], args: [] },
        install: 'Install Go from go.dev/dl.',
      };
    case 'java':
      return {
        compile: { tool: 'javac', candidates: ['javac'], args: ['-encoding', 'UTF-8', 'Main.java'] },
        run: { tool: 'java', candidates: ['java'], args: ['-cp', '.', 'Main'] },
        install: 'Install a Java 17+ JDK (for example Eclipse Temurin from adoptium.net).',
      };
    default:
      throw new Error(`Running ${language} programs locally is not supported.`);
  }
}

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
  truncated: boolean;
}

function exec(command: string, args: string[], cwd: string, stdin: string, timeout: number, env: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', truncated = false, timedOut = false;
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    const append = (current: string, chunk: Buffer) => {
      if (current.length >= OUTPUT_LIMIT) { truncated = true; return current; }
      const next = current + chunk.toString('utf8');
      if (next.length > OUTPUT_LIMIT) { truncated = true; return next.slice(0, OUTPUT_LIMIT); }
      return next;
    };
    child.stdout.on('data', chunk => (stdout = append(stdout, chunk)));
    child.stderr.on('data', chunk => (stderr = append(stderr, chunk)));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut, missing: error.code === 'ENOENT', truncated });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Like Python's subprocess (the sandbox), a signal-terminated program exits with -<signal number>.
      const signalled = code === null && signal && !timedOut ? -(constants.signals[signal] ?? 0) || null : code;
      resolve({ code: signalled, stdout, stderr, timedOut, missing: false, truncated });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

async function first(step: Step, toolchains: Toolchains, cwd: string, stdin: string, timeout: number, env: NodeJS.ProcessEnv, extra: string[] = []) {
  const override = step.candidates[0].startsWith('.') || step.candidates[0].endsWith('.exe') ? undefined : toolchains[step.tool];
  const candidates = override ? [override] : step.candidates;
  let outcome: Outcome | undefined;
  for (const candidate of candidates) {
    // Built programs are spawned by absolute path; the displayed command keeps the familiar ./main.
    const path = candidate.startsWith('./') || candidate === 'main.exe' ? join(cwd, candidate.replace(/^\.\//, '')) : candidate;
    outcome = await exec(path, [...step.args, ...extra], cwd, stdin, timeout, env);
    if (!outcome.missing) return { command: [candidate, ...step.args, ...extra], outcome };
  }
  return { command: [candidates[0], ...step.args, ...extra], outcome: outcome! };
}

/** Absolute path of a command on PATH (or the path itself), without running a shell. */
export function which(command: string, path = process.env.PATH ?? ''): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  const extensions = windows ? ['.cmd', '.exe', ''] : [''];
  for (const folder of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(folder, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Locate TypeScript's compiler script from `tsc` on PATH (or an override). Running `node <tsc.js>` avoids
 * spawning tsc.cmd on Windows, and a global `npm i -g typescript @types/node` keeps @types beside it,
 * which we pass as type roots like the sandbox does.
 */
export function typescript(tsc: string): { script: string; typeArgs: string[] } | undefined {
  const found = which(tsc);
  if (!found) return undefined;
  let script: string;
  try { script = realpathSync(found); } catch { return undefined; }
  if (script.endsWith('.cmd')) script = join(dirname(script), 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(script) || !/typescript[\\/]bin[\\/]tsc$/.test(script)) return undefined;
  const modules = dirname(dirname(dirname(script))); // .../node_modules/typescript/bin/tsc → .../node_modules
  return { script, typeArgs: existsSync(join(modules, '@types', 'node')) ? ['--typeRoots', join(modules, '@types'), '--types', 'node'] : [] };
}

/** A minimal environment: learner programs see PATH/HOME-like basics, never the editor's secrets. */
export function programEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'GOPATH', 'GOROOT', 'GOCACHE', 'JAVA_HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

export interface TraceStep {
  line: number;
  event: 'line' | 'return' | 'exception';
  function: string;
  depth: number;
  locals: Record<string, string>;
  output: number | null;
  value?: string;
  exception?: string;
}

export interface Trace {
  steps: TraceStep[];
  stopped: 'limit' | null;
  error: string | null;
  stdout: string;
  execution: Execution;
}

export const TRACE_LIMIT = 2000;

/** Python only: run main.py under media/pytrace.py and return every step in the learner's file. */
export async function traceLocally(tracer: string, input: LocalRun, toolchains: Toolchains = {}, limit = TRACE_LIMIT): Promise<Trace> {
  const dir = await mkdtemp(join(tmpdir(), 'dhimantai-trace-'));
  const env = programEnvironment();
  const out = join(dir, '.trace.json');
  env.DHIMANTAI_TRACE_OUT = out;
  const started = Date.now();
  try {
    await writeFile(join(dir, 'main.py'), input.source);
    for (const file of input.files) await writeFile(join(dir, file.name), file.content);
    const step: Step = { tool: 'python', candidates: plan('python').run.candidates, args: ['-I', tracer, String(limit), 'main.py'] };
    const { command, outcome } = await first(step, toolchains, dir, input.stdin, RUN_TIMEOUT_MS, env, input.argv);
    const execution: Execution = {
      status: outcome.missing ? 'toolchain_missing' : outcome.timedOut ? 'timeout' : 'exited', exit_code: outcome.code,
      stdout: outcome.stdout, stderr: outcome.missing ? `${command[0]} was not found. ${plan('python').install}` : outcome.stderr,
      command: ['python3', 'main.py', ...input.argv].map(quote).join(' '), duration_seconds: (Date.now() - started) / 1000, truncated: outcome.truncated,
    };
    let data: Omit<Trace, 'execution'> = { steps: [], stopped: null, error: null, stdout: outcome.stdout };
    try {
      data = JSON.parse(await readFile(out, 'utf8'));
    } catch {
      // No trace file: the tracer itself could not start (missing Python, timeout before writing).
    }
    return { ...data, execution };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const quote = (part: string) => (/^[\w./:=@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`);

/** Returns the same Execution shape the sandbox produces, plus `toolchain_missing` when a tool is absent. */
export async function runLocally(language: string, input: LocalRun, toolchains: Toolchains = {}, timeoutMs = RUN_TIMEOUT_MS): Promise<Execution> {
  const steps = plan(language);
  const dir = await mkdtemp(join(tmpdir(), 'dhimantai-run-'));
  const started = Date.now();
  const env = programEnvironment();
  const result = (status: string, outcome: Outcome | undefined, command: string[], note = ''): Execution => ({
    status,
    exit_code: outcome?.code ?? null,
    stdout: outcome?.stdout ?? '',
    stderr: (outcome?.stderr ?? '') + note,
    command: command.map(quote).join(' '),
    duration_seconds: (Date.now() - started) / 1000,
    truncated: outcome?.truncated ?? false,
  });
  try {
    await writeFile(join(dir, entryFile(language)), input.source);
    for (const file of input.files) await writeFile(join(dir, file.name), file.content);
    if (steps.compile) {
      let compile = steps.compile;
      let extra: string[] = [];
      if (language === 'typescript') {
        const ts = typescript(toolchains.tsc ?? 'tsc');
        if (!ts) return result('toolchain_missing', undefined, ['tsc'], `tsc was not found. ${steps.install}`);
        compile = { tool: 'node', candidates: ['node'], args: [ts.script, ...compile.args] };
        extra = ts.typeArgs;
      }
      const { command, outcome } = await first(compile, toolchains, dir, '', COMPILE_TIMEOUT_MS, env, extra);
      if (outcome.missing) return result('toolchain_missing', undefined, command, `${command[0]} was not found. ${steps.install}`);
      // Compilers report on either stream (tsc uses stdout); like the sandbox, diagnostics go to stderr.
      // The program never ran, so there is no program exit code (as in the sandbox).
      const diagnostics = { ...outcome, code: null, stdout: '', stderr: outcome.stdout + outcome.stderr };
      if (outcome.timedOut) return result('compile_timeout', diagnostics, command);
      if (outcome.code !== 0) return result('compile_error', diagnostics, command);
    }
    const { command, outcome } = await first(steps.run, toolchains, dir, input.stdin, timeoutMs, env, input.argv);
    if (outcome.missing) return result('toolchain_missing', undefined, command, `${command[0]} was not found. ${steps.install}`);
    // Like the sandbox, stderr stays exactly what the program wrote; the status says it was stopped.
    if (outcome.timedOut) return result('timeout', outcome, command);
    return result('exited', outcome, command);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}


export interface LocalTestResult {
  id: string;
  verdict: 'passed' | 'wrong_answer' | 'runtime_error' | 'timeout' | 'compile_error' | 'not_run';
  actual: string;
  stderr: string;
  duration_seconds: number;
}

const normalizeLines = (text: string) => text.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');

/** Public test cases on this computer, judged by the same rules as the server (code_tests.verdict). */
export async function runPublicTests(
  language: string, source: string, tests: import('./api').PublicTest[], pycall: string, toolchains: Toolchains = {},
): Promise<LocalTestResult[]> {
  const results: LocalTestResult[] = [];
  for (const test of tests) {
    if (test.kind === 'function') {
      results.push(await callLocally(source, test, pycall, toolchains));
      continue;
    }
    const execution = await runLocally(language, { source, argv: test.argv ?? [], stdin: test.stdin ?? '', files: test.files ?? [] }, toolchains, 10_000);
    const verdict = execution.status === 'compile_error' || execution.status === 'compile_timeout' ? 'compile_error'
      : execution.status === 'timeout' ? 'timeout'
      : execution.status !== 'exited' ? 'not_run'
      : execution.exit_code !== 0 ? 'runtime_error'
      : execution.truncated ? 'wrong_answer'
      : normalizeLines(execution.stdout) === normalizeLines(test.expected) ? 'passed' : 'wrong_answer';
    results.push({ id: test.id, verdict, actual: execution.stdout, stderr: execution.stderr, duration_seconds: execution.duration_seconds });
  }
  return results;
}

async function callLocally(source: string, test: import('./api').PublicTest, pycall: string, toolchains: Toolchains): Promise<LocalTestResult> {
  const dir = await mkdtemp(join(tmpdir(), 'dhimantai-test-'));
  const started = Date.now();
  try {
    await writeFile(join(dir, 'main.py'), source);
    const step: Step = { tool: 'python', candidates: plan('python').run.candidates, args: ['-I', pycall, test.call ?? '', test.expected] };
    const { outcome } = await first(step, toolchains, dir, '', 10_000, programEnvironment());
    const base = { id: test.id, stderr: outcome.stderr, duration_seconds: (Date.now() - started) / 1000 };
    if (outcome.missing) return { ...base, verdict: 'not_run', actual: '', stderr: `Python was not found. ${plan('python').install}` };
    if (outcome.timedOut) return { ...base, verdict: 'timeout', actual: '' };
    let value: { repr: string; equal: boolean } | undefined;
    try { value = JSON.parse(await readFile(join(dir, '_dhimantai_value.json'), 'utf8')); } catch { /* no result written */ }
    if (outcome.code !== 0 || !value) return { ...base, verdict: 'runtime_error', actual: '' };
    return { ...base, verdict: value.equal ? 'passed' : 'wrong_answer', actual: value.repr };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
