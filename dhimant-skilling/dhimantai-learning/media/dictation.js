// LiveKit owns microphone capture and utterance detection. Only final text enters the composer.
window.installDictation = (api, field, interrupt, submit) => {
  const mic = document.getElementById('audio-microphone'), status = document.getElementById('dictation-status');
  if (!mic || !field) return;
  const supported = !!(window.LivekitClient && navigator.mediaDevices?.getUserMedia);
  let key = '', active, transcript;
  const notice = message => { if (status) status.textContent = message; };
  function draw() {
    mic.disabled = !key || !supported;
    mic.title = !supported ? 'Microphone unavailable in this window.' : active?.phase === 'listening' ? 'Finish speaking'
      : active ? 'Cancel voice input' : 'Start microphone';
    mic.setAttribute('aria-label', mic.title);
    mic.setAttribute('aria-pressed', String(active?.phase === 'listening'));
  }
  function cancel(message = '') {
    const turn = active;
    active = undefined;
    if (turn) {
      clearTimeout(turn.timer);
      if (!turn.room) api.postMessage({type:'cancelDictation', id:turn.id});
      turn.track?.stop();
      void turn.room?.disconnect().catch(() => {});
    }
    draw(); notice(message);
  }
  function deadline(turn, ms, message) {
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => { if (active === turn) cancel(message); }, ms);
  }
  async function start() {
    const turn = active = {id:crypto.randomUUID(), phase:'connecting', startedEmpty:!field.value.trim()};
    draw(); notice('Connecting microphone…');
    deadline(turn, 40000, 'Voice input could not connect. Try the microphone again.');
    try {
      const paused = await interrupt?.();
      if (active !== turn) return;
      if (paused === false) { cancel('Pause the lesson video before starting the microphone.'); return; }
      const track = await window.LivekitClient.createLocalAudioTrack({echoCancellation:true, noiseSuppression:true, autoGainControl:true});
      if (active !== turn) { track.stop(); return; }
      turn.track = track;
      track.mediaStreamTrack.addEventListener('ended', () => {
        if (active === turn && turn.phase !== 'finishing') cancel('Microphone disconnected. Try again.');
      }, {once:true});
      api.postMessage({type:'voiceInputGrant', key, id:turn.id});
    } catch (error) {
      if (active === turn) cancel(error.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow microphone access in your system settings, then retry.'
        : 'Could not open the microphone. Check your input device and try again.');
    }
  }
  function receive(turn, value) {
    if (value?.error) { cancel(value.error); return; }
    const text = typeof value?.text === 'string' ? value.text.trim() : '';
    if (!text) { cancel('No speech was recognized.'); return; }
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    const addition = (start && !/\s/.test(field.value[start-1]) ? ' ' : '') + text;
    if (field.maxLength > 0 && field.value.length - (end-start) + addition.length > field.maxLength) {
      cancel('The transcript exceeds the message limit. Try a shorter question.'); return;
    }
    const autoSend = turn.startedEmpty && !field.value.trim() && !document.hidden;
    transcript = {text, language:value.language};
    // End capture immediately. Disconnect after the RPC handler returns its acknowledgement.
    active = undefined;
    clearTimeout(turn.timer);
    turn.track?.stop();
    setTimeout(() => void turn.room.disconnect().catch(() => {}), 0);
    draw(); notice('');
    field.setRangeText(addition, start, end, 'end'); field.dispatchEvent(new Event('input', {bubbles:true})); field.focus();
    if (!(autoSend && submit?.())) notice('Voice input added to your draft.');
  }
  async function connect(turn, grant) {
    const sdk = window.LivekitClient, room = turn.room = new sdk.Room();
    function fail(message) { if (active === turn) cancel(message); }
    async function publishWhenReady() {
      if (active !== turn || turn.phase !== 'connecting') return;
      const peer = room.remoteParticipants.get('dhimantai-transcription');
      if (!peer?.isAgent || peer.attributes?.['voice.input'] !== 'ready') return;
      turn.phase = 'opening';
      try {
        await room.localParticipant.publishTrack(turn.track);
        if (active !== turn) return;
        turn.phase = 'listening'; draw(); notice('Listening…');
        deadline(turn, 90000, 'Voice input ended. Select the microphone to speak again.');
      } catch { fail('Could not publish the microphone to LiveKit. Try the microphone again.'); }
    }
    room.localParticipant.registerRpcMethod('voiceTranscript', async data => {
      if (active !== turn || data.callerIdentity !== 'dhimantai-transcription' ||
          !['opening','listening','finishing'].includes(turn.phase)) return 'ignored';
      receive(turn, JSON.parse(data.payload)); return 'ok';
    });
    room.on(sdk.RoomEvent.ParticipantAttributesChanged, publishWhenReady);
    room.on(sdk.RoomEvent.ParticipantConnected, publishWhenReady);
    room.on(sdk.RoomEvent.ParticipantDisconnected, peer => {
      if (peer.identity === 'dhimantai-transcription') fail('Voice input ended. Select the microphone to try again.');
    });
    room.on(sdk.RoomEvent.Disconnected, () => fail('Voice input disconnected. Try the microphone again.'));
    try {
      await room.connect(grant.url, grant.token, {autoSubscribe:false});
      if (active === turn) await publishWhenReady();
      else await room.disconnect();
    } catch { fail('Could not connect to voice input. Try the microphone again.'); }
  }
  mic.onclick = () => {
    const turn = active;
    if (!turn) { if (key && supported) void start(); return; }
    if (turn.phase !== 'listening') { cancel(); return; }
    turn.phase = 'finishing'; draw(); notice('Finishing transcript…');
    turn.track.stop();
    deadline(turn, 8000, 'No final transcript arrived. Try the microphone again.');
    void turn.room.localParticipant.performRpc({destinationIdentity:'dhimantai-transcription', method:'finishVoiceInput',
      payload:'{}', responseTimeout:5000}).catch(() => {
      if (active === turn) cancel('Voice input could not finish. Try the microphone again.');
    });
  };
  window.addEventListener('message', ({data, origin}) => {
    // The desktop webview delivers host messages from its same-origin bootstrap frame.
    if (origin !== window.location.origin) return;
    if (data?.type !== 'voiceInputGrant' || !active || active.room || active.id !== data.id) return;
    if (data.error) cancel(data.error); else void connect(active, data);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', () => cancel());
  draw();
  return {setScope(value) { if (key !== value) { key = value || ''; transcript = undefined; cancel(); } }, cancel,
    languageFor(text) { return transcript && text.includes(transcript.text) ? transcript.language : undefined; }};
};
