import type { RemoteParticipant, RemoteTrackPublication, Room } from 'livekit-client';
import { LearningDevices } from './learningDevices';
import { prepareLearningAudio, switchLearningMode, waitForLearningAgent } from './learningAgent';
import { SpeechInterruption } from './speechInterruption';
import { mediaIcon } from '../src/mediaIcons';

declare const LivekitClient: typeof import('livekit-client');

/** Microphone for written Practice and native notebook forms that do not already own a learning room. */
window.installLearningVoice = (host, playback, replied) => {
  const mic = document.querySelector<HTMLButtonElement>('#audio-microphone');
  if (!mic) return;
  const status = document.getElementById('dictation-status') ?? document.createElement('small');
  if (!status.isConnected) { status.setAttribute('role', 'status'); mic.after(status); }
  let key = '', room: Room | undefined, agent: string | undefined;
  let opening: { id: string; timer: ReturnType<typeof setTimeout>; } | undefined;
  const output = new Set<HTMLMediaElement>();
  const interruption = new SpeechInterruption(updateAudio, () => {
    if (room && agent) void room.localParticipant.performRpc({ destinationIdentity: agent, method: 'stop_speaking', payload: '{}' }).catch(() => { });
  });
  function updateAudio() { for (const el of output) el.muted = interruption.muted || playback?.muted === true; }
  const devices = new LearningDevices({
    current: () => room && agent && key ? { room, agent } : undefined,
    capture: () => LivekitClient.createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    pause: async () => true, report: message => { status.textContent = message; },
    changed: state => {
      if (!state.microphone && mic.getAttribute('aria-pressed') === 'true') interruption.userSpeaking(false);
      mic.setAttribute('aria-pressed', String(state.microphone));
      mic.innerHTML = mediaIcon('microphone', state.microphone);
      const busy = !!opening || state.busy;
      mic.setAttribute('aria-busy', String(busy));
      mic.title = busy ? 'Cancel microphone connection' : state.microphone ? 'Stop microphone' : 'Start microphone';
      mic.setAttribute('aria-label', mic.title);
      if (busy) status.textContent = 'Connecting microphone…';
      mic.disabled = !key;
    },
  });
  function close(message = '') {
    if (opening) clearTimeout(opening.timer);
    opening = undefined;
    const old = room; room = undefined; agent = undefined;
    devices.stop(); interruption.reset();
    for (const el of output) { el.pause(); el.remove(); }
    output.clear();
    if (old) void old.disconnect().catch(() => { });
    status.textContent = message;
  }
  mic.onclick = () => {
    if (opening || mic.getAttribute('aria-busy') === 'true') { close('Microphone off.'); return; }
    if (!key) return;
    if (room && agent) { void room.startAudio().catch(() => { }); void devices.toggle(); return; }
    playback?.listenForReply();
    const id = crypto.randomUUID();
    opening = { id, timer: setTimeout(() => close('Could not connect the microphone. Select it to try again.'), 60000) };
    mic.title = 'Cancel microphone connection'; mic.setAttribute('aria-label', mic.title); mic.setAttribute('aria-busy', 'true');
    status.textContent = 'Connecting microphone…';
    host.postMessage({ type: 'learningVoice', id, key });
  };
  window.addEventListener('message', async ({ origin, data }) => {
    if (origin !== window.location.origin) return;
    if (data?.type === 'audioOff' || (data?.type === 'visibility' && !data.visible)) { close(); return; }
    if (data?.type !== 'learningVoiceGrant' || !opening || data.id !== opening.id || room) return;
    if (data.error) { close(data.error); return; }
    const live = new LivekitClient.Room({ audioOutput: { deviceId: playback?.deviceId } }); room = live;
    let learnerSpoke = false;
    const current = () => live === room;
    const isAgent = (peer: RemoteParticipant) => current() && peer.isAgent && (!agent || peer.identity === agent);
    const subscribe = (pub: RemoteTrackPublication, peer: RemoteParticipant) => { if (isAgent(peer) && pub.kind === 'audio') pub.setSubscribed(true); };
    const events = LivekitClient.RoomEvent;
    live.on(events.TrackPublished, subscribe);
    live.on(events.TrackSubscribed, (track, _pub, peer) => {
      if (track.kind !== 'audio' || !isAgent(peer)) return;
      const el = track.attach(); output.add(el); updateAudio(); document.body.append(el);
      void el.play().catch(() => { if (current()) status.textContent = 'Select the microphone to resume audio.'; });
    });
    live.on(events.TrackUnsubscribed, track => { for (const el of track.detach()) { output.delete(el); el.remove(); } });
    live.on(events.ActiveSpeakersChanged, peers => {
      if (!current()) return;
      const speaking = peers.includes(live.localParticipant);
      if (speaking) learnerSpoke = true;
      interruption.userSpeaking(speaking);
    });
    live.on(events.ParticipantAttributesChanged, (changed, peer) => {
      if (peer.identity !== agent || !current() || !('lk.agent.state' in changed)) return;
      interruption.agentChanged(changed['lk.agent.state']);
      if (learnerSpoke && changed['lk.agent.state'] === 'speaking') { learnerSpoke = false; replied?.(); }
    });
    const disconnected = () => { if (current()) close('Audio disconnected. Select the microphone to reconnect.'); };
    live.on(events.Disconnected, disconnected);
    live.on(events.Reconnecting, disconnected);
    live.on(events.ParticipantDisconnected, peer => { if (peer.identity === agent) disconnected(); });
    try {
      await live.connect(data.url, data.token, { autoSubscribe: false });
      if (!current()) { await live.disconnect(); return; }
      for (const peer of live.remoteParticipants.values()) for (const pub of peer.trackPublications.values()) subscribe(pub, peer);
      await waitForLearningAgent(live, current, async peer => {
        const ack = await switchLearningMode(live, peer.identity, data.mode);
        if (ack !== 'ok') throw new Error(ack.startsWith('error:') ? ack.slice(6).trim() : 'Could not start learning audio.');
        if (!current() || !opening) return;
        if (playback?.playbackSpeed && playback.playbackSpeed !== 1)
          await live.localParticipant.performRpc({ destinationIdentity: peer.identity, method: 'set_speech_playback_speed', payload: JSON.stringify({ speed: playback.playbackSpeed }) });
        await prepareLearningAudio(live, peer.identity);
        if (!current() || !opening) return;
        agent = peer.identity; interruption.agentChanged(peer.attributes['lk.agent.state'] || '');
        clearTimeout(opening.timer); opening = undefined;
        void live.startAudio().catch(() => { });
        await devices.toggle();
      });
    } catch (error) { if (current()) close(error instanceof Error ? error.message : 'Could not connect the microphone. Try again.'); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  window.addEventListener('pagehide', () => close());
  return {
    setScope(value) { if (value !== key) { key = value; close(); } },
    cancel: () => close(), updateAudio,
    async output(deviceId) {
      if (room && !await room.switchActiveDevice('audiooutput', deviceId)) throw new Error('Output unavailable');
    },
    async speed(speed) {
      if (room && agent && await room.localParticipant.performRpc({
        destinationIdentity: agent, method: 'set_speech_playback_speed',
        payload: JSON.stringify({ speed })
      }) !== 'ok') throw new Error('Voice speed was not accepted');
    },
  };
};
