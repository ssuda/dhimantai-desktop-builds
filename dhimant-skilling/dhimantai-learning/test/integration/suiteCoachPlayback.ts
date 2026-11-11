// Exercise the real WebRTC -> worklet -> output path inside VS Code, without a
// microphone, account, provider, or network service. Only signaling is replaced.
import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { audioControls, audioPolicy } from '../../src/coachAudio';

export async function run() {
  const ext = vscode.extensions.getExtension('optficial.dhimantai-learning')!;
  const media = vscode.Uri.joinPath(ext.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('dhimantai.playbackTest', 'Instructor playback check', vscode.ViewColumn.One,
    {enableScripts: true, localResourceRoots: [media]});
  const webview = panel.webview, nonce = 'coach-playback-test';
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<any>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Instructor playback probe did not finish; select Start audio check in its panel')), 60000);
    webview.onDidReceiveMessage(message => {
      if (message.step) console.log('Instructor playback probe:', message.step);
      else resolve(message);
    });
  });
  webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${audioPolicy}; media-src blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}">
</head><body><button id="test-start">Start audio check</button>${audioControls(webview, media, nonce)}
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check, label) => {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(40); }
  throw new Error('Timed out: ' + label + ' (' + document.getElementById('audio-status').textContent + ')');
};
(async () => {
  let audio, sender, receiver, oscillator;
  try {
    api.postMessage({step:'starting audio context'});
    audio = new AudioContext();
    // VS Code's iframe requires a real user gesture; do not bypass autoplay policy.
    document.getElementById('test-start').onclick = () => { void audio.resume(); };
    await audio.resume();
    document.getElementById('test-start').hidden = true;
    const destination = audio.createMediaStreamDestination(), gain = audio.createGain();
    oscillator = audio.createOscillator(); oscillator.frequency.value = 440;
    gain.gain.value = 0.04; oscillator.connect(gain).connect(destination); oscillator.start();
    sender = new RTCPeerConnection(); receiver = new RTCPeerConnection();
    sender.onicecandidate = e => { if (e.candidate) receiver.addIceCandidate(e.candidate); };
    receiver.onicecandidate = e => { if (e.candidate) sender.addIceCandidate(e.candidate); };
    const remote = new Promise(resolve => { receiver.ontrack = e => resolve(e.track); });
    sender.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    const track = await remote;
    api.postMessage({step:'connected loopback WebRTC'});
    const rms = analyser => {
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, n) => sum + n*n, 0) / samples.length);
    };
    // Record the old direct Web Audio path before attaching a media element.
    const baseline = audio.createMediaStreamSource(new MediaStream([track]));
    const baselineMeter = audio.createAnalyser(), silent = audio.createGain(); silent.gain.value = 0;
    baseline.connect(baselineMeter).connect(silent).connect(audio.destination);
    await delay(800); const unattachedRms = rms(baselineMeter);
    api.postMessage({step:'unattached RMS ' + unattachedRms});
    baseline.disconnect(); baselineMeter.disconnect(); silent.disconnect(); gain.gain.value = 0;
    let outputMeter, currentRoom, starts = 0;
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context, ...args) { super(context, ...args); outputMeter = context.createAnalyser(); super.connect(outputMeter); }
    };
    const events = {TrackPublished:'published', TrackSubscribed:'subscribed', DataReceived:'data', Disconnected:'disconnected'};
    class Room {
      remoteParticipants = new Map(); handlers = {};
      constructor() { currentRoom = this; }
      on(event, handler) { this.handlers[event] = handler; }
      async connect() { await this.handlers.subscribed({kind:'audio', mediaStreamTrack:track}, {trackName:'coach-reply'}, {identity:'dhimantai-coach'}); }
      async disconnect() { this.handlers.disconnected?.(); }
    }
    window.LivekitClient = {Room, RoomEvent: events};
    const post = data => window.dispatchEvent(new MessageEvent('message', {data}));
    window.installCoachAudio({postMessage(message) {
      if (message.type === 'audioJoin') post({...message, type:'audioGrant'});
      if (message.type === 'audioStart') { starts++; gain.gain.value = starts === 1 ? 0.04 : 0; }
    }});
    const button = document.getElementById('audio-toggle'), status = document.getElementById('audio-status');
    post({audioId:'loopback'}); button.click();
    await waitFor(() => status.textContent === 'Explaining…' && rms(outputMeter) > 0.005, 'rendered WebRTC speech');
    const playingRms = rms(outputMeter);
    button.click(); await waitFor(() => status.textContent.startsWith('Paused'), 'pause acknowledgement');
    await delay(200);
    if (rms(outputMeter) > 0.00001) throw new Error('Audio still audible while paused');
    // Speech keeps arriving while paused. Server completion must retain it.
    await delay(300); gain.gain.value = 0;
    currentRoom.handlers.data(new TextEncoder().encode('done'), {identity:'dhimantai-coach'}, 0, 'dhimantai.coach.playback');
    await delay(650);
    if (!status.textContent.startsWith('Paused')) throw new Error('Completed before paused speech was heard');
    button.click();
    await waitFor(() => rms(outputMeter) > 0.005, 'buffered speech after resume');
    await waitFor(() => status.textContent === 'Spoken explanation complete', 'local buffer completion');
    if (button.getAttribute('aria-label') !== 'Explain again') throw new Error('Replay unavailable');
    // A second, entirely silent reply must produce an error, never success.
    button.click(); await waitFor(() => starts === 2, 'replay request');
    currentRoom.handlers.data(new TextEncoder().encode('done'), {identity:'dhimantai-coach'}, 0, 'dhimantai.coach.playback');
    await waitFor(() => status.textContent.includes('No spoken explanation'), 'silent stream rejection');
    api.postMessage({ok:true, unattachedRms, playingRms, pause:true, bufferedResume:true, completion:true, replay:true, silentStreamRejected:true});
  } catch (error) { api.postMessage({ok:false, error:String(error)}); }
  finally { oscillator?.stop(); sender?.close(); receiver?.close(); if (audio) await audio.close(); }
})();
</script></body></html>`;
  try {
    const response = await result;
    assert.equal(response.ok, true, response.error);
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(response, null, 2));
  } finally { clearTimeout(timer!); panel.dispose(); }
}
