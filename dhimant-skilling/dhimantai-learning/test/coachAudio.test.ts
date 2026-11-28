import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function mount(blocked = false) {
  const dom = new JSDOM('<div id="coach-audio" data-worklet="buffer.js"><button id="audio-toggle"></button><span id="audio-status"></span></div>', {runScripts: 'outside-only'});
  const win = dom.window, sent: any[] = [], rooms: Room[] = [], nodes: Node[] = [], contexts: Context[] = [];
  const elements: HTMLMediaElement[] = [];
  win.HTMLMediaElement.prototype.play = async function() { elements.push(this as unknown as HTMLMediaElement); };
  win.HTMLMediaElement.prototype.pause = () => {};
  class Room {
    readonly remoteParticipants = new Map();
    readonly handlers = new Map<string, Function>();
    disconnected = false;
    constructor() { rooms.push(this); }
    on(event: string, fn: Function) { this.handlers.set(event, fn); }
    async connect(_url: string, _token: string, options: {autoSubscribe: boolean}) { assert.equal(options.autoSubscribe, false); }
    async disconnect() { this.disconnected = true; }
  }
  class Context {
    state = 'suspended';
    onstatechange: (() => void) | null = null;
    sinks: string[] = [];
    destination = {};
    sinkId = '';
    createMediaStreamDestination() { return {stream: {getTracks: () => []}}; }
    audioWorklet = {addModule: async (path: string) => assert.equal(path, 'buffer.js')};
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
    async resume() { if (blocked) throw new Error('Needs a gesture'); this.state = 'running'; this.onstatechange?.(); }
    async close() { this.state = 'closed'; }
    async setSinkId(id: string) { this.sinkId = id; this.sinks.push(id); }
  }
  class Node {
    messages: any[] = [];
    port = {postMessage: (m: unknown) => this.messages.push(m), onmessage: (_: any) => {}};
    constructor() { nodes.push(this); }
    connect() {}
    disconnect() {}
  }
  win.LivekitClient = {Room, RoomEvent: Object.fromEntries(['TrackPublished', 'TrackSubscribed', 'Disconnected', 'DataReceived'].map(e => [e, e]))};
  win.AudioContext = Context as any;
  win.AudioWorkletNode = Node as any;
  win.MediaStream = class {} as any;
  win.TextDecoder = TextDecoder as any;
  const media = new win.EventTarget();
  Object.assign(media, {enumerateDevices: async () => [{kind: 'audiooutput', deviceId: 'usb', label: 'USB headset'}]});
  Object.defineProperty(win.navigator, 'mediaDevices', {value: media});
  win.eval(readFileSync(resolve(__dirname, '../../media/learning-room/audioControls.js'), 'utf8'));
  win.eval(readFileSync(resolve(__dirname, '../../media/coachAudio.js'), 'utf8'));
  const playback = win.installCoachAudio({postMessage: (m: any) => sent.push(m)});
  const post = (data: object) => win.dispatchEvent(new win.MessageEvent('message', {data}));
  const btn = (id: string) => win.document.getElementById(id)!;
  const subscribe = async (identity = 'dhimantai-coach') => {
    await rooms.at(-1)!.handlers.get('TrackSubscribed')!({kind: 'audio', mediaStreamTrack: {}}, {trackName: 'coach-reply'}, {identity});
    await tick();
  };
  const rendered = (state: string) => nodes.at(-1)!.port.onmessage({data: {type: 'playback', state}});
  const done = () => rooms.at(-1)!.handlers.get('DataReceived')!(new TextEncoder().encode('done'), {identity: 'dhimantai-coach'}, 0, 'dhimantai.coach.playback');
  const off = () => win.document.querySelector<HTMLButtonElement>('.audio-actions button:last-child')!.click();
  return {dom, win, sent, rooms, nodes, contexts, elements, post, btn, subscribe, rendered, done, off, playback, allow: () => { blocked = false; }};
}

