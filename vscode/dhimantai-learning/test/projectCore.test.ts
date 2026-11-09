import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkArguments, checkState, createProject, createReadingProject, isProject, loadProjectCurriculum, projectIdentity, ProjectCurriculum, projectSnapshot, runProjectCheck } from '../src/projectCore';

const extension = resolve(__dirname, '../..'), starter = join(extension, 'media/projects/course-agent');
const engine = (exit = 0) => ({bin: process.execPath, execArgs: (_cwd: string, command: string, args: string[]) => {
  assert.equal(command, 'timeout'); assert.deepEqual(args.slice(0,4), ['--signal=KILL','28s','python','-m']);
  return ['-e', `process.stdout.write('Controlled container result');process.exit(${exit})`];
}});
const curriculum = () => readFile(join(extension, 'media/projects/course-agent.json'), 'utf8').then(JSON.parse) as Promise<ProjectCurriculum>;

test('starter creation preserves existing projects and creates a clean independent Git repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-core-')), project = join(root, 'agent');
  try {
    await createProject(starter, project);
    assert.equal(await isProject(project), true);
    assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: project, encoding: 'utf8'}), '');
    await assert.rejects(createProject(starter, project));
    const plan = await curriculum();
    const snapshot = await projectSnapshot(project, plan, plan.steps[0].files);
    const run = await runProjectCheck(project, plan.steps[0], snapshot.digest, new AbortController().signal, engine());
    assert.equal(run.status, 'passed', run.output);
    assert.equal(checkState(run, snapshot.digest, 'brief').state, 'current');
    const changed = await projectSnapshot(project, plan, [], new Map([['course_agent/agent.py', '# unsaved change']]));
    assert.equal(checkState(run, changed.digest, 'brief').state, 'changed');
    assert.equal(checkState(run, snapshot.digest, 'search').state, 'not_run');
    const fail = await runProjectCheck(project, plan.steps[1], snapshot.digest, new AbortController().signal, engine(1));
    assert.equal(fail.status, 'failed');
    await assert.rejects(runProjectCheck(project, plan.steps[0], snapshot.digest, new AbortController().signal, undefined as any), /course container/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('Coach shares bounded public excerpts; omitted files still invalidate evidence', async () => {
  const plan = await curriculum(), focus = ['course_agent/agent.py'];
  const first = await projectSnapshot(starter, plan, focus);
  const last = plan.files.at(-1)!;
  const changed = await projectSnapshot(starter, plan, focus, new Map([[last, '# changed']]));
  assert.notEqual(first.digest, changed.digest);
  assert.equal(first.files[0].path, focus[0]);
  assert.ok(first.files.length <= 12 && first.omitted.includes(last));
  assert.ok(Buffer.byteLength(JSON.stringify(first.files)) < 30000);
  assert.throws(() => checkArguments({...plan.steps[0], check: 'shell; rm'}));
});

test('a public filename cannot alias an env file or escape through a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-boundary-'));
  try {
    const secret = join(root, '.env'); await writeFile(secret, 'sentinel-secret');
    await symlink(secret, join(root, 'README.md'));
    const plan = {...await curriculum(), files: ['README.md']};
    await assert.rejects(projectSnapshot(root, plan, ['README.md']), /Linked files/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('both reading projects clone cleanly; large source excerpts retain line offsets and omitted dependencies invalidate checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-project-')), media = join(extension,'media');
  try {
    for (const id of ['shelf-reading', 'rich-reading'] as const) {
      const folder = join(root,id);
      await createReadingProject(media,id,folder);
      assert.equal(await projectIdentity(folder), id);
      assert.equal(execFileSync('git',['status','--porcelain'],{cwd:folder,encoding:'utf8'}),'');
      await assert.rejects(createReadingProject(media,id,folder));
      const plan = await loadProjectCurriculum(media,id);
      for (const step of plan.steps) assert.ok(checkArguments(step).length > 1);
      if (id === 'rich-reading') {
        const source = await readFile(join(folder,'rich/console.py'),'utf8');
        assert.ok(source.length > 64000);
        const line = source.split('\n').findIndex(text => text.includes('    def print(')) + 1;
        const first = await projectSnapshot(folder,plan,['rich/console.py'],undefined,{'rich/console.py':line});
        assert.equal(first.files[0].start_line,line - 8);
        assert.ok(first.files[0].text.includes('    def print('));
        assert.ok(first.files[0].truncated);
        assert.ok(first.files.length <= 12 && Buffer.byteLength(JSON.stringify(first.files)) < 30000);
        const changed = await projectSnapshot(folder,plan,[],new Map([['rich/_loop.py','# changed dependency']]));
        assert.notEqual(first.digest,changed.digest);
        const metadata = JSON.parse(await readFile(join(media,'projects/rich-source.json'),'utf8'));
        assert.equal(execFileSync('git',['rev-parse','HEAD~1^{tree}'],{cwd:folder,encoding:'utf8'}).trim(),metadata.sourceTree);
      }
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('cancellation terminates a hanging learner check without a passing result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-cancel-'));
  try {
    const plan = await curriculum(), controller = new AbortController();
    const promise = runProjectCheck(root, {...plan.steps[0], check: 'all'}, 'snapshot', controller.signal,
      {bin:process.execPath,execArgs:()=>['-e','setInterval(()=>{},1000)']});
    setTimeout(() => controller.abort(), 150);
    assert.equal((await promise).status, 'runtime_error');
  } finally { await rm(root, {recursive: true, force: true}); }
});
