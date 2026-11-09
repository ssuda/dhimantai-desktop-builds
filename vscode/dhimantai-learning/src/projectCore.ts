import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { cloneCapstone } from './capstoneRepo';
import { publicContextPath, selectProjectContext, ProjectStructure } from './projectContext';
import { promisify } from 'node:util';

const projectIds = ['course-agent', 'shelf-reading', 'rich-reading', 'shelf'];
// The original bundled capstone predates project markers. Keep existing clones recognizable without changing learner work.
const shelfStart = '9d7b2be98471876899eea8853f0b3f4e336bcbf9';
const git = (root: string, args: string[]) => promisify(execFile)('git', ['--no-optional-locks', ...args],
  {cwd: root, timeout: 5000, maxBuffer: 256000, windowsHide: true});

export interface ProjectStep {
  id: string; title: string; goal: string; opening: string; task: string;
  files: string[]; check: string; expected: string; hint: string; reflection: string;
  anchors?: Record<string, string>;
  nextAction?: {file: string; task: string};
}
export interface ProjectCurriculum { id: string; version: number; title: string; mode?: 'reading'; files: string[]; evidenceFiles?: string[]; steps: ProjectStep[] }
export interface ProjectSource { path: string; text: string; truncated: boolean; start_line: number }
export interface ProjectGit {
  state: 'available' | 'unavailable'; branch: string; head: string;
  changed_files: {path: string; status: string}[]; recent_commits: string[]; truncated: boolean;
}
export interface ProjectSnapshot { digest: string; files: ProjectSource[]; omitted: string[]; omitted_count: number; structure: ProjectStructure; git?: ProjectGit }
export interface ProjectRun {
  digest: string; step: string; status: 'passed' | 'failed' | 'runtime_error' | 'timed_out';
  command: string; output: string; truncated: boolean;
}
export interface ProjectCheckpoint {
  step: string; note: string; digest: string; at: string; assistance: number;
  externalHelp: 'reported' | 'none_reported' | 'unknown';
  completed?: boolean;
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
  if (!projectIds.includes(id)) throw new Error('Unknown course project.');
  const curriculum = JSON.parse(await readFile(join(media, 'projects', id + '.json'), 'utf8'));
  if (id === 'rich-reading') curriculum.evidenceFiles = JSON.parse(await readFile(join(media, 'projects/rich-source.json'), 'utf8')).evidenceFiles;
  return curriculum;
}

export function trackedProjectFiles(curriculum: ProjectCurriculum) { return [...new Set([...curriculum.files, ...curriculum.evidenceFiles ?? []])]; }

export async function projectFiles(root: string, curriculum: ProjectCurriculum) {
  const files = new Set(trackedProjectFiles(curriculum));
  if (['course-agent', 'shelf', 'shelf-reading', 'rich-reading'].includes(curriculum.id)) {
    const walk = async (folder: string, depth = 0) => {
      if (depth > 8) throw new Error('Project source folders are too deeply nested.');
      for (const entry of await readdir(join(root, folder), {withFileTypes: true}).catch(error => {
        if (error.code === 'ENOENT') return []; throw error;
      })) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.py)?$/.test(entry.name) || entry.name === '__pycache__') continue;
        const path = folder + '/' + entry.name;
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.name.endsWith('.py')) files.add(path);
        if (files.size > (curriculum.id === 'rich-reading' ? 2048 : 64)) throw new Error('Too many public project source, test and fixture files.');
      }
    };
    const folders = curriculum.id === 'rich-reading' ? ['rich', 'tests', 'examples', 'reading']
      : curriculum.id.startsWith('shelf') ? ['shelf', 'tests'] : ['course_agent', 'checks', 'tests'];
    for (const folder of folders) await walk(folder);
    // Public JSON fixtures are part of both coaching and the explicit handoff contract.
    for (const folder of curriculum.id === 'rich-reading' ? [] : ['data', 'scenarios']) {
      for (const entry of await readdir(join(root, folder), {withFileTypes: true}).catch(error => {
        if (error.code === 'ENOENT') return []; throw error;
      })) {
        if (/^[A-Za-z0-9_-]+\.json$/.test(entry.name) && publicContextPath(folder + '/' + entry.name)) files.add(folder + '/' + entry.name);
      }
    }
    if (files.size > (curriculum.id === 'rich-reading' ? 2048 : 64)) throw new Error('Too many public project source, test and fixture files.');
  }
  return [...files].sort();
}

export interface ProjectHandoff {
  project_id: 'course-agent'; files: {path: string; text: string}[];
  assistance: {coach_turns: number; other_help: ProjectCheckpoint['externalHelp']};
  checkpoint: string; check: ReturnType<typeof checkState>;
}