test('starting the microphone releases a playing reply and waits for a fresh answer', async () => {
  const m = mount();
  try {
    m.playback.reply('first'); m.btn('audio-toggle').click();
    const grant = {...m.sent.at(-1), type: 'audioGrant'};
    m.post(grant); await m.subscribe(); m.rendered('playing');
    m.playback.listenForReply();
    assert.equal(m.rooms[0].disconnected, true);
    assert.equal(m.contexts[0].state, 'running');
    assert.equal(m.elements[0].srcObject, null);
    const count = m.sent.length;
    m.post(grant); m.playback.reply('first');
    assert.equal(m.rooms.length, 1);
    assert.equal(m.sent.length, count, 'a repaint cannot replay the interrupted answer');
    m.playback.reply('second');
    assert.equal(m.sent.at(-1).type, 'audioJoin');
    assert.equal(m.sent.at(-1).id, 'second');
    m.playback.turnOff(); m.playback.reply('third');
    assert.equal(m.sent.at(-1).id, 'second');
  } finally { m.dom.window.close(); }
});

test('one Instructor control opts in, rejects stale grants and follows rendered audio through pause, completion and replay', async () => {
  const m = mount();
  try {
    m.post({audioId: 'first'});
    assert.equal(m.sent.length, 0);
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Enable spoken explanations');
    m.btn('audio-toggle').click();
    const first = m.sent.at(-1);
    m.post({type: 'state', state: {audioId: 'second'}});
    const current = m.sent.at(-1);
    m.post({...first, type: 'audioGrant'});
    assert.equal(m.rooms.length, 0);
    m.post({...current, type: 'audioGrant'});
    await m.subscribe('other'); assert.equal(m.nodes.length, 0);
    await m.subscribe();
    assert.equal(m.sent.at(-1).type, 'audioStart');
    assert.equal(m.elements.length, 2);
    assert.equal(m.elements[0], m.elements[1], 'the remote track uses the media element activated by the learner');
    assert.equal(m.elements[0].muted, true);
    assert.equal(m.elements[0].volume, 0, 'the worklet must be the only audible output');
    assert.equal(m.btn('audio-status').textContent, 'Preparing explanation…');
    m.rendered('playing'); assert.equal(m.btn('audio-status').textContent, 'Explaining…');
    m.btn('audio-toggle').click(); assert.equal(m.nodes[0].messages.at(-1).value, true);
    m.rendered('paused'); assert.match(m.btn('audio-status').textContent!, /Paused/);
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Resume spoken explanation');
    m.done(); await delay(550);
    assert.equal(m.nodes[0].messages.at(-1).type, 'finish');
    assert.match(m.btn('audio-status').textContent!, /Paused/, 'remote completion must not discard paused speech');
    assert.equal(m.elements[0].srcObject, null);
    m.btn('audio-toggle').click(); await tick();
    assert.equal(m.nodes[0].messages.at(-1).value, false);
    m.rendered('playing'); m.nodes[0].port.onmessage({data: {type: 'drained'}}); await delay(70);
    assert.equal(m.btn('audio-status').textContent, 'Spoken explanation complete');
    assert.equal(m.contexts[0].state, 'running');
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Explain again');
    m.btn('audio-toggle').click();
    assert.equal(m.sent.at(-1).type, 'audioJoin'); assert.equal(m.sent.at(-1).id, 'second');
    m.off(); assert.equal(m.btn('audio-status').textContent, 'Spoken explanations off');
    const count = m.sent.length; m.post({audioId: 'third'}); assert.equal(m.sent.length, count);
  } finally { m.off(); m.dom.window.close(); }
});

