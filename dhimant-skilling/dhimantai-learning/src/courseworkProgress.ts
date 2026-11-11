import type { TestReport } from './api';
import type { ProjectSubmission } from './projectResults';

export type CourseworkHelp = 'none_reported' | 'reported' | 'unknown';
export interface CourseworkResult {
  request_id: string; revision: string; source_hash: string; help: CourseworkHelp;
  cases: {id: string; verdict: string}[];
}
export interface ProjectAssessment {kind: 'project'; id: string; version: number; revision: string; gradable: boolean; steps: string[]}
export interface CourseCertificate {
  id: string; course_id: string; course_title: string; recipient_name: string; grade: string; score: number;
  issued_at: string; revoked_at: string | null; policy_version: string;
}
export interface CourseGrade {
  readiness?: import('./skilling').Readiness;
  coursework_ready?: boolean;
  certificate_id?: string;
  course_id: string; course_title: string; score: number | null; grade: string | null; eligible: boolean;
  passed_count: number; required_count: number; exercise_score: number | null; project_score: number | null;
  policy: {description: string; scope: string}; blockers: string[];
  topics: {topic: string; score: number; independent: number; required_independent: number; ready: boolean}[];
  requirements: {kind: 'exercise' | 'project'; id: string; title: string; score: number | null; passed: boolean; gradable: boolean}[];
}

/** No source, paths, commands, output or hidden inputs cross this boundary. */
export function exerciseResult(report: TestReport, requestId: string, sourceHash: string, help: CourseworkHelp): CourseworkResult | undefined {
  if (!report.assessment_revision) return;
  return {request_id: requestId, revision: report.assessment_revision, source_hash: sourceHash, help,
    cases: report.cases.map(c => ({id: c.id, verdict: c.verdict}))};
}
export function projectResult(submission: ProjectSubmission, assessment: ProjectAssessment): CourseworkResult | undefined {
  if (!assessment.gradable) return;
  if (assessment.version !== submission.curriculumVersion
      || assessment.steps.length !== submission.runs.length || assessment.steps.some(id => !submission.runs.some(r => r.step === id)))
    throw new Error('Project requirements changed. Update the course project before recording its grade.');
  return {request_id: submission.id, revision: assessment.revision, source_hash: submission.digest,
    help: submission.assistance.coachTurns > 0 ? 'reported' : submission.assistance.otherHelp,
    cases: submission.runs.map(r => ({id: r.step, verdict: r.status === 'passed' ? 'passed' : r.status === 'timed_out' ? 'timeout' : 'wrong_answer'}))};
}

interface State {keys(): readonly string[]; get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void>}
export interface PendingCoursework {kind: 'exercise' | 'project'; id: string; result: CourseworkResult}
/** Durable per-attempt keys prevent concurrent windows overwriting each other's pending result. No background retry loop. */
export class CourseworkOutbox {
  constructor(private readonly state: State) {}
  private prefix(environment: string, account: string) { return `courseworkPending:v1:${environment}:${account}:`; }
  pending(environment: string, account: string) {
    return this.state.keys().filter(k => k.startsWith(this.prefix(environment, account)))
      .map(k => this.state.get<PendingCoursework>(k)!).filter(Boolean);
  }
  async send(environment: string, account: string, value: PendingCoursework, post: (value: PendingCoursework) => Promise<unknown>) {
    const key = this.prefix(environment, account) + value.result.request_id;
    await this.state.update(key, value);
    await post(value);
    await this.state.update(key, undefined);
  }
  async retry(environment: string, account: string, post: (value: PendingCoursework) => Promise<unknown>) {
    const errors: string[] = [];
    for (const value of this.pending(environment, account).slice(0, 20)) {
      try { await this.send(environment, account, value, post); }
      catch (error) { errors.push(error instanceof Error ? error.message : 'Result could not be synced.'); }
    }
    if (errors.length) throw new Error(`${errors.length} result(s) remain pending. ${errors[0]}`);
  }
}
