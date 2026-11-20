import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, realpath, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectRuntime, prepareProjectDependencies} from '../src/projectRuntime';
import type {CourseEngine} from '../src/courseEngine';
import type {ProjectCurriculum} from '../src/projectCore';

test('Shelf selects Python and a guided project combines its own language and dependency manifests', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'project-tools-')));
  t.after(() => rm(folder,{recursive:true,force:true}));
  const curriculum: ProjectCurriculum = {id:'shelf', title:'Shelf', version:1, files:[], steps:[]};
  const shelf = await projectRuntime(folder,curriculum);
  assert.deepEqual(shelf.languages,['python']);
  assert.equal(shelf.bundled,true);
  await writeFile(join(folder,'package.json'),'{}');
  await writeFile(join(folder,'tsconfig.json'),'{}');
  await writeFile(join(folder,'requirements.txt'),'');
  const project = await projectRuntime(folder,{...curriculum, id:'skilling-project', mode:'guided', language:'java'});
  assert.deepEqual(new Set(project.languages),new Set(['java','javascript','typescript','python']));
  assert.equal(project.bundled,false);
});

test('an unchanged project reuses verified dependencies, and a linked dependency manifest is rejected', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'project-deps-')));
  t.after(() => rm(folder,{recursive:true,force:true}));
  const project = await projectRuntime(folder,{id:'shelf', title:'Shelf', version:1, files:[], steps:[]});
  const commands: string[] = [];
  const engine = {bin:process.execPath, execArgs:(_root:string, tool:string, args:string[]) => {
    commands.push([tool,...args].join(' '));
    return ['-e','process.exit(0)'];
  }} as CourseEngine;
  const fingerprint = await prepareProjectDependencies(engine, project);
  assert.equal(commands.length,2);
  assert.equal(await prepareProjectDependencies(engine, project, fingerprint),fingerprint);
  assert.equal(commands.length,2);
  await writeFile(join(folder,'requirements.txt'),'packaging==24.2');
  assert.notEqual(await prepareProjectDependencies(engine, project, fingerprint),fingerprint);
  assert.ok(commands.includes('python -m pip install -r requirements.txt'));
  await symlink(join(folder,'requirements.txt'),join(folder,'go.mod'));
  await assert.rejects(prepareProjectDependencies(engine, project),/Invalid project dependency manifest/);
});