test('blocked or interrupted audio exposes a gesture; silent output never reports success', async () => {
  const m = mount(true);
  try {
    m.post({audioId: 'one'}); m.btn('audio-toggle').click();
    m.post({...m.sent.at(-1), type: 'audioGrant'}); await m.subscribe();
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Play explanation');
    assert.equal(m.sent.filter(x => x.type === 'audioStart').length, 0);
    m.allow(); m.btn('audio-toggle').click(); await tick();
    assert.equal(m.sent.at(-1).type, 'audioStart');
    m.rendered('playing');
    m.contexts[0].state = 'suspended'; m.contexts[0].onstatechange?.();
    assert.match(m.btn('audio-status').textContent!, /interrupted/);
    assert.equal(m.nodes[0].messages.at(-1).value, true);
    m.rendered('playing'); assert.match(m.btn('audio-status').textContent!, /interrupted/);
    m.btn('audio-toggle').click(); await tick();
    assert.equal(m.sent.filter(x => x.type === 'audioStart').length, 1, 'resuming must not restart the remote reply');
    m.rendered('buffering'); m.done(); await delay(550);
    m.nodes[0].port.onmessage({data: {type: 'empty'}});
    assert.match(m.btn('audio-status').textContent!, /No spoken explanation/);
    assert.match(m.btn('audio-toggle').title, /No spoken explanation/, 'failure recovery is available without visible status text');
    assert.equal(m.contexts[0].state, 'running');
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Retry spoken explanation');
    assert.equal(m.btn('audio-status').classList.contains('audio-sr-only'), false);
    m.btn('audio-toggle').click(); m.post({...m.sent.at(-1), type: 'audioError'});
    assert.match(m.btn('audio-status').textContent!, /speech service is unavailable/);
  } finally { m.off(); m.dom.window.close(); }
});

test('an explicit output choice enables speech, retries the failed reply once, and keeps subsequent replies audible', async () => {
  const m = mount();
  const choose = async (label: string) => {
    m.win.document.querySelector<HTMLButtonElement>('.audio-chevron')!.click(); await tick();
    const buttons = m.win.document.querySelectorAll<HTMLButtonElement>('[aria-label="Audio output devices"] button');
    [...buttons].find(button => button.textContent === label)!.click(); await tick();
  };
  try {
    m.playback.reply('php');
    await choose('System default');
    const first = m.sent.at(-1);
    assert.equal(first.type, 'audioJoin');
    m.post({...first, type:'audioGrant'}); await m.subscribe();
    m.rooms[0].handlers.get('DataReceived')!(new TextEncoder().encode('error'), {identity:'dhimantai-coach'}, 0, 'dhimantai.coach.playback');
    assert.match(m.btn('audio-status').textContent!, /could not generate/);
    assert.equal(m.rooms[0].disconnected, true);
    assert.equal(m.btn('audio-toggle').getAttribute('aria-pressed'), 'true');
    const count = m.sent.length;
    m.playback.reply('php');
    m.win.navigator.mediaDevices.dispatchEvent(new m.win.Event('devicechange'));
    await tick(); assert.equal(m.sent.length, count, 'refreshing devices or the same text cannot start a retry');
    await choose('USB headset');
    const retry = m.sent.at(-1);
    assert.equal(m.sent.length, count + 1);
    assert.equal(retry.id, 'php'); assert.ok(retry.attempt > first.attempt);
    m.post({...first, type:'audioError'}); m.post({...retry, type:'audioGrant'}); await m.subscribe();
    m.rendered('playing');
    assert.equal(m.btn('audio-status').textContent, 'Explaining…');
    assert.deepEqual(m.contexts[0].sinks, ['usb']);
    m.post({...retry, type:'audioError', message:'Could not reach the speech service. Check your connection, then select the speaker to retry.'});
    assert.match(m.btn('audio-status').textContent!, /Check your connection/);
    m.playback.reply('laravel');
    const next = m.sent.at(-1);
    assert.equal(next.id, 'laravel'); assert.equal(next.type, 'audioJoin');
    m.post({...next, type:'audioGrant'}); await m.subscribe(); m.rendered('playing');
    assert.equal(m.btn('audio-status').textContent, 'Explaining…');
    assert.equal(m.contexts.length, 1);
    assert.equal(m.elements.at(-1), m.elements[0]);
  } finally { m.off(); m.dom.window.close(); }
});

