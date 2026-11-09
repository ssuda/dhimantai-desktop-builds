import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { cloneCapstone } from './capstoneRepo';

export interface ProjectStep {
  id: string; title: string; goal: string; opening: string; task: string;
  files: string[]; check: string; expected: string; hint: string; reflection: string;
  anchors?: Record<string, string>;
}
export interface ProjectCurriculum { id: string; version: number; title: string; mode?: 'reading'; files: string[]; evidenceFiles?: string[]; steps: ProjectStep[] }
export interface ProjectSource { path: string; text: string; truncated: boolean; start_line: number }
export interface ProjectSnapshot { digest: string; files: ProjectSource[]; omitted: string[] }
export interface ProjectRun {
  digest: string; step: string; status: 'passed' | 'failed' | 'runtime_error' | 'timed_out';
  command: string; output: string; truncated: boolean;
}
export interface ProjectCheckpoint {
  step: string; note: string; digest: string; at: string; assistance: number;
  externalHelp: 'reported' | 'none_reported' | 'unknown';
}

const invoke = (file: string, args: string[], cwd: string) => new Promise<void>((done, reject) =>
  execFile(file, args, {cwd, timeout: 15000, windowsHide: true}, error => error ? reject(new Error(
    (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Install Git to create a project repository.' : 'Could not initialize the project repository. The copied files remain in the chosen folder.')) : done()));

/** Template and curriculum come from the installed extension, never from executable workspace metadata. */
export async function createProject(source: string, destination: string) {
  await mkdir(destination); // An existing project is never overwritten or removed on failure.
  await cp(source, destination, {recursive: true, filter: path => !/(?:^|[/\\])__pycache__(?:[/\\]|$)|\.pyc$/.test(path)});
  await invoke('git', ['init', '-b', 'main'], destination);
  await invoke('git', ['add', '.'], destination);
  await invoke('git', ['-c', 'user.name=dhimantAI', '-c', 'user.email=starter@dhimantai.local',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Start the Course Research Agent project'], destination);
}

export async function createReadingProject(media: string, id: 'shelf-reading' | 'rich-reading', destination: string) {
  await cloneCapstone(id === 'rich-reading' ? join(media, 'projects/rich.bundle') : join(media, 'capstone/shelf.bundle'), destination);
  if (id === 'shelf-reading') {
    await cp(join(media, 'projects/shelf-reading'), destination, {recursive: true});
    await appendFile(join(destination, '.gitignore'), '\n.env*\n.dhimantai-local/\n');
    await invoke('git', ['add', '.'], destination);
    await invoke('git', ['-c', 'user.name=dhimantAI', '-c', 'user.email=starter@dhimantai.local',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Add the code-reading course guide'], destination);
  }
}

export async function loadProjectCurriculum(media: string, id: string): Promise<ProjectCurriculum> {
  if (!['course-agent', 'shelf-reading', 'rich-reading'].includes(id)) throw new Error('Unknown course project.');
  const curriculum = JSON.parse(await readFile(join(media, 'projects', id + '.json'), 'utf8'));
  if (id === 'rich-reading') curriculum.evidenceFiles = JSON.parse(await readFile(join(media, 'projects/rich-source.json'), 'utf8')).evidenceFiles;
  return curriculum;
}

export function trackedProjectFiles(curriculum: ProjectCurriculum) { return [...new Set([...curriculum.files, ...curriculum.evidenceFiles ?? []])]; }

export async function projectIdentity(root: string): Promise<string | undefined> {
  try {
    const file = join(root, '.dhimantai-project.json');
    if ((await stat(file)).size > 1000 || await realpath(file) !== join(await realpath(root), '.dhimantai-project.json')) return;
    const marker = JSON.parse(await readFile(file, 'utf8'));
    if (['course-agent', 'shelf-reading', 'rich-reading'].includes(marker.id) && marker.version === 1) return marker.id;
  } catch { /* Not a supported project. */ }
}
export async function isProject(root: string) { return !!(await projectIdentity(root)); }

export async function publicProjectFile(root: string, path: string) {
  if (isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some(p => p.startsWith('.')))
    throw new Error('Choose a public source file from this project.');
  const file = resolve(root, path), canonicalRoot = await realpath(root);
  const actual = await realpath(file);
  // Reject symlinks even inside the project: a public filename must never alias an env file.
  if (actual !== resolve(canonicalRoot, path) || relative(canonicalRoot, actual).startsWith('..'))
    throw new Error('Linked files cannot be shared with Coach.');
  if (!(await stat(file)).isFile() || (await stat(file)).size > 512000)
    throw new Error('Project source files must be smaller than 512 KB.');
  return actual;
}

/** Hash every declared source/check/fixture, including omitted context. Code and run output stay temporary. */
export async function projectSnapshot(root: string, curriculum: ProjectCurriculum, focus: string[],
    dirty = new Map<string, string>(), locations: Record<string, number | string> = {}): Promise<ProjectSnapshot> {
  const hash = createHash('sha256'), all = new Map<string, string>();
  let total = 0;
  for (const path of trackedProjectFiles(curriculum).sort()) {
    try {
      const file = await publicProjectFile(root, path);
      const text = dirty.get(path) ?? await readFile(file, 'utf8');
      total += Buffer.byteLength(text, 'utf8');
      if (text.length > 512000 || total > 8000000) throw new Error('Project context is too large.');
      hash.update(JSON.stringify([path, text])); all.set(path, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update(JSON.stringify([path, null]));
    }
  }
  const files: ProjectSource[] = [], omitted: string[] = [];
  let budget = 24000;
  const ordered = [...new Set([...focus, ...curriculum.files])].filter(path => curriculum.files.includes(path));
  for (const path of ordered) {
    const source = all.get(path);
    if (source === undefined || files.length >= 12 || budget < 256) { omitted.push(path); continue; }
    const lines = source.split('\n'), location = locations[path];
    const target = typeof location === 'string' ? Math.max(0, lines.findIndex(line => line.includes(location)))
      : Math.max(0, (location ?? 1) - 1);
    const start = Math.max(0, Math.min(target, lines.length - 1) - 8);
    let text = lines.slice(start).join('\n').slice(0, 6000);
    while (Buffer.byteLength(text, 'utf8') > budget) text = text.slice(0, -100);
    budget -= Buffer.byteLength(text, 'utf8');
    files.push({path, text, truncated: start > 0 || text.length < source.length, start_line: start + 1});
  }
  return {digest: hash.digest('hex'), files, omitted};
}

export function checkArguments(step: ProjectStep): string[] {
  const demonstrations: Record<string, string[]> = {
    'shelf:help': ['-m', 'shelf', '--help'], 'shelf:list': ['-m', 'shelf', 'list'],
    'shelf:search': ['-m', 'shelf', 'search', 'dune'], 'shelf:report': ['-m', 'shelf', 'report', '--by', 'decade'],
  };
  if (demonstrations[step.check]) return demonstrations[step.check];
  if (/^rich:(setup|text|markup|table|protocol|test-console|test-markup|test-table)$/.test(step.check))
    return ['-m', 'reading.run', step.check.slice(5)];
  if (step.check === 'all') return ['-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-v'];
  if (!/^(checks|tests)\.test_[a-z_]+$/.test(step.check)) throw new Error('Unknown project check.');
  return ['-m', 'unittest', step.check, '-v'];
}

export function checkState(run: ProjectRun | undefined, digest: string, step: string) {
  if (!run || run.step !== step) return {state: 'not_run' as const};
  return {state: run.digest === digest ? 'current' as const : 'changed' as const,
    status: run.status, command: run.command, output: run.output, truncated: run.truncated};
}

/** Execute exclusively in the course container. Missing setup never falls back to host Python. */
export function runProjectCheck(root: string, step: ProjectStep, digest: string,
    signal: AbortSignal, engine: {bin: string; execArgs(cwd: string, command: string, args: string[]): string[]}): Promise<ProjectRun> {
  if (!engine) return Promise.reject(new Error('Set up the course container before running project checks.'));
  const args = checkArguments(step), command = ['python', ...args].join(' ');
  return new Promise(resolveRun => {
    if (signal.aborted) return resolveRun({digest, step: step.id, status: 'runtime_error', command, output: 'Check cancelled.', truncated: false});
    let output = '', truncated = false, timedOut = false, settled = false;
    // The container owns its deadline too: killing the Podman client alone would leave Python running.
    const child = spawn(engine.bin, engine.execArgs(root, 'timeout', ['--signal=KILL', '28s', 'python', ...args]),
      {cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    const append = (chunk: Buffer) => { const text = chunk.toString(); truncated ||= output.length + text.length > 4000; output = (output + text).slice(0, 4000); };
    const finish = (status: ProjectRun['status']) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      resolveRun({digest, step: step.id, status, command, output, truncated});
    };
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true}, () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const cancel = () => { stop(); output = (output + '\nCheck cancelled.').slice(-4000); finish('runtime_error'); };
    const timer = setTimeout(() => { timedOut = true; stop(); output = (output + '\nCheck exceeded 30 seconds.').slice(-4000); finish('timed_out'); }, 30000);
    signal.addEventListener('abort', cancel, {once: true});
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', () => { output = 'The course container could not start. Use Runtime → Set up course and retry.'; finish('runtime_error'); });
    child.on('close', code => finish(timedOut || [124,137].includes(code ?? 0) ? 'timed_out' : code === 0 ? 'passed' : 'failed'));
  });
}
