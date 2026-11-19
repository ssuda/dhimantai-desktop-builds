import {authoredConfiguration} from './authoredConfiguration';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareColabNotebooks as prepare, tpuLessonCell, validateCourseLabs } from '../src/colabNotebooks';

const prepareColabNotebooks:typeof prepare=(labs,dir,environment,course='Build an LLM from Scratch',provider='google.colab')=>{const c=authoredConfiguration(course);return prepare(labs,dir,environment,course,provider,c.preferred_accelerator??undefined,c.external_guidance??undefined);};

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

test('published course configuration supplies the accelerator without a desktop course list', () => {
  assert.equal(authoredConfiguration('Inference Engineering').preferred_accelerator, 'gpu');
  assert.equal(authoredConfiguration('Developing Speech-to-Text Models').preferred_accelerator, 'gpu');
  assert.equal(authoredConfiguration('Transformers Foundations').preferred_accelerator, 'gpu');
  assert.equal(authoredConfiguration('Build an LLM from Scratch').preferred_accelerator, 'tpu');
  assert.equal(authoredConfiguration('Developing TTS Models with IndicSpeak').preferred_accelerator, 'gpu');
  for (const course of ['constructor', '__proto__', 'deepinfra', 'Python']) assert.equal(!!authoredConfiguration(course).preferred_accelerator, false);
});

test('IndicSpeak opens Colab GPU labs with its own setup and preserves learner work', async () => {
  const {realpath} = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'indicspeak-colab-')));
  try {
    const directory = join(root, 'colab');
    const source = {name:'01-foundations.ipynb', notebook:{nbformat:4, nbformat_minor:5, metadata:{}, cells:[
      {id:'title', cell_type:'markdown', source:'# TTS foundations', metadata:{}},
      {id:'setup', cell_type:'code', source:'from tts_runtime import setup\nsetup()', metadata:{}, outputs:['old'], execution_count:3}
    ]}};
    const names = await prepareColabNotebooks([source], directory, 'staging', 'Developing TTS Models with IndicSpeak');
    assert.deepEqual(names, ['00-colab-gpu.ipynb','01-foundations.ipynb']);
    const notebook = JSON.parse(await readFile(join(directory, source.name), 'utf8'));
    assert.equal(notebook.metadata.dhimantai_runtime.provider, 'google.colab');
    assert.equal(notebook.metadata.dhimantai_runtime.accelerator, 'gpu');
    assert.match(notebook.cells[0].source, /Colab.*default/);
    assert.doesNotMatch(JSON.stringify(notebook), /DeepInfer|TorchTPU|colab-tpu-setup/);
    const code = notebook.cells.find((cell:any) => cell.id === 'setup');
    assert.equal(code.source, source.notebook.cells[1].source);
    assert.deepEqual(code.outputs, []);
    await writeFile(join(directory, source.name), 'student edits');
    await prepareColabNotebooks([source], directory, 'staging', 'Developing TTS Models with IndicSpeak');
    assert.equal(await readFile(join(directory, source.name), 'utf8'), 'student edits');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('STT Colab export uses speech guidance and preserves authored code and edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stt-colab-'));
  try {
    const {realpath} = await import('node:fs/promises');
    const dir = join(await realpath(root), 'colab');
    const labs = [{name:'04-indictranscribe.ipynb', notebook: {
      nbformat:4, nbformat_minor:5, metadata:{}, cells:[
        {id:'title',cell_type:'markdown',source:'# IndicTranscribe',metadata:{}},
        {id:'run',cell_type:'code',source:'print("speech")',metadata:{},outputs:['old'],execution_count:1}
      ]
    }}];
    const names = await prepareColabNotebooks(labs, dir, 'staging', 'Developing Speech-to-Text Models');
    assert.deepEqual(names, ['00-colab-gpu.ipynb', '04-indictranscribe.ipynb']);
    const path = join(dir, names[1]);
    const result = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(result.metadata.dhimantai_runtime.provider, 'google.colab');
    assert.equal(result.metadata.dhimantai_runtime.accelerator, 'gpu');
    assert.match(result.cells[0].source, /Colab is the default/);
    assert.match(result.cells[0].source, /IndicTranscribe/);
    assert.doesNotMatch(result.cells[0].source, /DeepInfer|vLLM|TorchTPU/);
    assert.equal(result.cells.find((c:any) => c.id === 'run').source, 'print("speech")');
    assert.deepEqual(result.cells.find((c:any) => c.id === 'run').outputs, []);
    await writeFile(path, 'student notes');
    await prepareColabNotebooks(labs, dir, 'staging', 'Developing Speech-to-Text Models');
    assert.equal(await readFile(path, 'utf8'), 'student notes');
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('Transformers export keeps CPU labs and the optional Colab GPU switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'transformers-colab-'));
  try {
    const {realpath} = await import('node:fs/promises');
    const dir = join(await realpath(root), 'colab');
    const sources = [{name:'04-training.ipynb', notebook:{nbformat:4, nbformat_minor:5, metadata:{}, cells:[
      {id:'title', cell_type:'markdown', source:'# Tiny Transformer', metadata:{}},
      {id:'optional', cell_type:'code', source:'RUN_COLAB_GPU = False', metadata:{}, outputs:['old'], execution_count:1}
    ]}}];
    const names = await prepareColabNotebooks(sources, dir, 'staging', 'Transformers Foundations');
    assert.deepEqual(names, ['00-colab-gpu.ipynb', '04-training.ipynb']);
    const lab = JSON.parse(await readFile(join(dir, names[1]), 'utf8'));
    assert.equal(lab.metadata.dhimantai_runtime.provider, 'google.colab');
    assert.equal(lab.metadata.dhimantai_runtime.accelerator, 'gpu');
    assert.match(lab.cells[0].source, /core PyTorch labs run on CPU/);
    assert.doesNotMatch(lab.cells[0].source, /vLLM|IndicSpeak|DeepInfer|TorchTPU/);
    const cell = lab.cells.find((c:any) => c.id === 'optional');
    assert.equal(cell.source, 'RUN_COLAB_GPU = False');
    assert.deepEqual(cell.outputs, []);
    await writeFile(join(dir, names[1]), 'student experiment');
    await prepareColabNotebooks(sources, dir, 'staging', 'Transformers Foundations');
    assert.equal(await readFile(join(dir, names[1]), 'utf8'), 'student experiment');
  } finally { await rm(root, {recursive:true, force:true}); }
});