test('output switching preserves pause, new replies retain output, and hiding stops playback', async () => {
  const m = mount();
  try {
    m.post({audioId: 'one'}); m.btn('audio-toggle').click();
    m.post({...m.sent.at(-1), type: 'audioGrant'}); await m.subscribe();
    m.rendered('playing'); m.btn('audio-toggle').click(); m.rendered('paused');
    m.win.document.querySelector<HTMLButtonElement>('.audio-chevron')!.click(); await tick();
    m.win.document.querySelectorAll<HTMLButtonElement>('.audio-picker button')[1].click(); await tick();
    assert.deepEqual(m.contexts[0].sinks, ['usb']); assert.equal(m.contexts[0].state, 'running');
    assert.equal(m.nodes[0].messages.at(-1).value, true);
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Resume spoken explanation');
    m.post({audioId: 'two'}); m.post({...m.sent.at(-1), type: 'audioGrant'}); await m.subscribe();
    assert.equal(m.contexts.length, 1, 'the second prompt reuses the gesture-activated context');
    assert.equal(m.elements.at(-1), m.elements[0], 'the second prompt reuses the gesture-activated player');
    assert.deepEqual(m.contexts[0].sinks, ['usb']);
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Pause spoken explanation');
    m.win.document.dispatchEvent(new m.win.Event('visibilitychange'));
    assert.equal(m.btn('audio-status').textContent, 'Spoken explanations off');
    assert.equal(m.contexts[0].state, 'closed');
    assert.equal(m.elements[0].isConnected, false);
    m.post({type: 'audioOff'}); assert.equal(m.btn('audio-toggle').getAttribute('aria-pressed'), 'false');
  } finally { m.off(); m.dom.window.close(); }
});

function bufferHarness() {
  let BufferClass: any;
  class Processor { port = {onmessage: (_: any) => {}, postMessage: (_: unknown) => {}}; }
  runInNewContext(readFileSync(resolve(__dirname, '../../media/coachAudioBuffer.js'), 'utf8'), {
    AudioWorkletProcessor: Processor, sampleRate: 10, Float32Array,
    registerProcessor: (_: string, impl: any) => { BufferClass = impl; },
  });
  const buffer = new BufferClass(), messages: any[] = [];
  buffer.port.postMessage = (m: any) => messages.push(m);
  const command = (type: string, value?: boolean) => buffer.port.onmessage({data: {type, value}});
  const process = (values: number[], count = 2) => {
    const output = new Float32Array(count); buffer.process([[Float32Array.from(values)]], [[output]]); return [...output];
  };
  return {messages, command, process};
}

test('buffer reports actual output and resumes every paused sample in order after the server finishes', () => {
  const {messages, command, process} = bufferHarness();
  assert.deepEqual(process([0, 0]), [0, 0]); assert.equal(messages.at(-1).state, 'buffering');
  assert.deepEqual(process([1, 2]), [1, 2]); assert.equal(messages.at(-1).state, 'playing');
  command('pause', true);
  assert.deepEqual(process([3, 4, 5]), [0, 0]); assert.equal(messages.at(-1).state, 'paused');
  assert.deepEqual(process([6]), [0, 0]);
  command('finish'); assert.deepEqual(process([99]), [0, 0]); assert.equal(messages.at(-1).state, 'paused');
  command('pause', false);
  assert.deepEqual(process([], 3), [3, 4, 5]); assert.deepEqual(process([], 1), [6]);
  assert.equal(messages.at(-1).type, 'drained');
});

test('empty and all-silent streams cannot complete successfully and prolonged buffering is bounded', () => {
  for (const samples of [[], [0, 0, 0]]) {
    const h = bufferHarness(); h.process(samples, 3); h.command('finish'); h.process([]);
    assert.equal(h.messages.at(-1).type, 'empty');
    assert.ok(!h.messages.some(m => m.state === 'playing' || m.type === 'drained'));
  }
  const h = bufferHarness(); h.command('pause', true); h.process(Array(1901).fill(1));
  assert.equal(h.messages.at(-1).type, 'overflow');
});

