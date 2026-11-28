import { GitEvidence, GitExercise, GitProject, gitProjects } from './gitPractice';
import { architectureCase, DebugCheckEvent, debugCheckEvent, debugProjects, isDebugProject, transferTitles } from './architectureMemory';
import { desktopProjectEnabled } from './desktopFeatures';
import { COURSE_LANGUAGES } from './courseRecipe';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cloneCapstone } from './capstoneRepo';
import { redactSecrets, publicContextPath, selectProjectContext, ProjectStructure, ProjectLineSelection } from './projectContext';
import { promisify } from 'node:util';
import { ProjectCheckDiagnostic, ProjectCheckOutput } from './projectCheckOutput';

const projectIds = ['course-agent', 'shelf-reading', 'rich-reading', 'shelf', 'skilling-project', 'market-checkout', ...Object.keys(transferTitles)];
// The original bundled capstone predates project markers. Keep existing clones recognizable without changing learner work.
const shelfStart = '9d7b2be98471876899eea8853f0b3f4e336bcbf9';
const git = (root: string, args: string[]) => promisify(execFile)('git', ['--no-optional-locks', ...args],
  {cwd: root, timeout: 5000, maxBuffer: 256000, windowsHide: true});

export interface ProjectStep {
  id: string; title: string; goal: string; opening: string; task: string;
  files: string[]; check: string; expected: string; hint: string; reflection: string;
  deliverable?: string; evidencePrompt?: string; checkpointCheck?: string;
  guide?: {sections: string[]; cues: string[]; prepare: string; beforeRun: string; afterRun?: string};
  anchors?: Record<string, string>;
  nextAction?: {file: string; task: string};
}
export interface ProjectCurriculum { id: string; version: number; title: string; mode?: 'reading' | 'guided'; gitPractice?:GitExercise; architecture?: {prediction:string; focusFile:string; boundaryHint:string}; courseId?:string; courseTitle?:string; language?:string; files: string[]; evidenceFiles?: string[]; steps: ProjectStep[] }
export interface ProjectSource { path: string; text: string; truncated: boolean; start_line: number }
export interface ProjectGit {
  state: 'available' | 'unavailable'; branch: string; head: string;
  practice_starter?: GitProject;
  changed_files: {path: string; status: string}[]; recent_commits: string[]; truncated: boolean;
}
/**
 * digest identifies the project files. steps holds the original per-milestone hashes for existing checkpoints.
 * Shelf also keeps the local notebook sections so appending later work can preserve a saved checkpoint.
 */
export interface ProjectSnapshot {
  digest: string; steps: Record<string, string>; gitFingerprint?: string; gitRevision?: string;
  selection?: ProjectLineSelection;
  reading?: {sections: Record<string, string[]>; savedSections: Record<string, string[]>; sources: Record<string, string>; commandDigest: string};
  files: ProjectSource[]; omitted: string[]; omitted_count: number; structure: ProjectStructure; git?: ProjectGit;
}
export interface ProjectRun {
  digest: string; step: string; status: 'passed' | 'failed' | 'runtime_error' | 'timed_out';
  command: string; output: string; truncated: boolean;
  diagnostic?: ProjectCheckDiagnostic;
  gitEvidence?: GitEvidence;
  practiceEvent?: DebugCheckEvent;
}
export interface ProjectCheckpoint {
  step: string; note: string; digest: string; at: string; assistance: number;
  externalHelp: 'reported' | 'none_reported' | 'unknown';
  completed?: boolean;
  verified?: {summary: string; fingerprint: string};
  /** Hash of the source and notebook evidence captured for this checkpoint. */
  stepDigest?: string;
  /** Each shared notebook section contributes only the lines present at completion. */
  noteLines?: Record<string, number>;
}

