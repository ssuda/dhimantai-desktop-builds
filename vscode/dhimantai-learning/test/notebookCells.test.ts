import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NotebookCells,CellEvent} from '../src/notebookCells';
import {validSnapshot} from '../src/roomCode';

const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
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
    assert.match((await cells.run('python','answer')).stderr,/NameError/);
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
