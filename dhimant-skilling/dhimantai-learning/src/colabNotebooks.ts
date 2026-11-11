import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnvironmentName } from './environments';

interface Cell {
  id: string;
  cell_type: string;
  source: string | string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
}
interface Notebook { nbformat: number; nbformat_minor: number; metadata: Record<string, any>; cells: Cell[] }
export interface CourseLab { name: string; notebook: Notebook }
export function validateCourseLabs(labs: CourseLab[]): CourseLab[] {
  if (!Array.isArray(labs) || labs.length < 1 || labs.length > 16 || new Set(labs.map(l => l.name)).size !== labs.length
      || labs.some(l => !/^\d\d-[a-z0-9-]+\.ipynb$/.test(l.name) || l.notebook?.nbformat !== 4
        || !Array.isArray(l.notebook.cells) || !l.notebook.cells.length || !l.notebook.metadata)) {
    throw new Error('The service returned invalid course labs. Refresh your courses and try again.');
  }
  return labs;
}
const sourceText = (source: string | string[]) => Array.isArray(source) ? source.join('') : source;
const code = (id: string, source: string): Cell => ({ id, cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null });
const markdown = (id: string, source: string): Cell => ({ id, cell_type: 'markdown', source, metadata: {} });

export const TPU_SETUP = `_dhimantai_tpu_ready = False
import torch

# Current Colab TPU images include TorchTPU, which registers torch's "tpu" backend.
# Do not install the course's local CPU requirements in this remote kernel.
if not hasattr(torch, "tpu"):
    raise RuntimeError("TorchTPU is missing. Select Colab > New Colab Server > TPU with the current runtime image, then restart this notebook's kernel.")
try:
    DEVICE = torch.device("tpu:0")
    probe = torch.ones((2, 2), device=DEVICE)
    result = (probe @ probe).cpu()  # Materialize the computation before reporting success.
    if probe.device.type != "tpu" or not torch.equal(result, torch.full((2, 2), 2.0, device="cpu")):
        raise RuntimeError("The TPU computation did not match the expected result.")
    # These lessons use full float32 precision to check small numerical examples.
    with torch.tpu.precision(torch.tpu.Precision.HIGHEST):
        pass
except Exception as error:
    raise RuntimeError("TPU setup failed. Check the selected Colab server and restart the kernel before retrying. No CPU fallback was selected.") from error
_dhimantai_tpu_ready = True
print(f"TPU verified: {probe.device} | PyTorch {torch.__version__}")
`;

const guard = `if not globals().get("_dhimantai_tpu_ready", False):
    raise RuntimeError("Run the TPU setup cell successfully before this lesson cell.")
`;

// A device context puts both tensor factories and newly constructed module
// parameters on TPU. It ends with the cell, so other notebooks keep their defaults.
export function tpuLessonCell(source: string) {
  return guard + 'with torch.device(DEVICE), torch.tpu.precision(torch.tpu.Precision.HIGHEST):\n' +
    '    pass  # Keeps an empty practice cell runnable.\n' +
    source.split('\n').map(line => '    ' + line).join('\n') + '\n';
}

const steps = `## Run this notebook on Colab TPU

Choose **Use Colab Kernel** in the notebook toolbar, then **Select Another Kernel → Colab → New Colab Server → TPU**. Complete Google sign-in when prompted. Run the setup cell below before the lesson cells, including after every kernel restart.

These small lessons use one TPU device. Each code cell sets its tensor and model device explicitly through a PyTorch device context. Pure Python text processing still runs on the remote CPU. Small examples may be slower on TPU because of compilation overhead.

Your notebook stays on this computer; code executes on Colab. Local data files are not uploaded automatically. Use Explorer's **Upload to Colab** for data, and download checkpoints or save them to Google Drive before removing the server. When finished, use **Colab: Remove Server** to release it. Reopening a notebook does not restore its remote memory.

[Colab connection and file guide](https://github.com/googlecolab/colab-vscode/wiki/User-Guide) · [TorchTPU documentation](https://torchtpu.readthedocs.io/en/latest/)
`;

