import {authoredConfiguration} from './authoredConfiguration';
import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, realpath, rm, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {cellLanguages} from '../src/roomCode';

test('programming workspaces isolate account and environment, preserve course identity and never fetch course images',async()=>{
  const filename=resolve(__dirname,'../src/courseWorkspace.js'), exports:any={}, nativeRequire=createRequire(filename);
  const parent=await realpath(await mkdtemp(join(tmpdir(),'programming-runtime-'))), state=new Map<string,any>();
  let account='alice', environment='production', downloads=0;
  const stop=new Error('local build reached');
  const vscode={Uri:{file:(fsPath:string)=>({scheme:'file',fsPath})},env:{},
    workspace:{isTrusted:true,getConfiguration:()=>({get:()=>parent})},ProgressLocation:{Notification:1},
    window:{withProgress:async()=>{throw stop;}}};
  const stubs=new Map<string,unknown>([['vscode',vscode],...['./podman','./courseEngine','./courseDebug',
    './courseReadiness','./courseTerminal','./colab','./colabNotebooks','./notebookKernelPicker'].map(name=>[name,{}] as [string,unknown])]);
  runInNewContext(readFileSync(filename,'utf8'),{exports,process,require:(name:string)=>stubs.has(name)?stubs.get(name):nativeRequire(name)});
  const context={extensionPath:resolve(__dirname,'../..'),globalState:{keys:()=>[...state.keys()],get:(key:string)=>state.get(key),
    update:async(key:string,value:any)=>{state.set(key,value);}}};
  const workspaces=new exports.CourseWorkspaces(context,{session:async()=>({user:{id:account}})},()=>environment,{},true,
    undefined,async()=>{downloads++;return {runtime:null,configuration:authoredConfiguration('Java Programming')};});
  try {
    const alice=await workspaces.programmingFolder(account,environment);
    assert.equal((await workspaces.programmingFolder(account,environment)).fsPath,alice.fsPath);
    const record=workspaces.recordFor(alice);
    assert.equal(record.runtime,'programming');
    assert.deepEqual(new Set((await workspaces.recipe(record)).languages),new Set(Object.keys(cellLanguages)));
    await writeFile(join(record.root,'requirements.txt'),'# learner packages\nrequests==2.32.3\n');
    await workspaces.writeRecipe(record);
    const requirements=await readFile(join(record.root,'requirements.txt'),'utf8');
    assert.match(requirements,/^# learner packages\nrequests==2.32.3\n/);
    for(const name of ['numpy','pandas','matplotlib','scikit-learn'])assert.ok(requirements.includes(name+'=='));
    await assert.rejects(workspaces.setup(record),(error:unknown)=>error===stop);
    assert.equal(downloads,0);
    const course=await workspaces.courseFolder({course:'Java Programming',account,environment});
    assert.notEqual(course.fsPath,alice.fsPath);
    await assert.rejects(workspaces.setup(workspaces.recordFor(course)),(error:unknown)=>error===stop);
    assert.equal(downloads,1,'course setup still resolves its published image');
    account='bob';
    await assert.rejects(workspaces.programmingFolder('alice',environment),/Sign in/);
    const bob=await workspaces.programmingFolder(account,environment);
    assert.notEqual(bob.fsPath,alice.fsPath);
    environment='staging';
    assert.notEqual((await workspaces.programmingFolder(account,environment)).fsPath,bob.fsPath);
  } finally {await rm(parent,{recursive:true,force:true});}
});
