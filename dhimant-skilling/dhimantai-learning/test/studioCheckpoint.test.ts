import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {snapshot} from '../src/studioRuntime';

test('Instructor diff contains exactly the demonstrated edit and survives Git maintenance',async()=>{
  const root=await mkdtemp(join(tmpdir(),'studio-checkpoint-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','-q');git('config','user.name','Learner');git('config','user.email','learner@example.test');
    await writeFile(join(root,'model.php'),'baseline\n');git('add','.');git('commit','-qm','Start');
    const head=git('rev-parse','HEAD');
    await writeFile(join(root,'model.php'),'staged\n');git('add','model.php');
    await writeFile(join(root,'model.php'),'unstaged\n');
    const attempt=randomUUID(),demo=randomUUID();
    const buffers=new Map([['model.php','unsaved learner edit\n']]);
    const before=await snapshot(root,attempt,'Learner',buffers,{id:demo});
    const expected=buffers.get('model.php')!+'demonstration\n';
    buffers.set('model.php',expected);
    const after=await snapshot(root,attempt,'Instructor',buffers,{id:demo,file:'model.php',before:before.commit,expected});
    assert.equal(git('diff','--name-only',before.commit,after.commit),'model.php');
    assert.equal(git('show',before.commit+':model.php'),'unsaved learner edit');
    assert.equal(git('show',after.commit+':model.php'),expected.trim());
    assert.equal(git('show',':model.php'),'staged');assert.equal(git('rev-parse','HEAD'),head);
    assert.equal(git('show','-s','--format=%an',after.commit),'Instructor');
    await writeFile(join(root,'other.php'),'concurrent edit\n');
    await assert.rejects(snapshot(root,attempt,'Instructor',buffers,{id:randomUUID(),file:'model.php',before:before.commit,expected}),
      /source changed/);
    const learner=await snapshot(root,attempt,'Learner',new Map([['model.php','my next revision\n']]));
    git('reflog','expire','--expire=now','--all');git('gc','--prune=now');
    for(const [name,id] of [['before',before.commit],['after',after.commit]])
      assert.equal(git('rev-parse','refs/dhimantai/attempts/'+attempt+'/demos/'+demo+'/'+name),id);
    assert.equal(git('show',learner.commit+':model.php'),'my next revision');
  }finally{await rm(root,{recursive:true,force:true});}
});
