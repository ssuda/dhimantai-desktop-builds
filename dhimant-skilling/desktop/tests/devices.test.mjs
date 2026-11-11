import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from '../../dhimantai-learning/node_modules/esbuild/lib/main.js';
const result = await build({entryPoints:[fileURLToPath(new URL('../../dhimantai-learning/webview/learningDevices.ts', import.meta.url))],
  bundle:true, write:false, format:'esm', platform:'node'});
const {LearningDevices} = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
function fixture() {
  const calls = [], stopped = [], tracks = [];
  let current = true, capture;
  const connection = {agent:'teacher',room:{localParticipant:{
    performRpc: async request => {calls.push(JSON.parse(request.payload)); assert.equal(request.method,'toggle_audio'); return 'ok';},
    publishTrack: async track => {tracks.push(track);}, unpublishTrack: async () => {},
  }}};
  const track = {stop:()=>stopped.push(true), mediaStreamTrack:{addEventListener(){}}};
  const devices = new LearningDevices({current:()=>current ? connection : undefined,
    capture:()=>capture ? capture() : Promise.resolve(track), pause:async()=>true,changed(){},report(){}});
  return {devices,calls,stopped,tracks,track,disconnect:()=>{current=false;devices.stop();},capture:fn=>{capture=fn;}};
}
test('microphone uses existing audio RPC and stops hardware immediately', async()=>{
  const f=fixture(); await f.devices.toggle('microphone');
  assert.deepEqual(f.calls,[{input_enabled:true}]); assert.equal(f.tracks.length,1);
  f.devices.stop(); assert.equal(f.stopped.length,1);
  await new Promise(resolve=>setImmediate(resolve)); assert.deepEqual(f.calls[1],{input_enabled:false});
});
test('camera publishes video using Flutter semantics without a new server RPC',async()=>{
  const f=fixture(); await f.devices.toggle('camera'); assert.equal(f.tracks.length,1); assert.deepEqual(f.calls,[]);
  f.devices.stop(); assert.equal(f.stopped.length,1);
});
test('capture granted after leaving never publishes or enables agent input',async()=>{
  const f=fixture(); let resolve; f.capture(()=>new Promise(r=>{resolve=r;}));
  const pending=f.devices.toggle('camera'); f.disconnect(); resolve(f.track); await pending;
  assert.equal(f.stopped.length,1); assert.equal(f.tracks.length,0); assert.deepEqual(f.calls,[]);
});
test('denied capture never publishes',async()=>{
  const f=fixture(); f.capture(async()=>{throw new Error('Denied');}); await f.devices.toggle('camera');
  assert.equal(f.tracks.length,0); assert.deepEqual(f.calls,[]);
});
