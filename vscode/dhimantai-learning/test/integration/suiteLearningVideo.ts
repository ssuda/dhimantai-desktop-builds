// Real VS Code webview, production room bundle and live YouTube player.
// Catalog, auth and Instructor transport are fixtures; no live Instructor answer is certified.
import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import * as desktop from '../../src/desktopRoom';
import { Api } from '../../src/api';
import type { Auth } from '../../src/auth';
import { connect } from './suiteStudy';

const VIDEO = 'KnCP1Sg8ajU';
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
async function until(read: () => Promise<any>, label: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await wait(); } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}

export async function run() {
  const ext = vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!;
  const {auth} = await ext.activate();
  await vscode.workspace.getConfiguration('dhimantai').update('environment', 'staging', vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('dhimantai').update('courseContainers', false, vscode.ConfigurationTarget.Global);
  // Connect before installing fixtures so a connection failure leaves no mocks behind.
  const cdp = await connect();
  await cdp.evaluate(`globalThis.__videoTestErrors=[]; addEventListener('unhandledrejection', e=>__videoTestErrors.push(String(e.reason?.stack||e.reason)));`);
  const session = auth.session, grant = Api.prototype.learningRoom, catalog = Api.prototype.practiceCatalog, create = vscode.window.createWebviewPanel;
  const desktopGrant = desktop.desktopRoom;
  (desktop as any).desktopRoom = async () => ({url:'wss://lk-staging.dhimant.ai', token:'unused'});
  auth.session = async () => ({user: {id: 'video-transport-fixture'}, access_token: 'unused', refresh_token: 'unused', expires_at: 0});
  Api.prototype.learningRoom = async () => ({url: 'wss://lk-staging.dhimant.ai', token: 'unused'});
  Api.prototype.practiceCatalog = async () => ({languages: [], courses: [{name: 'Video transport fixture',
    chapters: [{id: '10000000-0000-0000-0000-000000000001', name: 'Token Embeddings'}]}]});
  const events: any[] = [];
  let host: vscode.WebviewPanel | undefined;
  const mock = `
const nativeApi = acquireVsCodeApi(); window.acquireVsCodeApi = () => nativeApi;
const report = (event, details = {}) => nativeApi.postMessage({type:'videoProbe', event, ...details});
report('codecs', {supported:Object.fromEntries(['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/webm; codecs="vp9, opus"',
  'video/mp4; codecs="av01.0.05M.08, mp4a.40.2"'].map(type => [type, document.createElement('video').canPlayType(type)]))});
window.addEventListener('message', e => {
  if (e.origin === 'https://api-staging.dhimant.ai' && e.data?.type === 'lessonPlayback') report('playerState', {state:e.data});
});
const agent = {identity:'transport-fixture', isAgent:true, trackPublications:new Map()};
let currentRoom, lastState, pauseRequests = 0;
const packet = data => currentRoom.handlers.DataReceived(new TextEncoder().encode(JSON.stringify(data)), agent);
class Room {
  constructor() { currentRoom = this; this.handlers = {}; this.remoteParticipants = new Map([[agent.identity, agent]]);
    this.localParticipant = {registerRpcMethod() {}, performRpc: async request => {
      if (request.method === 'switch_mode') {
        setTimeout(() => packet({method:'video_visual',provider:'youtube',video_id:'${VIDEO}',title:'Token Embeddings',topic:'Tokens and Embeddings'}), 100);
      } else if (request.method === 'on_video_state_update') {
        const state = JSON.parse(request.payload); report('workerState', {state});
        await new Promise(resolve => setTimeout(resolve, 200));
        lastState = state; report('workerAcknowledged', {state});
      }
      return 'ok';
    }, sendText: async text => {
      report('question', {text, state:lastState});
      packet({method:'display_on_screen',content:'**Transport check:** Your question arrived after the video paused. The real Instructor response requires a signed-in staging session.'});
    }};
  }
  on(event, handler) { this.handlers[event] = handler; }
  async connect() {} async disconnect() {} async startAudio() {} registerTextStreamHandler() {}
}
const eventNames = ['TrackPublished','TrackSubscribed','TrackUnsubscribed','DataReceived','ParticipantDisconnected','Disconnected','Reconnecting','Reconnected'];
window.LivekitClient = {Room, RoomEvent:Object.fromEntries(eventNames.map(name => [name,name]))};
window.addEventListener('DOMContentLoaded', () => {
  const notice = document.createElement('p'); notice.textContent = 'Native playback check: live YouTube video; Instructor transport is a test fixture.';
  const request = document.createElement('button'); request.textContent = 'Request server pause (test)';
  request.id = 'test-server-pause';
  request.onclick = () => { report('serverPauseRequest', {number:++pauseRequests}); packet({method:'video_pause_request',reason:'learner_turn'}); };
  const controls = document.createElement('div'); controls.className = 'modes'; controls.append(request);
  document.querySelector('header').prepend(notice, controls);
});
`;
  (vscode.window as any).createWebviewPanel = (...args: any[]) => {
    const panel = (create as any)(...args) as vscode.WebviewPanel;
    if (args[0] !== 'dhimantai.learningRoom') return panel;
    host = panel;
    panel.title = 'Inline video playback check';
    panel.webview.onDidReceiveMessage(message => {
      if (message?.type !== 'videoProbe') return;
      events.push(message);
      console.log('Video probe:', JSON.stringify(message));
    });
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(panel.webview), 'html')!;
    Object.defineProperty(panel.webview, 'html', {get: () => descriptor.get!.call(panel.webview), set: html => {
      const replacement = html.replace(/<script nonce="([^"]+)" src="[^"]*livekit-client\.umd\.js"><\/script>/,
        (_match: string, nonce: string) => `<script nonce="${nonce}">${mock}</script>`);
      assert.notEqual(replacement, html, 'the real learning-room HTML must contain its SDK script');
      descriptor.set!.call(panel.webview, replacement);
    }});
    return panel;
  };
  const ui = (expression: string) => cdp.webview(`d=>{if(!d.querySelector('#test-server-pause'))return null;return (${expression})(d);}`);
  let playerSession: string | undefined, youtubeSession: string | undefined, passed = false;
  const player = (expression: string) => cdp.evaluate(expression, playerSession);
  const state = (event: string) => events.filter(e => e.event === 'workerState' && e.state.event === event);
  const ask = (text: string) => ui(`d=>{d.querySelector('#message').value=${JSON.stringify(text)};d.querySelector('#composer').dispatchEvent(new d.defaultView.Event('submit',{cancelable:true}));return true;}`);
  try {
    await vscode.commands.executeCommand('dhimantai.openLearningRoom');
    await until(() => ui(`d=>!!d.querySelector('#lesson-list button:not([disabled])')`), 'lesson choice');
    await ui(`d=>{d.querySelector('#lesson-list button').click();return true;}`);
    await until(async () => {
      const targets = (await cdp.send('Target.getTargets')).targetInfos as any[];
      const wrapper = targets.find(t => t.url === 'https://api-staging.dhimant.ai/vscode-learning/videos/' + VIDEO);
      const youtube = targets.find(t => t.url.startsWith('https://www.youtube-nocookie.com/embed/' + VIDEO));
      if (!wrapper || !youtube) return false;
      playerSession = (await cdp.send('Target.attachToTarget', {targetId: wrapper.targetId, flatten: true})).sessionId;
      youtubeSession = (await cdp.send('Target.attachToTarget', {targetId: youtube.targetId, flatten: true})).sessionId;
      return true;
    }, 'live hosted player');
    await until(() => player(`typeof player !== 'undefined' && typeof player?.getPlayerState === 'function'
      && Number.isFinite(player.getPlayerState()) && player.getDuration() > 0`), 'YouTube ready');
    // Real player API and media decoding, never simulated playback events.
    // YouTube initializes its media source through the player controls, not a
    // direct HTMLVideoElement.play(). Its cross-origin API can lose activation,
    // so accept a real Play click without weakening the editor's autoplay policy.
    console.log('Select Play in the YouTube player if it does not start automatically.');
    await cdp.send('Runtime.evaluate', {expression: 'player.playVideo()', userGesture: true}, playerSession);
    await until(() => player('player.getPlayerState() === 1 && player.getCurrentTime() > 2'), 'actual video playback', 60000);
    const decoded = await cdp.evaluate(`(()=>{const v=document.querySelector('video');return {seconds:v.currentTime,
      frames:v.getVideoPlaybackQuality().totalVideoFrames,audioBytes:v.webkitAudioDecodedByteCount,
      muted:v.muted,volume:v.volume,error:v.error?.message};})()`, youtubeSession);
    events.push({event: 'decodedMedia', ...decoded});
    assert.ok(decoded.frames > 0 && decoded.audioBytes > 0, 'both video frames and audio must decode');
    assert.equal(decoded.muted, false); assert.ok(decoded.volume > 0); assert.equal(decoded.error, undefined);
    await until(() => ui(`d=>!d.querySelector('.video-actions button').disabled`), 'Pause and ask enabled');
    await ui(`d=>{d.querySelector('.video-actions button').click();return true;}`);
    await until(async () => state('paused').length > 0 && await ui(`d=>d.activeElement.id==='message'`), 'Pause and ask acknowledgement');
    await ask('Explain the numbers at this point.');
    await until(async () => events.some(e => e.event === 'question'), 'question after confirmed pause');
    let pausedAt = state('paused').at(-1).state.timestamp_sec;
    await ui(`d=>{d.querySelectorAll('.video-actions button')[1].click();return true;}`);
    await until(() => player(`player.getPlayerState()===1 && player.getCurrentTime()>${pausedAt + 1}`), 'resume advances playhead');
    await ask('Explain this next step.');
    await until(async () => events.filter(e => e.event === 'question').length === 2, 'sending while playing pauses first');
    pausedAt = state('paused').at(-1).state.timestamp_sec;
    await ui(`d=>{d.querySelectorAll('.video-actions button')[1].click();return true;}`);
    await until(() => player(`player.getPlayerState()===1 && player.getCurrentTime()>${pausedAt + 1}`), 'second resume');
    await ui(`d=>{d.querySelector('#test-server-pause').click();return true;}`);
    await until(async () => events.filter(e => e.event === 'workerAcknowledged' && e.state.event === 'paused').length >= 3
      && await player('player.getPlayerState()===2'), 'server requested pause and acknowledgement');
    const states = events.filter(event => event.event === 'workerState');
    assert.ok(states.filter(event => event.state.event === 'playing').length >= 2, 'playback must start and resume');
    assert.ok(states.filter(event => event.state.event === 'paused' && event.state.timestamp_sec > 0).length >= 2,
      'both Pause and ask and the server request must pause the real player');
    for (const question of events.filter(event => event.event === 'question')) {
      assert.equal(question.state?.event, 'paused');
      assert.ok(question.state.timestamp_sec > 0, 'the actual YouTube playhead must have advanced');
    }
    assert.ok(events.some(event => event.event === 'serverPauseRequest'));
    passed = true;
  } finally {
    if (!passed) console.log('Video host diagnostic:', await cdp.evaluate(`JSON.stringify({errors:globalThis.__videoTestErrors,
      frames:Array.from(document.querySelectorAll('iframe')).map(f=>({name:f.name,src:f.src}))})`).catch(()=>''));
    if (!passed && youtubeSession) console.log('Video media diagnostic:',await cdp.evaluate(`(()=>{const v=document.querySelector('video');return v?{time:v.currentTime,ready:v.readyState,network:v.networkState,paused:v.paused,frames:v.getVideoPlaybackQuality().totalVideoFrames,audio:v.webkitAudioDecodedByteCount,error:v.error?.message}:null})()`,youtubeSession).catch(()=>''));
    const output = process.env.DHIMANTAI_UX_OUT;
    if (output) {
      mkdirSync(output, {recursive: true});
      try { await ui(`d=>{d.querySelector('iframe')?.closest('article')?.scrollIntoView({block:'center'});return true;}`); } catch { /* The receipt below still records a crashed renderer. */ }
      try { writeFileSync(join(output, passed ? 'video-playback.png' : 'video-failure.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'})).data, 'base64')); } catch { /* Preserve the test receipt if the renderer exited. */ }
    }
    auth.session = session; Api.prototype.learningRoom = grant; Api.prototype.practiceCatalog = catalog;
    (desktop as any).desktopRoom = desktopGrant;
    (vscode.window as any).createWebviewPanel = create;
    const receipt = JSON.stringify({passed, vscode: vscode.version, electron: process.versions.electron, platform: process.platform,
      transport: 'fixture', player: 'live YouTube in VS Code', events}, null, 2);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, receipt);
    if (output) writeFileSync(join(output, 'video-playback.json'), receipt);
    cdp.close();
    host?.dispose();
  }
}
