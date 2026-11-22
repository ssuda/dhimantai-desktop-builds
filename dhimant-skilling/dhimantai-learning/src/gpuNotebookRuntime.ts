import * as vscode from 'vscode';
import type {SshGpuRuntime} from './sshGpuRuntime';
import type {CloudGpuRuntime} from './cloudGpuRuntime';
import type {GpuLabRequirement} from './sshRuntimeConfig';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chooseColabKernel, ensureColab} from './colab';
import {COLAB_SETUP_STEPS} from './colabSetup';
import {withHostMarker} from './hostRuntimeCheck';
import {openNotebookKernelPicker} from './notebookKernelPicker';
import type {CellOptions} from './notebookCells';
import type {Execution} from './api';

export const GPU_RUNTIMES = {
  ssh:'SSH · Your GPU machines', 'cloud-cli':'Cloud · Spot GPUs',
  colab: 'Google Colab · GPU',
  cloud: 'Cloud GPU · Jupyter',
  jupyter: 'Your GPU · Jupyter',
} as const;
export type GpuRuntime = keyof typeof GPU_RUNTIMES;
export const isGpuRuntime = (value: unknown): value is GpuRuntime => typeof value === 'string' && Object.hasOwn(GPU_RUNTIMES, value);
export const GPU_COST_NOTICE = 'Students must have access to their own GPU compute. Cloud compute, storage and network costs are separate from the course fee and paid by the student.';

// Public Microsoft Jupyter Kernels API. Google/Jupyter retain all connection credentials.
interface Kernel {
  readonly status: string;
  readonly language: string;
  executeCode(code: string, token: vscode.CancellationToken): AsyncIterable<{items: {mime: string; data: Uint8Array}[]}>;
}
interface JupyterApi { kernels: {getKernel(uri: vscode.Uri): Thenable<Kernel | undefined>} }
const marker = 'DHIMANTAI_GPU_READY';
const stdoutMime = new Set(['application/vnd.code.notebook.stdout', 'application/x.notebook.stream.stdout']);
const stderrMime = new Set(['application/vnd.code.notebook.stderr', 'application/x.notebook.stream.stderr']);
export function gpuRequirements(requirement?:GpuLabRequirement) {
  const count=requirement?requirement.nodes*requirement.gpusPerNode:1;
  const capability=requirement?.minComputeCapability??7.5, memory=requirement?.minVramMiB??6000;
  return `This lab requires ${count} Linux NVIDIA GPU${count===1?'':'s'}, each with compute capability ${capability.toFixed(1)} or newer and at least ${memory} MiB VRAM.`
    + (capability>=8 ? ' A T4 (compute capability 7.5) cannot run this recipe. Select compatible hardware such as L4/A100 with enough memory.' : '')
    + ' Passing this hardware check does not guarantee enough memory for every model; run the lesson preflight before training.';
}

