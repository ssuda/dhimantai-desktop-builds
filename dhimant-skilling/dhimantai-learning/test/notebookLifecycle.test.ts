import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn,ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NotebookCells} from '../src/notebookCells';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(timeout=0) {
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  const messages:any[]=[];
  child.stdin.on('data',data=>{
    for(const line of String(data).trim().split('\n')) {
      const request=JSON.parse(line);messages.push(request);
      if(request.action==='run' && !timeout)child.stdout.write(JSON.stringify({kind:'done',id:request.id,
        execution:{status:'exited',exit_code:0,stdout:'ready\n',stderr:'',truncated:false}})+'\n');
    }
  });
  const cells=new NotebookCells(()=>({}),undefined,undefined,timeout,{target:'Test',start:async()=>child as unknown as ChildProcessWithoutNullStreams});
  return {child,cells,messages,finish:()=>{child.stdout.end();child.stderr.end();child.emit('close',0);}};
}

test('disposable sessions wait for close, not exit, and repeated close sends one shutdown request',async()=>{
  const f=fixture();
  await f.cells.run('python','pass');
  let done=false;
  const closing=f.cells.close().then(()=>{done=true;});
  const repeated=f.cells.close();
  f.child.emit('exit',0);await tick();
  assert.equal(done,false,'exit can precede release of child handles');
  assert.equal(f.messages.filter(m=>m.action==='close').length,1);
  f.finish();await Promise.all([closing,repeated]);assert.ok(done);
});

test('I/O failure and run timeout still wait for the retired runtime process',async()=>{
  for(const timedOut of [false,true]) {
    const f=fixture(timedOut?5:0);
    const result=await f.cells.run('python','pass');
    if(timedOut)assert.equal(result.status,'timeout');
    else f.child.stdin.emit('error',new Error('pipe failed'));
    let done=false;
    const closing=f.cells.close().then(()=>{done=true;});
    await tick();assert.equal(done,false);
    f.finish();await closing;
  }
});

test('shutdown has a deadline and an actionable recovery message; a late close remains safe',async()=>{
  const f=fixture();await f.cells.run('python','pass');
  await assert.rejects(f.cells.close(10),/temporary files were kept.*Restart runtime.*reopen the desktop/);
  assert.equal(f.messages.filter(m=>m.action==='close').length,1);
  f.finish();await f.cells.close(10);
});

test('closing during transport startup waits for the cancelled child to close',async()=>{
  const f=fixture();let resolveStart!:(child:ChildProcessWithoutNullStreams)=>void;
  const cells=new NotebookCells(()=>({}),undefined,undefined,0,{target:'Test',start:()=>new Promise(resolve=>{resolveStart=resolve;})});
  const running=assert.rejects(cells.run('python','pass'),/restarted/);
  await tick();let done=false;
  const closing=cells.close().then(()=>{done=true;});resolveStart(f.child as unknown as ChildProcessWithoutNullStreams);
  await running;await tick();assert.equal(done,false);
  f.finish();await closing;
});

test('real child with delayed shutdown releases its working directory before cleanup',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'notebook-process-'));
  let child:ChildProcessWithoutNullStreams|undefined,closed=false;
  const cells=new NotebookCells(()=>({}),undefined,undefined,0,{target:'Test',start:async()=>{
    child=spawn(process.execPath,['-e',`
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.action==='run')console.log(JSON.stringify({id:m.id,kind:'done',execution:{status:'exited',exit_code:0,stdout:'ready',stderr:''}}));
        if(m.action==='close')setTimeout(()=>process.exit(0),150);
      });
    `],{cwd:folder,windowsHide:true});
    child.once('close',()=>{closed=true;});return child;
  }});
  try {
    assert.equal((await cells.run('python','pass')).exit_code,0);
    await cells.close();assert.ok(closed);
    await rm(folder,{recursive:true,force:true});
  } finally {child?.kill();await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
