import {authoredConfiguration} from './authoredConfiguration';
import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {gpuLabRequirement} from '../src/sshRuntimeConfig';

async function fixture(nodes=1,gpusPerNode=2) {
  const media=resolve(__dirname,'../../media/course'),filename=resolve(__dirname,'../src/sshGpuRuntime.js');
  const nativeRequire=createRequire(filename),exports:any={},calls:string[]=[],writes:any[]=[];
  let verified={nodes,gpus:nodes*gpusPerNode},disposed=0,machine='one';
  const record=()=>({machine,hostname:'gpu',architecture:'x86_64',python:'/env/bin/python',root:'/tmp/runtime',packages:'same',user:'ubuntu',sshPort:22,
    gpus:Array.from({length:gpusPerNode},(_,i)=>({uuid:'gpu-'+i,name:'GPU',memory:24000})),addresses:[{interface:'eth1',ip:'10.1.1.2'}]});
  const vscode={window:{withProgress:async(_:any,fn:any)=>fn({report:()=>{}},{onCancellationRequested:()=>({dispose:()=>{}})})},ProgressLocation:{Notification:1}};
  class SshConnection {
    async initialize(){}
    async exec(_:any,command:string){calls.push(command);return / 'prepare' '-'$/.test(command)?'DHIMANTAI_RESULT '+JSON.stringify(record()):
      / 'verify' '-'$/.test(command)?'DHIMANTAI_RESULT '+JSON.stringify(verified):'';}
    dispose(){disposed++;}
  }
  runInNewContext(readFileSync(filename,'utf8'),{exports,module:{exports},Buffer,AbortController,setTimeout,clearTimeout,
    require:(id:string)=>id==='vscode'?vscode:id==='./sshConnection'?{SshConnection,SshCommandError:class extends Error {}}:
      id==='./notebookCells'?{NotebookCells:class {busy=false;restart(){}run(){return Promise.resolve('remote');}}}:nativeRequire(id)});
  const recipe={...await gpuLabRequirement(authoredConfiguration('Inference Engineering'),'Chapter 7: GPU Clusters and Parallelism'),nodes,gpusPerNode};
  const runtime=new exports.SshGpuRuntime(media,'account|lesson',recipe,{update:async(...args:any[])=>writes.push(args)});
  return {runtime,calls,writes,record,verified:(value:any)=>{verified=value;},disposed:()=>disposed,exports};
}

test('one machine with two GPUs becomes ready only after its actual two-GPU verification',async()=>{
  const f=await fixture();
  try {
    await f.runtime.connect([{host:'ubuntu@gpu'}]);
    assert.match(f.runtime.label,/1 machine · 2 GPUs/);
    assert.equal(await f.runtime.run('python','print(1)'),'remote');
    assert.equal(f.calls.filter(c=>/ 'prepare'/.test(c)).length,1);
    assert.equal(f.calls.filter(c=>/ 'verify'/.test(c)).length,1);
    assert.equal(f.calls.filter(c=>/ 'firewall'/.test(c)).length,0);
  }finally{f.runtime.dispose();}
});

test('failed hardware verification cannot become runnable and closes its owned SSH connection',async()=>{
  const f=await fixture();f.verified({nodes:1,gpus:1});
  await assert.rejects(f.runtime.connect([{host:'gpu'}]),/verify every required GPU/);
  assert.throws(()=>f.runtime.run('python','print(1)'),/Connect the selected/);
  assert.equal(f.disposed(),1);assert.equal(f.writes.length,0);
});

test('two SSH aliases of the same machine do not count as a two-machine cluster',async()=>{
  const f=await fixture(2,1);
  await assert.rejects(f.runtime.connect([{host:'alias-a'},{host:'alias-b'}]),/different physical machine/);
  assert.equal(f.disposed(),1);assert.equal(f.calls.filter(c=>/ 'verify'/.test(c)).length,0);
});
