import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {spawnSync} from 'node:child_process';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gpu-runtime-test-'));
  const changes = new Set<(event:any)=>void>(), closed = new Set<(event:any)=>void>();
  const listen = (listeners:Set<any>) => (callback:any) => {listeners.add(callback);return {dispose:()=>listeners.delete(callback)};};
  const cell:any = {outputs:[]};
  const uri = {fsPath:join(root,'connection.ipynb'),toString:()=> 'file:///connection.ipynb'};
  const doc:any = {uri,metadata:{metadata:{kernelspec:{name:'python3'}}},isClosed:false,cellCount:0,cellAt:()=>cell,save:async()=>true};
  const calls:string[] = [], executed:string[] = [], tokens:any[] = [];
  let pick = 'Check the selected kernel', probe = true, probeRuns = 0, probeError = 'no GPU';
  let outputs:any[] = [{items:[{mime:'application/x.notebook.stream.stdout',data:Buffer.from('remote result\n')}]}];
  let session = '';
  const kernel:any = {language:'python',status:'idle',executeCode:async function*(code:string, token:any) {
    if (code.startsWith('print(globals().get("_dhimantai_verified_session"')) {
      yield {items:[{mime:'application/vnd.code.notebook.stdout',data:Buffer.from(session)}]};return;
    }
    executed.push(code);tokens.push(token);for (const output of outputs) yield output;
  }};
  let currentKernel:any = kernel;
  const api = {kernels:{getKernel:async()=>currentKernel}};
  let prepared:any[]=[];
  let initialMetadata:any;
  const vscode:any = {workspace:{isTrusted:true,openNotebookDocument:async()=>{
      initialMetadata=JSON.parse(readFileSync(uri.fsPath,'utf8')).metadata;return doc;
    },applyEdit:async(edit:any)=>{
      prepared=edit.edits[0].cells;doc.metadata=edit.edits[1].metadata;return true;
    },
    onDidChangeNotebookDocument:listen(changes),onDidCloseNotebookDocument:listen(closed)},
    window:{showInformationMessage:async()=>{},showNotebookDocument:async()=>{}},
    extensions:{getExtension:()=>({activate:async()=>api})},Uri:{file:()=>uri},
    WorkspaceEdit:class {edits:any[]=[];set(_uri:any,edits:any[]){this.edits=edits;}},
    NotebookEdit:{replaceCells:(_range:any,cells:any[])=>({cells}),updateNotebookMetadata:(metadata:any)=>({metadata})},
    NotebookRange:class {},NotebookCellData:class {constructor(public kind:number,public value:string,public languageId:string){}},
    NotebookCellKind:{Markup:1,Code:2},CancellationTokenSource:class {
      token={isCancellationRequested:false};cancel(){this.token.isCancellationRequested=true;}dispose(){}
    },commands:{executeCommand:async(id:string)=>{
      calls.push(id);
      if (id === 'notebook.cell.execute') {
        session = /_dhimantai_verified_session = "([^"]+)"/.exec(prepared[1].value)?.[1] ?? '';
        probeRuns++;cell.outputs=[{items:[{data:Buffer.from(probe?'DHIMANTAI_GPU_READY':probeError)}]}];
        for(const changed of changes) changed({notebook:doc,cellChanges:[{cell,executionSummary:{success:probe}}]});
      }
    }}};
  const filename=resolve(__dirname,'../src/gpuNotebookRuntime.js'), exports:any={};
  const modules:Record<string,any>={};
  const nativeRequire=createRequire(filename);
  runInNewContext(readFileSync(filename,'utf8'), {exports,module:{exports},Buffer,setTimeout,clearTimeout,
    require:(id:string)=>modules[id]??(id==='vscode'?vscode:id==='./colab'?{ensureColab:async()=>true,chooseColabKernel:async(_doc:any,accelerator:string)=>{
      assert.equal(accelerator,'gpu');return pick;
    }}
      :id==='./notebookKernelPicker'?{openNotebookKernelPicker:async()=>pick}:nativeRequire(id))});
  const runtime=new exports.GpuNotebookRuntime(root,'staging|student|lesson');
  return {runtime,exports,vscode,doc,kernel,calls,executed,tokens,changes,modules,restartKernel:()=>{session='';},prepared:()=>prepared,initialMetadata:()=>initialMetadata,
    probeRuns:()=>probeRuns,outputs:(next:any[])=>{outputs=next;},pick:(next:string)=>{pick=next;},probe:(value:boolean)=>{probe=value;},
    probeError:(value:string)=>{probe=false;probeError=value;},
    changeKernel:()=>{currentKernel={...kernel};},close:async()=>{runtime.dispose();await rm(root,{recursive:true,force:true});}};
}

