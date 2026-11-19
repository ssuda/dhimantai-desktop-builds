import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NotebookCells,CellEvent} from '../src/notebookCells';
import {validSnapshot} from '../src/roomCode';
import {RuntimePreparationError} from '../src/runtimeErrors';

const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const python=process.env.DHIMANTAI_TEST_PYTHON || (process.platform==='win32'?'python':'python3');
const hasIPython=()=>{try{execFileSync(python,['-c','import IPython'],{stdio:'ignore'});return true;}catch{return false;}};
test('failed preparation is identified before sending code and permits a successful retry',async()=>{
  let broken=true, toolReads=0;
  const events:CellEvent[]=[];
  const cells=new NotebookCells(()=>{toolReads++;return {python};},async()=>{
    if(broken)throw new Error('Podman cannot apply the course resource limits.');
    return undefined;
  });
  try {
    await assert.rejects(cells.run('python','print("Runtime ready")','',{event:e=>events.push(e)}),error=>{
      assert.ok(error instanceof RuntimePreparationError);
      assert.match(error.message,/Podman cannot apply/);
      return true;
    });
    assert.equal(toolReads,0,'preparation failures must not execute locally');
    assert.equal(cells.busy,false);
    assert.deepEqual(events,[{kind:'phase',phase:'preparing'}]);
    broken=false;
    const run=await cells.run('python','print("Runtime ready")');
    assert.equal(run.status,'exited');assert.equal(run.exit_code,0);assert.equal(run.stdout,'Runtime ready\n');
  } finally {await cells.close();}
});

test('C++ and TypeScript distinguish compiler rejection from runtime failure and never run stale output',
  {timeout:30000},async()=>{
    const cells=new NotebookCells(()=>({python,tsc:resolve(__dirname,'../../node_modules/typescript/bin/tsc')}));
    try {
      for(const [language,good,bad,diagnostic] of [
        ['cpp','#include <iostream>\nint main() { int count = 5; std::cout << count << "\\n"; }',
          '#include <iostream>\nint main() { int count = 5\nstd::cout << count << "\\n"; }',/expected.*;/s],
        ['typescript','let count: number = 5; console.log(count);','let count: number = "five"; console.log(count);',/TS2322/],
      ] as const) {
        const initial=await cells.run(language,good);
        assert.equal(initial.status,'exited');assert.equal(initial.stdout,'5\n');
        const failed=await cells.run(language,bad);
        assert.equal(failed.status,'compile_error');assert.notEqual(failed.exit_code,0);
        assert.match(failed.stderr+failed.stdout,diagnostic);
        assert.doesNotMatch(failed.stdout,/^5$/m,'old executable output must not run');
        const recovered=await cells.run(language,good);
        assert.equal(recovered.status,'exited');assert.equal(recovered.exit_code,0);assert.equal(recovered.stdout,'5\n');
      }
      const runtimeFailure=await cells.run('cpp','int main() { return 7; }');
      assert.equal(runtimeFailure.status,'exited');assert.equal(runtimeFailure.exit_code,7);
    } finally {await cells.close();}
  });

test('failed pip commands and unchecked installations fail the cell without poisoning later runs',
  {skip:!hasIPython(),timeout:30000},async()=>{
    const cells=new NotebookCells(()=>({python}),undefined,undefined,10000);
    try {
      for(const source of [
        '%pip install --no-index dhimantai-missing-regression-package',
        'import sys\n!{sys.executable} -m pip install --no-index dhimantai-missing-regression-package',
        'import sys, subprocess\nresult=subprocess.run([sys.executable,"-m","pip","install","--no-index","dhimantai-missing-regression-package"])\nprint(result.returncode)',
      ]) {
        const failed=await cells.run('python',source);
        assert.equal(failed.exit_code,1,JSON.stringify(failed));
        assert.match(failed.stderr+failed.stdout,/No matching distribution|Could not find a version/);
        const next=await cells.run('python','print("ready")');
        assert.equal(next.exit_code,0);assert.equal(next.stdout,'ready\n');
      }
      const handled=await cells.run('python','import sys, subprocess\nresult=subprocess.run([sys.executable,"-c","raise SystemExit(7)"])\nassert result.returncode==7');
      assert.equal(handled.exit_code,0,handled.stderr);
      const expanded=await cells.run('python','def shell_probe():\n    local_word="function-local"\n    !echo {local_word}\nshell_probe()');
      assert.equal(expanded.stdout.trim(),'function-local');
    } finally {await cells.close();}
  });
