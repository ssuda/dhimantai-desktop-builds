import {authoredConfiguration} from './authoredConfiguration';
import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseSshHost,sshArgs,gpuLabRequirement} from '../src/sshRuntimeConfig';
import {NotebookCells} from '../src/notebookCells';

test('SSH input accepts config hosts and standard connection options without remote commands',()=>{
  assert.deepEqual(parseSshHost('ssh -p 2202 -i "/keys/my key" -J gateway ubuntu@gpu'),{host:'ubuntu@gpu',port:2202,identity:'/keys/my key',jump:'gateway'});
  for(const value of ['ssh -o ProxyCommand=evil gpu','ssh gpu rm -rf /','-bad','ssh user@host;evil','ssh -p 0 gpu','ssh -p 65536 gpu','ssh gpu\n','ssh -i "open gpu'])assert.throws(()=>parseSshHost(value));
  const args=sshArgs(parseSshHost('gpu'),'python3 -u helper.py');
  assert.ok(args.includes('StrictHostKeyChecking=ask'));assert.ok(args.includes('ForwardAgent=no'));
});

test('the authored lab chooses one GPU, two-GPU layouts or no allocation',async()=>{
  const media=resolve(__dirname,'../../media/course');
  assert.equal((await gpuLabRequirement(authoredConfiguration('Inference Engineering'),'Chapter 2: Running vLLM Offline'))?.nodes,1);
  const cluster=await gpuLabRequirement(authoredConfiguration('Inference Engineering'),'Chapter 7: GPU Clusters and Parallelism');
  assert.deepEqual(cluster?.layouts?.map(l=>[l.nodes,l.gpusPerNode]),[[1,2],[2,1]]);
  assert.equal(await gpuLabRequirement(authoredConfiguration('Inference Engineering'),'Chapter 6: DeepInfer Architecture and Deployment'),undefined);
  assert.equal(await gpuLabRequirement(authoredConfiguration('Transformers Foundations'),'Chapter 1: Attention from Queries, Keys and Values'),undefined);
  assert.equal((await gpuLabRequirement(authoredConfiguration('Developing TTS Models with IndicSpeak'),'Chapter 6: Fine-Tuning IndicSpeak with LoRA'))?.minComputeCapability,8);
  assert.equal(await gpuLabRequirement(authoredConfiguration('Developing TTS Models with IndicSpeak'),'Chapter 7: Full Training and Reproducible Experiments'),undefined,'unreviewed full-training memory must not trigger a cheap GPU rental');
});

test('an external transport executes the real cell bridge persistently and never falls back to local Python',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'ssh-cell-transport-'));
  let starts=0;
  const cells=new NotebookCells(()=>{throw new Error('Local toolchain must not be used');},undefined,undefined,0,
    {target:'SSH test transport',start:async()=>{starts++;return spawn('python3',['-u',resolve(__dirname,'../../media/course/cells.py')],{cwd:folder});}});
  try {
    await cells.run('python','x=41');
    const result=await cells.run('python','print(x+1)');assert.equal(result.stdout,'42\n');assert.equal(result.runtime_target,'SSH test transport');assert.equal(starts,1);
    const input=await cells.run('python','print(input("name: "))','',{interactive:true,event:e=>{if(e.kind==='input')cells.input('learner');}});assert.match(input.stdout,/learner/);
    await cells.run('python','open("result.txt","w").write("saved")');assert.equal(await readFile(join(folder,'result.txt'),'utf8'),'saved');
    const cancel=new AbortController();
    const result2=await cells.run('python','print("started",flush=True)\nwhile True: pass','',{signal:cancel.signal,event:e=>{if(e.kind==='stream')cancel.abort();}});
    assert.equal(result2.status,'cancelled');
  }finally{cells.restart();await new Promise(r=>setTimeout(r,100));await rm(folder,{recursive:true,force:true});}
  const failed=new NotebookCells(()=>{throw new Error('Unsafe fallback');},undefined,undefined,0,{target:'SSH',start:async()=>{throw new Error('SSH unavailable');}});
  await assert.rejects(failed.run('python','print(1)'),/SSH unavailable/);
});

test('cloud VM aliases remember their verified host key across SSH calls',()=>{
  const args=sshArgs({host:'dhai-cluster-worker1',cloudVm:true},'python3');
  assert.ok(args.includes('UserKnownHostsFile=~/.ssh/known_hosts'));
  assert.ok(args.includes('HostKeyAlias=dhai-cluster-worker1'));
  assert.ok(args.includes('StrictHostKeyChecking=ask'));
  assert.ok(!sshArgs({host:'my-own-host'},'python3').includes('UserKnownHostsFile=~/.ssh/known_hosts'));
});
