import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PauseEpoch, deadline } from '../src/debugEvidence';
import { debugExtension, localDebugLaunch } from '../src/debugLaunch';

test('a resume, edit or a newer pause invalidates captured debugger evidence', () => {
  const pause = new PauseEpoch();
  assert.equal(pause.matches(pause.current),false);
  const first = pause.stopped(7,'breakpoint');
  assert.equal(pause.thread,7); assert.ok(pause.matches(first));
  pause.invalidate(); assert.equal(pause.matches(first),false);
  const second = pause.stopped(7,'step');
  assert.ok(pause.matches(second)); assert.equal(pause.matches(first),false);
  pause.stopped(undefined,'pause'); assert.equal(pause.matches(pause.current),false);
});

test('unresponsive debugger requests time out without retrying indefinitely', async () => {
  await assert.rejects(deadline(new Promise(() => {}),10),/did not respond/);
  assert.equal(await deadline(Promise.resolve(42)),42);
});

test('native launch plans select language adapters and preserve source maps and stdin paths', () => {
  for (const language of ['python','javascript','typescript','java','go','c','rust']) {
    const {launch,server} = localDebugLaunch(language,'/a course/cell',23456,{},'/extension/debugpy',false,['--count','two words']);
    assert.ok(debugExtension(language,false));
    assert.ok(launch.type && launch.request);
    if (server) assert.ok(server.some(value => value.includes('127.0.0.1:23456')));
    else assert.deepEqual(launch.stdio,['/a course/cell/stdin.txt',null,null]);
    assert.deepEqual(server?.slice(-2)??launch.args,['--count','two words']);
    if (language === 'typescript') assert.equal(launch.sourceMaps,true);
    if (language === 'python') assert.equal(launch.port,undefined,'debugpy connect and a top-level port are mutually exclusive');
  }
  assert.equal(debugExtension('c',true),'ms-vscode.cpptools');
  assert.equal(debugExtension('c',false),'vadimcn.vscode-lldb');
  assert.throws(() => localDebugLaunch('shell','/tmp',0,{},'',false));
});
