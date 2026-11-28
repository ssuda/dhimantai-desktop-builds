import { createHash } from 'node:crypto';
import { checkCommand, evidenceFingerprint, checkState } from './projectCore';
import { redactSecrets } from './projectContext';
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

type EvidenceSnapshot = Pick<ProjectSnapshot, 'digest' | 'steps' | 'reading'>;

function readingDigest(stepId: string, reading: NonNullable<ProjectSnapshot['reading']>, counts: Record<string, number>) {
  const hash = createHash('sha256').update(reading.sources[stepId]);
  for (const section of Object.keys(counts).sort()) {
    hash.update(JSON.stringify([section, reading.sections[section]?.slice(0, counts[section]) ?? []]));
  }
  return hash.digest('hex');
}

export function checkpointEvidence(step: ProjectStep, snapshot: EvidenceSnapshot) {
  if (!step.guide || !snapshot.reading) return {stepDigest: snapshot.steps[step.id]};
  const {reading} = snapshot;
  const noteLines = Object.fromEntries(step.guide.sections.map(name => [name, reading.sections[name]?.length ?? 0]));
  return {noteLines, stepDigest: readingDigest(step.id, reading, noteLines)};
}

export function checkpointCurrent(checkpoint: ProjectCheckpoint, snapshot: string | EvidenceSnapshot) {
  if (typeof snapshot === 'string') return checkpoint.digest === snapshot;
  if (checkpoint.noteLines) {
    return snapshot.reading ? checkpoint.stepDigest === readingDigest(checkpoint.step, snapshot.reading, checkpoint.noteLines)
      : checkpoint.digest === snapshot.digest;
  }
  if (checkpoint.stepDigest && snapshot.steps?.[checkpoint.step]) return checkpoint.stepDigest === snapshot.steps[checkpoint.step];
  return checkpoint.digest === snapshot.digest;
}

export function projectMilestones(curriculum: ProjectCurriculum, progress: ProjectProgress, snapshot?: string | EvidenceSnapshot) {
  return curriculum.steps.map(step => {
    const checkpoint = progress.checkpoints[step.id];
    return {id: step.id, verified: !!checkpoint?.verified, status: checkpoint?.completed
      ? (snapshot && !checkpoint.verified && !checkpointCurrent(checkpoint, snapshot) ? 'review' : 'complete')
      : (checkpoint || progress.visited.includes(step.id) ? 'in_progress' : 'not_started')};
  });
}

/** Historical demonstrations remain useful after later milestones change the same files. */
export function milestoneHistory(curriculum: ProjectCurriculum, progress: ProjectProgress, snapshot: ProjectSnapshot) {
  return curriculum.steps.flatMap(step => {
    const saved = progress.checkpoints[step.id];
    if (!saved) return [];
    const state = saved.verified && saved.completed ? 'verified' : saved.completed ? 'self_reported' : 'draft';
    const current = saved.verified ? saved.verified.fingerprint === evidenceFingerprint(snapshot)
      : checkpointCurrent(saved, snapshot);
    const evidence = redactSecrets(saved.verified?.summary || saved.note).slice(0, 180);
    const reflection = saved.verified ? redactSecrets(saved.note.trim().split(/\r?\n/).slice(1).join(' ')).slice(0, 120) : '';
    return [{step: step.id, state, current, evidence, ...(reflection ? {learner_note: reflection} : {})}];
  }).slice(-12);
}

export function checkpointProof(step: ProjectStep, output: string, note: string) {
  const proof = JSON.parse(output) as {summary:string; answers:string[]};
  const normalize = (text: string) => text.trim().replace(/→/g, '->').replace(/\s*->\s*/g, '->')
    .replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
  const answer = normalize(note.trim().split(/\r?\n/)[0]);
  const matches = proof.answers.some(value => /^[0-9a-f]{40}$/.test(value)
    ? /^[a-f0-9]{7,40}$/i.test(answer) && value.startsWith(answer.toLowerCase()) : normalize(value) === answer);
  if (!matches) throw new Error('The evidence does not match this milestone. ' + step.evidencePrompt);
  return proof.summary;
}

