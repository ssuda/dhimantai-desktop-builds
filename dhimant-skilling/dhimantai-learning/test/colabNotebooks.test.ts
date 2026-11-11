import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { courseAccelerator, hasColabLabs, prepareColabNotebooks, tpuLessonCell, validateCourseLabs } from '../src/colabNotebooks';

test('Colab copies retain seven authored labs and Instructor scope, with no outputs or local CPU installs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dhimantai-colab-'));
  const labs = resolve(__dirname, '../../media/course/labs');
  try {
    // Resolve macOS /var -> /private/var as production courseDirectory does.
    const { realpath } = await import('node:fs/promises');
    const dir = join(await realpath(root), 'colab');
    const names = await prepareColabNotebooks(labs, dir, 'staging');
    assert.equal(names.length, 8);
    for (const name of names) {
      const notebook = JSON.parse(await readFile(join(dir, name), 'utf8'));
      assert.equal(notebook.metadata.dhimantai_coach.environment, 'staging');
      assert.equal(notebook.metadata.dhimantai_runtime.accelerator, 'tpu');
      const setup = notebook.cells.find((c: any) => c.id === 'colab-tpu-setup');
      assert.match(setup.source, /device=DEVICE/);
      assert.doesNotMatch(setup.source, /pip install|torch_xla|cuda/);
      for (const cell of notebook.cells.filter((c: any) => c.cell_type === 'code')) {
        assert.deepEqual(cell.outputs, []);
        assert.equal(cell.execution_count, null);
      }
      if (name.startsWith('00')) continue;
      const original = JSON.parse(await readFile(join(labs, name), 'utf8'));
      for (const cell of original.cells) {
        const copy = notebook.cells.find((c: any) => c.id === cell.id);
        assert.equal(copy.source, cell.cell_type === 'code' ? tpuLessonCell(cell.source) : cell.source);
      }
    }
    const edited = join(dir, names[1]);
    await writeFile(edited, 'learner edits and saved output');
    await prepareColabNotebooks(labs, dir, 'staging');
    assert.equal(await readFile(edited, 'utf8'), 'learner edits and saved output');
    assert.deepEqual((await readdir(dir)).sort(), names.sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Colab setup rejects linked destination folders before writing notebooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dhimantai-colab-links-'));
  try {
    await symlink(root, join(root, 'colab'), 'dir');
    await assert.rejects(prepareColabNotebooks('unused', join(root, 'colab'), 'production'), /inside the course/);
    assert.deepEqual(await readdir(root), ['colab']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('free course export writes only the entitled chapter and does not link locked labs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dhimantai-colab-free-'));
  const labs = resolve(__dirname, '../../media/course/labs');
  try {
    const { realpath } = await import('node:fs/promises');
    const dir = join(await realpath(root), 'colab');
    const entitled = [{name:'01-environment.ipynb',notebook:JSON.parse(await readFile(join(labs,'01-environment.ipynb'),'utf8'))}];
    const names = await prepareColabNotebooks(entitled, dir, 'staging');
    assert.deepEqual(names, ['00-colab-tpu.ipynb', '01-environment.ipynb']);
    assert.deepEqual((await readdir(dir)).sort(), names);
    const setup = JSON.parse(await readFile(join(dir, names[0]), 'utf8'));
    assert.doesNotMatch(JSON.stringify(setup), /02-text-data|03-attention/);
    await assert.rejects(prepareColabNotebooks([], dir, 'staging'), /invalid course labs/);
    assert.throws(() => validateCourseLabs([{...entitled[0],name:'../outside.ipynb'}]), /invalid course labs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('inference GPU notebooks retain authored code, all eight chapters, and learner edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inference-colab-'));
  try {
    const {realpath} = await import('node:fs/promises');
    const dir = join(await realpath(root), 'colab');
    const sources = Array.from({length: 8}, (_, i) => ({name: `0${i + 1}-lesson.ipynb`, notebook: {
      nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
        {id:'title', cell_type:'markdown', source:'# Inference lesson', metadata:{}},
        {id:'gpu', cell_type:'code', source:'from vllm import LLM\nprint("gpu")', metadata:{}, outputs:['old output'], execution_count:4}
      ]
    }}));
    const names = await prepareColabNotebooks(sources, dir, 'staging', 'Inference Engineering');
    assert.equal(names.length, 9);
    assert.equal(names[0], '00-colab-gpu.ipynb');
    const first = JSON.parse(await readFile(join(dir, names[1]), 'utf8'));
    assert.equal(first.metadata.dhimantai_runtime.accelerator, 'gpu');
    assert.equal(first.metadata.dhimantai_coach.environment, 'staging');
    assert.equal(first.cells.find((c:any) => c.id === 'gpu').source, sources[0].notebook.cells[1].source);
    assert.deepEqual(first.cells.find((c:any) => c.id === 'gpu').outputs, []);
    assert.doesNotMatch(JSON.stringify(first), /TorchTPU|colab-tpu-setup|with torch.device/);
    await writeFile(join(dir, names[1]), 'saved learner edits');
    await prepareColabNotebooks(sources.slice(0,1), dir, 'staging', 'Inference Engineering');
    assert.equal(await readFile(join(dir, names[1]), 'utf8'), 'saved learner edits');
    await assert.rejects(prepareColabNotebooks(sources, dir, 'staging', 'Unknown'), /No external runtime labs/);
    const ownNames = await prepareColabNotebooks(sources.slice(0, 1), join(await realpath(root), 'gpu'), 'staging', 'Inference Engineering', 'jupyter');
    assert.equal(ownNames[0], '00-gpu-runtime.ipynb');
    const own = JSON.parse(await readFile(join(root, 'gpu', ownNames[1]), 'utf8'));
    assert.equal(own.metadata.dhimantai_runtime.provider, 'jupyter');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('course accelerators use explicit course names, including normalized GPU names', () => {
  assert.equal(courseAccelerator(' Inference Engineering '), 'gpu');
  assert.equal(courseAccelerator('Build an LLM from Scratch'), 'tpu');
  for (const course of ['constructor', '__proto__', 'deepinfra', 'Python']) assert.equal(hasColabLabs(course), false);
});
