import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import * as ts from 'typescript';
import {learningPreferences} from '../src/learningPreferences';

test('learning preferences restore valid choices and tolerate missing older state', () => {
  assert.deepEqual(learningPreferences(undefined), {preferred_name:'', check_frequency:'frequent', voice:''});
  assert.deepEqual(learningPreferences({preferred_name:' Varun ',check_frequency:'minimal',voice:'calm'}),
    {preferred_name:'Varun',check_frequency:'minimal',voice:'calm'});
  assert.equal(learningPreferences({voice:'unknown'}).voice, '');
});

test('microphone stop reports a failed submission and never restarts capture', async () => {
  const exports:any = {};
  const source = ts.transpileModule(readFileSync(resolve(__dirname,'../../webview/learningDevices.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(source, {exports, Set, Map});
  let stopped = 0, captures = 0;
  const messages:string[] = [];
  const connection = {agent:'worker',room:{localParticipant:{
    performRpc:async (request:any) => {
      if (JSON.parse(request.payload).commit_turn) throw new Error('RPC timeout');
      return 'ok';
    }, publishTrack:async()=>{}, unpublishTrack:async()=>{},
  }}};
  const devices = new exports.LearningDevices({current:()=>connection,
    capture:async()=>{captures++;return {stop:()=>{stopped++;},mediaStreamTrack:{addEventListener(){}}};},
    pause:async()=>true,changed:()=>{},report:(message:string)=>messages.push(message)});
  await devices.toggle();
  await devices.toggle();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(stopped,1); assert.equal(captures,1);
  assert.match(messages.at(-1)!, /response could not be confirmed/);
});
