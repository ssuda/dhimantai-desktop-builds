import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

function fixture(approval?:string) {
  const filename=resolve(__dirname,'../src/cloudGpuRuntime.js'),exports:any={};
  const require=createRequire(filename),writes:any[]=[],calls:string[][]=[];
  runInNewContext(readFileSync(filename,'utf8'),{exports,module:{exports},Buffer,setTimeout,require:(id:string)=>id==='vscode'?{window:{showInformationMessage:async()=>approval}}:id==='./cloudCli'?{CLOUD_CLIS:{jarvis:{label:'JarvisLabs'}},AVAILABLE_CLOUD_PROVIDERS:['jarvis']}:require(id)});
  const runtime=new exports.CloudGpuRuntime({globalState:{update:async(key:string,value:any)=>writes.push({key,value:value?JSON.parse(JSON.stringify(value)):undefined})}},'test-scope');
  runtime.key='owned-lab';runtime.allocated=true;runtime.record={version:1,provider:'jarvis',account:'account',name:'dhai-owned',scope:'test-scope',quote:{region:'IN2',zone:'',nodes:1,gpusPerNode:2,type:'A30',price:60,currency:'INR'},resources:{},ids:['42'],phase:'running'};
  runtime.cli={requireAccount:async()=>{},run:async(args:string[])=>{calls.push(args);return [];}};
  return {runtime,exports,writes,calls};
}

test('spot selection compares total layout price and ignores incompatible or unpriced offers',()=>{
  const f=fixture(),requirement={nodes:2,gpusPerNode:1,layouts:[{nodes:1,gpusPerNode:2},{nodes:2,gpusPerNode:1}]};
  const offers=[{type:'two-small',nodes:2,gpusPerNode:1,price:.2},{type:'one-dual',nodes:1,gpusPerNode:2,price:.3},{type:'unknown',nodes:1,gpusPerNode:2},{type:'wrong',nodes:1,gpusPerNode:1,price:.01}];
  assert.equal(f.exports.cheapestSpot(offers,requirement).type,'one-dual');
  assert.equal(f.exports.cheapestSpot([{nodes:2,gpusPerNode:1,price:NaN}],requirement),undefined);
});

test('failed cleanup retains its journal and an account mismatch prevents cloud mutations',async()=>{
  const f=fixture();f.runtime.cli.run=async()=>{throw new Error('Provider temporarily unavailable');};
  await assert.rejects(f.runtime.teardown(),/unavailable/);assert.equal(f.writes.at(-1).value.phase,'cleanup');
  const g=fixture();g.runtime.cli.requireAccount=async()=>{throw new Error('Wrong account');};
  await assert.rejects(g.runtime.teardown(),/Wrong account/);assert.equal(g.calls.length,0);assert.equal(g.writes.length,0);
});

test('failed reconnect never deletes an existing learner workspace',async()=>{
  const f=fixture();f.runtime.preserveWork=true;let paused=0,deleted=0;
  f.runtime.pause=async()=>{paused++;};f.runtime.teardown=async()=>{deleted++;};
  await f.runtime.failedSetup();assert.equal(paused,1);assert.equal(deleted,0);
  f.runtime.preserveWork=false;await f.runtime.failedSetup();assert.equal(deleted,1);
});

test('Indian spot selection prices two GPUs on one machine and excludes overseas, VM and on-demand offers',async()=>{
  const f=fixture();f.runtime.record.provider='jarvis';
  const rows=[
    {gpu_type:'A30',region:'IN2',vram:'24GB',workload_type:'container',spot_num_free_devices:2,spot_price:30},
    {gpu_type:'L4',region:'IN2',vram:'24GB',workload_type:'container',spot_num_free_devices:2,spot_price:35},
    {gpu_type:'A100',region:'EU1',vram:'40GB',workload_type:'container',spot_num_free_devices:8,spot_price:1},
    {gpu_type:'A100',region:'IN1',vram:'40GB',workload_type:'vm',spot_num_free_devices:8,spot_price:2},
    {gpu_type:'H100',region:'IN2',vram:'80GB',workload_type:'container',num_free_devices:8,price_per_hour:3},
  ];
  f.runtime.cli.run=async(args:string[])=>args[0]==='status'?{currency:'INR'}:rows;
  const requirement={nodes:2,gpusPerNode:1,minComputeCapability:7.5,minVramMiB:6000,layouts:[{nodes:1,gpusPerNode:2},{nodes:2,gpusPerNode:1}]};
  const quote=await f.runtime.quote(requirement);assert.equal(quote.nodes,1);assert.equal(quote.gpusPerNode,2);assert.equal(quote.type,'A30');assert.equal(quote.price,60);assert.equal(quote.currency,'INR');
  await assert.rejects(f.runtime.quote({...requirement,layouts:[{nodes:2,gpusPerNode:1}]}),/cannot join a VPC/);
  rows.splice(0,2);await assert.rejects(f.runtime.quote(requirement),/No priced, compatible spot capacity/);
});

