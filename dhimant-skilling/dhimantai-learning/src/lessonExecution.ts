import type { Execution } from './roomCode';

/** Local follow-up notes, never restored run evidence or assessment results. */
export interface ExecutionIssue { key: string; snippet: string; detail: string }

function lastException(output: string) {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  return [...plain.matchAll(/^([A-Z]\w*)(?::[^\r\n]*)?$/gm)].at(-1);
}

export function matchesExpectedError(run?: Execution, expected?: string): boolean {
  if (!expected || !run || run.status !== 'exited' || run.exit_code !== 1 || run.truncated) return false;
  // Local kernels can put the traceback in stdout. Prefer stderr when present.
  return lastException(run.stderr.trim() || run.stdout)?.[1] === expected;
}

export function recordExecutionIssue(issues: ExecutionIssue[], key: string, snippet: string, run?: Execution, error?: string, expected?: string): ExecutionIssue[] {
  const remaining = issues.filter(issue => issue.key !== key);
  if (!error && matchesExpectedError(run, expected)) return remaining;
  if (run?.status === 'exited' && run.exit_code === 0 && !run.truncated && !error) return remaining;
  let detail = '';
  if (error) detail = 'Run could not be confirmed: ' + error;
  else if (run) {
    const cause = run.stderr.trim() || (run.exit_code ? lastException(run.stdout)?.[0] : '');
    detail = cause || (run.status === 'exited' ? `Exit code ${run.exit_code}` : run.status.replace(/_/g, ' '));
    if (run.truncated) detail += ' · Output incomplete; rerun to confirm.';
  }
  if (!detail) return issues;
  return [...remaining, {key, snippet, detail:detail.slice(-600)}].slice(-1000);
}

export function validExecutionIssues(value: unknown): value is ExecutionIssue[] {
  return Array.isArray(value) && value.length <= 1000 && new Set(value.map(issue => issue?.key)).size === value.length
    && value.every(issue => issue && typeof issue.key === 'string' && issue.key.length > 0 && issue.key.length <= 200
      && typeof issue.snippet === 'string' && /^code-\d{1,9}$/.test(issue.snippet)
      && typeof issue.detail === 'string' && issue.detail.length > 0 && issue.detail.length <= 600);
}

const plainMarkdown = (text: string) => text.replace(/\s+/g, ' ').replace(/[\\`*_[\]<>#|]/g, '\\$&');
export function executionFollowup(issues: ExecutionIssue[]): string {
  if (!issues.length) return '';
  const dependencies = issues.some(issue => /ModuleNotFoundError|ImportError|dependency could not be loaded/i.test(issue.detail));
  return '**Coding follow-up pending**\n\nRecorded on this computer. These activities still need a successful rerun; lesson coverage does not confirm practical completion.\n\n'
    + issues.map(issue => `- ${issue.snippet}: ${plainMarkdown(issue.detail)}`).join('\n')
    + (dependencies ? '\n\nFor a missing package in the course container:\n\n'
      + '1. Runtime → Set up / rebuild course. Wait for setup to finish.\n'
      + '2. Rerun prerequisite cells, then the failed cell.\n'
      + '3. If setup fails again: Runtime → Open course terminal. Share the setup error with Instructor.\n\n'
      + 'For a connected external kernel, follow its course setup instructions.'
      : '\n\nNext: address the reported error or incomplete output, then rerun the affected cell.');
}

/** Completion is supplied by the shared Instructor; a recap alone is not completion. */
export function lessonCompletion(data: Record<string, unknown>): 'complete' | 'partial' | 'unverified' {
  if (data.is_complete === true && data.partial_session === false && data.summary_scope === 'full') return 'complete';
  if (data.is_complete === false || data.partial_session === true || data.summary_scope === 'partial') return 'partial';
  return 'unverified';
}
