// Push-to-talk dictation fills the current draft. Only an explicit send submits the question.
window.installDictation = (api, field, interrupt) => {
  const mic = document.getElementById('audio-microphone'), status = document.getElementById('dictation-status');
  if (!mic || !field) return;
  let key = '', id = '', recorder, stream, context, timeout, phase = '';
  const supported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.AudioContext && window.OfflineAudioContext);
  const notice = message => { if (status) status.textContent = message; };
  function draw() {
    mic.disabled = !key || !supported;
    mic.title = !supported ? 'Microphone capture is unavailable in this window.' : phase === 'recording' ? 'Stop recording and transcribe'
      : phase ? 'Cancel dictation' : 'Start microphone';
    mic.setAttribute('aria-label', mic.title);
    mic.setAttribute('aria-pressed', String(phase === 'recording'));
  }
  function release() {
    clearTimeout(timeout);
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    stream = recorder = undefined;
  }
  function cancel(message = '') {
    if (phase === 'transcribing') api.postMessage({type:'cancelDictation', id});
    id = phase = '';
    release();
    if (context) { void context.close().catch(() => {}); context = undefined; }
    notice(message); draw();
  }
  async function start() {
    const token = id = crypto.randomUUID();
    phase = 'requesting'; interrupt?.(); draw(); notice('Requesting microphone access…');
    try {
      timeout = setTimeout(() => cancel('Microphone permission timed out. Try again when ready.'), 30000);
      const captured = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}, video:false});
      if (token !== id) { captured.getTracks().forEach(track => track.stop()); return; }
      clearTimeout(timeout);
      stream = captured;
      for (const track of stream.getAudioTracks()) track.onended = () => {
        if (id === token && phase === 'recording') cancel('Microphone disconnected. Check your input device and try again.');
      };
      const chunks = [], recording = recorder = new MediaRecorder(stream);
      recording.ondataavailable = event => { if (token === id && event.data.size) chunks.push(event.data); };
      recording.onerror = () => { if (id === token) cancel('Microphone recording failed. Check your input device and try again.'); };
      recording.onstop = async () => {
        if (token !== id) return;
        release(); phase = 'transcribing'; draw(); notice('Transcribing…');
        timeout = setTimeout(() => cancel('Transcription timed out. Try the microphone again.'), 40000);
        try {
          const decoder = context = new AudioContext();
          const decoded = await decoder.decodeAudioData(await new Blob(chunks, {type:recording.mimeType}).arrayBuffer());
          if (token !== id) return;
          const length = Math.min(480000, Math.ceil(decoded.duration * 16000));
          const offline = new OfflineAudioContext(1, length, 16000);
          const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
          const samples = (await offline.startRendering()).getChannelData(0);
          if (token !== id) return;
          const bytes = new Uint8Array(samples.length * 2), data = new DataView(bytes.buffer);
          for (let i = 0; i < samples.length; i++) data.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          api.postMessage({type:'dictate', key, id:token, pcm:btoa(binary)});
        } catch { if (token === id) cancel('The recording could not be read. Try the microphone again.'); }
      };
      recording.start(); phase = 'recording'; draw(); notice('Listening… Select the microphone to finish.');
      timeout = setTimeout(release, 30000);
    } catch (error) {
      if (token === id) cancel(error.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow the microphone in the desktop prompt and your system privacy settings, then retry.'
        : 'Could not open the microphone. Check the selected system input and try again.');
    }
  }
  mic.onclick = () => { if (phase === 'recording') release(); else if (phase) cancel(); else if (key && supported) void start(); };
  window.addEventListener('message', ({data}) => {
    if (data?.type !== 'dictated' || !id || data.id !== id) return;
    if (data.error || !data.text?.trim()) { cancel(data.error || 'No speech was recognized.'); return; }
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    const prefix = start && !/\s/.test(field.value[start - 1]) ? ' ' : '';
    const addition = prefix + data.text.trim();
    if (field.maxLength > 0 && field.value.length - (end - start) + addition.length > field.maxLength) {
      cancel('The transcript exceeds the message limit. Record a shorter question.'); return;
    }
    phase = '';
    field.setRangeText(addition, start, end, 'end'); field.dispatchEvent(new Event('input', {bubbles:true})); field.focus();
    cancel('Voice input added. Review your message before sending.');
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', () => cancel());
  draw();
  return {setScope(value) { if (key !== value) { key = value || ''; cancel(); } }, cancel};
};
