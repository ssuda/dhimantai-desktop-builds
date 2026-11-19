import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {SpeechInterruption} from '../webview/speechInterruption';

test('speech mutes immediately, sends one stop per utterance and keeps old audio suppressed until a new reply', () => {
  const events:string[]=[];
  const gate=new SpeechInterruption(()=>events.push(gate.muted?'muted':'audible'),()=>events.push('rpc'));
  gate.agentChanged('speaking');events.length=0;
  gate.userSpeaking(true);gate.userSpeaking(true);
  assert.deepEqual(events,['muted','rpc']);
  assert.equal(gate.listening,true);
  gate.userSpeaking(false);
  assert.equal(gate.muted,true,'pausing between words cannot resume the interrupted reply');
  gate.agentChanged('speaking');assert.equal(gate.muted,true,'old speaking state is not a new reply');
  gate.agentChanged('listening');gate.agentChanged('thinking');gate.agentChanged('speaking');
  assert.equal(gate.muted,false);
});

test('a new reply waits for the learner to stop, and disconnect clears the speech gate', () => {
  const gate=new SpeechInterruption(()=>{},()=>{});
  gate.agentChanged('speaking');gate.userSpeaking(true);
  gate.agentChanged('listening');gate.agentChanged('speaking');
  assert.equal(gate.muted,true);
  gate.userSpeaking(false);assert.equal(gate.muted,false);
  gate.userSpeaking(true);gate.reset();assert.equal(gate.muted,false);assert.equal(gate.listening,false);
});
