import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cloneCapstone } from '../src/capstoneRepo';
import { checkArguments, checkCommand, checkDigest, checkState, checkStatus, tailText, createProject, createReadingProject, isProject, loadProjectCurriculum, prepareProjectHandoff, projectIdentity, ProjectCurriculum, projectSnapshot, runProjectCheck } from '../src/projectCore';

const extension = resolve(__dirname, '../..'), starter = join(extension, 'media/projects/course-agent');
const engine = (exit = 0) => ({bin: process.execPath, execArgs: (_cwd: string, command: string, args: string[]) => {
  assert.equal(command, 'timeout'); assert.deepEqual(args.slice(0,3), ['--signal=KILL','28s','python']);
  assert.equal(args[3], '-X'); assert.match(args[4], /^dhimantai_check=[0-9a-f]{16}$/); assert.equal(args[5], '-m');
  return ['-e', `process.stdout.write('Controlled container result');process.exit(${exit})`];
}});
const curriculum = () => readFile(join(extension, 'media/projects/course-agent.json'), 'utf8').then(JSON.parse) as Promise<ProjectCurriculum>;

test('container failures expose diagnostics locally without changing the Coach or handoff check contract', async () => {
  const step = (await curriculum()).steps[3];
  const output = 'subtest ... ERROR\n'.repeat(500) + 'Traceback (most recent call last):\n'
    + '  File "/course/course_agent/tools.py", line 14, in dispatch\n'
    + 'NotImplementedError: Implement dispatch in milestone 4\n\nFAILED (errors=8)\n';
  for (const code of [1, 0, 124]) {
    const run = await runProjectCheck(starter, step, 'snapshot', new AbortController().signal,
      {bin: process.execPath, execArgs: () => ['-e', `process.stderr.write(${JSON.stringify(output)}, () => process.exit(${code}))`]});
    assert.equal(run.status, code === 1 ? 'failed' : code === 0 ? 'passed' : 'timed_out');
    assert.equal(run.diagnostic?.file, code === 1 ? 'course_agent/tools.py' : undefined);
    assert.equal(run.truncated, true);
    assert.ok(run.output.length <= 4000);
    assert.match(run.output, /FAILED \(errors=8\)/);
    const state = checkState(run, 'snapshot', step.id);
    assert.equal('diagnostic' in state, false, 'backend uses a strict schema; summary stays in local UI state');
  }
});

