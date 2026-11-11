import type { ProjectCheckpoint, ProjectCurriculum, ProjectSnapshot, ProjectStep } from './projectCore';

export interface ProjectProgress {
  visited: string[];
  checkpoints: Record<string, ProjectCheckpoint>;
}

/** Older installations saved one checkpoint. Restore it without inferring completion. */
export function restoreProjectProgress(curriculum: ProjectCurriculum,
    saved?: {progress?: ProjectProgress; checkpoint?: ProjectCheckpoint}): ProjectProgress {
  const ids = new Set(curriculum.steps.map(step => step.id));
  const checkpoints = Object.fromEntries(Object.entries(saved?.progress?.checkpoints ?? {})
    .filter(([id, checkpoint]) => ids.has(id) && checkpoint?.step === id));
  const legacy = saved?.checkpoint;
  if (!saved?.progress && legacy && ids.has(legacy.step)) checkpoints[legacy.step] = {...legacy, completed: false};
  return {visited: [...new Set([...(saved?.progress?.visited ?? []), ...Object.keys(checkpoints)])].filter(id => ids.has(id)), checkpoints};
}

/**
 * A completed milestone needs review only when its own files change. Pass the snapshot (or its step digests) so
 * checkpoints saved with stepDigest compare per milestone; a bare project digest keeps the older whole-project rule.
 */
export function projectMilestones(curriculum: ProjectCurriculum, progress: ProjectProgress,
    snapshot: string | Pick<ProjectSnapshot, 'digest' | 'steps'>) {
  const digest = typeof snapshot === 'string' ? snapshot : snapshot.digest;
  const steps = typeof snapshot === 'string' ? undefined : snapshot.steps;
  return curriculum.steps.map(step => {
    const checkpoint = progress.checkpoints[step.id];
    const current = checkpoint?.stepDigest && steps?.[step.id] ? checkpoint.stepDigest === steps[step.id]
      : checkpoint?.digest === digest; // Older checkpoints (or callers) only know the whole-project digest.
    return {id: step.id, status: checkpoint?.completed
      ? (current ? 'complete' : 'review')
      : (checkpoint || progress.visited.includes(step.id) ? 'in_progress' : 'not_started')};
  });
}

export function projectOtherHelp(progress: ProjectProgress, current: ProjectCheckpoint['externalHelp']) {
  return Object.values(progress.checkpoints).some(checkpoint => checkpoint.externalHelp === 'reported') ? 'reported' : current;
}

/** This second help step remains available without an account or model request. */
export function smallerProjectStep(step: ProjectStep) {
  const file = step.nextAction?.file ?? step.files[0], anchor = step.anchors?.[file];
  const action = step.nextAction?.task ?? 'Choose one input and follow only its next call. Write what goes in and what comes back.';
  return `Try one smaller step\n\nOpen \`${file}\`${anchor ? ` and find \`${anchor.trim()}\`` : ''}. ${action}\n\nCompare your result with the expected outcome: ${step.expected}\n\nIf you need more help, tell Coach what you expected, what you observed and where the trace stops.`;
}
