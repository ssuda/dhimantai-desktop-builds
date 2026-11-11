import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ProjectCurriculum, ProjectCheckpoint, ProjectRun, loadProjectCurriculum, projectSnapshot, runProjectCheck } from './projectCore';

export interface SubmissionGit {
  available: boolean; head: string; branch: string; dirty: boolean; subject: string;
}
export interface ProjectSubmission {
  id: string; at: string; digest: string; curriculumVersion: number;
  outcome: 'completed' | 'needs_work'; runs: ProjectRun[]; git: SubmissionGit;
  assistance: {coachTurns: number; otherHelp: ProjectCheckpoint['externalHelp']};
  note: string; evidence: 'local_checks' | 'reading_checks_and_self_report';
}
export interface SavedProject {
  root: string; projectId: string; title: string; updatedAt: string; submissions: ProjectSubmission[];
}
export type ProjectSummary = SavedProject & {status: string};
interface State { keys(): readonly string[]; get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }

/** Only canonical GitHub URLs survive; credentials and arbitrary remote addresses are never stored. */
export function githubRepository(remote: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  return match && !['.', '..'].includes(match[1]) && !['.', '..'].includes(match[2])
    ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

/** GitHub's compare page addresses a branch by path; keep '/' separators and encode each segment. */
export function githubCompareUrl(repository: string, branch: string) {
  return `${repository}/compare/${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`;
}

/** The branch's configured upstream (set by publishing or push -u), without contacting the remote. */
export async function branchUpstream(root: string, branch: string): Promise<{remote: string; branch: string} | undefined> {
  const config = (key: string) => promisify(execFile)('git', ['--no-optional-locks', 'config', '--get', `branch.${branch}.${key}`],
    {cwd: root, timeout: 5000, windowsHide: true}).then(result => result.stdout.trim(), () => '');
  const [remote, merge] = await Promise.all([config('remote'), config('merge')]);
  return remote && remote !== '.' && merge.startsWith('refs/heads/') ? {remote, branch: merge.slice('refs/heads/'.length)} : undefined;
}

export async function submissionGit(root: string): Promise<SubmissionGit> {
  const git = (args: string[]) => promisify(execFile)('git', ['--no-optional-locks', ...args],
    {cwd: root, timeout: 5000, maxBuffer: 256000, windowsHide: true});
  try {
    const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(top) !== await realpath(root)) throw new Error('Not the project repository');
    const [head, branch, status, subject] = await Promise.all([
      git(['rev-parse', '--verify', 'HEAD']), git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ({stdout: ''})),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), git(['log', '-1', '--format=%s']),
    ]);
    return {available: true, head: head.stdout.trim(), branch: branch.stdout.trim(), dirty: !!status.stdout,
      subject: subject.stdout.trim().slice(0, 240)};
  } catch { return {available: false, head: '', branch: '', dirty: false, subject: ''}; }
}

export function projectResultStatus(record: SavedProject, digest?: string, available = true): string {
  if (!available) return 'Project folder unavailable';
  const last = record.submissions.at(-1);
  if (!last) return 'In progress';
  if (digest && digest !== last.digest) return 'Changed since submission · submit again';
  if (last.outcome === 'needs_work') return 'Needs work · final check did not pass';
  return last.evidence === 'reading_checks_and_self_report'
    ? 'Completed locally · reading self-report' : 'Completed locally · final checks passed';
}

/** One key per project avoids overwriting other projects when several VS Code windows are open. */
export class ProjectResults {
  constructor(private readonly state: State, private readonly changed: () => void = () => {}) {}
  private prefix(environment: string, account: string) { return `projectResults:v1:${environment}:${account}:`; }
  private key(environment: string, account: string, root: string) {
    return this.prefix(environment, account) + createHash('sha256').update(root).digest('hex');
  }
  list(environment: string, account: string): SavedProject[] {
    return this.state.keys().filter(key => key.startsWith(this.prefix(environment, account)))
      .map(key => this.state.get<SavedProject>(key)!).filter(record => record?.root && Array.isArray(record.submissions))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(environment: string, account: string, root: string) { return this.state.get<SavedProject>(this.key(environment, account, root)); }
  /** Forget a saved project (for example a deleted folder). Files on disk are never touched. */
  async remove(environment: string, account: string, root: string) {
    await this.state.update(this.key(environment, account, root), undefined); this.changed();
  }
  async save(environment: string, account: string, root: string, curriculum: ProjectCurriculum, submission?: ProjectSubmission) {
    const saved = this.get(environment, account, root);
    const previous = saved?.projectId === curriculum.id ? saved : undefined;
    const record: SavedProject = {root, projectId: curriculum.id, title: curriculum.title, updatedAt: new Date().toISOString(),
      submissions: [...previous?.submissions ?? [], ...submission ? [submission] : []].slice(-20)};
    await this.state.update(this.key(environment, account, root), record); this.changed();
    return record;
  }
  async summaries(media: string, environment: string, account: string): Promise<ProjectSummary[]> {
    return Promise.all(this.list(environment, account).map(async record => {
      try {
        if (!(await stat(record.root)).isDirectory()) throw new Error('Project folder unavailable');
        const curriculum = await loadProjectCurriculum(media, record.projectId, record.root);
        const snapshot = await projectSnapshot(record.root, curriculum, [], new Map());
        return {...record, status: projectResultStatus(record, snapshot.digest)};
      } catch { return {...record, status: projectResultStatus(record, undefined, false)}; }
    }));
  }
}

/** All authored reading commands; build projects use their full final checker, never the selected small check. */
export function finalProjectSteps(curriculum: ProjectCurriculum) {
  if (curriculum.mode === 'reading') return curriculum.steps.filter((step, index, all) => all.findIndex(s => s.check === step.check) === index);
  const final = curriculum.steps.at(-1);
  if (!final || !['all', 'final:agent', 'shelf:capstone'].includes(final.check)) throw new Error('This project has no final checker.');
  return [{...final, check: final.check === 'all' ? 'final:agent' : final.check}];
}

export async function submitProject(root: string, curriculum: ProjectCurriculum,
    assistance: ProjectSubmission['assistance'], note: string, signal: AbortSignal,
    engine: Parameters<typeof runProjectCheck>[4],
    runCheck: typeof runProjectCheck = runProjectCheck): Promise<ProjectSubmission> {
  if (curriculum.mode === 'reading' && !note.trim()) throw new Error('Add your reading evidence in the checkpoint note before submitting.');
  const snapshot = await projectSnapshot(root, curriculum, [], new Map()), git = await submissionGit(root);
  const runs: ProjectRun[] = [];
  for (const step of finalProjectSteps(curriculum)) {
    if (signal.aborted) throw new Error('Submission cancelled. No completion recorded.');
    const run = await runCheck(root, step, snapshot.digest, signal, engine);
    runs.push(run);
    if (run.status !== 'passed') break;
  }
  const after = await projectSnapshot(root, curriculum, [], new Map()), afterGit = await submissionGit(root);
  if (signal.aborted || after.digest !== snapshot.digest || JSON.stringify(afterGit) !== JSON.stringify(git))
    throw new Error('Project files or Git state changed during submission. Submit the saved version again.');
  return {id: randomUUID(), at: new Date().toISOString(), digest: snapshot.digest, curriculumVersion: curriculum.version,
    outcome: runs.length > 0 && runs.every(run => run.status === 'passed') ? 'completed' : 'needs_work', runs, git,
    assistance, note: note.slice(0, 1000), evidence: curriculum.mode === 'reading' ? 'reading_checks_and_self_report' : 'local_checks'};
}