test('Jarvis CLI creation and changed-ID resume explicitly retain spot with SSH on the selected Indian machine',async()=>{
  const f=fixture();f.runtime.record.provider='jarvis';f.runtime.record.quote={type:'A30',nodes:1,gpusPerNode:2,region:'IN2',price:60,currency:'INR'};f.runtime.identity='/owned/key';
  const instance={machine_id:42,name:'dhai-owned',gpu_type:'A30',num_gpus:2,template:'pytorch',region:'IN2',is_spot:true,status:'Running',ssh_command:'ssh -p 2222 root@gpu.example'};
  f.runtime.cli.run=async(args:string[])=>{f.calls.push(args);if(args[0]==='gpus')return [{gpu_type:'A30',region:'IN2',spot_price:30,spot_num_free_devices:2,workload_type:'container'}];
    if(args[0]==='status')return {currency:'INR'};if(args[0]==='list')return [{...instance,status:'Paused'}];if(args[0]==='resume')return {...instance,machine_id:43};return instance;};
  const hosts=await f.runtime.jarvis();assert.equal(hosts[0].port,2222);assert.equal(hosts[0].identity,'/owned/key');
  const create=f.calls.find(c=>c[0]==='create')!;assert.ok(create.includes('--spot'));assert.ok(!create.includes('--vm'));assert.equal(create[create.indexOf('--num-gpus')+1],'2');
  await f.runtime.resume();assert.equal(f.runtime.record.ids[0],'43');assert.ok(f.calls.find(c=>c[0]==='resume')?.includes('--spot'));
  assert.throws(()=>f.runtime.jarvisHost({...instance,is_spot:false}),/requested Indian spot/);
  assert.throws(()=>f.runtime.jarvisHost({...instance,region:'EU1'}),/requested Indian spot/);
});

test('Jarvis cleanup reconciles a lost create response by its owned name and retains unrelated instances',async()=>{
  const f=fixture();f.runtime.record.provider='jarvis';f.runtime.record.ids=[];f.runtime.record.resources={};let removed=false;
  f.runtime.cli.run=async(args:string[])=>{f.calls.push(args);if(args[0]==='destroy'){assert.equal(args[1],'42');removed=true;return {success:true};}
    return [{machine_id:999,name:'my-existing-gpu'},...removed?[]:[{machine_id:42,name:'dhai-owned'}]];};
  await f.runtime.teardown();assert.ok(removed);assert.equal(f.calls.filter(c=>c[0]==='destroy').length,1);assert.equal(f.writes.at(-1).value,undefined);
});

test('an unknown create that is not listed yet retains its journal and prevents a duplicate rental',async()=>{
  const f=fixture();f.runtime.record.ids=[];f.runtime.record.resources={createRequested:'1'};
  await assert.rejects(f.runtime.teardown(),/create result is unknown/);
  assert.equal(f.writes.at(-1).value.phase,'cleanup');
  assert.equal(f.runtime.allocated,true);
  assert.equal(f.calls.filter(c=>c[0]==='create'||c[0]==='destroy').length,0);
});

test('an increased spot rate requires approval before resuming the saved workspace',async()=>{
  for(const approval of [undefined,'Resume spot runtime']) {
    const f=fixture(approval);
    const instance={machine_id:42,name:'dhai-owned',gpu_type:'A30',num_gpus:2,template:'pytorch',region:'IN2',is_spot:true,status:'Paused',ssh_command:'ssh root@gpu.example'};
    f.runtime.cli.run=async(args:string[])=>{f.calls.push(args);
      if(args[0]==='list')return [instance];
      if(args[0]==='gpus')return [{gpu_type:'A30',region:'IN2',spot_price:40,spot_num_free_devices:2}];
      if(args[0]==='status')return {currency:'INR'};
      if(args[0]==='resume')return {...instance,status:'Running'};
    };
    if(!approval){await assert.rejects(f.runtime.resume(),/Resume cancelled/);assert.equal(f.calls.filter(c=>c[0]==='resume').length,0);}
    else {await f.runtime.resume();assert.equal(f.runtime.record.quote.price,80);assert.equal(f.calls.filter(c=>c[0]==='resume').length,1);}
  }
});
