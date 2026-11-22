import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitProject, gitProjects } from '../src/gitPractice';
import { createGitProject, loadProjectCurriculum, projectIdentity, projectSnapshot } from '../src/projectCore';
import { submitProject } from '../src/projectResults';
import { validateProjectWorkspace } from '../src/projectSetup';

const media = join(__dirname,'../../media');
for (const project of Object.keys(gitProjects) as GitProject[]) {
  test(project + ' verifies the actual parents, commits and combined tree without changing the repository', async () => {
    const parent = await mkdtemp(join(tmpdir(),'git-practice-')), root=join(parent,project);
    try {
      await createGitProject(media,project,root);
      assert.equal(await projectIdentity(root),project);
      const personal = await loadProjectCurriculum(media,'personal-project');
      assert.equal((await projectSnapshot(root,personal,[],new Map(),{},'',undefined,true)).git?.practice_starter,project);
      await validateProjectWorkspace(media,project,root);
      const plan = await loadProjectCurriculum(media,project), spec=plan.gitPractice!;
      const git = (...args:string[]) => execFileSync('git',['-c','user.name=Student','-c','user.email=student@example.invalid',
        '-c','commit.gpgsign=false','-c','core.hooksPath=',...args],{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
      const put = (file:string,value:unknown) => writeFile(join(root,file),JSON.stringify(value)+'\n');
      const check = async () => {
        const before = git('status','--porcelain=v1'), head = git('rev-parse','HEAD');
        const result = await submitProject(root,plan,{coachTurns:0,otherHelp:'unknown'},'',new AbortController().signal,undefined);
        assert.equal(git('status','--porcelain=v1'),before);
        assert.equal(git('rev-parse','HEAD'),head);
        return result.runs[0].gitEvidence;
      };
      const empty = {skills:[],complete:false};
      assert.deepEqual(await check(),empty);
      git('switch','-c','student/work');
      assert.deepEqual(await check(),empty);
      git('commit','--allow-empty','-m','Start the review');
      assert.deepEqual(await check(),empty);
      git('reset','--soft',spec.base);
      await put(spec.policy,spec.local);
      git('add',spec.policy); git('commit','-m','Adjust the local policy');
      assert.deepEqual(await check(),{skills:['branch'],complete:false});
      await put(spec.other,spec.otherValue); git('add',spec.other); git('commit','-m','Move the meeting location');
      assert.deepEqual(await check(),{skills:['branch','commits'],complete:false});
      git('commit','--amend','-m','wip');
      assert.deepEqual(await check(),{skills:['branch'],complete:false});
      git('commit','--amend','-m','Set the pickup location');
      const preMerge = git('rev-parse','HEAD');
      assert.throws(() => git('merge','--no-edit','team/operations'));
      assert.match(await readFile(join(root,spec.policy),'utf8'),/<<<<<<< HEAD/);
      assert.deepEqual(await check(),{skills:['branch','commits'],complete:false});
      git('checkout','--theirs','--',spec.policy); git('add',spec.policy); git('commit','--no-edit');
      assert.deepEqual(await check(),{skills:['branch','commits'],complete:false});
      await put(spec.policy,spec.combined); git('add',spec.policy); git('commit','--amend','--no-edit');
      const complete = {skills:['branch','commits','conflict'],complete:true};
      assert.deepEqual(await check(),complete);
      const hash = async () => (await projectSnapshot(root,plan,[])).digest;
      const finished = await hash();
      await writeFile(join(root,'scratch.txt'),'unrelated change');
      assert.equal((await check())?.complete,false);
      await rm(join(root,'scratch.txt'));
      git('switch','--detach','HEAD');
      assert.notEqual(await hash(),finished);
      assert.deepEqual(await check(),empty);
      git('switch','student/work');
      git('branch','-f','main',preMerge);
      assert.notEqual(await hash(),finished);
      assert.deepEqual(await check(),empty);
      git('branch','-f','main',spec.base);
      git('switch','-c','student/mixed','main');
      await put(spec.policy,spec.local); await put(spec.other,spec.otherValue);
      git('add','--',spec.policy,spec.other); git('commit','-m','Apply both requests together');
      assert.throws(() => git('merge','--no-edit','team/operations'));
      await put(spec.policy,spec.combined); git('add',spec.policy); git('commit','--no-edit');
      assert.deepEqual(await check(),{skills:['branch','conflict'],complete:false});
    } finally { await rm(parent,{recursive:true,force:true}); }
  });
}
