import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

function fixture(provider:string, approve:boolean, platform='linux', account='ready') {
  const calls:any[]=[], facts:string[]=[], pickers:string[][]=[];
  const label:Record<string,string>={aws:'AWS EC2',gcp:'Google Compute Engine',azure:'Microsoft Azure'};
  const plan={name:'dhai-0123456789abcdef',owner:['account'],existing:false,
    quote:{type:'gpu-vm',gpu:'L4',region:'region',zone:'zone-a',price:.3,nodes:2,gpusPerNode:1}};
  const closed=new EventEmitter(),terminals:any[]=[];
  const vscode={ProgressLocation:{Notification:1},window:{
    showQuickPick:async(items:any[])=>{pickers.push(items.map(item=>item.label));return items.find(item=>item.id===provider);},
    showInputBox:async()=>'region',
    showInformationMessage:async(text:string,_options:unknown,first:string)=>{facts.push(text);return approve?first:undefined;},
    createTerminal:(options:any)=>{const terminal={exitStatus:{code:0},show(){terminals.push(options);
      account=options.shellArgs.includes('--install')?'login':options.shellArgs.includes('--login')&&provider==='gcp'?'project':'ready';setImmediate(()=>closed.emit('close',terminal));}};
      return terminal;},
    onDidCloseTerminal:(callback:any)=>{closed.on('close',callback);return {dispose:()=>closed.off('close',callback)};},
    showErrorMessage:async()=>undefined,
    withProgress:async(_:unknown,run:Function)=>run({}, {onCancellationRequested:()=>({dispose(){}})}),
  }};
  const modules:Record<string,unknown>={vscode};
  const spawn=(bin:string,args:string[],options:any)=>{
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{}});
    let input='';child.stdin.on('data',chunk=>input+=chunk);
    child.stdin.on('finish',()=>setImmediate(()=>{
      const msg=JSON.parse(input);calls.push({bin,args,options,...msg});
      const result=msg.action==='account'?account:msg.action==='plan'?(msg.region?plan:null):msg.action==='connect'?{
        hosts:[plan.name,plan.name+'-worker1'],expiresAt:Date.now()+600000}:null;
      child.stdout.write('DHIMANTAI_RESULT '+JSON.stringify(result)+'\n');child.emit('close',0);
    }));
    return child;
  };
  function load(name:string,overrides:Record<string,unknown>={}) {
    const path=resolve(__dirname,'../src/'+name+'.js'),exports:any={},require=createRequire(path);
    runInNewContext(readFileSync(path,'utf8'),{exports,module:{exports},setTimeout,clearTimeout,process:{platform},Buffer,
      require:(id:string)=>overrides[id]??modules[id]??require(id)});
    return exports;
  }
  modules['./cloudCli']=load('cloudCli',{'./localRunner':{}});
  modules['./skySpotRuntime']=load('skySpotRuntime',{'node:child_process':{spawn}});
  const {CloudGpuRuntime}=load('cloudGpuRuntime');
  const runtime=new CloudGpuRuntime({asAbsolutePath:(file:string)=>'/extension path/'+file},'lab|owner');
  const recipe={nodes:2,gpusPerNode:1,minComputeCapability:8,minVramMiB:6000};
  return {runtime,recipe,facts,calls,pickers,label,terminals};
}

test('all three cloud picker entries connect priced VMs and dispatch save and release to the owning provider',async()=>{
  for(const id of ['aws','gcp','azure']){
    const f=fixture(id,true,id==='azure'?'win32':'linux');
    const result=await f.runtime.connect(f.recipe);
    assert.deepEqual(Array.from(f.pickers[0]),['JarvisLabs','AWS EC2','Google Compute Engine','Microsoft Azure']);
    assert.equal(f.runtime.label,f.label[id]+' · Spot');
    assert.equal(result.requirement.managedContainer,false);
    assert.deepEqual(Array.from(result.hosts,(host:any)=>host.host),['dhai-0123456789abcdef','dhai-0123456789abcdef-worker1']);
    assert.ok(result.hosts.every((host:any)=>host.cloudVm));
    assert.match(f.facts[0],/USD 0.600\/hour/);
    await f.runtime.savedArtifact('/saved');await f.runtime.teardown();
    assert.deepEqual(f.calls.map(call=>call.action),['account','plan','plan','connect','saved','release']);
    for(const call of f.calls){
      assert.equal(call.provider,id);assert.equal(call.options.shell,false);
      assert.equal(call.bin,id==='azure'?'wsl.exe':'python3');
      assert.ok(call.args.includes('/extension path/media/course/sky_spot.py'));
      assert.equal(call.lease,f.calls[0].lease);
    }
  }
});

test('cancelling the quote creates and deletes no machines',async()=>{
  const f=fixture('aws',false);
  await assert.rejects(f.runtime.connect(f.recipe),/cancelled/);
  await f.runtime.failedSetup();
  assert.deepEqual(f.calls.map(call=>call.action),['account','plan','plan']);
});

test('first-use cloud tools install and sign in before presenting a billable quote',async()=>{
  for(const [id,platform] of [['aws','darwin'],['azure','win32'],['gcp','win32']]){
    const f=fixture(id,true,platform,'install');
    await f.runtime.connect(f.recipe);
    assert.deepEqual(f.calls.map(c=>c.action),[...Array(id==='gcp'?4:3).fill('account'),'plan','plan','connect']);
    assert.deepEqual(f.terminals.map(t=>Array.from(t.shellArgs).slice(-2)),[['--install',id],['--login',id],...(id==='gcp'?[['--project',id]]:[])]);
    assert.ok(f.terminals.every(t=>t.shellPath===(platform==='win32'?'wsl.exe':'python3')));
  }
});

test('declining student sign-in never requests a quote',async()=>{
  const f=fixture('azure',false,'darwin','login');
  await assert.rejects(f.runtime.connect(f.recipe),/cancelled/);
  assert.deepEqual(f.calls.map(c=>c.action),['account']);
  assert.equal(f.terminals.length,0);
});

test('canceling GCE sign-in or project selection exits before a quote or allocation',async()=>{
  for(const state of ['login','project']){
    const f=fixture('gcp',false,'darwin',state);
    await assert.rejects(f.runtime.connect(f.recipe),/cancelled/);
    assert.deepEqual(f.calls.map(c=>c.action),['account']);
    assert.equal(f.terminals.length,0);
  }
});
