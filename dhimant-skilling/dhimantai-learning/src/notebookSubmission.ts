import { createHash } from 'node:crypto';
import type { Draft, DraftPayload, FailureCategory, GradingSuite, NotebookCell, PublicTest, Submission, TestReport, Workspace } from './api';
import type { LocalTestResult } from './localRunner';
import { ENVIRONMENTS, EnvironmentName } from './environments';

export interface NotebookLink {
  protocol: 1;
  exercise_id: string;
  export_id: string;
  account_id: string;
  environment: EnvironmentName;
  workspace: 'practice' | 'doubt_practice';
  draft_version: number;
  language: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const languages = ['python', 'rust', 'c', 'java', 'javascript', 'typescript', 'go'];

export function notebookLink(metadata: any): NotebookLink {
  const link = metadata?.dhimantai;
  if (!link || link.protocol !== 1 || !uuid.test(link.exercise_id) || !uuid.test(link.export_id)
      || typeof link.account_id !== 'string' || !link.account_id || link.account_id.length > 100
      || !Object.hasOwn(ENVIRONMENTS, link.environment) || !['practice', 'doubt_practice'].includes(link.workspace)
      || !Number.isSafeInteger(link.draft_version) || link.draft_version < 0 || !languages.includes(link.language)) {
    throw new Error('This notebook has no valid DhimantAI question link. Export it again from the question in the updated app, then bring your code into that notebook.');
  }
  // Whitelist fields: a notebook cannot supply an API URL or credentials.
  return { protocol: 1, exercise_id: link.exercise_id, export_id: link.export_id, account_id: link.account_id,
    environment: link.environment, workspace: link.workspace, draft_version: link.draft_version, language: link.language };
}

export function submissionCells(cells: { cell_type: string; source: string; language?: string }[], language: string): NotebookCell[] {
  if (!cells.length || cells.length > 60 || !cells.some(c => c.cell_type === 'code' && c.source.trim())) {
    throw new Error('Use 1–60 cells, including a code cell with your solution.');
  }
  if (cells.some(c => !['code', 'markdown'].includes(c.cell_type) || typeof c.source !== 'string' || c.source.includes('\0'))) {
    throw new Error('Only code and markdown cells with valid source are supported.');
  }
  if (cells.some(c => c.cell_type === 'code' && c.language && c.language !== language)) {
    throw new Error(`Keep all code cells in ${language}, the language of this question.`);
  }
  if (cells.reduce((n, c) => n + Buffer.byteLength(c.source), 0) > 20_000) throw new Error('Keep a Practice answer below 20 KB of source.');
  return cells.map(c => ({ cell_type: c.cell_type as NotebookCell['cell_type'], source: c.source, metadata: {},
    ...(c.cell_type === 'code' ? { outputs: [], execution_count: null } : {}) }));
}

// Hash only server-persisted learner fields, with stable ordering. Imported outputs,
// kernel metadata and client-supplied question text are never execution evidence.
export function payloadDigest(payload: DraftPayload): string {
  return createHash('sha256').update(JSON.stringify([
    payload.language, payload.notebook.cells.map(c => [c.cell_type, c.source]), payload.notes,
    payload.help_used, payload.milestones, payload.stdin ?? '', payload.argv ?? [],
    (payload.files ?? []).map(f => [f.name, f.content]),
  ])).digest('hex');
}

export interface NotebookOperation {
  baseVersion: number;
  payloadDigest: string;
  savedVersion?: number;
  requestId: string;
}

export interface NotebookApi {
  workspace(): Promise<Workspace>;
  save(version: number, payload: DraftPayload): Promise<{ draft: Draft }>;
  check(version: number, requestId: string): Promise<{ submission: Submission }>;
}

function requestId(link: NotebookLink, version: number, digest: string): string {
  // UUIDv8: stable across a notebook rename/reopen or a different machine.
  // A new export or a new saved version represents a new intentional submission.
  const hex = createHash('sha256').update(JSON.stringify(['dhimantai-notebook-check-v1', link.environment,
    link.account_id, link.workspace, link.exercise_id, link.export_id, version, digest])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Durable save/check retries; no overwrite of a newer browser draft. */
export async function submitNotebook(link: NotebookLink, cells: NotebookCell[], api: NotebookApi,
  previous: NotebookOperation | undefined, remember: (state: NotebookOperation) => PromiseLike<void>) {
  const workspace = await api.workspace();
  const questionId = link.workspace === 'doubt_practice' ? `doubt:${link.exercise_id}` : link.exercise_id;
  if (workspace.project.question_id !== questionId || workspace.project.id !== `practice:${questionId}`
      || (workspace.draft.payload.question_id && workspace.draft.payload.question_id !== questionId)) {
    throw new Error('The server returned a different question. Reopen the original question and export again.');
  }
  if (!workspace.project.languages.includes(link.language) || workspace.source_changed) {
    throw new Error('The question requirements changed. Review the question in the app and export again. Your notebook is kept.');
  }
  const payload: DraftPayload = { ...workspace.draft.payload, language: link.language,
    notebook: { nbformat: 4, cells } };
  const digest = payloadDigest(payload);
  let baseline = previous?.savedVersion ?? link.draft_version;
  // A lost save response is recoverable only when the next revision contains the
  // exact intended payload. Any other change remains a conflict.
  if (previous && previous.savedVersion === undefined && workspace.draft.version === previous.baseVersion + 1
      && payloadDigest(workspace.draft.payload) === previous.payloadDigest) {
    previous = { ...previous, savedVersion: workspace.draft.version,
      requestId: requestId(link, workspace.draft.version, previous.payloadDigest) };
    await remember(previous);
    baseline = previous.savedVersion!;
  }
  if (workspace.draft.version !== baseline) {
    throw new Error(`The app has a different saved draft (v${workspace.draft.version}; notebook v${baseline}). Your notebook is kept. Compare the saved work in the app and export a fresh notebook before submitting.`);
  }
  let operation = previous?.payloadDigest === digest ? previous : {
    baseVersion: baseline, payloadDigest: digest, requestId: requestId(link, baseline, digest),
  };
  if (operation.savedVersion === undefined) {
    await remember(operation); // Persist before the first write or request.
    const saved = payloadDigest(workspace.draft.payload) === digest && baseline > 0
      ? workspace.draft : (await api.save(baseline, payload)).draft;
    operation = { ...operation, savedVersion: saved.version, requestId: requestId(link, saved.version, digest) };
    await remember(operation);
  }
  // Questions without a test suite still receive code; their conversational
  // assessment is submitted explicitly from the Practice session in the app.
  const submission = workspace.project.tests
    ? (await api.check(operation.savedVersion!, operation.requestId)).submission : undefined;
  return { version: operation.savedVersion!, submission };
}

const VERDICT_LABELS: Record<string, string> = {passed: 'Passed', wrong_answer: 'Wrong answer', runtime_error: 'Runtime error',
  timeout: 'Time limit exceeded', compile_error: 'Compilation error', not_run: 'Not run'};
const CATEGORIES: FailureCategory[] = ['edge case', 'empty input', 'large input', 'off-by-one', 'type', 'other'];

/**
 * Grade code against every case of an exercise in the learner's own runtime (the same harness as Check samples).
 * The suite lives only in this call: the report keeps verdicts, counts and a kind of case per failure, never an
 * input, expected answer, output or error text that could echo a hidden input. Compiler errors are kept: they
 * describe the code, not a test.
 */
export async function gradeLocally(suite: () => Promise<GradingSuite>, run: (cases: PublicTest[]) => Promise<LocalTestResult[]>,
  questionId: string): Promise<TestReport> {
  const loaded = await suite();
  if (loaded.question_id !== questionId) throw new Error('The service returned a different exercise. Open it again from Practice.');
  if (!loaded.tests.length) throw new Error('This exercise has no graded tests yet. Check samples and compare the output yourself.');
  const results = await run(loaded.tests.map(({visibility: _visibility, category: _category, ...test}) => test));
  const cases = loaded.tests.map(test => {
    const result = results.find(r => r.id === test.id);
    const verdict = result?.verdict && Object.hasOwn(VERDICT_LABELS, result.verdict) ? result.verdict : 'not_run';
    return {id: test.id, visibility: test.visibility, verdict, label: VERDICT_LABELS[verdict],
      ...(verdict === 'compile_error' && result?.stderr ? {stderr: result.stderr.slice(-1000)} : {}),
      ...(test.visibility === 'hidden' && verdict !== 'passed' ? {category: CATEGORIES.includes(test.category) ? test.category : 'other' as const} : {})};
  });
  const passed = cases.filter(c => c.verdict === 'passed').length, shown = cases.filter(c => c.visibility === 'public');
  return {suite_version: loaded.suite_version, assessment_revision: loaded.assessment_revision, passed, total: cases.length, all_passed: passed === cases.length && cases.length > 0,
    public: {passed: shown.filter(c => c.verdict === 'passed').length, total: shown.length}, cases};
}