export function courseAccelerator(course: string): 'tpu' | 'gpu' | undefined {
  switch (course.trim().toLowerCase()) {
    case 'build an llm from scratch': return 'tpu';
    case 'inference engineering': return 'gpu';
    default: return undefined;
  }
}
export const hasColabLabs = (course: string) => !!courseAccelerator(course);

const gpuSteps = `## Connect a GPU runtime

In Instructor's **Notebook runtime** dropdown choose **Google Colab**, then **Select Another Kernel → Colab → New Colab Server → GPU**. Complete your own Google sign-in. GPU availability and usage depend on your account.

For your own Linux GPU machine, choose **Your GPU / Jupyter server**, then **Select Another Kernel → Existing Jupyter Server** (or its local Python environment). Follow Chapter 1 for Jupyter and SSH tunnel setup. The notebook's preflight verifies the actual GPU before installing or running vLLM.

Code runs on the selected machine; notebooks stay on this computer. Upload required files separately and download result files before stopping the runtime. Colab: Remove Server releases a Colab allocation. Stop your own Jupyter process and rented GPU separately when finished.

vLLM labs execute the engine directly without a hosted inference API. DeepInfer's current SM100 / Ascend 950 deployment requires separate compatible hardware; its source and planning exercises can be studied here.
`;

export async function prepareColabNotebooks(labs: string | CourseLab[], directory: string, environment: EnvironmentName, course = 'Build an LLM from Scratch', provider: 'google.colab' | 'jupyter' = 'google.colab') {
  const accelerator = courseAccelerator(course);
  if (!accelerator) throw new Error('No external runtime labs are available for this course.');
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('The Colab notebook folder must be inside the course.');
  const sources = typeof labs === 'string' ? await Promise.all((await readdir(labs))
    .filter(name => /^\d\d-.*\.ipynb$/.test(name)).sort().map(async name =>
      ({name, notebook: JSON.parse(await readFile(join(labs, name), 'utf8')) as Notebook}))) : validateCourseLabs(labs);
  const notebooks: {name: string; notebook: Notebook}[] = [];
  for (const {name, notebook: original} of sources) {
    const title = sourceText(original.cells[0].source).split('\n')[0].replace(/^#+ /, '');
    const notebook: Notebook = {
      ...original,
      metadata: { ...original.metadata,
        dhimantai_runtime: { provider, accelerator, version: 1 },
        dhimantai_coach: { version: 1, environment, path: '/notebook-coach/tutor', question: title },
      },
      cells: [markdown('colab-guide', accelerator === 'tpu' ? steps : gpuSteps),
        ...(accelerator === 'tpu' ? [code('colab-tpu-setup', TPU_SETUP)] : []), ...original.cells.map(cell =>
        cell.cell_type === 'code'
          ? { ...cell, source: accelerator === 'tpu' ? tpuLessonCell(sourceText(cell.source)) : sourceText(cell.source), outputs: [], execution_count: null }
          : cell)],
    };
    notebooks.push({name, notebook});
  }
  if (!notebooks.length) throw new Error('No labs are unlocked. Open Pricing & Purchases to unlock the course.');
  const setup: Notebook = {
    nbformat: 4, nbformat_minor: 5,
    metadata: { ...notebooks[0].notebook.metadata,
      dhimantai_coach: { version: 1, environment, path: '/notebook-coach/tutor', question: `Set up ${course} on ${accelerator.toUpperCase()}` } },
    cells: [markdown('intro', `# ${course} — ${accelerator.toUpperCase()} runtime\n\n` + (accelerator === 'tpu' ? steps : gpuSteps)),
      ...(accelerator === 'tpu' ? [code('colab-tpu-setup', TPU_SETUP)] : []),
      markdown('lessons', '## Open a lesson\n\nEach notebook has its own kernel selection and setup cell. Choose **Open Course with Colab Runtime** again to select a lesson, or open one of these files:\n\n' +
        notebooks.map(({name}) => `- [${name}](${name})`).join('\n'))],
  };
  notebooks.unshift({name: provider === 'google.colab' ? `00-colab-${accelerator}.ipynb` : `00-${accelerator}-runtime.ipynb`, notebook: setup});
  for (const {name, notebook} of notebooks) {
    try { await writeFile(join(directory, name), JSON.stringify(notebook, null, 2), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  return notebooks.map(({name}) => name);
}