/** Prompts follow observable work. The learner always controls the check and the self-reported checkpoint. */
export function readingGuidance(curriculum: ProjectCurriculum, index: number, milestones: ReturnType<typeof projectMilestones>,
    progress: ProjectProgress, check: ReturnType<typeof checkState>, snapshot?: ProjectSnapshot) {
  const step = curriculum.steps[index], guide = step.guide;
  if (!guide) return;
  if (!snapshot?.reading) return 'Open Milestone brief and files to continue while the project files are unavailable.';
  if (milestones[index].status === 'review') return 'Revisit your saved evidence for this milestone. After reviewing the changes, select Save changes to confirm it.';
  if (milestones[index].status === 'complete') {
    const next = milestones.findIndex((m, i) => i > index && m.status !== 'complete');
    const remaining = next >= 0 ? next : milestones.findIndex(m => m.status !== 'complete');
    if (remaining >= 0) return `Checkpoint saved. Select “${curriculum.steps[remaining].title}” to continue.`;
    return index === milestones.length - 1 ? 'All milestones are marked complete. Select Submit project when you are ready.'
      : 'All milestones are marked complete. Open the final milestone to submit your project.';
  }
  if (check.state === 'changed') return 'The project files used by the command changed. Save your files and select Run this step to check the current version.';
  if (check.state === 'current' && check.status !== 'passed') {
    if (check.status === 'runtime_error') return 'Open Project tools, then Runtime, and select Set up and verify environment. Then retry Run this step.';
    return 'Inspect the command output below. Use I’m stuck for help with the failure, then retry Run this step.';
  }
  // Several milestones share a heading. Earlier checkpoints' lines do not establish work on a later task.
  const section = guide.sections[0];
  // The final handoff deliberately reuses the trace built in earlier milestones.
  const priorCount = index === curriculum.steps.length - 1 ? 0 : Math.max(0, ...milestones.slice(0, index).map(m =>
    m.status === 'complete' ? progress.checkpoints[m.id].noteLines?.[section] ?? 0 : 0));
  const lines = snapshot.reading.savedSections[section] ?? [];
  const notes = lines.slice(priorCount).join('\n').toLowerCase();
  const hasNotes = guide.cues.every(cue => notes.includes(cue.toLowerCase()));
  // Cues can suggest a run, but a learner can use different wording and choose to run the command themselves.
  if (!notes || (!hasNotes && check.state !== 'current')) return check.state === 'current' ? 'The command passed. ' + guide.prepare : guide.prepare;
  if (check.state === 'current') {
    return ['The command passed.', guide.afterRun, step.evidencePrompt, 'Enter your answer in Checkpoint and select Complete milestone.']
      .filter(Boolean).join(' ');
  }
  return `${guide.beforeRun} Select Run this step to execute \`${checkCommand(step)}\` and inspect its output.`;
}

export function projectOtherHelp(progress: ProjectProgress, current: ProjectCheckpoint['externalHelp']) {
  return Object.values(progress.checkpoints).some(checkpoint => checkpoint.externalHelp === 'reported') ? 'reported' : current;
}

/** This second help step remains available without an account or model request. */
export function smallerProjectStep(step: ProjectStep) {
  const file = step.nextAction?.file ?? step.files[0], anchor = step.anchors?.[file];
  const action = step.nextAction?.task ?? 'Choose one input and follow only its next call. Write what goes in and what comes back.';
  return `Try one smaller step\n\nOpen \`${file}\`${anchor ? ` and find \`${anchor.trim()}\`` : ''}. ${action}\n\nCompare your result with the expected outcome: ${step.expected}\n\nIf you need more help, tell the mentor what you expected, what you observed and where the trace stops.`;
}
