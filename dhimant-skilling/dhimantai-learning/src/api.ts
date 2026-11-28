import type { ArchitectureAttempts, ArchitectureEvent, ArchitectureTopic, PracticeFollowup } from './architectureMemory';
import type { SkillingPathway, SkillingBrief } from './skilling';
import { randomUUID } from 'node:crypto';
import { Auth } from './auth';
import { Environment } from './environments';
import type { StudyChoice, StudySource } from './studyContent';
import type { NotebookApi, NotebookLink } from './notebookSubmission';
import type { SessionNotebookLink, TransferBody, TransferReceipt } from './sessionNotebookTransfer';
import type { CourseLab } from './colabNotebooks';
import type { RuntimeRelease } from './courseRuntime';
import type {CourseRuntimeResponse} from './courseConfiguration';
import type { ProjectHandoff } from './projectCore';
import type { CourseCertificate, CourseGrade, CourseworkResult, ProjectAssessment } from './courseworkProgress';

export interface HandoffAvailability {
  mode: 'teacher' | 'handoff'; teachers: {id: string; name: string}[];
  history: {thread_id: string; source_hash: string; created_at: string}[];
}
export interface HandoffReceipt {thread: {id: string; status: string; created_at: string; version: number}; source_hash: string}
export interface HandoffDetail {thread: HandoffReceipt['thread']; messages: {author_role: string; author_name: string; body: string}[]; has_more: boolean}

// Shapes mirror agent/course_projects (practice.py definition, domain.py draft/public_submission, code_help.py public_help).

export interface SampleFile {
  name: string;
  content: string;
  description: string;
  expected_output: Record<string, string>;
}

export interface RunConfiguration {
  protocol: number;
  preset: 'word_count' | 'baby_names' | 'sql' | 'pglab' | null;
  arguments: { value: string; description: string }[];
  sample_files: SampleFile[];
  max_files: number;
  max_file_bytes: number;
  max_total_bytes: number;
}

/** A public test case: input and expected answer (hidden cases never reach the editor). */
export interface PublicTest {
  id: string;
  kind: 'stdio' | 'cli' | 'function' | 'sql' | 'lab';
  /** SQL: the dataset, an optional query that inspects the result, and whether row order matters. */
  setup?: string;
  check?: string;
  ordered?: boolean;
  stdin?: string;
  argv?: string[];
  files?: { name: string; content: string }[];
  call?: string;
  expected: string;
}

export type Verdict = 'passed' | 'wrong_answer' | 'runtime_error' | 'timeout' | 'compile_error' | 'not_run';

/** Server check of the saved draft against every case; hidden cases carry only their verdict. */
export interface TestReport {
  assessment_revision?: string | null;
  suite_version: number;
  passed: number;
  total: number;
  all_passed: boolean;
  public: { passed: number; total: number };
  cases: { id: string; visibility: 'public' | 'hidden'; verdict: Verdict; label: string; input?: unknown; expected?: string; actual?: string; stderr?: string;
    /** Failed hidden cases: the kind of case only, never its input or answer. */
    category?: FailureCategory }[];
}

export type FailureCategory = 'edge case' | 'empty input' | 'large input' | 'off-by-one' | 'type' | 'other';

/** Every case of an exercise, for grading in the learner's course container. Kept in memory only, never saved. */
export interface GradingSuite {
  assessment_revision?: string | null;
  suite_version: number;
  question_id: string;
  tests: (PublicTest & { visibility: 'public' | 'hidden'; category: FailureCategory })[];
}

export interface PracticeProject {
  programming_environment?: 'external';
  id: string;
  question_id: string;
  title: string;
  subject?: string;
  brief: string;
  starter_code?: string | null;
  languages: string[];
  run_configuration: RunConfiguration;
  contract: string;
  workspace_kind?: string;
  code_assistance_allowed: boolean;
  /** Pilot arm: false gives the earlier help behaviour (agent/course_projects/help_ladder.py). */
  learning_gates?: boolean;
  public_examples?: PublicTest[];
  tests?: { suite_version: number; public: PublicTest[]; hidden_count: number } | null;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown';
  source: string;
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: null;
}

