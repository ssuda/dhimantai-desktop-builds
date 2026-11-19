import * as assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as vscode from 'vscode';
import {GpuNotebookRuntime} from '../../src/gpuNotebookRuntime';

/** Real VS Code command/event boundary; the provider is simulated, no GPU is rented. */
export async function run() {
  const root=await mkdtemp(join(tmpdir(),'dhimantai-gpu-native-'));
  const runtime=new GpuNotebookRuntime(root,'integration|student|lesson');
  const original={get:vscode.extensions.getExtension,execute:vscode.commands.executeCommand,info:vscode.window.showInformationMessage};
  const checks:{step:string;ok:boolean}[]=[];
  const executed:string[]=[];
  let probes=0;
  const kernel={language:'python',status:'idle',async *executeCode(code:string) {
    executed.push(code);yield {items:[{mime:'application/x.notebook.stream.stdout',data:Buffer.from('on selected GPU\n')}]};
  }};
  const controller=vscode.notebooks.createNotebookController('dhimantai-gpu-test','jupyter-notebook','Test GPU provider');
  controller.supportedLanguages=['python'];
  controller.executeHandler=async cells=>{
    for(const cell of cells) {
      probes++;assert.match(cell.document.getText(),/nvidia-smi/);
      const task=controller.createNotebookCellExecution(cell);task.start(Date.now());
      await task.replaceOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout('DHIMANTAI_GPU_READY\nSimulated GPU\n')])]);
      task.end(true,Date.now());
    }
  };
  try {
    (vscode.extensions as any).getExtension=(id:string)=>id==='ms-toolsai.jupyter'
      ? {activate:async()=>({kernels:{getKernel:async()=>kernel}})} : original.get(id);
    (vscode.window as any).showInformationMessage=async()=>undefined;
    (vscode.commands as any).executeCommand=(id:string,...args:any[])=>id==='notebook.selectKernel'
      ? original.execute(id,{id:controller.id,extension:'optficial.dhimantai-learning',notebookEditor:vscode.window.activeNotebookEditor})
      : original.execute(id,...args);
    await runtime.connect('cloud');
    assert.equal(probes,1);
    const doc=vscode.window.activeNotebookEditor!.notebook;
    assert.equal(doc.metadata.metadata.dhimantai_runtime.provider,'jupyter');
    assert.equal(doc.metadata.metadata.dhimantai_runtime.accelerator,'gpu');
    checks.push({step:'Native kernel selection and cell execution report successful GPU probe',ok:true});
    const events:any[]=[];
    const result=await runtime.run('python','print("lesson code")','',{event:event=>events.push(event)});
    assert.deepEqual(executed,['print("lesson code")']);
    assert.equal(result.runtime_target,'Cloud GPU · Jupyter');assert.equal(result.exit_code,0);
    assert.equal(events[0].text,'on selected GPU\n');
    await runtime.connect('cloud');assert.equal(probes,1);
    checks.push({step:'Instructor code and outputs use the connected provider and reuse its kernel',ok:true});
    runtime.dispose();
    await assert.rejects(runtime.run('python','do_not_run()'),/Connect the selected/);
    checks.push({step:'Disposed connection cannot execute or fall back to the course container',ok:true});
  } finally {
    runtime.dispose();controller.dispose();
    (vscode.extensions as any).getExtension=original.get;
    (vscode.commands as any).executeCommand=original.execute;
    (vscode.window as any).showInformationMessage=original.info;
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify(checks,null,2));
    await rm(root,{recursive:true,force:true});
  }
}