test('selecting cloud verifies the kernel, then runs each Instructor cell on it without a picker or container',async()=>{
  const f=await fixture();try {
    await f.runtime.connect('cloud');
    const events:any[]=[];
    const result=await f.runtime.run('python','answer = 42\nprint(answer)','',{event:(e:any)=>events.push(e)});
    assert.deepEqual(f.executed,['answer = 42\nprint(answer)']);
    assert.equal(result.runtime_target,'Cloud GPU · Jupyter');assert.equal(result.stdout,'remote result\n');
    assert.equal(result.exit_code,0);assert.equal(events.find(e=>e.kind==='stream').stream,'stdout');
    await f.runtime.connect('cloud');
    assert.equal(f.probeRuns(),1,'reselecting a healthy connection reuses it');
    assert.deepEqual(f.calls,['notebook.cell.execute']);
    assert.equal(f.changes.size,0,'probe event subscriptions are cleaned up');
  } finally {await f.close();}
});

test('Colab setup retains GPU identity and explains provider recovery before hardware validation',async()=>{
  const f=await fixture();try {
    await f.runtime.connect('colab');
    assert.equal(f.initialMetadata().dhimantai_runtime.provider,'google.colab','external identity exists before the editor can choose a local kernel');
    assert.equal(f.doc.metadata.metadata.dhimantai_runtime.provider,'google.colab');
    assert.equal(f.doc.metadata.metadata.dhimantai_runtime.accelerator,'gpu');
    assert.equal(f.doc.metadata.metadata.kernelspec.name,'python3');
    const guide=f.prepared()[0].value;
    assert.match(guide,/Use Colab Kernel/);assert.match(guide,/Microsoft Jupyter/);
    assert.match(guide,/Python 3 \(ipykernel\)/);assert.match(guide,/If searching for Colab shows no match/);
    assert.match(guide,/choose the runtime again in Instructor/);
    assert.match(guide,/not a prerequisite/);
    assert.match(guide,/GPU requirements.*This lab requires/s);
    assert.ok(guide.indexOf('GPU requirements')<guide.indexOf('Use Colab Kernel'));
  }finally{await f.close();}
});

