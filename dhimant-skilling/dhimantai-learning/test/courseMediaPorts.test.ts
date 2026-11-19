import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { courseMediaPublishArgs } from '../src/courseRuntime';

test('LiveKit publishes signaling and the advertised TURN TCP port only on loopback', () => {
  assert.deepEqual(courseMediaPublishArgs({ports:[{port:7880,protocol:'tcp'},{port:3478,protocol:'tcp'}]}), [
    '--publish', '127.0.0.1:7880:7880/tcp', '--publish', '127.0.0.1:3478:3478/tcp'
  ]);
});

test('other courses and untrusted names receive no media bindings', () => {
  assert.deepEqual(courseMediaPublishArgs({ports:[]}), []);
  for(const port of [0,80,65536,NaN])assert.throws(()=>courseMediaPublishArgs({ports:[{port,protocol:'tcp'}]}));
});
