import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {projectDebugTarget} from '../src/projectCore';

test('project debugging uses a public reproduction and keeps the private grader out of the launch', () => {
  const target = (check: string) => projectDebugTarget({check});
  assert.deepEqual(target('shelf:list'), ['-m','shelf','list']);
  assert.deepEqual(target('tests.test_search'), ['-m','unittest','tests.test_search','-v']);
  assert.deepEqual(target('debug:meter-blocks'), ['-c','from meter import blocks\nprint(blocks(45))']);
  assert.deepEqual(projectDebugTarget({check:'debug:meter-blocks'},['test_regression.py']),
    ['-m','unittest','discover','-p','test*.py','-v']);
  assert.equal(target('architecture:parcel-pickup'), undefined);
  assert.equal(target('shelf-evidence:list'), undefined);
  assert.equal(target('final:agent'), undefined);
});

test('the project adapter runs in the project container and reports only current public pause locations', async () => {
  const subscription = {dispose() {}};
  let adapter: any, tracker: any, terminate: any, launch: any, launchOptions: any;
  const notices: [string,string,number,()=>boolean][] = [];
  const debug = {
    registerDebugAdapterDescriptorFactory: (_type:string, f:unknown) => { adapter=f; return subscription; },
    registerDebugAdapterTrackerFactory: (_type:string, f:unknown) => { tracker=f; return subscription; },
    onDidTerminateDebugSession: (fn:unknown) => { terminate=fn; return subscription; },
    startDebugging: async (_folder:unknown, config:unknown, options:unknown) => { launch=config; launchOptions=options; return true; },
  };
  const vscode = {debug, Uri:{file:(root:string)=>root}, workspace:{isTrusted:true, getWorkspaceFolder:()=>undefined},
    DebugAdapterExecutable:class { constructor(readonly command:string,readonly args:string[]) {} }};
  const sandbox = {exports:{} as any, require:(id:string) => id === 'vscode' ? vscode :
    id.startsWith('./') ? require('../src/' + id.slice(2)) : require(id)};
  runInNewContext(readFileSync(join(__dirname,'../src/projectDebugger.js'),'utf8'),sandbox);
  const tool = new sandbox.exports.ProjectDebugger((...info:typeof notices[number]) => notices.push(info));
  const root='/learner/project', remote='/course/repository';
  const engine = {bin:'podman',path:()=>remote,execArgs:(folder:string,cmd:string,args:string[]) => {
    assert.equal(folder,root); return ['exec','-i','--workdir',remote,'learner-container',cmd,...args];
  }};
  let path = root + '/app.py', current = true;
  const session = {get configuration() {return launch;},type:'dhimantai-project',customRequest: async (command:string) => {
    assert.equal(command,'stackTrace'); return {stackFrames:[{source:{path},line:7}]};
  }};
  try {
    await tool.start(root,engine,['-m','shelf','list'],()=>current);
    assert.equal(launchOptions.noDebug,false);
    assert.equal(launch.module,'shelf'); assert.equal(launch.args[0],'list');
    assert.equal(launch.pathMappings[0].localRoot,root); assert.equal(launch.pathMappings[0].remoteRoot,remote);
    const exe=adapter.createDebugAdapterDescriptor(session);
    assert.equal(exe.command,'podman');
    assert.deepEqual([...exe.args],['exec','-i','--workdir',remote,'learner-container','python','-m','debugpy.adapter']);
    assert.throws(()=>adapter.createDebugAdapterDescriptor({configuration:{}}));
    const watch=tracker.createDebugAdapterTracker(session);
    const pause=()=>watch.onDidSendMessage({type:'event',event:'stopped',body:{threadId:1}});
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    pause(); await tick();
    assert.deepEqual(notices[0].slice(0,3),[root,'app.py',7]);
    assert.equal(notices[0][3](),true);
    watch.onWillReceiveMessage({command:'next'});
    assert.equal(notices[0][3](),false);
    path='/outside/app.py'; pause(); await tick();
    path=root+'/.env'; pause(); await tick();
    path=root+'/app.py'; pause(); watch.onWillReceiveMessage({command:'continue'}); await tick();
    assert.equal(notices.length,1);
    current=false; pause(); await tick();
    assert.equal(notices.length,1);
    terminate(session); assert.equal(tracker.createDebugAdapterTracker(session),undefined);
    await tool.start(root,engine,['-c','from meter import blocks\nprint(blocks(45))'],()=>true,true);
    assert.equal(launchOptions.noDebug,true); assert.equal(launch.module,undefined);
    assert.match(launch.code,/blocks\(45\)/);
  } finally { tool.dispose(); }
});