export interface DraftPayload {
  question_id?: string;
  language: string;
  notebook: { nbformat: 4; nbformat_minor?: number; metadata?: unknown; cells: NotebookCell[] };
  notes: string;
  help_used: string;
  milestones: number[];
  stdin?: string;
  argv?: string[];
  files?: { name: string; content: string }[];
}

export interface Draft {
  version: number;
  payload: DraftPayload;
}

export interface Execution {
  runtime_target?: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  command: string;
  duration_seconds: number;
  truncated: boolean;
  interactive_input?: boolean;
}

export interface Submission {
  id: string;
  kind: 'run' | 'evaluate' | 'check';
  status: 'queued' | 'running' | 'assessed' | 'failed';
  draft_version: number;
  created_at: string;
  automated?: { execution?: Execution; tests?: TestReport; scope?: string } | null;
  error?: string | null;
}

export interface Runtime {
  ready_languages?: string[];
  status: 'ready' | 'offline' | 'not_configured' | 'unknown' | 'external';
  message?: string;
}

export interface Workspace {
  project: PracticeProject;
  draft: Draft;
  submissions: Submission[];
  source_changed: boolean;
  coding_help_received: boolean;
  runtime: Runtime;
}

export type HelpMode = 'hint' | 'statement' | 'block';

export interface Assistance {
  id: string;
  request_id: string;
  mode: HelpMode;
  draft_version: number;
  status: 'generating' | 'ready' | 'failed';
  response?: { hint: string; code: string; explanation: string; check_question: string } | null;
  received_at?: string | null;
  applied_at?: string | null;
  error?: string | null;
  target: { cell_index: number; selected_code: string; selection_start: number; selection_end: number };
}

export interface CoachTurn {
  id?: string;
  say: string;
  question: string;
  strategy: string;
  line: number | null;
  replies: string[];
  /** model/fallback: the server coach; agent: the coach agent on this computer (through the gateway). */
  source: 'model' | 'fallback' | 'agent';
}

export interface CoachRuntimeRelease {
  version: string;
  platform: string;
  url: string;
  sha256: string;
  size: number;
  root: string;
  entry: string;
}

/** expired: the course access period ended, so every chapter is locked until the learner buys again. */
export interface LabCompute {version:1;status:'specified'|'unspecified';nodes?:number;gpusPerNode?:number;totalGpus?:number;optionalGpus?:number;note:string;layouts?:{nodes:number;gpusPerNode:number}[]}
export interface Chapter { id: string; name: string; lesson?: string; locked?: boolean; expired?: boolean; progress?: import('./courseProgress').ChapterCoverage; compute?:LabCompute }
export interface Course { name: string; chapters: Chapter[]; project_coach?: {course_id: string | null} | null }
export interface Language { id: string; name: string }
export type QuestionPool = 'textbook' | 'institution';
export interface PracticeQuestion { id: string; title: string; topic?: string; language: string; difficulty?: string; kind?: 'written' }

export interface WrittenPractice { id: string; title: string; question: string; course: string; kind: 'written'; assessment: 'feedback_only'; preparation: 'recommended' }
export interface GeneratedExercise {
  exercise: { title: string; task: string; example_input: string; expected_output: string };
  course: string; chapter: string; language: string; kernel: string; difficulty: string;
  validation?: 'reference_execution';
  tests?: PublicTest[];
}

