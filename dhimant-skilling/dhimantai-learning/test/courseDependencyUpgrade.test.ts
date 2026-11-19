import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {courseRecipe, Recipe} from '../src/courseRecipe';

test('existing speech-to-text workspace gets the new package and a new image fingerprint without losing files', async () => {
  const filename = resolve(__dirname, '../src/courseWorkspace.js'), exports:any = {};
  const nativeRequire = createRequire(filename);
  const stubs = new Set(['vscode', './podman', './courseEngine', './courseRecovery', './courseDebug',
    './courseReadiness', './courseTerminal', './colab', './colabNotebooks', './notebookKernelPicker']);
  runInNewContext(readFileSync(filename, 'utf8'), {exports, process,
    require:(name:string) => stubs.has(name) ? {} : nativeRequire(name)});
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stt-upgrade-')));
  try {
    const courses = Object.create(exports.CourseWorkspaces.prototype);
    courses.media = resolve(__dirname, '../../media/course');
    const profiles = JSON.parse(await readFile(join(__dirname,'../../../../content/courses/runtime-profiles.json'), 'utf8'));
    const current = courseRecipe(profiles, 'Developing Speech-to-Text Models');
    let recipe:Recipe = {...current, services:[], requirements:['numpy==2.1.3'], imports:['torch', 'numpy']};
    courses.recipe = async () => recipe;
    courses.configuration = async () => ({scenarios:{version:1,scenarios:[]}});
    await courses.writeRecipe({root});
    const original = '# Custom learner dependency\nnumpy==2.1.3\nrequests==2.32.3\n';
    await writeFile(join(root, 'requirements.txt'), original);
    await writeFile(join(root, 'my-notebook.ipynb'), 'learner work');
    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8') + '\n# learner comment\n';
    await writeFile(join(root, 'Dockerfile'), dockerfile);
    const before = await courses.writeRecipe({root});
    recipe = current;
    const after = await courses.writeRecipe({root});
    assert.notEqual(after, before, 'the old image must not be reused after dependencies change');
    assert.equal(await readFile(join(root, 'requirements.txt'), 'utf8'), original + 'transformers==4.57.6\n');
    assert.equal(await readFile(join(root, 'my-notebook.ipynb'), 'utf8'), 'learner work');
    assert.equal(await readFile(join(root, 'Dockerfile'), 'utf8'),
      dockerfile.replace('for item in python;', 'for item in python audio;'));
    assert.equal(await courses.writeRecipe({root}), after, 'repeated setup must be stable');
  } finally {await rm(root, {recursive:true, force:true});}
});