test('original Shelf capstones open without migration and share custom tests plus current Git progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shelf-coach-')), folder = join(root, 'shelf');
  const git = (...args: string[]) => execFileSync('git', args, {cwd: folder, encoding: 'utf8'}).trim();
  try {
    await cloneCapstone(join(extension, 'media/capstone/shelf.bundle'), folder);
    assert.equal(await projectIdentity(folder), 'shelf');
    assert.equal(await projectIdentity(join(folder, 'shelf')), undefined, 'nested directories are not project roots');
    assert.equal(git('status', '--porcelain'), '', 'recognition must not add metadata or change learner files');
    await assert.rejects(readFile(join(folder, '.dhimantai-project.json')), {code: 'ENOENT'});
    const plan = await loadProjectCurriculum(join(extension, 'media'), 'shelf');
    for (const step of plan.steps) assert.ok(checkArguments(step).length);
    assert.deepEqual(checkArguments(plan.steps.at(-1)!), ['check.py']);
    const baseline = await projectSnapshot(folder, plan, plan.steps[0].files);
    assert.equal(baseline.git?.branch, 'main');
    assert.equal(baseline.git?.head, git('rev-parse', 'HEAD'));
    git('switch', '-c', 'fix-search-case');
    const branch = await projectSnapshot(folder, plan, []);
    assert.equal(branch.digest, baseline.digest, 'the project digest covers files only');
    assert.deepEqual(branch.steps, baseline.steps, 'milestones depend on their own files, not Git state');
    assert.notEqual(checkDigest(branch, plan.steps.at(-1)!), checkDigest(baseline, plan.steps.at(-1)!), 'branch-only changes invalidate the capstone checker');
    assert.equal(checkDigest(branch, plan.steps[1]), branch.digest, 'other checks ignore Git state');
    await writeFile(join(folder, 'tests/test_regression.py'), '# learner regression test\n');
    await writeFile(join(folder, '.env'), 'private-key-sentinel');
    await writeFile(join(folder, 'shelf/credentials.py'), 'private-key-sentinel');
    const snapshot = await projectSnapshot(folder, plan, ['tests/test_regression.py']);
    assert.equal(snapshot.files[0].path, 'tests/test_regression.py');
    assert.equal(snapshot.git?.branch, 'fix-search-case');
    assert.ok(snapshot.git?.changed_files.some(file => file.path === 'tests/test_regression.py'));
    assert.ok(!JSON.stringify(snapshot).includes('.env'));
    assert.ok(!JSON.stringify(snapshot).includes('private-key-sentinel'));
    assert.ok(!JSON.stringify(snapshot).includes('credentials.py'));
    assert.equal(snapshot.git?.recent_commits.length, 6);
    assert.ok(snapshot.structure.files.includes('check.py'));
    const dirty = await projectSnapshot(folder, plan, ['tests/test_regression.py'], new Map([['tests/test_regression.py', '# unsaved test']]));
    assert.equal(dirty.files[0].text, '# unsaved test');
    assert.notEqual(dirty.digest, snapshot.digest);
    git('add', 'tests/test_regression.py');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Test #12');
    const committed = await projectSnapshot(folder, plan, []);
    assert.equal(committed.digest, snapshot.digest, 'committing unchanged files keeps file evidence current');
    assert.notEqual(checkDigest(committed, plan.steps.at(-1)!), checkDigest(snapshot, plan.steps.at(-1)!), 'commit and index changes invalidate the capstone checker');
    assert.match(committed.git!.recent_commits[0], /Test #12/);
    assert.equal(committed.git?.head, git('rev-parse', 'HEAD'));
    assert.equal(await projectIdentity(folder), 'shelf', 'learner commits keep the original project identity');
    await symlink(join(folder, '.env'), join(folder, 'tests/test_leak.py'));
    await assert.rejects(projectSnapshot(folder, plan, []), /Linked files/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('an unrelated repository or invalid marker is not recognized as Shelf', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-identity-'));
  try {
    execFileSync('git', ['init', '-q'], {cwd: root});
    assert.equal(await projectIdentity(root), undefined);
    await writeFile(join(root, '.dhimantai-project.json'), '{"id":"shelf","version":2}');
    assert.equal(await projectIdentity(root), undefined);
    await writeFile(join(root, '.dhimantai-project.json'), '{"id":"shelf","version":1}');
    assert.equal(await projectIdentity(root), 'shelf');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('explicit handoffs include custom tests, preserve assistance and invalidate checks after custom edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-handoff-')), project = join(root, 'agent');
  try {
    await createProject(starter, project);
    const plan = await curriculum(), original = await projectSnapshot(project, plan, []);
    await writeFile(join(project, 'tests/test_custom.py'), 'assert True\n');
    await writeFile(join(project, '.env'), 'private-key-sentinel');
    const changed = await projectSnapshot(project, plan, []);
    assert.notEqual(changed.digest, original.digest);
    const handoff = await prepareProjectHandoff(project, plan, {coach_turns: 3, other_help: 'reported'}, 'My evidence',
      {digest: original.digest, step: 'handoff', status: 'passed', output: 'Old check', command: 'python', truncated: false});
    assert.equal(handoff.check.state, 'changed');
    assert.equal(handoff.assistance.coach_turns, 3);
    assert.ok(handoff.files.some(f => f.path === 'tests/test_custom.py'));
    assert.ok(!JSON.stringify(handoff).includes('private-key-sentinel'));
    await symlink(join(project, '.env'), join(project, 'tests/test_leak.py'));
    await assert.rejects(prepareProjectHandoff(project, plan, handoff.assistance, ''), /Linked files/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('starter creation preserves existing projects and creates a clean independent Git repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-core-')), project = join(root, 'agent');
  try {
    await createProject(starter, project);
    assert.equal(await isProject(project), true);
    assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: project, encoding: 'utf8'}), '');
    await assert.rejects(createProject(starter, project));
    const plan = await curriculum();
    for (const step of plan.steps) for (const [path, anchor] of Object.entries(step.anchors ?? {}))
      assert.ok((await readFile(join(project, path), 'utf8')).includes(anchor), `${step.id}: ${path} contains ${anchor}`);
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
  const last = first.omitted[0];
  const changed = await projectSnapshot(starter, plan, focus, new Map([[last, '# changed']]));
  assert.notEqual(first.digest, changed.digest);
  assert.equal(first.files[0].path, focus[0]);
  assert.ok(first.files.length <= 12 && first.omitted.includes(last));
  assert.ok(Buffer.byteLength(JSON.stringify(first.files)) < 30000);
  assert.throws(() => checkArguments({...plan.steps[0], check: 'shell; rm'}));
});

test('new student tests and JSON fixtures are selected by the question and unsaved contents invalidate evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-retrieval-')), project = join(root, 'agent');
  try {
    await createProject(starter, project);
    const plan = await curriculum();
    await writeFile(join(project, 'tests/test_edge.py'), 'def test_empty_documents(): pass\n');
    await writeFile(join(project, 'data/edge.json'), '[{"title":"empty documents"}]\n');
    const first = await projectSnapshot(project, plan, ['README.md'], undefined, {}, 'Explain tests/test_edge.py and data/edge.json');
    for (const path of ['tests/test_edge.py', 'data/edge.json', 'README.md']) assert.ok(first.files.some(f => f.path === path));
    const changed = await projectSnapshot(project, plan, [], new Map([['tests/test_edge.py', 'def test_empty_documents(): assert False']]), {}, 'Explain test_empty_documents');
    assert.notEqual(first.digest, changed.digest);
    assert.ok(changed.files.find(f => f.path === 'tests/test_edge.py')?.text.includes('assert False'));
    const handoff = await prepareProjectHandoff(project, plan, {coach_turns: 1, other_help: 'unknown'}, '',
      {digest: first.digest, step: 'handoff', status: 'passed', command: 'python', output: 'OK', truncated: false});
    assert.equal(handoff.check.state, 'current');
    assert.ok(handoff.files.some(f => f.path === 'data/edge.json'));
  } finally { await rm(root, {recursive: true, force: true}); }
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
      for (const step of plan.steps) {
        assert.ok(checkArguments(step).length > 1);
        for (const [path, anchor] of Object.entries(step.anchors ?? {}))
          assert.ok((await readFile(join(folder, path), 'utf8')).includes(anchor), `${id}/${step.id}: ${path} contains ${anchor}`);
      }
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
        const retrieved = await projectSnapshot(folder, plan, ['README.md'], undefined, {}, 'Explain rich/_loop.py and its tests');
        assert.equal(retrieved.files[0].path, 'rich/_loop.py', 'non-curated manifest source can be retrieved');
        assert.ok(retrieved.structure.files.includes('rich/_loop.py'));
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