const probeErrorMarker='DHIMANTAI_GPU_ERROR:';
/** Surface the probe's recovery message in Instructor as well as the connection notebook. */
export function gpuProbeFailure(output:string) {
  for(const line of output.split(/\r?\n/)) {
    if(line.startsWith('DHIMANTAI_GPU_ERROR ')) {
      try {const message:unknown=JSON.parse(line.slice('DHIMANTAI_GPU_ERROR '.length));
        if(typeof message==='string')return message.slice(0,2000);
      } catch { /* Older probe output may be truncated. */ }
    }
    if(!line.startsWith(probeErrorMarker))continue;
    try {
      const error=JSON.parse(line.slice(probeErrorMarker.length));
      if(typeof error.message==='string' && error.message.length<=2000)return error.message;
    } catch { /* Older kernels and non-probe output use the generic recovery below. */ }
  }
  return 'GPU connection check failed. Read the connection notebook output, select a compatible GPU kernel and retry.';
}
export function gpuProbe(provider: GpuRuntime, requirement?:GpuLabRequirement, hostPaths: string[] = [], bootHash?: string) {
  const recovery=provider==='colab'
    ? 'In Select Kernel, choose Colab > New Colab Server > GPU, select a compatible allocation, then choose Google Colab again in Instructor to retry. If your account cannot allocate it, use your own compatible GPU via Jupyter.'
    : 'Select a compatible Linux GPU Jupyter server, then choose this runtime again in Instructor to retry.';
  return `import hashlib, json, os, platform, subprocess

def _dhimantai_gpu_error(message):
    print('${probeErrorMarker}' + json.dumps({'message': message}), flush=True)
    raise RuntimeError(message)

${provider === 'colab' ? `if 'COLAB_RELEASE_TAG' not in os.environ:
    _dhimantai_gpu_error('This is not a Colab runtime. Choose Use Colab Kernel in the notebook toolbar, then Select Another Kernel > Colab > New Colab Server > GPU > Python 3 (ipykernel). If Colab is missing, enable Google Colab and Microsoft Jupyter in Extensions and reload the app. GPU availability has not been checked.')
` : ''}if platform.system() != 'Linux':
    _dhimantai_gpu_error('The kernel connected, but this lab needs Linux. ${recovery}')
course_container = os.path.isfile('/opt/dhimantai/runner.cjs') and any(os.path.isfile(p) for p in ('/run/.containerenv', '/.dockerenv'))
if not course_container:
    same_host = any(os.path.isdir(path) for path in ${JSON.stringify(hostPaths)})
${bootHash ? `    with open('/proc/sys/kernel/random/boot_id', 'rb') as boot:
        same_host = same_host or hashlib.sha256(boot.read()).hexdigest() == ${JSON.stringify(bootHash)}
` : ''}    if same_host:
        _dhimantai_gpu_error('This kernel is running on the desktop host. Connect a remote GPU server or select the course container.')
visible = os.environ.get('CUDA_VISIBLE_DEVICES')
if visible is not None and visible.strip() in ('', '-1'):
    _dhimantai_gpu_error('The kernel connected, but no CUDA devices are visible. ${recovery}')
try:
    report = subprocess.check_output(['nvidia-smi', '--query-gpu=name,compute_cap,memory.total', '--format=csv,noheader,nounits'] + (['--id=' + visible] if visible is not None else []), text=True, timeout=20)
except (OSError, subprocess.SubprocessError):
    _dhimantai_gpu_error('The kernel connected, but its NVIDIA GPU could not be queried. Check the GPU allocation and NVIDIA driver. ${recovery}')
print(report)
try:
    devices = [row.rsplit(',', 2) for row in report.strip().splitlines()]
    compatible = sum(float(capability) >= ${requirement?.minComputeCapability??7.5} and float(memory) >= ${requirement?.minVramMiB??6000} for _, capability, memory in devices)
except ValueError:
    _dhimantai_gpu_error('The kernel connected, but GPU detection returned an unreadable report. Check the NVIDIA driver and connection notebook output before retrying.')
if compatible < ${requirement?requirement.nodes*requirement.gpusPerNode:1}:
    _dhimantai_gpu_error('The kernel connected, but its hardware is incompatible. Detected: ' + report.strip().replace('\\n', '; ') + '. ' + ${JSON.stringify(gpuRequirements(requirement)+' '+recovery)})
print('${marker}')
`;
}

/** Bridge Instructor cells to the student's selected Jupyter kernel, never to a local fallback. */
export class GpuNotebookRuntime implements vscode.Disposable {
  private ssh?:SshGpuRuntime;
  private cloud?:CloudGpuRuntime;
  private finishing?:Promise<string|undefined>;
  private lifetime?:NodeJS.Timeout;
  private selected?:GpuRuntime;
  private connection?: {provider: GpuRuntime; doc: vscode.NotebookDocument; kernel: Kernel; api: JupyterApi; session: string};
  private cancellation?: vscode.CancellationTokenSource;
  private connecting = false;
  private cancelProbe?: () => void;
  private generation = 0;
  get busy() { return this.connecting || !!this.cancellation || !!this.ssh?.busy || !!this.finishing; }
  get label(){return this.ssh?(this.cloud?.label??'SSH')+' · '+this.ssh.label.replace(/^SSH · /,''):this.connection?GPU_RUNTIMES[this.connection.provider]:undefined;}
  constructor(private readonly directory: string, private readonly scope: string,
    private managed?:{media:string;context:vscode.ExtensionContext;requirement:GpuLabRequirement}) {}

