import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, access, rm, readdir, writeFile, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

test('notebook readiness checks course dependencies and closes its disposable session on success or failure', async () => {
  const filename = resolve(__dirname, '../src/courseReadiness.js'), nativeRequire = createRequire(filename);
  const good = {status:'exited',exit_code:0,stdout:'Course environment ready\n',stderr:'',truncated:false};
  for (const outcome of [good, {...good,exit_code:1,stdout:'',stderr:'Python notebook could not start.'},
    {...good,exit_code:1,stderr:"Python dependency could not be loaded. No module named 'transformers'"},
    {...good,status:'timeout'}, {...good,truncated:true}, {...good,stdout:''}, new Error('Container stopped')]) {
    const folder = await mkdtemp(join(tmpdir(), 'notebook-readiness-test-'));
    let closed = false, ran = false;
    const engine = {root:folder}, exports:any = {};
    let temporary = '';
    class Cells {
      constructor(_tools:unknown, private selected:()=>Promise<unknown>, private workspace:()=>Promise<string>) {}
      async run(language:string, source:string) {
        temporary = await this.workspace();
        ran = true;
        assert.equal(await this.selected(), engine);
        assert.equal(language, 'python');
        assert.match(source, /import_module/);
        for (const name of ['IPython', 'ipykernel', 'nbformat', 'torch', 'numpy', 'transformers']) assert.ok(source.includes(JSON.stringify(name)));
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      async close() {await new Promise(resolve=>setTimeout(resolve,20)); closed = true;}
    }
    runInNewContext(readFileSync(filename,'utf8'), {exports,require:(id:string)=>id==='./notebookCells'
      ? {NotebookCells:Cells} : id==='node:fs/promises' ? {...nativeRequire(id),rm:async(path:string,options:any)=>{
        assert.ok(closed,'Windows cannot remove the child working directory before close');
        assert.equal(path,temporary);
        assert.equal(options.maxRetries,5);assert.equal(options.retryDelay,100);
        return rm(path,options);
      }} : nativeRequire(id)});
    try {
      const pending = exports.verifyCourseNotebook(engine, ['torch', 'numpy', 'transformers']);
      if (outcome === good) await pending;
      else await assert.rejects(pending, /Container stopped|Python notebook check failed/);
      assert.ok(ran); assert.ok(closed);
      await assert.rejects(access(temporary), {code:'ENOENT'});
      assert.deepEqual(await readdir(folder),[]);
    } finally {await rm(folder,{recursive:true,force:true});}
  }
});

test('persistent Windows cleanup locks do not block a ready runtime or mask a failed check', async () => {
  const filename = resolve(__dirname, '../src/courseReadiness.js'), nativeRequire = createRequire(filename);
  for (const code of ['EBUSY','EPERM','ENOTEMPTY']) for (const fails of [false,true]) {
    const root = await mkdtemp(join(tmpdir(),'notebook-locked-'));
    const original = new Error('Missing PyTorch dependency'), warnings:unknown[]=[];
    let closed = false, removals = 0;
    class Cells {
      async run() {if(fails)throw original;return {status:'exited',exit_code:0,stdout:'Course environment ready\n'};}
      async close() {closed=true;}
    }
    const exports:any={};
    runInNewContext(readFileSync(filename,'utf8'), {exports,console:{warn:(...args:unknown[])=>warnings.push(args)},require:(id:string)=>
      id==='./notebookCells' ? {NotebookCells:Cells} : id==='node:fs/promises' ? {...nativeRequire(id),rm:async()=>{
        assert.ok(closed);removals++;throw Object.assign(new Error('locked'),{code});
      }} : nativeRequire(id)});
    try {
      await writeFile(join(root,'learner.py'),'keep my work');
      if(fails)await assert.rejects(exports.verifyCourseNotebook({root}),error=>error===original);
      else assert.match(await exports.verifyCourseNotebook({root}),/You can continue running code.*after closing dhimantAI/);
      assert.equal(removals,1,'no unbounded requeue after the fs.rm retry budget is exhausted');
      assert.equal(warnings.length,1);
      assert.equal(await readFile(join(root,'learner.py'),'utf8'),'keep my work');
      assert.equal((await readdir(root)).filter(name=>name.startsWith('.notebook-')).length,1);
    } finally {await rm(root,{recursive:true,force:true});}
  }
});

test('a shutdown timeout retains the directory, preserves the original failure, and never starts deletion', async () => {
  const filename = resolve(__dirname, '../src/courseReadiness.js'), nativeRequire = createRequire(filename);
  for(const fails of [false,true]) {
    const root=await mkdtemp(join(tmpdir(),'notebook-shutdown-')),exports:any={};
    const original=new Error('Notebook startup failed'),shutdown=new Error('Runtime did not close; restart the runtime');
    class Cells {
      async run(){if(fails)throw original;return {status:'exited',exit_code:0,stdout:'Course environment ready\n'};}
      async close(){throw shutdown;}
    }
    runInNewContext(readFileSync(filename,'utf8'),{exports,console:{warn:()=>{}},require:(id:string)=>id==='./notebookCells'
      ? {NotebookCells:Cells} : id==='node:fs/promises' ? {...nativeRequire(id),rm:()=>assert.fail('live runtime files must be retained')} : nativeRequire(id)});
    try {
      await assert.rejects(exports.verifyCourseNotebook({root}),error=>error===(fails?original:shutdown));
      assert.equal((await readdir(root)).length,1);
    } finally {await rm(root,{recursive:true,force:true});}
  }
});