test('Colab probe stops the wrong runtime before querying GPUs and still enforces hardware requirements',async()=>{
  const f=await fixture();try {
    const probe=f.exports.gpuProbe('colab',{minComputeCapability:8,minVramMiB:6000,nodes:1,gpusPerNode:1});
    const run=(colab:boolean,report:string,source=probe)=>spawnSync('python3',['-c',`import os, platform, subprocess
os.environ.pop('CUDA_VISIBLE_DEVICES', None)
os.environ.pop('COLAB_RELEASE_TAG', None)
${colab ? "os.environ['COLAB_RELEASE_TAG'] = 'test'" : ''}
platform.system = lambda: 'Linux'
os.path.isfile = lambda path: False
def gpu_report(*args, **kwargs):
    print('GPU_QUERIED')
    return ${JSON.stringify(report)}
subprocess.check_output = gpu_report
exec(${JSON.stringify(source)})
`],{encoding:'utf8'});
    const host=run(false,'NVIDIA L4, 8.9, 23034', f.exports.gpuProbe('jupyter', undefined, ['.']));
    assert.equal(host.status,1);assert.match(host.stdout,/desktop host/);
    assert.doesNotMatch(host.stdout,/GPU_QUERIED|DHIMANTAI_GPU_READY/);
    const podman=run(false,'NVIDIA L4, 8.9, 23034');
    assert.equal(podman.status,1);assert.doesNotMatch(podman.stdout,/GPU_QUERIED|DHIMANTAI_GPU_READY/);
    assert.match(podman.stderr,/Use Colab Kernel.*GPU availability has not been checked/);
    const t4=run(true,'Tesla T4, 7.5, 15360');
    assert.equal(t4.status,1);assert.match(t4.stdout,/GPU_QUERIED/);
    const failure=f.exports.gpuProbeFailure(t4.stdout);
    assert.match(failure,/kernel connected.*hardware is incompatible.*Tesla T4/);
    assert.match(failure,/T4.*cannot run.*L4\/A100/);
    assert.match(failure,/New Colab Server.*retry/);
    assert.match(f.exports.gpuProbeFailure(podman.stdout),/not a Colab runtime.*availability has not been checked/);assert.doesNotMatch(t4.stdout,/DHIMANTAI_GPU_READY/);
    f.probeError(t4.stdout);
    await assert.rejects(f.runtime.connect('colab'), (error:any) => error.message === failure);
    await assert.rejects(f.runtime.run('python','print(1)'),/Connect the selected/);
    const l4=run(true,'NVIDIA L4, 8.9, 23034');
    assert.equal(l4.status,0,l4.stderr);assert.match(l4.stdout,/DHIMANTAI_GPU_READY/);
    const small=run(true,'NVIDIA L4, 8.9, 4000');
    assert.equal(small.status,1);assert.match(f.exports.gpuProbeFailure(small.stdout),/4000.*6000 MiB/);
    const malformed=run(true,'NVIDIA L4, N\/A, N\/A');
    assert.equal(malformed.status,1);assert.match(f.exports.gpuProbeFailure(malformed.stdout),/unreadable report/);
  }finally{await f.close();}
});

test('finishing a managed lab saves artifacts before cloud teardown and retains work when saving fails',async()=>{
  const f=await fixture(),events:string[]=[];
  try {
    f.runtime.ssh={busy:false,saveWorkspace:async()=>{events.push('save');return '/saved/lab';},dispose:()=>events.push('disconnect')};
    f.runtime.cloud={savedArtifact:async()=>events.push('record'),teardown:async()=>events.push('delete'),pause:async()=>events.push('pause')};
    assert.equal(await f.runtime.finish(),'/saved/lab');assert.deepEqual(events,['save','record','delete','disconnect']);
    events.length=0;
    f.runtime.ssh={busy:false,saveWorkspace:async()=>{throw new Error('Disk full');},dispose:()=>{}};
    f.runtime.cloud={teardown:async()=>events.push('delete'),pause:async()=>events.push('pause')};
    await assert.rejects(f.runtime.finish(),/Disk full.*Disks are retained/);assert.deepEqual(events,['pause']);
    f.runtime.ssh=undefined;f.runtime.cloud=undefined;
  }finally{await f.close();}
});

test('a session cancelled while the CLI creates machines cleans them up without preparing or running learner code',async()=>{
  const f=await fixture();let ready:(value:any)=>void=()=>{},destroyed=0,prepared=0;
  f.runtime.managed={media:'/media',context:{},requirement:{nodes:1,gpusPerNode:1}};
  f.modules['./cloudGpuRuntime']={CloudGpuRuntime:class {connect(){return new Promise(resolve=>{ready=resolve;});}async failedSetup(){destroyed++;}}};
  f.modules['./sshGpuRuntime']={SshGpuRuntime:class {async connect(){prepared++;}dispose(){}}};
  try {
    const connecting=f.runtime.connect('cloud-cli');await new Promise(resolve=>setTimeout(resolve,0));
    f.runtime.dispose();ready({hosts:[],requirement:{nodes:1,gpusPerNode:1}});
    await assert.rejects(connecting,/session changed/);assert.equal(destroyed,1);assert.equal(prepared,0);
  }finally{await f.close();}
});

