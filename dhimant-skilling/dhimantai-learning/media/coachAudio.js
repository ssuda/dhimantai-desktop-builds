// A learner gesture enables spoken explanations for this and subsequent Instructor replies.
window.installCoachAudio = api => {
  const controls = document.getElementById('coach-audio');
  if (!controls) return;
  const toggle = document.getElementById('audio-toggle'), status = document.getElementById('audio-status');
  let enabled = false, id, attempt = 0, room, context, source, buffer, media, timer, drainTimer;
  let paused = false, muted = false, phase = 'off', retryPlay, failure = '';
  const actions = document.createElement('div'), off = document.createElement('button'), mute = document.createElement('button');
  actions.className = 'audio-actions';
  mute.type = off.type = 'button'; off.textContent = 'Turn off spoken explanations'; actions.append(mute, off);
  const speaker = new window.DhimantAudio.SpeakerControl(toggle, {
    supported: () => typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    select: async deviceId => {
      const current = context;
      if (current) await current.setSinkId(deviceId === 'default' ? '' : deviceId);
      if (context !== current) throw new Error('Playback changed');
    },
    actions,
    menuLabel: 'Spoken explanation options',
    playback: async () => {},
  });

  function draw() {
    const explaining = phase === 'playing' || phase === 'buffering' || phase === 'muted';
    const label = !enabled ? 'Enable spoken explanations' : paused ? 'Resume spoken explanation' :
      phase === 'blocked' ? 'Play explanation' : explaining ? 'Pause spoken explanation' :
      phase === 'complete' ? 'Explain again' : 'Turn off spoken explanations';
    speaker.update(!enabled || muted, false, label, paused || phase === 'blocked' || phase === 'complete' ? 'play' : explaining ? 'pause' : 'speaker');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.title = failure ? `${failure} ${label}` : phase === 'blocked' ? `${status.textContent}. ${label}` : muted ? `${label} (muted)` : label;
    mute.textContent = muted ? 'Unmute speaker' : 'Mute speaker';
    mute.setAttribute('aria-pressed', String(muted));
    mute.disabled = off.disabled = !enabled;
    if (phase === 'playing') status.textContent = 'Explaining…';
    if (phase === 'muted') status.textContent = 'Muted · playback continues';
    if (phase === 'buffering') status.textContent = 'Preparing explanation…';
    if (paused) status.textContent = phase === 'paused' ? 'Paused · your place is saved' : 'Pausing…';
  }
  function releaseMedia() {
    source?.disconnect(); source = undefined;
    if (media?.srcObject) { media.pause(); media.srcObject = null; }
  }
  function stop() {
    ++attempt;
    clearTimeout(timer); clearTimeout(drainTimer);
    releaseMedia();
    buffer?.disconnect(); buffer = undefined;
    if (context) context.onstatechange = null;
    const old = room; room = undefined;
    if (old) void old.disconnect().catch(() => {});
    retryPlay = undefined;
    paused = false;
  }
  function closeOutput() {
    stop();
    media?.remove(); media = undefined;
    if (context) { void context.close().catch(() => {}); context = undefined; }
  }
  function enable(waitForNext = false) {
    enabled = true;
    start(waitForNext);
    if (context) return;
    try {
      // Chromium grants playback to the element and context used during the gesture.
      // Keep them for subsequent replies while releasing each finished remote track.
      context = new AudioContext();
      media = document.createElement('audio');
      media.hidden = true; media.muted = true; media.volume = 0;
      controls.append(media);
      const silent = context.createMediaStreamDestination().stream;
      media.srcObject = silent;
      void context.resume().catch(() => {});
      void media.play().catch(() => {}).finally(() => {
        for (const track of silent.getTracks()) track.stop();
      });
    } catch { fail(); }
  }
  function turnOff() {
    closeOutput(); enabled = false; muted = false; failure = ''; phase = 'off'; status.textContent = 'Spoken explanations off'; draw();
  }
  function start(waitForNext = false) {
    stop();
    failure = '';
    const play = id && !waitForNext;
    phase = play ? 'connecting' : 'waiting';
    status.textContent = play ? 'Connecting audio…' : 'Spoken explanations on · waiting for a reply';
    draw();
    if (!play) return;
    api.postMessage({type: 'audioJoin', id, attempt});
    timer = setTimeout(fail, 45000);
  }
  function fail(message = 'Spoken explanation unavailable. Select the speaker to retry.') {
    closeOutput(); enabled = false; phase = 'off';
    failure = message; status.textContent = message;
    draw();
  }
  off.onclick = turnOff;
  mute.onclick = () => {
    muted = !muted;
    buffer?.port.postMessage({type: 'mute', value: muted});
    draw();
  };
  toggle.onclick = () => {
    if (!enabled) { enable(); return; }
    if (phase === 'blocked' || paused) { void retryPlay?.(); return; }
    if (phase === 'complete') { start(); return; }
    if (phase === 'playing' || phase === 'buffering' || phase === 'muted') {
      paused = true;
      buffer?.port.postMessage({type: 'pause', value: true});
      draw();
      return;
    }
    turnOff();
  };

  async function connect(grant) {
    const sdk = window.LivekitClient, number = attempt;
    const live = new sdk.Room();
    room = live;
    const active = () => enabled && room === live && attempt === number;
    const subscribe = (pub, peer) => {
      if (active() && peer.identity === 'dhimantai-coach' && pub.kind === 'audio' && pub.trackName === 'coach-reply') pub.setSubscribed(true);
    };
    let requested = false, finished = false, attached = false, played = false, drained = false;
    function complete() {
      if (!active() || !drained || paused || context?.state !== 'running') return;
      clearTimeout(drainTimer);
      // Allow the final render quantum to reach the output before closing it.
      drainTimer = setTimeout(() => {
        if (!active() || paused || context?.state !== 'running') return;
        stop(); phase = 'complete'; status.textContent = muted ? 'Spoken explanation complete · muted' : 'Spoken explanation complete'; draw();
      }, Math.max(50, ((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000));
    }
    live.on(sdk.RoomEvent.TrackPublished, subscribe);
    live.on(sdk.RoomEvent.TrackSubscribed, async (track, pub, peer) => {
      if (!active() || attached || peer.identity !== 'dhimantai-coach' || pub.trackName !== 'coach-reply' || track.kind !== 'audio') return;
      attached = true;
      try {
        const audio = context;
        await audio.audioWorklet.addModule(controls.dataset.worklet);
        if (!active()) return;
        if (speaker.deviceId !== 'default' && audio.sinkId !== speaker.deviceId) {
          await audio.setSinkId(speaker.deviceId);
          if (!active()) return;
        }
        buffer = new AudioWorkletNode(audio, 'coach-audio-buffer', {channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
          processorOptions: {maxSeconds: 380}});
        buffer.port.postMessage({type: 'mute', value: muted});
        buffer.port.onmessage = ({data}) => {
          if (!active()) return;
          if (data.type === 'overflow' || data.type === 'empty') {
            fail('No spoken explanation was received. Select the speaker to retry.'); return;
          }
          if (data.type === 'playback') {
            if (data.state === 'playing' || data.state === 'muted') played = true;
            // A queued worklet message must not overwrite an interruption or pause request.
            if (!requested || phase === 'blocked' || audio.state !== 'running' || (data.state === 'paused') !== paused) return;
            phase = data.state; draw();
          }
          if (data.type === 'drained' && finished && played) {
            drained = true; complete();
          }
        };
        buffer.onprocessorerror = () => { if (active()) fail(); };
        buffer.connect(audio.destination);
        const stream = new MediaStream([track.mediaStreamTrack]);
        // Chromium can supply only silence to Web Audio for an unattached remote
        // WebRTC track. Keep a silent media element playing to drive its receiver.
        // The worklet is the sole audible path, including while paused.
        const element = media;
        element.srcObject = stream;
        source = audio.createMediaStreamSource(stream);
        source.connect(buffer);
        retryPlay = async () => {
          try {
            // Start both directly in the click handler when a gesture is needed.
            await Promise.all([audio.resume(), element.srcObject ? element.play() : Promise.resolve()]);
            if (!active()) return;
            if (audio.state !== 'running') throw new Error('Playback needs a gesture');
            paused = false;
            buffer.port.postMessage({type: 'pause', value: false});
            phase = 'buffering'; draw();
            if (drained) { complete(); return; }
            if (!requested) {
              requested = true;
              clearTimeout(timer); timer = setTimeout(fail, 185000 / Math.min(speaker.playbackSpeed, 1));
              api.postMessage({type: 'audioStart', id, attempt: number, speed: speaker.playbackSpeed});
            }
          } catch {
            if (active()) { paused = false; phase = 'blocked'; status.textContent = 'Audio paused · select the play icon to continue'; draw(); }
          }
        };
        audio.onstatechange = () => {
          if (!active()) return;
          if (audio.state === 'closed') { fail(); return; }
          if (audio.state !== 'running') {
            buffer.port.postMessage({type: 'pause', value: true});
            phase = 'blocked'; paused = false;
            status.textContent = 'Audio interrupted · select the play icon to continue'; draw();
          }
        };
        // Expose the gesture fallback even when resume() remains pending.
        phase = 'blocked'; status.textContent = 'Ready · select the play icon to start'; draw();
        void retryPlay();
      } catch { if (active()) fail(); }
    });
    live.on(sdk.RoomEvent.DataReceived, (bytes, peer, _kind, topic) => {
      if (!active() || peer?.identity !== 'dhimantai-coach' || topic !== 'dhimantai.coach.playback') return;
      if (new TextDecoder().decode(bytes) !== 'done' || !requested) { fail(); return; }
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Drain the remote track's final frames, then retain only locally buffered speech.
      drainTimer = setTimeout(() => {
        if (!active()) return;
        releaseMedia();
        buffer?.port.postMessage({type: 'finish'});
        void live.disconnect().catch(() => {});
      }, 500);
    });
    live.on(sdk.RoomEvent.Disconnected, () => { if (active() && !finished) fail(); });
    try {
      await live.connect(grant.url, grant.token, {autoSubscribe: false});
      if (!active()) { await live.disconnect(); return; }
      for (const peer of live.remoteParticipants.values()) for (const pub of peer.trackPublications.values()) subscribe(pub, peer);
    } catch { if (active()) fail(); }
  }

  window.addEventListener('message', ({data}) => {
    if (data?.type === 'audioOff') { if (Object.hasOwn(data, 'audioId')) id = data.audioId; turnOff(); return; }
    if (data?.type === 'audioGrant' || data?.type === 'audioError') {
      if (!enabled || data.attempt !== attempt || data.id !== id) return;
      if (data.type === 'audioError') fail();
      else void connect(data).catch(() => { if (enabled && data.attempt === attempt && data.id === id) fail(); });
      return;
    }
    // A Practice notebook decides which replies were shown and forwards only those (reply() below).
    if (data?.type === 'practiceReply') return;
    const state = data?.type === 'state' ? data.state : data;
    if (state && Object.hasOwn(state, 'audioId')) accept(state.audioId);
  });
  function accept(audioId) {
    if (audioId === id) return;
    id = audioId;
    if (enabled) start();
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && enabled) turnOff(); });
  window.addEventListener('pagehide', turnOff);
  draw();
  return {
    reply: audioId => accept(typeof audioId === 'string' ? audioId : null),
    // A microphone gesture interrupts this reply and opts into the next one.
    listenForReply() {
      enable(true);
    },
    turnOff,
  };
};
