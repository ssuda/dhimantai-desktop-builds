/** Real Podman startup/repair in a disposable course, without a local runtime override. */
import * as assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as vscode from 'vscode';
import type {activate} from '../../src/extension';
import {openPracticeFile} from '../../src/practiceInNotebook';
import {PRACTICE_KERNEL} from '../../src/practiceKernel';
import {run} from '../../src/podman';
import {EMAIL, PASSWORD, QUESTION_ID} from './contractServer';

export async function runTest() {
  const {auth,courses} = await vscode.extensions.getExtension<NonNullable<Awaited<ReturnType<typeof activate>>>>('optficial.dhimantai-learning')!.activate();
  const parent = await realpath(await mkdtemp(join(tmpdir(),'dhimantai-recovery-')));
  await vscode.workspace.getConfiguration('dhimantai').update('exercisesFolder',parent,vscode.ConfigurationTarget.Global);
  assert.equal(courses.enabled,true);
  await auth.signInWithPassword(EMAIL,PASSWORD);
  const account=(await auth.session())!.user.id;
  const root=await courses.courseFolder({course:'Python',account,environment:'production'});
  let doc=await openPracticeFile({id:QUESTION_ID,account,title:'Container recovery',question:'Print 42.',starter:'print(42)',language:'python',
    assistance:true,tests:[],path:'/practice-code/'+QUESTION_ID+'/notebook-coach'},'production',root,PRACTICE_KERNEL);
  let code=doc.getCells().find(c=>c.kind===vscode.NotebookCellKind.Code)!;
  const results:object[]=[];
  let engine:Awaited<ReturnType<typeof courses.forFile>>;
  const execute=async (step:string)=>{
    console.log('Course recovery:',step);
    const previous=code.executionSummary?.executionOrder;
    await vscode.commands.executeCommand('notebook.cell.execute',{ranges:[{start:code.index,end:code.index+1}],document:doc.uri});
    for(let i=0;i<6000;i++) {
      if(code.executionSummary?.executionOrder!==previous && code.executionSummary?.success!==undefined) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.notEqual(code.executionSummary?.executionOrder, previous, 'the waiting Run must execute, not reuse a previous success');
    const output=code.outputs.flatMap(o=>o.items).map(i=>Buffer.from(i.data).toString()).join('');
    assert.equal(code.executionSummary?.success,true,output);
    assert.match(output,/42/);
    results.push({step,ok:true,output,runtime:'course container'});
  };
  try {
    await execute('first Run prepares the course and executes without a second Run click');
    engine=await courses.forFile(root,'python'); assert.ok(engine);
    const owner=await run(engine.bin,['inspect','--format','{{index .Config.Labels "ai.dhimant.course"}}',engine.name]);
    assert.equal(engine.name,'dhimantai-course-'+owner);
    assert.ok(root.fsPath.startsWith(parent+'/'));
    await writeFile(join(root.fsPath,'learner-work.txt'),'preserve my work\n');
    await run(engine.bin,['stop',engine.name]);
    await execute('stopped container starts automatically and the waiting cell runs');
    // Damage only the newly created, labelled test container. The image and all other containers remain intact.
    await run(engine.bin,['exec','--user','0',engine.name,'/bin/sh','-c','rm /usr/local/bin/python']);
    await run(engine.bin,['stop',engine.name]);
    await execute('broken course Python is repaired and the original Run executes automatically');
    assert.equal(await readFile(join(root.fsPath,'learner-work.txt'),'utf8'),'preserve my work\n');
    assert.equal(code.document.getText(),'print(42)');
    results.push({step:'repair preserves the learner notebook and course files',ok:true});
    const pick = vscode.window.showQuickPick;
    try {
      (vscode.window as any).showQuickPick = async (items: {label:string}[]) => items.find(item => item.label === 'Python');
      doc = await openPracticeFile({id:QUESTION_ID,account,title:'Outside course',question:'Print the platform and 42.',
        starter:'import sys\nprint(sys.platform)\nprint(42)',language:'python',assistance:true,tests:[],
        path:'/practice-code/'+QUESTION_ID+'/notebook-coach'},'production',vscode.Uri.file(join(parent,'outside-course')),PRACTICE_KERNEL);
      assert.equal(courses.recordFor(doc.uri), undefined);
      code = doc.getCells().find(c=>c.kind===vscode.NotebookCellKind.Code)!;
      await execute('a notebook outside the course folder selects a course and runs in its container');
      assert.match(code.outputs.flatMap(o=>o.items).map(i=>Buffer.from(i.data).toString()).join(''), /linux/);
    } finally { (vscode.window as any).showQuickPick = pick; }
  } catch(error) {results.push({step:'failure',ok:false,error:String(error)});throw error;}
  finally {
    if(engine) await run(engine.bin,['rm','--force',engine.name]).catch(()=>{});
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({vscode:vscode.version,extension:'0.36.2',root:root.fsPath,results},null,2));
  }
}
export {runTest as run};
