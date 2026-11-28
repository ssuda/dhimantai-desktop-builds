import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {SpeechInterruption} from '../webview/speechInterruption';

test('selecting the microphone silences the current reply before capture or speech detection', () => {
  const events: string[] = [];
  const gate = new SpeechInterruption(() => events.push(gate.muted ? 'muted' : 'audible'),
    explicit => events.push(explicit ? 'microphone' : 'speech'));
  gate.agentChanged('speaking');
  events.length = 0;
  gate.interruptReply();
  gate.interruptReply();
  assert.deepEqual(events, ['muted', 'microphone']);
  assert.equal(gate.listening, false);
  gate.agentChanged('speaking');
  assert.equal(gate.muted, true);
  gate.agentChanged('listening');
  gate.agentChanged('speaking');
  assert.equal(gate.muted, false);
});

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

test('running code stops a spoken explanation once but never cancels a reply still being prepared', () => {
  const events: string[] = [];
  const gate = new SpeechInterruption(() => events.push(gate.muted ? 'muted' : 'audible'),
    explicit => events.push(explicit ? 'stop' : 'speech'));
  gate.agentChanged('thinking');
  events.length = 0;
  assert.equal(gate.pauseForRun(), false);
  assert.deepEqual(events, []);
  gate.agentChanged('speaking');
  events.length = 0;
  assert.equal(gate.pauseForRun(), true);
  assert.equal(gate.pauseForRun(), false, 'a second Run does not send another stop');
  assert.deepEqual(events, ['muted', 'stop']);
  gate.agentChanged('listening');
  gate.agentChanged('speaking');
  assert.equal(gate.muted, false, 'the next reply, such as the run review, is heard');
});
