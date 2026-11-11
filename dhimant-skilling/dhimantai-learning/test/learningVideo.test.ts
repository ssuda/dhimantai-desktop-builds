import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { chapterId, lessonPicker, selectLesson } from './lessonPicker';

const VIDEO = 'ZjU3sikq8Mg', OTHER = 'aaaaaaaaaaa', ORIGIN = 'https://api-staging.dhimant.ai';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup(playable = true) {
  const ids = ['wide', 'latest', 'tutor', 'doubt_solver', 'end', 'sound', 'send', 'teach-back', 'video'];
  const dom = new JSDOM('<!doctype html>' + ids.map(id => `<button id="${id}"${id === 'end' ? ' disabled' : ''}></button>`).join('') +
    '<span id="status"></span><input id="follow-code" type="checkbox" checked><input id="stuck-hints" type="checkbox">' +
    '<small id="code-observer-status"></small><main id="feed"></main><form id="composer"><textarea id="message"></textarea></form>',
    {runScripts: 'outside-only', url: 'https://webview.example', pretendToBeVisual: true});
  const w = dom.window, messages: any[] = [], rpcs: any[] = [], chats: string[] = [], commands: any[] = [];
  w.document.body.insertAdjacentHTML('afterbegin', lessonPicker);
  const agent = {identity: 'worker', isAgent: true, trackPublications: new Map()};
  let room!: Room, acknowledge: (payload: any) => Promise<string> = async () => 'ok';
  let expirePause: (() => void) | undefined;
  const timeout = w.setTimeout.bind(w);
  w.setTimeout = ((handler: () => void, delay: number, ...args: any[]) => {
    if (delay === 10000) expirePause = handler;
    return timeout(handler, delay, ...args);
  }) as any;
  class Room {
    listeners = new Map<string, Function>();
    remoteParticipants = new Map([['worker', agent]]);
    localParticipant = {
      registerRpcMethod() {},
      performRpc: async (rpc: any) => {
        rpcs.push(rpc);
        return rpc.method === 'on_video_state_update' ? acknowledge(JSON.parse(rpc.payload)) : 'ok';
      },
      sendText: async (text: string) => { chats.push(text); },
    };
    constructor() { room = this; }
    on(name: string, fn: Function) { this.listeners.set(name, fn); }
    async connect() {} async disconnect() {} registerTextStreamHandler() {}
  }
  const names = ['TrackPublished', 'TrackSubscribed', 'TrackUnsubscribed', 'DataReceived', 'ParticipantDisconnected', 'Disconnected', 'Reconnecting', 'Reconnected'];
  w.LivekitClient = {Room, RoomEvent: Object.fromEntries(names.map(name => [name, name]))};
  w.acquireVsCodeApi = () => ({postMessage: (message: any) => messages.push(message)});
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.HTMLMediaElement.prototype.canPlayType = () => playable ? 'probably' : '';
  const post = (data: object, origin = w.location.origin, source: any = null) => w.dispatchEvent(new w.MessageEvent('message', {data, origin, source}));
  w.eval(readFileSync(resolve(__dirname, '../../media/learning-room/room.js'), 'utf8'));
  w.document.getElementById('tutor')!.click();
  selectLesson(w, messages.at(-1).attempt);
  const attempt = messages.at(-1).attempt;
  post({type: 'grant', attempt, url: 'unused', token: 'unused', chapterId}); await tick();
  const receive = (packet: object) => room.listeners.get('DataReceived')!(new TextEncoder().encode(JSON.stringify(packet)), agent);
  const frames = new Map<string, HTMLIFrameElement>();
  function addVideo(id = VIDEO) {
    receive({method: 'video_visual', provider: 'youtube', video_id: id, title: 'Lesson', topic: 'A test topic'});
    post({type: 'videoChecked', attempt, videoId: id, ok: true, url: ORIGIN + '/vscode-learning/videos/' + id});
    const frame = w.document.querySelector<HTMLIFrameElement>(`iframe[src$="${id}"]`);
    if (frame) { frames.set(id, frame); frame.contentWindow!.postMessage = message => commands.push(message); }
  }
  function playback(state: string, seconds: number, id = VIDEO, origin = ORIGIN) {
    post({type: 'lessonPlayback', id, state, seconds}, origin, frames.get(id)!.contentWindow);
  }
  const field = w.document.getElementById('message') as HTMLTextAreaElement;
  const send = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', {cancelable: true}));
  const videoEvents = () => rpcs.filter(rpc => rpc.method === 'on_video_state_update').map(rpc => JSON.parse(rpc.payload));
  return {w, messages, chats, commands, field, addVideo, playback, send, receive, videoEvents,
    ack: (handler: typeof acknowledge) => { acknowledge = handler; }, expire: () => expirePause!(), close: () => w.close()};
}

