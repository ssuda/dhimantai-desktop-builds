import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadProjectCurriculum, ProjectCheckpoint, stepDigests } from '../src/projectCore';
import { projectMilestones, projectOtherHelp, restoreProjectProgress, smallerProjectStep } from '../src/projectProgress';

const media = join(__dirname, '../../media');
const checkpoint: ProjectCheckpoint = {step: 'map', note: 'Application in shelf/, assertions in tests/.', digest: 'original',
  at: '2026-11-09T00:00:00Z', assistance: 2, externalHelp: 'reported'};

test('legacy evidence migrates to its own milestone without claiming completion', async () => {
  const plan = await loadProjectCurriculum(media, 'shelf-reading');
  const progress = restoreProjectProgress(plan, {checkpoint: {...checkpoint, completed: true}});
  assert.equal(progress.checkpoints.map.assistance, 2);
  assert.equal(progress.checkpoints.map.externalHelp, 'reported');
  assert.equal(projectMilestones(plan, progress, 'original')[0].status, 'in_progress');
  assert.equal(projectMilestones(plan, progress, 'original')[1].status, 'not_started');
  assert.equal(restoreProjectProgress(plan).checkpoints.map, undefined, 'a separate account starts empty');
});

test('per-milestone completion survives restoration and flags changed evidence without losing notes', async () => {
  const plan = await loadProjectCurriculum(media, 'shelf-reading');
  const progress = restoreProjectProgress(plan, {progress: {visited: ['entry', 'removed'], checkpoints: {
    map: {...checkpoint, completed: true},
    entry: {...checkpoint, step: 'entry', note: 'Trace main to load', completed: false},
    removed: {...checkpoint, step: 'removed', completed: true},
  }}});
  assert.deepEqual(projectMilestones(plan, progress, 'original').slice(0, 3).map(s => s.status), ['complete', 'in_progress', 'not_started']);
  const restored = restoreProjectProgress(plan, JSON.parse(JSON.stringify({progress})));
  assert.equal(projectMilestones(plan, restored, 'edited')[0].status, 'review');
  assert.equal(restored.checkpoints.map.note, checkpoint.note);
  assert.equal(restored.checkpoints.entry.note, 'Trace main to load');
  assert.equal(restored.checkpoints.removed, undefined);
  assert.ok(!restored.visited.includes('removed'));
  assert.equal(projectOtherHelp(restored, 'none_reported'), 'reported', 'a handoff retains assistance reported on earlier milestones');
});

test('every bundled milestone offers a smaller action linked to a relevant public file', async () => {
  for (const id of ['shelf-reading', 'rich-reading', 'course-agent']) {
    const plan = await loadProjectCurriculum(media, id);
    for (const step of plan.steps) {
      assert.ok(step.nextAction?.task, `${id}/${step.id} needs a smaller action`);
      assert.ok(step.files.includes(step.nextAction!.file));
      assert.ok(plan.files.includes(step.nextAction!.file));
      assert.ok(smallerProjectStep(step).includes(step.nextAction!.task));
      assert.ok(smallerProjectStep(step).includes(step.expected));
    }
  }
});

test('editing one milestone’s files leaves other completed milestones complete', async () => {
  const plan = await loadProjectCurriculum(media, 'course-agent');
  const files = new Map(plan.files.map(path => [path, '# ' + path]));
  const before = {digest: 'project-a', steps: stepDigests(plan, files)};
  const [search, tools] = [plan.steps[1], plan.steps[3]];
  const progress = restoreProjectProgress(plan, {progress: {visited: [], checkpoints: {
    [search.id]: {...checkpoint, step: search.id, completed: true, digest: before.digest, stepDigest: before.steps[search.id]},
    [tools.id]: {...checkpoint, step: tools.id, completed: true, digest: before.digest, stepDigest: before.steps[tools.id]},
  }}});
  // tools.py belongs to the tools milestone, not to search.
  assert.ok(!search.files.includes('course_agent/tools.py') && tools.files.includes('course_agent/tools.py'));
  const after = {digest: 'project-b', steps: stepDigests(plan, new Map([...files, ['course_agent/tools.py', '# edited']]))};
  const status = (snapshot: typeof before) => Object.fromEntries(projectMilestones(plan, progress, snapshot).map(m => [m.id, m.status]));
  assert.equal(status(before)[search.id], 'complete');
  assert.equal(status(after)[search.id], 'complete', 'another milestone’s file changed');
  assert.equal(status(after)[tools.id], 'review', 'its own file changed');
  // Older checkpoints without stepDigest, or callers passing only the project digest, keep the whole-project rule.
  assert.equal(projectMilestones(plan, progress, 'project-b')[1].status, 'review');
  const legacy = restoreProjectProgress(plan, {progress: {visited: [], checkpoints: {[search.id]: {...checkpoint, step: search.id, completed: true, digest: 'project-a'}}}});
  assert.equal(projectMilestones(plan, legacy, before)[1].status, 'complete');
  assert.equal(projectMilestones(plan, legacy, after)[1].status, 'review');
  // A deleted file is a change too.
  const removed = new Map(files); removed.delete('course_agent/search.py');
  assert.notEqual(stepDigests(plan, removed)[search.id], before.steps[search.id]);
});