export interface LearningPurchases {
  payments_ready: boolean;
  refresh_incomplete?: boolean;
  more_pending?: boolean;
  purchases: { id: string; title: string; amount: number; currency: string; course_ids: string[];
    status: 'creating' | 'created' | 'paid' | 'refunded'; created_at: string; offer_id: string;
    can_resume?: boolean; attempt_state?: 'failed' | 'processing' | null;
    paid_at?:string|null; razorpay_payment_id?:string|null }[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export const ACCESS_ENDED = 'Access ended · Buy again in the Course Catalog to continue.';

/** Older project services use one refusal for both missing and expired enrollment. */
export function accessErrorMessage(status: number, path: string, message: string, code?: string): string | undefined {
  const project = /^\/(?:course-project-handoffs|notebook-coach\/project)(?:[/?]|$)/.test(path);
  if (project && (status === 402 || status === 403 && code === 'payment_required'))
    return 'Open the Course Catalog to check which courses your account can access.';
  if (status === 402 || (status === 403 && /^(?:access_(?:ended|expired)|course_access_expired|payment_required)$/.test(code ?? ''))) return ACCESS_ENDED;
  if (status !== 403) return;
  if (/^Your (?:access to this course ended|course access has ended)\b/i.test(message)) return ACCESS_ENDED;
  if (project && /^(?:Join an available Python course|Project help needs active Python course access)/.test(message))
    return 'Open the Course Catalog and check that your learning account has an active Python course with an accessible chapter.';
}

export class Api {
  constructor(private readonly auth: Auth, private readonly env: () => Environment, private readonly expectedAccount?: string) {}

  /** Desktop studio shares the web instructor's assignment, saved-job and atomic publication APIs. */
  courseAuthoring<T>(path = '', body?: unknown) {
    if (path && !/^\/(?:courses|updates)\/[a-zA-Z0-9_-]+(?:\/(?:updates|apply|retry-index))?$/.test(path))
      throw new Error('Invalid course authoring action.');
    return this.request<T>(body === undefined ? 'GET' : 'POST', '/instructor/course-authoring' + path, body);
  }

  /** Practical-course authoring: interview questions, then a draft validated against the discovered forms. */
  appAuthoring<T>(body: {stage: 'interview' | 'draft'; goal: string; forms: unknown[]; answers?: {question: string; answer: string}[];
      revise?: {course: unknown; problems: string[]}}) {
    return this.request<T>('POST', '/instructor/app-authoring', body, false, undefined, 330_000);
  }

  guidedErpForms(signal?: AbortSignal) {
    return this.request<{id:string; title:string; version:string; lessons:import('./browserLearning').BrowserTask[]}>(
      'GET', '/learning/guided-forms/erpnext-essentials', undefined, false, signal);
  }

  transferNotebook(link: SessionNotebookLink, body: TransferBody) {
    const base = `/${link.workspace === 'doubt_practice' ? 'doubt-practice' : 'practice-code'}/${encodeURIComponent(link.exercise_id)}`;
    return this.request<{ receipt: TransferReceipt }>('POST', `${base}/transfer/${encodeURIComponent(link.transfer_id)}/send`,
      body, false, AbortSignal.timeout(20_000));
  }

  notebook(link: NotebookLink): NotebookApi {
    const base = `/${link.workspace === 'doubt_practice' ? 'doubt-practice' : 'practice-code'}/${encodeURIComponent(link.exercise_id)}`;
    return {
      workspace: () => this.request<Workspace>('GET', base),
      save: (expected_version, payload) => this.request<{ draft: Draft }>('POST', `${base}/save`, { ...payload, expected_version }),
      check: (expected_version, request_id) => this.request<{ submission: Submission }>('POST', `${base}/submit`, { kind: 'check', expected_version, request_id }),
    };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, retried = false, signal?: AbortSignal, timeout = 75_000): Promise<T> {
    const readinessEvidence=/^\/skilling\/courses\/[a-z0-9-]+\/submissions$/.test(path)||/^\/skilling\/weekly\/[0-9a-f-]+\/submit$/.test(path);
    if (!readinessEvidence && (path.startsWith('/tutor-code/') || /\/(save|submit|editor|learning-events|transfer|submissions)(\/|$)/.test(path)
        || /\/assist\//.test(path))) {
      throw new ApiError(410, 'Write and save in VS Code; run code in the course container. Server storage and notebook transfer are retired.', 'external_programming_required');
    }
    const token = await this.auth.accessToken(retried);
    if (this.expectedAccount) {
      const session = await this.auth.session();
      if (session?.user.id !== this.expectedAccount || session.access_token !== token) {
        throw new ApiError(401, 'Your account changed. Sign in with the account that exported this workspace. No code was sent.');
      }
    }
    let response: Response;
    try {
      signal?.throwIfAborted();
      response = await fetch(this.env().apiUrl + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new ApiError(0, 'Could not reach dhimantAI. Check your connection and try again.');
    }
    if (response.status === 401 && !retried) return this.request(method, path, body, true, signal, timeout);
    const text = await response.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!response.ok) {
      const message = typeof data.error === 'string' && data.error ? data.error : `Request failed (${response.status}).`;
      const access = accessErrorMessage(response.status, path, message, data.code);
      throw new ApiError(response.status, access ?? message, data.code ?? (access === ACCESS_ENDED ? 'access_ended' : access ? 'course_access_required' : undefined));
    }
    return data as T;
  }

  practiceCatalog(signal?: AbortSignal) {
    return this.request<{ courses: Course[]; languages: Language[]; question_pools?: QuestionPool[] }>('GET', '/notebook-coach/exercises', undefined, false, signal);
  }

  architecturePractice(course?: string) {
    return this.request<PracticeFollowup>('GET', '/notebook-coach/project/architecture-memory/practice'
      + (course ? '?course=' + encodeURIComponent(course) : ''));
  }

  architectureMemory(project: string, event: ArchitectureEvent, course?: string) {
    const query = course ? '?course=' + encodeURIComponent(course) : '';
    return this.request<{attempts:ArchitectureAttempts; event:string}>('POST', '/notebook-coach/project/architecture-memory' + query, {project, ...event});
  }

  projectHandoffAvailability() {
    return this.request<HandoffAvailability>('GET', '/course-project-handoffs');
  }
  sendProjectHandoff(request_id: string, snapshot: ProjectHandoff) {
    return this.request<HandoffReceipt>('POST', '/course-project-handoffs', {request_id, snapshot});
  }
  projectHandoffDetail(id: string, page = 0) {
    return this.request<HandoffDetail>('GET', '/course-project-handoffs/' + encodeURIComponent(id) + '?page=' + page);
  }
  projectModel(run_id: string, messages: unknown[], signal: AbortSignal) {
    return this.request<{action: object; mode: 'managed_live'}>('POST', '/course-project-handoffs/model', {run_id, messages}, false, signal);
  }

  studyChapter(id: string, signal: AbortSignal) {
    return this.request<StudySource>('GET', '/notebook-coach/study/' + encodeURIComponent(id), undefined, false, signal);
  }

  studyCatalog() {
    return this.request<{courses: StudyChoice[]}>('GET', '/notebook-coach/study');
  }

  courseGrade(course: string) {
    return this.request<{gradebook: CourseGrade; certificate: CourseCertificate | null}>('GET', '/coursework/courses/' + encodeURIComponent(course));
  }
  courseCertificates() { return this.request<{certificates: CourseCertificate[]}>('GET', '/course-projects/certificates'); }
  claimCourseCertificate(course: string) {
    return this.request<{certificate: CourseCertificate}>('POST', '/coursework/courses/' + encodeURIComponent(course) + '/certificate', {});
  }
  async courseworkResult(kind: 'exercise' | 'project', id: string, result: CourseworkResult) {
    const receipt = await this.request<{recorded: boolean; score: number}>('POST', '/coursework/' + (kind === 'exercise' ? 'exercises/' : 'projects/') + encodeURIComponent(id) + '/result', result);
    if (receipt?.recorded !== true) throw new Error('The gradebook did not confirm this result. Retry sync.');
    return receipt;
  }
  projectAssessment(id: string) {
    return this.request<{assessment: ProjectAssessment}>('GET', '/coursework/projects/' + encodeURIComponent(id));
  }

  skillingPathway(course:string) { return this.request<SkillingPathway>('GET','/skilling/courses/'+encodeURIComponent(course)); }
  skillingBrief(course:string,kind:string,requirements:string) { return this.request<SkillingBrief>('POST','/skilling/courses/'+encodeURIComponent(course)+'/brief',{kind,requirements}); }
  submitSkilling(course:string,value:object) { return this.request('POST','/skilling/courses/'+encodeURIComponent(course)+'/submissions',value); }
  startSkillingWeekly(course:string) { return this.request('POST','/skilling/courses/'+encodeURIComponent(course)+'/weekly',{}); }
  submitSkillingWeekly(id:string,answers:Record<string,string>,assistance:string) { return this.request('POST','/skilling/weekly/'+encodeURIComponent(id)+'/submit',{answers,assistance}); }
  skillingReviewQueue(offset=0) { return this.request<{submissions:{id:string;course_id:string;kind:string;title:string;learner:string;latest_review:string|null}[]}>('GET','/skilling/reviews?offset='+offset); }
  skillingReview(id:string) { return this.request<import('./skillingReview').ReviewDetail>('GET','/skilling/reviews/'+encodeURIComponent(id)); }
  saveSkillingReview(id:string,value:object) { return this.request('POST','/skilling/reviews/'+encodeURIComponent(id),value); }

  learningPurchases(refresh = false, openedPurchase?: string) {
    const query = refresh ? '?refresh=true' + (openedPurchase ? '&purchase=' + encodeURIComponent(openedPurchase) : '') : '';
    return this.request<LearningPurchases>('GET', '/learning-billing/purchases' + query);
  }

  courseLabs(course: string) {
    return this.request<{labs: CourseLab[]}>('GET', '/notebook-coach/labs?course=' + encodeURIComponent(course));
  }

  courseRuntime(course: string) {
    return this.request<CourseRuntimeResponse>('GET', '/notebook-coach/runtime?course=' + encodeURIComponent(course));
  }

  purchaseLearningOffer(offer_id: string) {
    return this.request<{order_id: string; checkout_url: string}>('POST', '/learning-billing/orders', {offer_id});
  }

  resumeLearningPurchase(id: string) {
    return this.request<{order_id: string; checkout_url: string}>('POST', '/learning-billing/orders/' + encodeURIComponent(id) + '/resume');
  }

  practiceQuestions(chapter: string, pool: QuestionPool) {
    return this.request<{ questions: PracticeQuestion[] }>('GET', `/notebook-coach/exercises/${encodeURIComponent(chapter)}/questions?pool=${pool}`);
  }

  writtenPractice(id: string) {
    return this.request<WrittenPractice>('GET', `/notebook-coach/written/${encodeURIComponent(id)}`);
  }

  writtenFeedback(id: string, body: {mode: 'hint' | 'review'; answer: string; message: string; assistance: string;
      help_level?: number; ladder_token?: string; attachments?: {name: string; type: string; data: string}[]}, signal: AbortSignal) {
    return this.request<{feedback: string; next_step: string; assessment: 'feedback_only'; assistance: string;
      help_level?: number; ladder_token?: string | null}>(
      'POST', `/notebook-coach/written/${encodeURIComponent(id)}`, body, false, signal);
  }

  generateExercise(chapter_id: string, language: string, difficulty: string, focus: string) {
    return this.request<GeneratedExercise>('POST', '/notebook-coach/exercises', {chapter_id, language, difficulty, focus});
  }

  learningRoom(mode: 'tutor' | 'doubt_solver' | 'study') {
    return this.request<{url: string; token: string}>('POST', '/vscode-learning/session', {mode});
  }

  dictate(pcm: string, language: string | undefined, signal: AbortSignal) {
    return this.request<{text: string}>('POST', '/notebook-coach/dictation', {pcm, language}, false, signal, 35000);
  }

  audioGrant(path: string, text: string, query = '') {
    return this.request<{url: string; token: string}>('POST', path + '/audio' + query, {text});
  }

  startAudio(path: string, text: string, ticket: string, speed = 1, query = '') {
    return this.request<{accepted: boolean}>('POST', path + '/audio' + query, {text, ticket, speed});
  }

  /** Line-level help: the server needs the learner's explanation and a token proving a hint came first. */
  nextLine(path: string, body: {question: string; language: string; source: string; line: number; explanation: string; ladder_token?: string}) {
    return this.request<{code: string; hint: string; explanation: string; ladder_token?: string | null}>('POST', path + '/next-line', body);
  }

  studioEntry(lesson:import('./studioTypes').LessonId, mode:import('./studioTypes').StudioMode, attempt?:string) {
    return this.request<import('./studioTypes').StudioAccess>('POST','/notebook-coach/project/equipment-desk/entry',{lesson,mode,attempt});
  }
  studioTurn(turn:object) {
    return this.request<import('./studioTypes').StudioReply>('POST','/notebook-coach/project',{...turn,project_id:'equipment-desk'});
  }

  notebookCoach(path: string, body: object, signal?: AbortSignal) {
    return this.request<{ guidance: string; prompt: string; line: number | null; choices?: string[]; replies?: string[]; strategy?: string;
      architecture_topic?: ArchitectureTopic; published_comparison?: { call: string; expected: string; matches: boolean }; ladder_token?: string | null; help_level?: number;
      /** Set when the next rung was requested without a new attempt, so the level stayed the same. */
      ladder_note?: string }>('POST', path, body, false, signal);
  }

  /** Fetch an authenticated, short-lived copy of the learner's Tutor editor. */
  tutorHandoff(id: string) {
    return this.request<{ handoff: unknown }>('GET', `/tutor-code/vscode/${encodeURIComponent(id)}`, undefined, false, AbortSignal.timeout(15_000));
  }

  tutorOpened(id: string) {
    return this.request<{ opened: boolean }>('POST', `/tutor-code/vscode/${encodeURIComponent(id)}/opened`, {}, false, AbortSignal.timeout(15_000));
  }

  /** Which coach runtime this computer should use, from the dhimantAI database. */
  coachRuntime(platform: string) {
    return this.request<{ release: CoachRuntimeRelease | null; assignment?: 'agent' | 'server' }>('GET', `/coach-runtime?platform=${encodeURIComponent(platform)}`);
  }

  private base(questionId: string) {
    return `/practice-code/${encodeURIComponent(questionId)}`;
  }

  workspace(questionId: string) {
    return this.request<Workspace>('GET', this.base(questionId));
  }

  save(questionId: string, expectedVersion: number, payload: DraftPayload) {
    return this.request<{ draft: Draft }>('POST', `${this.base(questionId)}/save`, { ...payload, expected_version: expectedVersion });
  }

  run(questionId: string, expectedVersion: number, requestId = randomUUID()) {
    return this.request<{ submission: Submission }>('POST', `${this.base(questionId)}/submit`, { kind: 'run', expected_version: expectedVersion, request_id: requestId });
  }

  /** The full test suite for local grading; only for a learner who can open the exercise now. */
  gradingSuite(questionId: string) {
    return this.request<GradingSuite>('GET', `${this.base(questionId)}/grading-suite`);
  }

  /** Queue a server check of the saved draft against all test cases (public and hidden). */
  check(questionId: string, expectedVersion: number, requestId = randomUUID()) {
    return this.request<{ submission: Submission }>('POST', `${this.base(questionId)}/submit`, { kind: 'check', expected_version: expectedVersion, request_id: requestId });
  }

  assist(questionId: string, body: {
    work?: DraftPayload; expected_version: number; mode: HelpMode; cell_index: number; selection_start: number; selection_end: number;
    local_run?: { status: string; exit_code: number | null; command: string; stdout: string; stderr: string; truncated: boolean };
    /** The learner's own account of the problem; required by the server for line and block help. */
    explanation: string;
    /** Signed proof of the help already given for this exercise; the server refuses skipped levels. */
    ladder_token?: string;
  }, requestId = randomUUID()) {
    return this.request<{ assistance: Assistance; ladder_token?: string | null }>('POST', `${this.base(questionId)}/assist`, { ...body, request_id: requestId });
  }

  /** Tells the web app this exercise is open in VS Code ("open", then "heartbeat" each minute, "close"). */
  editor(questionId: string, event: 'open' | 'heartbeat' | 'close', clientVersion: string, signal = AbortSignal.timeout(8_000)) {
    return this.request<{ editor: unknown }>('POST', `${this.base(questionId)}/editor`, { client: 'vscode', client_version: clientVersion.slice(0, 40), platform: process.platform, event }, false, signal);
  }

  /** Learning-loop evidence (reported by this device); duplicates by id are ignored by the server. */
  learningEvents(questionId: string, events: unknown[]) {
    return this.request<{ accepted: string[]; rejected?: { id: string; reason: string }[] }>('POST', `${this.base(questionId)}/learning-events`, { events });
  }

  assistEvent(questionId: string, assistanceId: string, event: 'received' | 'apply') {
    return this.request<{ assistance?: Assistance; draft?: Draft }>('POST', `${this.base(questionId)}/assist/${encodeURIComponent(assistanceId)}`, { event });
  }
}
