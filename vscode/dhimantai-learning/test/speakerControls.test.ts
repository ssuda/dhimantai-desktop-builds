import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

const asset = (path: string) => readFileSync(resolve(__dirname, '../../media', path), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('speaker picker switches outputs, retains the prior selection on failure, and falls back when unplugged', async () => {
  const dom = new JSDOM('<button id="sound">Mute</button><button id="outside">Outside</button>', {runScripts: 'outside-only'});
  const w = dom.window, calls: string[] = [];
  let outputs = [{kind: 'audiooutput', deviceId: 'headphones', label: 'Headphones'},
    {kind: 'audioinput', deviceId: 'mic', label: 'Microphone'}];
  let fail = false, supported = true;
  const media = new w.EventTarget();
  Object.assign(media, {enumerateDevices: async () => outputs});
  Object.defineProperty(w.navigator, 'mediaDevices', {value: media});
  try {
    w.eval(asset('learning-room/audioControls.js'));
    const main = w.document.getElementById('sound')!;
    const control = new w.DhimantAudio.SpeakerControl(main, {supported: () => supported,
      select: async (id: string) => { calls.push(id); if (fail) throw new Error('denied'); }});
    control.update(true);
    assert.equal(main.getAttribute('aria-label'), 'Unmute speaker');
    assert.equal(main.getAttribute('aria-pressed'), 'true');
    const arrow = w.document.querySelector<HTMLButtonElement>('.audio-chevron')!;
    const picker = w.document.querySelector<HTMLElement>('.audio-picker')!;
    const choices = () => Array.from(picker.querySelectorAll('button'));
    arrow.click(); await tick();
    assert.deepEqual(choices().map(b => b.textContent), ['System default', 'Headphones']);
    assert.equal(w.document.activeElement, choices()[0]);
    choices()[1].click(); await tick();
    assert.deepEqual(calls, ['headphones']);
    assert.equal(control.deviceId, 'headphones');
    assert.equal(picker.hidden, true);
    assert.equal(w.document.activeElement, arrow);
    assert.equal(main.getAttribute('aria-pressed'), 'true', 'device selection never unmutes');
    arrow.click(); await tick();
    assert.equal(choices()[1].getAttribute('aria-pressed'), 'true');
    fail = true; choices()[0].click(); await tick();
    assert.equal(control.deviceId, 'headphones');
    assert.equal(picker.hidden, false);
    assert.match(picker.textContent!, /Could not switch/);
    fail = false; outputs = [];
    media.dispatchEvent(new w.Event('devicechange')); await tick();
    assert.equal(control.deviceId, 'default');
    assert.equal(calls.at(-1), 'default');
    picker.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    assert.equal(picker.hidden, true);
    assert.equal(arrow.getAttribute('aria-expanded'), 'false');
    supported = false; arrow.click(); await tick();
    assert.match(picker.textContent!, /computer’s sound settings/);
    w.document.getElementById('outside')!.click();
    assert.equal(picker.hidden, true);
  } finally { w.close(); }
});

test('learning room mutes locally, remembers each agent, and applies the chosen output to new sessions', async () => {
  const dom = new JSDOM('<button id="wide"></button><button id="latest"></button><button id="tutor"></button><button id="doubt_solver"></button><button id="end" disabled></button><button id="sound"></button><span id="status"></span><input id="follow-code"><input id="stuck-hints"><small id="code-observer-status"></small><main id="feed"></main><form id="composer"><textarea id="message"></textarea><button id="send"></button><button id="teach-back"></button><button id="video"></button></form>',
    {runScripts: 'outside-only', url: 'https://webview.example'});
  const w = dom.window, sent: any[] = [], rooms: Room[] = [], rpcs: string[] = [];
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  const peer = {identity: 'worker', isAgent: true, trackPublications: new Map()};
  let rejectPlayback: ((error: Error) => void) | undefined;
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker', peer]]);
    localParticipant = {registerRpcMethod() {}, performRpc: async ({method}: {method: string}) => { rpcs.push(method); return 'ok'; }};
    outputs: string[] = [];
    constructor(readonly options: any) { rooms.push(this); }
    on(name: string, handler: Function) { this.listeners.set(name, handler); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
    async switchActiveDevice(kind: string, id: string) { assert.equal(kind, 'audiooutput'); this.outputs.push(id); return true; }
    async startAudio() { return new Promise<void>((_, reject) => { rejectPlayback = reject; }); }
  }
  const events = ['TrackPublished', 'TrackSubscribed', 'TrackUnsubscribed', 'DataReceived', 'ParticipantDisconnected', 'Disconnected', 'Reconnecting', 'Reconnected'];
  w.LivekitClient = {Room, RoomEvent: Object.fromEntries(events.map(e => [e, e]))};
  w.acquireVsCodeApi = () => ({postMessage: (m: any) => sent.push(m)});
  Object.defineProperty(w.HTMLMediaElement.prototype, 'setSinkId', {value: async () => {}});
  const media = new w.EventTarget();
  Object.assign(media, {enumerateDevices: async () => [{kind: 'audiooutput', deviceId: 'usb', label: 'USB speaker'}]});
  Object.defineProperty(w.navigator, 'mediaDevices', {value: media});
  const btn = (id: string) => w.document.getElementById(id)!;
  const join = async (mode: string) => {
    // Use the same direct mode selection as the Catalog and Command Palette.
    // The hidden Instructor button is a retry for the current mode, not navigation.
    w.dispatchEvent(new w.MessageEvent('message', {origin:w.location.origin, data:{type:'openTutor',mode}}));
    if (mode === 'tutor') selectLesson(w, sent.at(-1).attempt);
    w.dispatchEvent(new w.MessageEvent('message', {origin: w.location.origin,
      data: {type: 'grant', attempt: sent.at(-1).attempt, url: 'unused', token: 'unused', ...(mode === 'tutor' ? {chapterId} : {})}}));
    await tick();
  };
  const subscribe = () => {
    const element = w.document.createElement('audio');
    element.play = async () => {}; element.pause = () => {};
    rooms.at(-1)!.listeners.get('TrackSubscribed')!({kind: 'audio', attach: () => element}, {}, peer);
    return element;
  };
  try {
    w.eval(asset('learning-room/room.js'));
    await join('tutor');
    const track = subscribe();
    const visibility = (visible: boolean) => w.dispatchEvent(new w.MessageEvent('message', {
      origin:w.location.origin, data:{type:'visibility',visible},
    }));
    visibility(false);
    assert.equal(track.muted, true, 'switching tabs mutes the hidden notebook');
    const lateTrack = subscribe();
    assert.equal(lateTrack.muted, true, 'new audio in a hidden notebook stays muted');
    visibility(true);
    assert.equal(track.muted, false);
    assert.equal(lateTrack.muted, false);
    assert.equal(rooms.length, 1, 'switching tabs keeps the same live session');
    const before = rpcs.length;
    btn('sound').click();
    assert.equal(track.muted, true);
    assert.equal(rpcs.length, before, 'speaker mute never interrupts the agent');
    visibility(false); visibility(true);
    assert.equal(track.muted, true, 'tab changes preserve the learner’s mute choice');
    w.document.querySelector<HTMLButtonElement>('.audio-chevron')!.click(); await tick();
    w.document.querySelectorAll<HTMLButtonElement>('.audio-picker button')[1].click(); await tick();
    assert.deepEqual(rooms[0].outputs, ['usb']);
    assert.equal(track.muted, true);
    await join('doubt_solver');
    assert.equal(rooms[1].options.audioOutput.deviceId, 'usb');
    assert.equal(subscribe().muted, false, 'Doubt Solver has its own mute choice');
    await join('tutor');
    assert.equal(subscribe().muted, true, 'Instructor restores its mute choice');
    btn('sound').click(); // pending browser playback gesture
    await join('doubt_solver');
    rejectPlayback!(new Error('Old room could not play'));
    await tick();
    assert.equal(btn('sound').getAttribute('aria-label'), 'Mute speaker', 'late playback errors cannot replace the current control');
  } finally { w.close(); }
});