/** An explicit final snapshot, including learner-authored tests, never a workspace archive. */
export async function prepareProjectHandoff(root: string, curriculum: ProjectCurriculum,
    assistance: ProjectHandoff['assistance'], checkpoint: string, run?: ProjectRun): Promise<ProjectHandoff> {
  if (curriculum.id !== 'course-agent') throw new Error('Final submission is available for the Course Research Agent.');
  const paths = await projectFiles(root, curriculum), files = [];
  for (const path of paths) {
    const text = await readFile(await publicProjectFile(root, path), 'utf8');
    if (Buffer.byteLength(text) > 64000) throw new Error('Keep each handoff file under 64 KB: ' + path);
    files.push({path, text});
  }
  const hash = createHash('sha256');
  for (const {path, text} of files) hash.update(JSON.stringify([path, text]));
  const result: ProjectHandoff = {project_id: 'course-agent', files, assistance, checkpoint,
    check: checkState(run, hash.digest('hex'), 'handoff')};
  if (Buffer.byteLength(JSON.stringify(result)) > 250000) throw new Error('Keep the project handoff under 250 KB.');
  return result;
}

export async function projectIdentity(root: string): Promise<string | undefined> {
  try {
    const file = join(root, '.dhimantai-project.json');
    if ((await stat(file)).size > 1000 || await realpath(file) !== join(await realpath(root), '.dhimantai-project.json')) return;
    const marker = JSON.parse(await readFile(file, 'utf8'));
    if (projectIds.includes(marker.id) && marker.version === 1) return marker.id;
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
  try {
    const {stdout} = await git(root, ['rev-parse', '--show-toplevel', 'refs/tags/start^{commit}']);
    const [top, start] = stdout.trim().split(/\r?\n/);
    if (start === shelfStart && await realpath(top) === await realpath(root)) return 'shelf';
  } catch { /* Not an original Shelf capstone repository. */ }
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
    dirty = new Map<string, string>(), locations: Record<string, number | string> = {}, question = ''): Promise<ProjectSnapshot> {
  const hash = createHash('sha256'), all = new Map<string, string>();
  let total = 0;
  const paths = await projectFiles(root, curriculum);
  for (const path of paths) {
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
  const repository = curriculum.id === 'shelf' ? await projectGit(root, paths) : undefined;
  if (repository) hash.update(repository.fingerprint);
  return {digest: hash.digest('hex'), ...selectProjectContext(all, focus, question, locations), ...(repository ? {git: repository.context} : {})};
}

/** No remotes, author details, arbitrary diffs or private filenames are sent to Coach. */
async function projectGit(root: string, paths: string[]): Promise<{context: ProjectGit; fingerprint: string}> {
  try {
    const [branchName, identity, status, history] = await Promise.all([
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(root, ['rev-parse', 'HEAD']),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(root, ['log', '-6', '--format=%h %s']),
    ]);
    const branch = branchName.stdout.trim(), head = identity.stdout.trim();
    const changed: ProjectGit['changed_files'] = [], entries = status.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const code = entries[i].slice(0, 2), path = entries[i].slice(3);
      if (paths.includes(path) && publicContextPath(path)) changed.push({path, status: code});
      if (/[RC]/.test(code)) i++; // porcelain -z also includes the original name of a rename/copy.
    }
    const commits = history.stdout.trim().split(/\r?\n/).filter(Boolean);
    return {context: {state: 'available', branch: branch.slice(0, 160), head,
      changed_files: changed.slice(0, 64), recent_commits: commits.map(line => line.slice(0, 220)),
      truncated: changed.length > 64 || commits.some(line => line.length > 220) || branch.length > 160},
      fingerprint: JSON.stringify([branchName.stdout, identity.stdout, status.stdout])};
  } catch {
    return {context: {state: 'unavailable', branch: '', head: '', changed_files: [], recent_commits: [], truncated: false},
      fingerprint: 'git-unavailable'};
  }
}

export function checkArguments(step: ProjectStep): string[] {
  if (step.check === 'final:agent') return ['-B', '-c', [
    'import sys, tempfile, unittest',
    // Never accept stale bytecode for the saved source being submitted.
    'with tempfile.TemporaryDirectory(prefix="dhimantai-final-") as cache:',
    '    sys.pycache_prefix = cache',
    '    suite = unittest.defaultTestLoader.discover(".", pattern="test_*.py")',
    '    result = unittest.TextTestRunner(verbosity=2).run(suite)',
    '    print("Final checker: %s tests; %s skipped" % (result.testsRun, len(result.skipped)))',
    '    sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped else 1)',
  ].join('\n')];
  const demonstrations: Record<string, string[]> = {
    'shelf:help': ['-m', 'shelf', '--help'], 'shelf:list': ['-m', 'shelf', 'list'],
    'shelf:search': ['-m', 'shelf', 'search', 'dune'], 'shelf:report': ['-m', 'shelf', 'report', '--by', 'decade'],
  };
  if (demonstrations[step.check]) return demonstrations[step.check];
  if (step.check === 'shelf:capstone') return ['check.py'];
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
