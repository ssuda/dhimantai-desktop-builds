import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProject, loadProjectCurriculum, runProjectCheck } from '../src/projectCore';
import { ProjectResults, branchUpstream, finalProjectSteps, githubCompareUrl, githubRepository, projectResultStatus, submissionGit, submitProject } from '../src/projectResults';

const media = resolve(__dirname, '../../media');
const engine = {bin: 'container-only', execArgs: () => []};
const help = {coachTurns: 4, otherHelp: 'reported' as const};
const pass: typeof runProjectCheck = async (_root, step, digest) => ({step: step.id, digest, status: 'passed', command: step.check, output: 'Passed', truncated: false});
async function fixture(action: (root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'project-results-')), root = join(directory, 'project');
  try { await createProject(join(media, 'projects/course-agent'), root); await action(root); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

test('final submission selects the full checker and saves source, Git and assistance evidence', async () => fixture(async root => {
  const curriculum = await loadProjectCurriculum(media, 'course-agent');
  const calls: string[] = [];
  const result = await submitProject(root, curriculum, help, 'My evidence', new AbortController().signal, engine, async (...args) => {
    calls.push(args[1].check); return pass(...args);
  });
  assert.deepEqual(calls, ['final:agent']);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.assistance, help);
  assert.equal(result.git.available, true); assert.equal(result.git.dirty, false);
  assert.match(result.git.head, /^[a-f0-9]{40}$/);
  await writeFile(join(root, 'tests/test_student.py'), 'pass\n');
  const edited = await submitProject(root, curriculum, help, '', new AbortController().signal, engine, pass);
  assert.equal(edited.git.dirty, true); assert.notEqual(edited.digest, result.digest);
  assert.equal(edited.git.head, result.git.head, 'uncommitted source is not attributed to a new commit');
}));

test('failure and timeout remain incomplete; edits or cancellation never award completion', async () => fixture(async root => {
  const curriculum = await loadProjectCurriculum(media, 'course-agent');
  for (const status of ['failed', 'runtime_error', 'timed_out'] as const) {
    const result = await submitProject(root, curriculum, help, '', new AbortController().signal, engine,
      async (...args) => ({...await pass(...args), status}));
    assert.equal(result.outcome, 'needs_work');
  }
  await assert.rejects(submitProject(root, curriculum, help, '', new AbortController().signal, engine, async (...args) => {
    await writeFile(join(root, 'tests/test_student.py'), '# changed during check\n'); return pass(...args);
  }), /changed during submission/);
  const controller = new AbortController();
  await assert.rejects(submitProject(root, curriculum, help, '', controller.signal, engine, async (...args) => {
    controller.abort(); return pass(...args);
  }), /changed during submission|cancelled/);
}));

test('Git evidence rejects parent repositories and identifies detached HEAD', async () => fixture(async root => {
  await mkdir(join(root, 'nested'));
  assert.equal((await submissionGit(join(root, 'nested'))).available, false);
  execFileSync('git', ['checkout', '--detach', '-q'], {cwd: root});
  const git = await submissionGit(root);
  assert.equal(git.available, true); assert.equal(git.branch, '');
}));

test('results survive reopening, isolate learner/service, retain history and mark edited or missing projects', async () => fixture(async root => {
  const values = new Map<string, any>();
  const state = {keys: () => [...values.keys()], get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }};
  const curriculum = await loadProjectCurriculum(media, 'course-agent'), results = new ProjectResults(state);
  await results.save('staging', 'alice', root, curriculum);
  assert.equal(projectResultStatus(results.list('staging', 'alice')[0]), 'In progress');
  const submitted = await submitProject(root, curriculum, help, '', new AbortController().signal, engine, pass);
  await results.save('staging', 'alice', root, curriculum, submitted);
  const restored = new ProjectResults(state);
  assert.equal(restored.list('production', 'alice').length, 0);
  assert.equal(restored.list('staging', 'bob').length, 0);
  assert.equal(restored.list('staging', 'alice')[0].submissions[0].id, submitted.id);
  assert.match((await restored.summaries(media, 'staging', 'alice'))[0].status, /Completed locally/);
  await writeFile(join(root, 'EXPLANATION.md'), 'Updated explanation');
  assert.match((await restored.summaries(media, 'staging', 'alice'))[0].status, /Changed since submission/);
  const failed = {...submitted, id: 'retry', outcome: 'needs_work' as const};
  await restored.save('staging', 'alice', root, curriculum, failed);
  assert.equal(restored.list('staging', 'alice')[0].submissions.length, 2);
  assert.match(projectResultStatus(restored.list('staging', 'alice')[0]), /Needs work/);
  await rm(root, {recursive: true});
  assert.equal((await restored.summaries(media, 'staging', 'alice'))[0].status, 'Project folder unavailable');
}));

test('reading submission runs each authored command and requires an explicit reading note', async () => {
  const curriculum = await loadProjectCurriculum(media, 'rich-reading');
  assert.equal(finalProjectSteps(curriculum).length, new Set(curriculum.steps.map(step => step.check)).size);
  await assert.rejects(submitProject('/unused', curriculum, help, '', new AbortController().signal, engine, pass), /reading evidence/);
});

test('GitHub destinations reject credentials, alternate hosts and malformed paths', () => {
  for (const url of ['https://github.com/learner/project.git', 'git@github.com:learner/project.git', 'ssh://git@github.com/learner/project'])
    assert.equal(githubRepository(url), 'https://github.com/learner/project');
  for (const url of ['https://token@github.com/learner/project.git', 'https://github.com.evil/learner/project',
    'file:///private/repo', 'https://github.com/owner/repo?token=secret', 'https://github.com/../repo', 'https://evil/owner/repo'])
    assert.equal(githubRepository(url), undefined);
});

test('pull request compare links keep branch folders and require a published upstream', async () => fixture(async root => {
  assert.equal(githubCompareUrl('https://github.com/learner/project', 'fix/search case#1'),
    'https://github.com/learner/project/compare/fix/search%20case%231?expand=1');
  assert.equal(githubCompareUrl('https://github.com/learner/project', 'main'), 'https://github.com/learner/project/compare/main?expand=1');
  assert.equal(await branchUpstream(root, 'main'), undefined, 'an unpublished branch has no upstream');
  execFileSync('git', ['config', 'branch.main.remote', 'origin'], {cwd: root});
  execFileSync('git', ['config', 'branch.main.merge', 'refs/heads/fix/search'], {cwd: root});
  assert.deepEqual(await branchUpstream(root, 'main'), {remote: 'origin', branch: 'fix/search'});
}));

test('removing a saved project forgets only that entry and never touches its files', async () => fixture(async root => {
  const values = new Map<string, any>();
  const state = {keys: () => [...values.keys()], get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); }};
  const curriculum = await loadProjectCurriculum(media, 'course-agent');
  let changes = 0; const results = new ProjectResults(state, () => changes++);
  await results.save('staging', 'alice', root, curriculum);
  await results.save('staging', 'alice', root + '-other', curriculum);
  await results.remove('staging', 'alice', root);
  assert.deepEqual(results.list('staging', 'alice').map(r => r.root), [root + '-other']);
  assert.equal(changes, 3);
  assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}), '');
}));

test('the agent’s last milestone checks exactly what submission checks', async () => {
  const curriculum = await loadProjectCurriculum(media, 'course-agent');
  assert.equal(curriculum.steps.at(-1)!.check, 'final:agent', 'skipped placeholder tests must fail the milestone check too');
  assert.deepEqual(finalProjectSteps(curriculum).map(step => step.check), ['final:agent']);
});