test('cancelled or failed setup does not become runnable or fall back to another runtime',async()=>{
  const f=await fixture();try {
    f.pick('No kernel was selected.');await assert.rejects(f.runtime.connect('cloud'),/cancelled/);
    assert.equal(f.probeRuns(),0);await assert.rejects(f.runtime.run('python','print(1)'),/Connect the selected/);
    f.pick('Check the kernel');f.probe(false);await assert.rejects(f.runtime.connect('cloud'),/check failed/);
    await assert.rejects(f.runtime.run('python','print(1)'),/Connect the selected/);
    assert.equal(f.executed.length,0);assert.equal(f.runtime.busy,false);
  } finally {await f.close();}
});

test('changing a native kernel after connecting blocks execution until it is reverified',async()=>{
  const f=await fixture();try {
    await f.runtime.connect('colab');f.changeKernel();
    await assert.rejects(f.runtime.run('python','print(1)'),/changed or disconnected/);
    assert.equal(f.executed.length,0);
    assert.match(f.exports.gpuProbe('colab'),/COLAB_RELEASE_TAG/);
    assert.doesNotMatch(f.exports.gpuProbe('cloud'),/COLAB_RELEASE_TAG/);
  } finally {await f.close();}
});

test('GPU execution streams rich output, reports Python errors and honors cancellation',async()=>{
  const f=await fixture();try {
    await f.runtime.connect('jupyter');
    const events:any[]=[];
    f.outputs([{items:[{mime:'text/plain',data:Buffer.from('plot')},{mime:'image/png',data:Buffer.from([1,2])}]},
      {items:[{mime:'application/vnd.code.notebook.error',data:Buffer.from(JSON.stringify({name:'ValueError',message:'bad input'}))}]}]);
    const result=await f.runtime.run('python','raise ValueError()','',{event:(event:any)=>events.push(event)});
    assert.equal(result.exit_code,1);assert.match(result.stderr,/ValueError: bad input/);
    assert.deepEqual(events.slice(0,2).map(e=>e.phase),['preparing','running']);
    assert.equal(events.filter(e=>e.kind==='display').length,1);assert.equal(events.find(e=>e.kind==='display').data['image/png'],'AQI=');
    const abort=new AbortController();abort.abort();
    const cancelled=await f.runtime.run('python','should_not_run()','',{signal:abort.signal});
    assert.equal(cancelled.status,'cancelled');assert.equal(f.executed.length,1);
    await assert.rejects(f.runtime.run('javascript','bad'),/Python/);
    await assert.rejects(f.runtime.run('python','bad','local input'),/put inputs/);
  } finally {await f.close();}
});

test('closing the connection or disposing an account session blocks later execution',async()=>{
  const f=await fixture();try {
    await f.runtime.connect('cloud');f.doc.isClosed=true;
    await assert.rejects(f.runtime.run('python','print(1)'),/Connect the selected/);
    f.doc.isClosed=false;f.runtime.dispose();
    await assert.rejects(f.runtime.run('python','print(1)'),/Connect the selected/);
    assert.equal(f.executed.length,0);
  } finally {await f.close();}
});

test('reselecting a connected managed provider preserves its workspace and cleanup timer',async()=>{
  const f=await fixture();
  try {
    f.runtime.selected='cloud-cli';
    f.runtime.cloud={teardown:()=>assert.fail('active allocation released')};
    f.runtime.ssh={connected:true,saveWorkspace:()=>assert.fail('active workspace closed')};
    const timer=setTimeout(()=>{},60000);f.runtime.lifetime=timer;
    try {
      await f.runtime.connect('cloud-cli');
      assert.equal(f.runtime.ssh.connected,true);
      assert.equal(f.runtime.lifetime,timer);
    }finally{clearTimeout(timer);}
  }finally{f.runtime.ssh=undefined;f.runtime.cloud=undefined;await f.close();}
});

test('a restarted kernel cannot receive a learner cell until remote verification succeeds again',async()=>{
  const f=await fixture();try {
    await f.runtime.connect('jupyter');
    f.restartKernel();
    await assert.rejects(f.runtime.run('python','learner_source'),/session changed/);
    assert.deepEqual(f.executed,[]);
  }finally{await f.close();}
});