test('cancellation also stops the marked check process inside the container', async () => {
  const plan = await curriculum(), controller = new AbortController(), calls: {command: string; args: string[]}[] = [];
  const promise = runProjectCheck(starter, plan.steps[1], 'snapshot', controller.signal, {bin: process.execPath, execArgs: (_cwd, command, args) => {
    calls.push({command, args});
    return command === 'timeout' ? ['-e', 'setInterval(()=>{},1000)'] : ['-e', ''];
  }});
  setTimeout(() => controller.abort(), 150);
  assert.equal((await promise).status, 'runtime_error');
  assert.equal(calls.length, 2);
  const marker = calls[0].args[4].replace('dhimantai_check=', '');
  assert.equal(calls[1].command, 'python'); assert.equal(calls[1].args[0], '-c');
  assert.equal(calls[1].args[2], marker);
  assert.ok(!calls[1].args[1].includes('dhimantai_check=' + marker), 'the stopper never matches its own command line');
  assert.match(calls[1].args[1], /killpg/);
});

test('container start failures are runtime errors with setup recovery; timeouts and exits keep their meaning', async () => {
  const step = (await curriculum()).steps[1];
  assert.deepEqual([0, 1, 2, 124, 125, 126, 127, 137, null].map(code => checkStatus(code)),
    ['passed', 'failed', 'failed', 'timed_out', 'runtime_error', 'runtime_error', 'runtime_error', 'timed_out', 'failed']);
  assert.equal(checkStatus(0, true), 'timed_out');
  for (const code of [125, 126, 127]) {
    const run = await runProjectCheck(starter, step, 'snapshot', new AbortController().signal,
      {bin: process.execPath, execArgs: () => ['-e', `process.stderr.write('Error: no container with name or ID found\\n', () => process.exit(${code}))`]});
    assert.equal(run.status, 'runtime_error');
    assert.match(run.output, /Set up course/);
    assert.equal(run.diagnostic, undefined);
  }
});

test('trimmed check output never starts with half of a surrogate pair', async () => {
  const text = 'a' + '😀'.repeat(3000);
  for (const limit of [3999, 4000]) {
    const tail = tailText(text, limit);
    assert.ok(tail.length <= limit);
    assert.doesNotMatch(tail, /^[\uDC00-\uDFFF]/);
    assert.equal(Buffer.from(tail, 'utf8').toString('utf8'), tail, 'round-trips as valid UTF-8');
  }
  const step = (await curriculum()).steps[1];
  const run = await runProjectCheck(starter, step, 'snapshot', new AbortController().signal,
    {bin: process.execPath, execArgs: () => ['-e', `process.stdout.write('x' + '😀'.repeat(2500), () => process.exit(1))`]});
  assert.ok(run.truncated);
  assert.doesNotMatch(run.output, /^[\uDC00-\uDFFF]/);
});

test('the final checker is shown with a short command that fits the handoff contract', () => {
  assert.ok(checkCommand({check: 'final:agent'}).length <= 300);
  assert.equal(checkCommand({check: 'shelf:capstone'}), 'python check.py');
  assert.equal(checkCommand({check: 'checks.test_tools'}), 'python -m unittest checks.test_tools -v');
});