test('inline questions wait for the player pause and worker acknowledgement; explicit resume reaches the player', async () => {
  const h = await setup();
  try {
    h.addVideo(); h.playback('playing', 12); await tick();
    let acknowledgePause!: (value: string) => void;
    h.ack(payload => payload.event === 'paused' ? new Promise(resolve => { acknowledgePause = resolve; }) : Promise.resolve('ok'));
    h.field.value = 'Why did that happen?'; h.send(); await tick();
    assert.equal(h.commands.at(-1).action, 'pause'); assert.equal(h.chats.length, 0);
    h.playback('paused', 13.25, VIDEO, 'https://untrusted.example'); await tick();
    assert.equal(h.videoEvents().length, 1);
    h.playback('paused', 13.25); await tick();
    assert.equal(h.chats.length, 0, 'the paused event alone is not a worker acknowledgement');
    assert.equal(h.videoEvents().at(-1).timestamp_sec, 13.25);
    acknowledgePause('ok'); await tick();
    assert.deepEqual(h.chats, ['Why did that happen?']); assert.equal(h.field.value, '');
    assert.equal(h.commands.filter(command => command.action === 'resume').length, 0);
    h.w.document.querySelectorAll<HTMLButtonElement>('.video-actions button')[1].click();
    assert.equal(h.commands.at(-1).action, 'resume');
    assert.doesNotMatch(h.w.document.getElementById('feed')!.textContent!, /Watch on YouTube/);
    assert.equal(h.messages.some(message => message.type === 'openVideo'), false);
  } finally { h.close(); }
});

test('server pause requests and Pause and ask use the same acknowledgement flow', async () => {
  const h = await setup();
  try {
    h.addVideo(); h.playback('playing', 20); await tick();
    h.receive({method: 'video_pause_request', reason: 'learner_turn'});
    assert.equal(h.commands.at(-1).action, 'pause');
    h.w.document.querySelector<HTMLButtonElement>('.video-actions button')!.click();
    assert.equal(h.commands.filter(command => command.action === 'pause').length, 1);
    h.playback('paused', 21); await tick();
    assert.equal(h.w.document.activeElement, h.field);
    assert.equal(h.chats.length, 0, 'Pause and ask does not invent a learner message');
    assert.match(h.w.document.getElementById('status')!.textContent!, /Video paused/);
  } finally { h.close(); }
});

test('failed pause acknowledgements preserve the draft and can be retried after a manual pause', async () => {
  const h = await setup();
  try {
    h.addVideo(); h.playback('playing', 5); await tick();
    h.ack(async () => { throw new Error('offline'); });
    h.field.value = 'Explain this step'; h.send(); await tick();
    h.playback('paused', 6); await tick();
    assert.equal(h.chats.length, 0); assert.equal(h.field.value, 'Explain this step');
    assert.match(h.w.document.getElementById('status')!.textContent!, /Could not confirm/);
    h.ack(async () => 'ok'); h.send(); await tick();
    assert.deepEqual(h.chats, ['Explain this step']);
  } finally { h.close(); }
});

test('resuming while the worker confirms a manual pause still pauses again before sending', async () => {
  const h = await setup();
  try {
    h.addVideo(); h.playback('playing', 5); await tick();
    let confirm!: (value: string) => void;
    h.ack(() => new Promise(resolve => { confirm = resolve; }));
    h.playback('paused', 6); await tick();
    h.field.value = 'Explain this step'; h.send(); await tick();
    h.playback('playing', 6);
    h.ack(async () => 'ok'); confirm('ok'); await tick();
    assert.equal(h.chats.length, 0);
    assert.equal(h.commands.at(-1).action, 'pause');
    h.playback('paused', 7); await tick();
    assert.deepEqual(h.chats, ['Explain this step']);
    assert.equal(h.videoEvents().at(-1).timestamp_sec, 7);
  } finally { h.close(); }
});

test('missing player responses time out without sending; ending the session cancels a pending question', async () => {
  const h = await setup();
  try {
    h.addVideo(); h.playback('playing', 5); await tick();
    h.field.value = 'Explain this step'; h.send(); await tick(); h.expire(); await tick();
    assert.equal(h.chats.length, 0); assert.equal(h.field.value, 'Explain this step');
    h.send(); await tick(); h.w.document.getElementById('end')!.click(); await tick();
    assert.equal(h.chats.length, 0);
    assert.match(h.w.document.getElementById('status')!.textContent!, /Session ended/);
  } finally { h.close(); }
});

test('another video replaces pause context; a player failure restores worker speech via closed', async () => {
  const h = await setup();
  try {
    h.addVideo(); h.playback('playing', 5); await tick();
    h.addVideo(OTHER); h.playback('playing', 1, OTHER); await tick();
    h.playback('paused', 6); await tick();
    assert.equal(h.videoEvents().at(-1).video_id, OTHER);
    assert.equal(h.videoEvents().at(-1).event, 'playing');
    h.playback('unavailable', 2, OTHER); await tick();
    assert.equal(h.videoEvents().at(-1).event, 'closed');
    assert.match(h.w.document.getElementById('feed')!.textContent!, /cannot play inside VS Code/);
    h.field.value = 'Please explain instead'; h.send(); await tick();
    assert.deepEqual(h.chats, ['Please explain instead']);
  } finally { h.close(); }
});

test('codec hints do not prevent inline negotiation; failed players can retry without an external link', async () => {
  const h = await setup(false);
  try {
    h.addVideo();
    const feed = h.w.document.getElementById('feed')!;
    assert.ok(feed.querySelector('iframe'));
    h.playback('unavailable', 0); await tick();
    assert.equal(feed.querySelector('iframe, a'), null);
    assert.match(feed.textContent!, /cannot play inside VS Code/);
    h.field.value = 'Please explain instead'; h.send(); await tick();
    assert.deepEqual(h.chats, ['Please explain instead']);
    feed.querySelector<HTMLButtonElement>('button')!.click();
    assert.ok(feed.querySelector('iframe'));
  } finally { h.close(); }
});