  async connect(provider: GpuRuntime) {
    if (this.busy) throw new Error('Wait for the current cell or connection to finish.');
    if(this.cloud && this.ssh?.connected && provider===this.selected)return;
    clearTimeout(this.lifetime);
    if(this.ssh){
      if(provider===this.selected){this.ssh.dispose();this.ssh=undefined;}
      else await this.finish();
    }
    this.selected=provider;
    if(provider==='ssh'||provider==='cloud-cli') {
      if(!this.managed)throw new Error('This lesson has no reviewed GPU setup recipe.');
      if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before connecting GPU compute.');
      this.connection=undefined;this.connecting=true;
      const generation=++this.generation;
      try {
        let requirement=this.managed.requirement,hosts;
        if(provider==='cloud-cli'){
          const {CloudGpuRuntime}=await import('./cloudGpuRuntime');
          this.cloud??=new CloudGpuRuntime(this.managed.context,this.scope);
          const allocation=await this.cloud.connect(requirement);requirement=allocation.requirement;hosts=allocation.hosts;
          if(generation!==this.generation)throw new Error('The learning session changed during cloud setup.');
        }
        const {SshGpuRuntime}=await import('./sshGpuRuntime');
        this.ssh=new SshGpuRuntime(this.managed.media,this.scope,requirement,this.managed.context.globalState);
        await this.ssh.connect(hosts);
        if(generation!==this.generation)throw new Error('The learning session changed during GPU setup.');
        if(this.cloud)this.lifetime=setTimeout(()=>{this.ssh?.restart();void this.finish().then(()=>vscode.window.showInformationMessage('The lab runtime limit was reached. Your work was saved and cloud resources released.'),error=>vscode.window.showErrorMessage((error as Error).message));},this.cloud.remainingMs);
        return;
      }catch(error){this.ssh?.dispose();this.ssh=undefined;const cloud=this.cloud;this.cloud=undefined;
        if(cloud)try{await cloud.failedSetup();}catch(cleanup){throw new Error((error as Error).message+' Cleanup needs attention: '+(cleanup as Error).message);}
        throw error;
      }finally{this.connecting=false;}
    }
    if(provider==='colab'&&this.managed&&this.managed.requirement.nodes*this.managed.requirement.gpusPerNode>1)
      throw new Error('This lab needs two GPUs. Use a cloud or SSH runtime with the required layout.');
    const prior = this.connection;
    if (prior?.provider === provider && !prior.doc.isClosed && prior.kernel.status === 'idle'
        && await prior.api.kernels.getKernel(prior.doc.uri) === prior.kernel) return;
    this.connection = undefined;
    this.connecting = true;
    const generation = ++this.generation;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting GPU compute.');
      if (provider === 'colab' && !await ensureColab()) throw new Error('Google Colab setup was cancelled. Select the runtime to retry.');
      const extension = vscode.extensions.getExtension<JupyterApi>('ms-toolsai.jupyter');
      if (!extension) throw new Error('Install Microsoft Jupyter, then select the GPU runtime again.');
      const api = await extension.activate();
      if (!api.kernels?.getKernel) throw new Error('Update Microsoft Jupyter to connect Instructor to your GPU runtime.');
      await mkdir(this.directory, {recursive: true});
      const key = createHash('sha256').update(this.scope + '|' + provider).digest('hex').slice(0, 24);
      const uri = vscode.Uri.file(join(this.directory, key + '.ipynb'));
      try {
        await writeFile(uri.fsPath, JSON.stringify({nbformat:4, nbformat_minor:5,
          metadata:{kernelspec:{name:'python3',display_name:'Python 3',language:'python'},
            dhimantai_runtime:{provider:provider === 'colab' ? 'google.colab' : 'jupyter',accelerator:'gpu',version:1}}, cells:[]}), {flag:'wx'});
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const doc = await vscode.workspace.openNotebookDocument(uri);
      const session = randomUUID();
      await withHostMarker(async (hostPaths, bootHash) => {
        const edit = new vscode.WorkspaceEdit();
        edit.set(uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, doc.cellCount), [
          new vscode.NotebookCellData(vscode.NotebookCellKind.Markup,
            `# ${GPU_RUNTIMES[provider]}\n\n${GPU_COST_NOTICE}\n\n**GPU requirements**\n\n${gpuRequirements(this.managed?.requirement)}\n\n${provider === 'colab' ? COLAB_SETUP_STEPS : 'Connect your GPU Jupyter server using Select Kernel.'}\n\nThis connection notebook runs the hardware check; your lesson cells and outputs stay in Instructor. Keep it open while using this runtime. After fixing a failed connection, choose the runtime again in Instructor to complete its hardware check. Release rented compute with your provider when finished.`, 'markdown'),
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, gpuProbe(provider,this.managed?.requirement,hostPaths,bootHash) + '\n_dhimantai_verified_session = ' + JSON.stringify(session), 'python'),
        ]), vscode.NotebookEdit.updateNotebookMetadata({...doc.metadata, metadata: {
          ...(doc.metadata.metadata ?? doc.metadata.custom?.metadata ?? {}),
          dhimantai_runtime: {provider: provider === 'colab' ? 'google.colab' : 'jupyter', accelerator: 'gpu', version: 1},
        }})]);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not prepare the GPU connection notebook.');
        await doc.save();
        if (provider !== 'colab') void vscode.window.showInformationMessage(
          'Choose Existing Jupyter Server and connect to your GPU server. Instructor will then run cells there. Compute costs are separate from the course fee.');
        const selection = provider === 'colab' ? await chooseColabKernel(doc, 'gpu') : await openNotebookKernelPicker(doc);
        if (!selection || selection.startsWith('No kernel was selected')) throw new Error('GPU connection cancelled. Select the runtime to retry.');
        if (generation !== this.generation) throw new Error('The learning session changed during GPU setup.');
        await this.probe(doc);
      });
      const kernel = await api.kernels.getKernel(uri);
      if (!kernel || kernel.language.toLowerCase() !== 'python') throw new Error('A Python GPU kernel did not connect. Select the runtime again.');
      if (generation !== this.generation) throw new Error('The learning session changed during GPU setup.');
      this.connection = {provider, doc, kernel, api, session};
    } finally { this.connecting = false; }
  }

  private async probe(doc: vscode.NotebookDocument) {
    const cell = doc.cellAt(1);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); changed.dispose(); closed.dispose();
        this.cancelProbe = undefined;
        error ? reject(error) : resolve();
      };
      const changed = vscode.workspace.onDidChangeNotebookDocument(event => {
        if (event.notebook !== doc) return;
        for (const change of event.cellChanges) {
          if (change.cell !== cell || change.executionSummary?.success === undefined) continue;
          const output = cell.outputs.flatMap(output => output.items).map(item => Buffer.from(item.data).toString()).join('\n');
          finish(change.executionSummary.success && output.includes(marker) ? undefined
            : new Error(gpuProbeFailure(output)));
        }
      });
      const closed = vscode.workspace.onDidCloseNotebookDocument(closed => {
        if (closed === doc) finish(new Error('GPU connection notebook closed. Select the runtime to reconnect.'));
      });
      const timer = setTimeout(() => {
        void vscode.commands.executeCommand('notebook.cell.cancelExecution', {ranges:[{start:1,end:2}],document:doc.uri});
        finish(new Error('GPU connection timed out. Check the server and select the runtime again.'));
      }, 120_000);
      this.cancelProbe = () => {
        void vscode.commands.executeCommand('notebook.cell.cancelExecution', {ranges:[{start:1,end:2}],document:doc.uri});
        finish(new Error('GPU connection cancelled because the learning session changed.'));
      };
      void vscode.commands.executeCommand('notebook.cell.execute', {ranges:[{start:1,end:2}],document:doc.uri})
        .then(undefined, () => finish(new Error('Could not run the GPU connection check. Select a GPU kernel and retry.')));
    });
  }

  async run(language: string, source: string, stdin = '', options: CellOptions = {}): Promise<Execution> {
    if (this.busy) throw new Error('Wait for the current GPU cell or connection to finish.');
    if(this.ssh)return this.ssh.run(language,source,stdin,options);
    const connection = this.connection;
    if (!connection || connection.doc.isClosed) throw new Error('Connect the selected GPU runtime before running. No course-container fallback was used.');
    if (language !== 'python') throw new Error('GPU runtimes execute Python notebook cells. Use the course container for other languages.');
    if (stdin || options.argv?.length || options.files?.length) throw new Error('For GPU labs, put inputs in the Python cell and upload files to the selected GPU server.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running code.');
    const cancellation = new vscode.CancellationTokenSource();
    this.cancellation = cancellation;
    const abort = () => cancellation.cancel();
    options.signal?.addEventListener('abort', abort, {once:true});
    const started = Date.now();
    let stdout = '', stderr = '', failed = false, truncated = false;
    try {
      options.event?.({kind:'phase',phase:'preparing'});
      const kernel = await connection.api.kernels.getKernel(connection.doc.uri);
      if (kernel !== connection.kernel || ['dead','terminating','unknown'].includes(kernel.status)) {
        this.connection = undefined;
        throw new Error('The GPU kernel changed or disconnected. Select the runtime to reconnect before running.');
      }
      if (kernel.status !== 'idle') throw new Error('The selected GPU kernel is busy. Wait for it to finish before running this cell.');
      if (options.signal?.aborted) abort();
      if (!cancellation.token.isCancellationRequested) {
        // A notebook can switch or restart kernels between the hardware probe and Run.
        let session = '';
        for await (const output of kernel.executeCode('print(globals().get("_dhimantai_verified_session", ""))', cancellation.token)) {
          for (const item of output.items) {
            if (stdoutMime.has(item.mime)) session += Buffer.from(item.data).toString();
          }
        }
        if (!cancellation.token.isCancellationRequested && session.trim() !== connection.session) {
          this.connection = undefined;
          throw new Error('The GPU kernel session changed. Reconnect the remote runtime before running this cell.');
        }
      }
      if (!cancellation.token.isCancellationRequested) options.event?.({kind:'phase',phase:'running'});
      if (!cancellation.token.isCancellationRequested) for await (const output of kernel.executeCode(source, cancellation.token)) {
        const display: Record<string,string> = {};
        for (const item of output.items) {
          const text = Buffer.from(item.data).toString();
          if (item.mime === 'application/vnd.code.notebook.error') {
            failed = true;
            let message = text;
            try { const error = JSON.parse(text); message = error.stack || `${error.name}: ${error.message}`; } catch { /* plain error */ }
            stderr += message + '\n'; options.event?.({kind:'stream',stream:'stderr',text:message+'\n'});
          } else if (stdoutMime.has(item.mime) || stderrMime.has(item.mime)) {
            const stream = stderrMime.has(item.mime) ? 'stderr' : 'stdout';
            if (stream === 'stdout') stdout += text; else stderr += text;
            options.event?.({kind:'stream',stream,text});
          } else if (['text/plain','text/html','text/markdown','image/png','image/jpeg','image/svg+xml','application/json'].includes(item.mime)) {
            display[item.mime] = item.mime.startsWith('image/') && item.mime !== 'image/svg+xml'
              ? Buffer.from(item.data).toString('base64') : text;
          }
          if (stdout.length + stderr.length > 1_000_000) { stdout = stdout.slice(-500_000); stderr = stderr.slice(-500_000); truncated = true; }
        }
        if (Object.keys(display).length) options.event?.({kind:'display',data:display});
      }
      return {status:cancellation.token.isCancellationRequested ? 'cancelled' : 'exited',
        exit_code:cancellation.token.isCancellationRequested ? null : failed ? 1 : 0, stdout, stderr,
        command:'Python',runtime_target:GPU_RUNTIMES[connection.provider],duration_seconds:(Date.now()-started)/1000,truncated};
    } finally { options.signal?.removeEventListener('abort', abort); cancellation.dispose(); this.cancellation = undefined; }
  }

  async restart() {
    if(this.ssh){this.ssh.restart();return;}
    const connection = this.connection;
    this.dispose();
    if (connection && !connection.doc.isClosed) {
      await vscode.window.showNotebookDocument(connection.doc, {preview:false});
      await vscode.commands.executeCommand('jupyter.restartkernel', connection.doc.uri);
    }
  }
  input(value:string|null){this.ssh?.input(value);}
  async pause(){await this.cloud?.pause();}
  async terminal(){if(this.ssh)return this.ssh.terminal();throw new Error('Open a terminal in the selected Jupyter server.');}
  finish():Promise<string|undefined> {
    if(this.finishing)return this.finishing;
    const ssh=this.ssh,cloud=this.cloud;clearTimeout(this.lifetime);
    this.finishing=(async()=>{
      if(!ssh)return;
      let saved:string|undefined;
      try {
        const deadline=Date.now()+30000;
        while(ssh.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));
        saved=await ssh.saveWorkspace(join(this.directory,'saved',createHash('sha256').update(this.scope).digest('hex').slice(0,24)));
        if(cloud){await cloud.savedArtifact(saved);await cloud.teardown();}
        ssh.dispose();this.ssh=undefined;this.cloud=undefined;return saved;
      }catch(error){
        // Never delete unsaved learner work. Stop compute, retain disks and the cleanup journal.
        if(cloud)try{await cloud.pause();}catch(pause){throw new Error((error as Error).message+' Cloud stop also failed: '+(pause as Error).message+' Check this allocation; compute may still be billed.');}
        throw new Error((error as Error).message+(cloud?' Remaining compute stopped. '+(saved?'Work is saved at '+saved+'. Cleanup must be retried.':'Disks are retained for recovery.')+' Storage may still be billed.':''));
      }
    })().finally(()=>{this.finishing=undefined;});
    return this.finishing;
  }
  dispose() { this.generation++; this.cancelProbe?.(); this.cancellation?.cancel(); this.connection = undefined;
    if(this.connecting){this.ssh?.dispose();return;}
    if(this.ssh){this.ssh.restart();void this.finish().catch(error=>{this.ssh?.dispose();void vscode.window.showErrorMessage((error as Error).message);});}
  }
}