const invoke = (file: string, args: string[], cwd: string) => new Promise<void>((done, reject) =>
  execFile(file, args, {cwd, timeout: 15000, windowsHide: true}, error => error ? reject(new Error(
    (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Install Git to create a project repository.' : 'Could not initialize the project repository.')) : done()));
// Starter commits must not depend on the learner's hooks, signing setup or Git version (init -b needs Git 2.28).
const starterCommit = (message: string, cwd: string) => invoke('git', ['-c', 'core.hooksPath=', '-c', 'user.name=dhimantAI',
  '-c', 'user.email=starter@dhimantai.local', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message], cwd);

/**
 * Build a new project in a private sibling folder and move it into place only when complete, so a failed setup never
 * leaves a half-made project at the destination. An existing destination is never overwritten.
 */
export async function stageProject(destination: string, build: (folder: string) => Promise<void>) {
  if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
    throw Object.assign(new Error('The project folder already exists.'), {code: 'EEXIST'});
  const staging = join(dirname(destination), `.${basename(destination)}.setup-${randomBytes(6).toString('hex')}`);
  try {
    await build(staging);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}

export async function initializeProject(root:string) {
  await invoke('git',['init','-q'],root);
  await invoke('git',['symbolic-ref','HEAD','refs/heads/main'],root);
  await invoke('git',['add','.'],root);
  await starterCommit('Start the guided Skilling project',root);
}

/** Template and curriculum come from the installed extension, never from executable workspace metadata. */
export function createProject(source: string, destination: string) {
  return stageProject(destination, async folder => {
    await mkdir(folder);
    await cp(source, folder, {recursive: true, filter: path => !/(?:^|[/\\])__pycache__(?:[/\\]|$)|\.pyc$/.test(path)});
    await invoke('git', ['init', '-q'], folder);
    await invoke('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], folder);
    await invoke('git', ['add', '.'], folder);
    await starterCommit('Start the course project', folder);
  });
}

export function createGitProject(media:string, id:GitProject, destination:string) {
  return stageProject(destination, folder => cloneCapstone(join(media,'projects',id+'.bundle'), folder));
}

export function createShelfProject(media: string, destination: string) {
  return stageProject(destination, folder => cloneCapstone(join(media, 'capstone/shelf.bundle'), folder));
}

export function createReadingProject(media: string, id: 'shelf-reading' | 'rich-reading', destination: string) {
  return stageProject(destination, async folder => {
    await cloneCapstone(id === 'rich-reading' ? join(media, 'projects/rich.bundle') : join(media, 'capstone/shelf.bundle'), folder);
    if (id === 'shelf-reading') {
      await cp(join(media, 'projects/shelf-reading'), folder, {recursive: true});
      await appendFile(join(folder, '.gitignore'), '\n.env*\n.dhimantai-local/\n');
      await invoke('git', ['add', '.'], folder);
      await starterCommit('Add the code-reading course guide', folder);
    }
  });
}

/** A saved project folder that was moved or deleted is reported as such, never as a missing Git installation. */
export async function requireProjectFolder(root: string) {
  const folder = await stat(root).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined; throw error; });
  if (!folder?.isDirectory()) throw Object.assign(new Error(`Project folder not found: "${root}". It may have been moved or deleted.`), {code: 'PROJECT_FOLDER_MISSING'});
}
export const projectFolderMissing = (error: unknown) => (error as {code?: string})?.code === 'PROJECT_FOLDER_MISSING';

export async function loadProjectCurriculum(media: string, id: string, root?:string): Promise<ProjectCurriculum> {
  if (id === 'personal-project') {
    return {id, version:1, title:'Your project', files:[], steps:[{id:'review', title:'Project review',
      goal:'Support the learner’s goal in this repository.', opening:'', files:[], check:'', expected:'',
      task:'Open a file and tell the mentor what you want to build, understand or fix.', hint:'', reflection:''}]};
  }
  if (!projectIds.includes(id)) throw new Error('Unknown course project.');
  const curriculum = JSON.parse(await readFile(join(media, 'projects', id + '.json'), 'utf8'));
  if(id==='skilling-project') {
    if(!root)throw new Error('Open the guided project folder.');
    const file=join(root,'.dhimantai-skilling.json');
    if((await stat(file)).size>12000||await realpath(file)!==join(await realpath(root),'.dhimantai-skilling.json'))throw new Error('Invalid guided project metadata.');
    const metadata=JSON.parse(await readFile(file,'utf8'));
    if(typeof metadata.course_id!=='string'||!/^[a-z0-9-]{1,100}$/.test(metadata.course_id)||typeof metadata.requirements!=='string'||metadata.requirements.length>6000||typeof metadata.title!=='string'||metadata.title.length>200)throw new Error('Invalid guided project metadata.');
    curriculum.title=metadata.title;curriculum.courseId=metadata.course_id;curriculum.language=metadata.language ?? 'python';
    if (typeof metadata.course_title === 'string' && metadata.course_title.length <= 200) curriculum.courseTitle = metadata.course_title;
    if (!COURSE_LANGUAGES.includes(curriculum.language)) throw new Error('Unsupported guided project language: ' + curriculum.language);
    curriculum.steps[0].goal=metadata.requirements.slice(0,500);
  }
  if (id === 'rich-reading') curriculum.evidenceFiles = JSON.parse(await readFile(join(media, 'projects/rich-source.json'), 'utf8')).evidenceFiles;
  return curriculum;
}

const DEPLOYMENT_FILES=/^(?:Dockerfile(?:\.[A-Za-z0-9_-]+)?|(?:docker-)?compose\.ya?ml|pyproject\.toml|requirements(?:-[a-z]+)?\.txt|package\.json|Makefile|Procfile|Caddyfile|Cargo\.toml|pom\.xml)$/;
export function trackedProjectFiles(curriculum: ProjectCurriculum) { return [...new Set([...curriculum.files, ...curriculum.evidenceFiles ?? []])]; }

export async function projectFiles(root: string, curriculum: ProjectCurriculum) {
  const files = new Set(trackedProjectFiles(curriculum));
  if(curriculum.id==='skilling-project' || curriculum.architecture) {
    const walk=async(folder:string,depth=0):Promise<void>=>{
      if(depth>8)throw new Error('Project source folders are too deeply nested.');
      for(const entry of await readdir(join(root,folder),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
        const path=folder ? folder+'/'+entry.name : entry.name;
        if(entry.isDirectory()&&/^[A-Za-z0-9_-]+$/.test(entry.name)&&!['node_modules','vendor','dist','build','__pycache__'].includes(entry.name))await walk(path,depth+1);
        else if(entry.isFile() && (!curriculum.architecture || entry.name.endsWith('.py')) && publicContextPath(path))files.add(path);
        if(files.size>256)throw new Error('Keep guided project context within 256 public files.');
      }
    };
    if (curriculum.architecture) { await walk(''); return [...files].sort(); }
    await walk('src');await walk('tests');
    // Deployment and build evidence the learner actually wrote: only files that exist, so nothing is reported missing.
    for(const entry of await readdir(root,{withFileTypes:true}))
      if(entry.isFile()&&DEPLOYMENT_FILES.test(entry.name)&&publicContextPath(entry.name))files.add(entry.name);
    for(const entry of await readdir(join(root,'.github','workflows'),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;}))
      if(entry.isFile()&&publicContextPath('.github/workflows/'+entry.name))files.add('.github/workflows/'+entry.name);
    if(files.size>256)throw new Error('Keep guided project context within 256 public files.');
  }
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
export async function isEnabledProject(root: string) {
  const id = await projectIdentity(root);
  return !!id && desktopProjectEnabled(id);
}

export async function publicProjectFile(root: string, path: string) {
  if (isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some(p => p.startsWith('.')))
    throw new Error('Choose a public source file from this project.');
  const file = resolve(root, path), canonicalRoot = await realpath(root);
  const actual = await realpath(file);
  // Reject symlinks even inside the project: a public filename must never alias an env file.
  if (actual !== resolve(canonicalRoot, path) || relative(canonicalRoot, actual).startsWith('..'))
    throw new Error('Linked files cannot be shared with the mentor.');
  if (!(await stat(file)).isFile() || (await stat(file)).size > 512000)
    throw new Error('Project source files must be smaller than 512 KB.');
  return actual;
}

export function personalSource(path: string) {
  return publicContextPath(path) && /\.(py|pyi|php|ts|tsx|js|jsx|java|kt|cs|go|rb|rs|cpp|c|h|swift)$/.test(path)
    && !/(?:^|\/)(?:node_modules|vendor|dist|build|__pycache__|venv)(?:\/|$)/.test(path);
}

async function personalFiles(root:string, focus:string[]) {
  const paths = [...new Set(focus.filter(personalSource))].slice(0, 12);
  if (!paths.length) return [];
  // Inspect only files the learner opened or saved, respecting the repository's ignore rules.
  let candidates = paths;
  try {
    const {stdout} = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths]);
    const allowed = new Set(stdout.split('\0'));
    candidates = paths.filter(path => allowed.has(path));
  } catch (error) {
    if (!String((error as {stderr?:string}).stderr).includes('not a git repository')) return [];
  }
  const safe = await Promise.all(candidates.map(path => publicProjectFile(root,path).then(() => path, () => '')));
  return safe.filter(Boolean).sort();
}

/** Hash every declared source/check/fixture, including omitted context. Code and run output stay temporary. */
export async function projectSnapshot(root: string, curriculum: ProjectCurriculum, focus: string[],
    dirty = new Map<string, string>(), locations: Record<string, number | string> = {}, question = '',
    selection?: ProjectLineSelection, includeGit = false): Promise<ProjectSnapshot> {
  await requireProjectFolder(root);
  const hash = createHash('sha256'), all = new Map<string, string>();
  const commandHash = curriculum.id === 'shelf-reading' ? createHash('sha256') : undefined;
  let total = 0;
  let savedNotes: string | undefined;
  const paths = curriculum.id === 'personal-project' ? await personalFiles(root, focus) : await projectFiles(root, curriculum);
  for (const path of paths) {
    try {
      const file = await publicProjectFile(root, path);
      const text = dirty.get(path) ?? await readFile(file, 'utf8');
      total += Buffer.byteLength(text, 'utf8');
      if (text.length > 512000 || total > 8000000) throw new Error('Project context is too large.');
      if (commandHash && path === 'READING_NOTES.md' && dirty.has(path)) savedNotes = await readFile(file, 'utf8');
      const entry = JSON.stringify([path, text]);
      hash.update(entry); all.set(path, text);
      if (path !== 'READING_NOTES.md') commandHash?.update(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const missing = JSON.stringify([path, null]);
      hash.update(missing);
      if (path !== 'READING_NOTES.md') commandHash?.update(missing);
    }
  }
  let reading: ProjectSnapshot['reading'];
  if (commandHash) {
    const sections = readingSections(all.get('READING_NOTES.md') ?? '');
    reading = {sections, savedSections: savedNotes === undefined ? sections : readingSections(savedNotes),
      sources: stepDigests(curriculum, all, 'READING_NOTES.md'), commandDigest: commandHash.digest('hex')};
  }
  const repository = curriculum.id === 'shelf' || curriculum.gitPractice || includeGit
    ? await projectGit(root, paths, curriculum.id === 'personal-project', !!curriculum.gitPractice) : undefined;
  if (curriculum.gitPractice && repository) hash.update(repository.fingerprint);
  return {digest: hash.digest('hex'), steps: stepDigests(curriculum, all), reading,
    ...selectProjectContext(all, focus, question, locations, selection),
    ...(repository ? {git: repository.context, gitFingerprint: repository.fingerprint, gitRevision: repository.revision} : {})};
}

/** A learner can keep adding to the notebook after saving a milestone checkpoint. */
export function readingSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = Object.create(null);
  let lines: string[] | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{1,2}\s/.test(line)) {
      lines = line.startsWith('## ') ? (sections[line.slice(3).trim()] ??= []) : undefined;
    } else if (lines && line) lines.push(line);
  }
  return sections;
}

/** Each milestone's evidence is its own files: editing a later milestone's file leaves earlier ones complete. */
export function stepDigests(curriculum: ProjectCurriculum, files: ReadonlyMap<string, string>, omit?: string): Record<string, string> {
  return Object.fromEntries(curriculum.steps.map(step => {
    const hash = createHash('sha256').update(JSON.stringify(['step', step.id]));
    for (const path of [...new Set(step.files)].sort()) {
      if (path !== omit) hash.update(JSON.stringify([path, files.get(path) ?? null]));
    }
    return [step.id, hash.digest('hex')];
  }));
}

export function evidenceFingerprint(snapshot: Pick<ProjectSnapshot, 'digest' | 'gitFingerprint'>) {
  return snapshot.gitFingerprint
    ? createHash('sha256').update(JSON.stringify([snapshot.digest, snapshot.gitFingerprint])).digest('hex') : snapshot.digest;
}

/** Checks that judge Git history (the Shelf capstone checker) are also invalidated by branch, commit or status changes. */
export function checkDigest(snapshot: Pick<ProjectSnapshot, 'digest' | 'gitFingerprint' | 'reading'>, step: Pick<ProjectStep, 'check'>) {
  if (snapshot.reading) return snapshot.reading.commandDigest;
  return step.check === 'shelf:capstone' ? evidenceFingerprint(snapshot) : snapshot.digest;
}

/** No remotes, author details, arbitrary diffs or private filenames are sent to Coach. */
async function projectGit(root: string, paths: string[], personal:boolean, exercise:boolean): Promise<{context: ProjectGit; fingerprint: string; revision?: string}> {
  try {
    // A folder inside some other repository must not report that repository's branch or changes.
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(top) !== await realpath(root)) throw new Error('Not the project repository.');
    const [branchName, identity, status, history, refs, index] = await Promise.all([
      git(root, ['symbolic-ref','--quiet','--short','HEAD']).catch(() => ({stdout:'HEAD\n'})),
      git(root, ['rev-parse','--verify','HEAD']).catch(() => ({stdout:''})),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(root, ['log', '-6', '--format=%h %s']).catch(() => ({stdout:''})),
      exercise ? git(root,['for-each-ref','--format=%(refname) %(objectname)','refs/heads/main']) : {stdout:''},
      exercise ? git(root,['ls-files','--stage','-z']) : {stdout:''},
    ]);
    const branch = branchName.stdout.trim(), head = identity.stdout.trim();
    const changed: ProjectGit['changed_files'] = [], entries = status.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const code = entries[i].slice(0, 2), path = entries[i].slice(3);
      if ((paths.includes(path) || personal && !/(?:^|\/)(?:node_modules|vendor|build|dist|__pycache__|venv)\//.test(path)) && publicContextPath(path)) changed.push({path, status: code});
      if (/[RC]/.test(code)) i++; // porcelain -z also includes the original name of a rename/copy.
    }
    const commits = history.stdout.trim().split(/\r?\n/).filter(Boolean);
    let starter:GitProject | undefined;
    if (personal && head) {
      for (const id of Object.keys(gitProjects) as GitProject[]) {
        const plan = JSON.parse(readFileSync(join(__dirname,'../../media/projects',id+'.json'),'utf8')) as ProjectCurriculum;
        if (await git(root,['--no-replace-objects','merge-base','--is-ancestor',plan.gitPractice!.base, head]).then(() => true,() => false)) {
          starter = id; break;
        }
      }
    }
    const fingerprintInputs = [branchName.stdout, identity.stdout, status.stdout];
    if (exercise) fingerprintInputs.push(refs.stdout,index.stdout);
    return {context: {state: 'available', ...(starter ? {practice_starter:starter} : {}), branch: redactSecrets(branch).slice(0, 160), head,
      changed_files: changed.slice(0, 64), recent_commits: commits.map(line => redactSecrets(line).slice(0, 220)),
      truncated: changed.length > 64 || commits.some(line => line.length > 220) || branch.length > 160},
      revision: head ? createHash('sha256').update(branch + '\0' + head).digest('hex') : undefined,
      // Hashed: raw status names private files (.env) and must never travel with the snapshot.
      fingerprint: createHash('sha256').update(JSON.stringify(fingerprintInputs)).digest('hex')};
  } catch {
    return {context: {state: 'unavailable', branch: '', head: '', changed_files: [], recent_commits: [], truncated: false},
      fingerprint: 'git-unavailable'};
  }
}

export function checkArguments(step: Pick<ProjectStep, 'check'>, files?: string[], gitRevision?: string): string[] {
  if (step.check.startsWith('debug:') && isDebugProject(step.check.slice(6))) {
    const id = step.check.slice(6), file = debugProjects[id].file;
    const media = join(__dirname, '../../media/projects');
    return ['-I', '-B', '-c', readFileSync(join(media, 'debug_check.py'), 'utf8'), id,
      readFileSync(join(media, id, file), 'utf8'), JSON.stringify(files ?? [file, 'test_regression.py'])];
  }
  if (step.check.startsWith('architecture:') && architectureCase(step.check.slice('architecture:'.length))) {
    const checker = readFileSync(join(__dirname, '../../media/projects/architecture_check.py'), 'utf8');
    return ['-I', '-B', '-c', checker, step.check.slice('architecture:'.length)];
  }
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
  if (step.check === 'shelf:capstone' || step.check.startsWith('shelf-evidence:')) {
    const id = step.check === 'shelf:capstone' ? 'final' : step.check.slice('shelf-evidence:'.length);
    return ['-I', '-B', '-c', readFileSync(join(__dirname, '../../media/projects/shelf_evidence.py'), 'utf8'), id, shelfStart, ...(gitRevision ? [gitRevision] : [])];
  }
  if (/^rich:(setup|text|markup|table|protocol|test-console|test-markup|test-table)$/.test(step.check))
    return ['-m', 'reading.run', step.check.slice(5)];
  if(step.check==='guided:inspect')return ['-c','from pathlib import Path; print("Inspect actual run and test evidence in the project terminal."); [print(str(p)) for d in ("src","tests") for p in sorted(Path(d).rglob("*")) if p.is_file() and not any(x.startswith(".") or x in ("node_modules","vendor","__pycache__") for x in p.parts)]'];
  if (step.check === 'all') return ['-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-v'];
  if (!/^(checks|tests)\.test_[a-z_]+$/.test(step.check)) throw new Error('Unknown project check.');
  return ['-m', 'unittest', step.check, '-v'];
}

export function projectDebugTarget(step: Pick<ProjectStep, 'check'>, files: string[] = []) {
  // Only the public reproduction or the learner's tests belong in a debugger.
  if (step.check.startsWith('debug:') || step.check.startsWith('architecture:')) {
    if (files.some(file => /^test[\w-]*\.py$/.test(file)))
      return ['-m','unittest','discover','-p','test*.py','-v'];
    const id = step.check.slice('debug:'.length);
    if (step.check.startsWith('debug:') && isDebugProject(id)) return ['-c',debugProjects[id].reproduction];
    return;
  }
  if (!/^(all|shelf:(help|list|search|report)|rich:(text|markup|table|protocol|test-console|test-markup|test-table)|(checks|tests)\.test_[a-z_]+)$/.test(step.check)) return;
  return checkArguments(step);
}

/** What the learner and Coach see; the final checker's inline script is an implementation detail (and too long). */
export function checkCommand(step: Pick<ProjectStep, 'check'>) {
  if (step.check === 'shelf:capstone') return 'python check.py';
  if (step.check.startsWith('shelf-evidence:')) return 'Verify Shelf milestone';
  if (step.check.startsWith('debug:')) return 'Verify repair and regression test';
  if (step.check.startsWith('architecture:')) return 'Verify the public behavior and shared decision';
  return step.check === 'final:agent' ? 'python -m unittest discover -p "test_*.py" (final check: skipped tests do not pass)'
    : ['python', ...checkArguments(step)].join(' ');
}

/** Keep at most the last limit characters without starting on the second half of a UTF-16 surrogate pair. */
export function tailText(text: string, limit: number) {
  const tail = text.slice(-limit);
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

/** timeout(1) and podman exec report 125 (container/exec failure), 126 (not executable) and 127 (not found). */
export function checkStatus(code: number | null, timedOut = false): ProjectRun['status'] {
  if (timedOut || code === 124 || code === 137) return 'timed_out';
  if (code === 125 || code === 126 || code === 127) return 'runtime_error';
  return code === 0 ? 'passed' : 'failed';
}
const containerFailure = 'The project container could not start. Use Runtime → Set up and verify environment, then retry.';

export function checkState(run: ProjectRun | undefined, digest: string, step: string) {
  if (!run || run.step !== step) return {state: 'not_run' as const};
  return {state: run.digest === digest ? 'current' as const : 'changed' as const,
    status: run.status, command: run.command, output: run.output, truncated: run.truncated};
}

/** Execute exclusively in the project container. Missing setup never falls back to host Python. */
// Runs inside the container on cancel: kill the process group of the check carrying this marker (timeout(1) leads it).
// The marker is passed split so this killer's own command line never matches it.
const stopCheck = [
  'import os, signal, sys',
  'marker = ("dhimantai_check=" + sys.argv[1]).encode()',
  'for pid in filter(str.isdigit, os.listdir("/proc")):',
  '    try:',
  '        if marker in open("/proc/%s/cmdline" % pid, "rb").read().split(b"\\0") and int(pid) != os.getpid():',
  '            group = os.getpgid(int(pid))',
  '            os.killpg(group, signal.SIGKILL) if group != os.getpgrp() else os.kill(int(pid), signal.SIGKILL)',
  '    except OSError:',
  '        pass',
].join('\n');

/** Execute exclusively in the project container. Missing setup never falls back to host Python. */
export function runProjectCheck(root: string, step: ProjectStep, digest: string,
    signal: AbortSignal, engine: {bin: string; execArgs(cwd: string, command: string, args: string[]): string[]; path?(local: string): string}, files?: string[], gitRevision?: string): Promise<ProjectRun> {
  if (!engine) return Promise.reject(new Error('Set up the project container before running project checks.'));
  const args = checkArguments(step, files, gitRevision), command = checkCommand(step);
  return new Promise(resolveRun => {
    if (signal.aborted) return resolveRun({digest, step: step.id, status: 'runtime_error', command, output: 'Check cancelled.', truncated: false});
    let projectDir: string | undefined;
    try { projectDir = engine.path?.(root); } catch { /* Diagnostics then accept only project-relative frames. */ }
    const capture = new ProjectCheckOutput(projectDir);
    const marker = randomBytes(8).toString('hex');
    let notice = '', timedOut = false, settled = false;
    // The container owns its deadline too: killing the Podman client alone would leave Python running.
    // -X options are ignored by Python; this one only marks the process so cancellation can find it in the container.
    const child = spawn(engine.bin, engine.execArgs(root, 'timeout', ['--signal=KILL', '28s', 'python', '-X', 'dhimantai_check=' + marker, ...args]),
      {cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    const finish = (status: ProjectRun['status'], practiceEvent?: DebugCheckEvent) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      const captured = capture.finish();
      const output = captured.output + notice;
      resolveRun({digest, step: step.id, status, command, output: tailText(output, 4000),
        truncated: captured.truncated || output.length > 4000, ...(practiceEvent ? {practiceEvent} : {}),
        ...(status === 'failed' && captured.diagnostic ? {diagnostic: captured.diagnostic} : {})});
    };
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true}, () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const cancel = () => {
      stop();
      // Killing the local Podman client does not stop the process inside the container.
      try {
        execFile(engine.bin, engine.execArgs(root, 'python', ['-c', stopCheck, marker]), {timeout: 10000, windowsHide: true}, () => {});
      } catch { /* The container deadline still stops the check. */ }
      notice = '\nCheck cancelled.'; finish('runtime_error');
    };
    const timer = setTimeout(() => { timedOut = true; stop(); notice = '\nCheck exceeded 30 seconds.'; finish('timed_out'); }, 30000);
    signal.addEventListener('abort', cancel, {once: true});
    child.stdout.on('data', (chunk: Buffer) => { if (!settled) capture.append(chunk, 'stdout'); });
    child.stderr.on('data', (chunk: Buffer) => { if (!settled) capture.append(chunk, 'stderr'); });
    child.on('error', () => { notice = containerFailure; finish('runtime_error'); });
    child.on('close', code => {
      const status = checkStatus(code, timedOut);
      if (status === 'runtime_error') notice = '\n' + containerFailure;
      finish(status, step.check.startsWith('debug:') ? debugCheckEvent(code) : undefined);
    });
  });
}