test('preparation precedes execution and cancellation during preparation never runs learner code',async()=>{
  let ready!:()=>void;
  const gate=new Promise<void>(resolve=>{ready=resolve;});
  const cells=new NotebookCells(()=>({}),async()=>{await gate;return undefined;});
  const events:CellEvent[]=[], abort=new AbortController();
  try {
    const pending=cells.run('python','print("should not run")','',{signal:abort.signal,event:e=>events.push(e)});
    assert.deepEqual(events,[{kind:'phase',phase:'preparing'}]);
    abort.abort(); ready();
    await assert.rejects(pending,/cancelled/);
    assert.deepEqual(events,[{kind:'phase',phase:'preparing'}]);
    const run=await cells.run('python','print("ready")','',{event:e=>events.push(e)});
    assert.equal(run.stdout,'ready\n');
    assert.deepEqual(events.slice(1,3),[{kind:'phase',phase:'preparing'},{kind:'phase',phase:'running'}]);
    assert.ok(events.slice(3).some(e=>e.kind==='stream' && e.text.includes('ready')));
  } finally {await cells.close();}
});
test('cells share Python definitions, exported shell environment and project files; subprocess output streams',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'cell-test-'));
  const cells=new NotebookCells(()=>({}),undefined,async()=>folder);
  try{
    assert.equal((await cells.run('python','answer=41')).exit_code,0);
    assert.equal((await cells.run('python','answer+1')).stdout,'42\n');
    assert.equal((await cells.run('bash','mkdir -p project; cd project; export CELL_TEST=ready; printf shared > data.txt')).exit_code,0);
    assert.equal((await cells.run('python','import os; print(os.getenv("CELL_TEST")); print(open("data.txt").read())')).stdout,'ready\nshared\n');
    assert.equal((await cells.run('bash','%%writefile project/helper.js\nmodule.exports=42;')).exit_code,0);
    assert.equal((await cells.run('javascript','console.log(require("./helper"))')).stdout,'42\n');
    const events:CellEvent[]=[];
    const result=await cells.run('python','import subprocess\nsubprocess.run(["echo","child output"],check=True)', '',{event:e=>events.push(e)});
    assert.match(result.stdout,/child output/);
    assert.ok(events.some(e=>e.kind==='stream' && e.text.includes('child output')));
    const uploaded=(content:string)=>({files:[{name:'uploaded.txt',content}]});
    assert.equal((await cells.run('python','print(open("../uploaded.txt").read())','',uploaded('first'))).stdout,'first\n');
    await cells.run('python','open("../uploaded.txt","w").write("edited in cell")');
    assert.equal((await cells.run('python','print(open("../uploaded.txt").read())','',uploaded('first'))).stdout,'edited in cell\n');
    assert.equal((await cells.run('python','print(open("../uploaded.txt").read())','',uploaded('revised'))).stdout,'revised\n');
    await cells.run('bash','unset CELL_TEST');
    assert.equal((await cells.run('python','print(os.getenv("CELL_TEST"))')).stdout,'None\n');
    cells.restart();
    assert.equal(await readFile(join(folder,'project/data.txt'),'utf8'),'shared');
    const missing = await cells.run('python','answer');
    assert.notEqual(missing.exit_code, 0);
    assert.match(missing.stdout + missing.stderr,/NameError/);
  }finally{cells.restart();await pause(100);await rm(folder,{recursive:true,force:true});}
});

test('live Python and program input, rich display, interruption and subsequent execution',async()=>{
  const cells=new NotebookCells(()=>({}));
  try{
    const events:CellEvent[]=[];
    const answer=await cells.run('python','print(input("Name? "))','',{interactive:true,event:e=>{events.push(e);if(e.kind==='input')cells.input('Asha');}});
    assert.match(answer.stdout,/Name\? Asha/);
    assert.equal((await cells.run('python','import sys; print(repr(sys.stdin.read(1))); print(repr(sys.stdin.readline()))','',
      {interactive:true,event:e=>{if(e.kind==='input')cells.input('abc');}})).stdout,"'a'\n'bc\\n'\n");
    const node=await cells.run('javascript','process.stdout.write("ready\\n"); process.stdin.once("data",x=>{console.log(x.toString().trim());process.exit(0);});','',
      {interactive:true,event:e=>{if(e.kind==='stream' && e.text.includes('ready'))cells.input('typed live');}});
    assert.match(node.stdout,/typed live/);
    await cells.run('python','display({"text/html":"<b>result</b>"},raw=True)','',{event:e=>events.push(e)});
    assert.ok(events.some(e=>e.kind==='display' && e.data['text/html']==='<b>result</b>'));
    const abort=new AbortController();
    const pending=cells.run('python','print("started",flush=True)\nwhile True: pass','',{signal:abort.signal,event:e=>{if(e.kind==='stream')abort.abort();}});
    assert.equal((await pending).status,'cancelled');
    assert.equal((await cells.run('python','print("after stop")')).stdout,'after stop\n');
    const external=await cells.run('bash','echo running; sleep 60','',{event:e=>{if(e.kind==='stream')cells.stop();}});
    assert.equal(external.status,'cancelled');
  }finally{cells.restart();}
});

test('cell input validation accepts shell/database and prevents invalid file paths',()=>{
 const base={snippet:'code-1',revision:0,source:'',stdin:'',question:'Experiment'};
 for(const language of ['bash','zsh','pglab','sql'])assert.equal(validSnapshot({...base,language}),true);
 assert.equal(validSnapshot({...base,language:'python',files:[{name:'../outside',content:'x'}]}),false);
 assert.equal(validSnapshot({...base,language:'python',argv:['hello world'],files:[{name:'src/main.c',content:'x'}]}),true);
});