test('mute consumes speech silently while pause retains it', () => {
  const h = bufferHarness();
  h.command('mute', true);
  assert.deepEqual(h.process([1, 2]), [0, 0]);
  assert.equal(h.messages.at(-1).state, 'muted');
  h.command('pause', true);
  assert.deepEqual(h.process([3, 4]), [0, 0]);
  h.command('mute', false); h.command('pause', false); h.command('finish');
  assert.deepEqual(h.process([99]), [3, 4]);
  assert.equal(h.messages.at(-1).type, 'drained');
});

test('compact menu mutes without pausing and turning off clears the mute choice', async () => {
  const m = mount();
  try {
    m.post({audioId: 'one'}); m.btn('audio-toggle').click();
    m.post({...m.sent.at(-1), type: 'audioGrant'}); await m.subscribe(); m.rendered('playing');
    const mute = m.win.document.querySelector<HTMLButtonElement>('.audio-actions button')!;
    mute.click();
    assert.equal(m.nodes[0].messages.at(-1).type, 'mute');
    assert.equal(m.nodes[0].messages.at(-1).value, true);
    m.rendered('muted');
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Pause spoken explanation');
    assert.match(m.btn('audio-toggle').title, /muted/);
    mute.click(); m.rendered('playing');
    assert.equal(m.nodes[0].messages.at(-1).value, false);
    mute.click(); m.off(); m.btn('audio-toggle').click();
    m.post({...m.sent.at(-1), type: 'audioGrant'}); await m.subscribe();
    assert.equal(m.nodes.at(-1)!.messages[0].value, false);
  } finally { m.off(); m.dom.window.close(); }
});

test('late pause acknowledgements and a pause at the final output boundary remain resumable', async () => {
  const m = mount();
  try {
    m.post({audioId: 'one'}); m.btn('audio-toggle').click();
    m.post({...m.sent.at(-1), type: 'audioGrant'}); await m.subscribe(); m.rendered('playing');
    m.btn('audio-toggle').click(); m.btn('audio-toggle').click(); await tick();
    m.rendered('paused'); // queued before the resume request
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Pause spoken explanation');
    m.rendered('playing'); m.done(); await delay(550);
    m.nodes[0].port.onmessage({data: {type: 'drained'}});
    m.btn('audio-toggle').click(); await delay(70);
    assert.notEqual(m.btn('audio-status').textContent, 'Spoken explanation complete');
    m.btn('audio-toggle').click(); await tick(); await delay(70);
    assert.equal(m.btn('audio-status').textContent, 'Spoken explanation complete');
  } finally { m.off(); m.dom.window.close(); }
});

test('Coach speed is sent on playback, and changing it preserves paused speech until the next reply', async () => {
  const m = mount();
  try {
    const speed = m.win.document.querySelector<HTMLSelectElement>('.audio-speed select')!;
    speed.value = '0.5'; speed.dispatchEvent(new m.win.Event('change')); await tick();
    m.post({audioId:'one'}); m.btn('audio-toggle').click();
    m.post({...m.sent.at(-1), type:'audioGrant'}); await m.subscribe();
    assert.equal(m.sent.at(-1).speed, 0.5);
    m.rendered('playing'); m.btn('audio-toggle').click(); m.rendered('paused');
    const sent = m.sent.length;
    speed.value = '2'; speed.dispatchEvent(new m.win.Event('change')); await tick();
    assert.equal(m.sent.length, sent);
    assert.equal(m.btn('audio-toggle').getAttribute('aria-label'), 'Resume spoken explanation');
    m.post({audioId:'two'}); m.post({...m.sent.at(-1), type:'audioGrant'}); await m.subscribe();
    assert.equal(m.sent.at(-1).speed, 2);
  } finally { m.off(); m.dom.window.close(); }
});
