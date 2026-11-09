// Buffer only the active spoken reply, in memory. Pausing retains incoming speech.
// Nothing is recorded on disk. Report rendered samples, not server completion.
class CoachAudioBuffer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.ceil(sampleRate * 190));
    this.head = 0;
    this.size = 0;
    this.paused = false;
    this.muted = false;
    this.finished = false;
    this.played = false;
    this.quiet = sampleRate;
    this.state = undefined;
    this.port.onmessage = ({data}) => {
      if (data.type === 'pause') {
        this.paused = data.value;
        this.state = undefined; // acknowledge even a quick pause/resume pair
      }
      if (data.type === 'finish') this.finished = true;
      if (data.type === 'mute') this.muted = data.value;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0], output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    if (!this.finished && input) {
      if (this.size + input.length > this.samples.length) {
        this.port.postMessage({type: 'overflow'});
        return false;
      }
      for (const value of input) {
        this.samples[(this.head + this.size) % this.samples.length] = value;
        this.size++;
      }
    }
    if (!this.paused) {
      this.quiet += output.length;
      for (let i = 0; i < output.length && this.size; i++) {
        const value = this.samples[this.head];
        if (!this.muted) output[i] = value;
        if (Math.abs(value) > 0.00001) { this.played = true; this.quiet = 0; }
        this.head = (this.head + 1) % this.samples.length;
        this.size--;
      }
    }
    const state = this.paused ? 'paused' : this.quiet < sampleRate * 0.75 ? (this.muted ? 'muted' : 'playing') : 'buffering';
    if (state !== this.state) {
      this.state = state;
      this.port.postMessage({type: 'playback', state});
    }
    if (this.finished && !this.size && !this.paused) {
      this.port.postMessage({type: this.played ? 'drained' : 'empty'});
      return false;
    }
    return true;
  }
}
registerProcessor('coach-audio-buffer', CoachAudioBuffer);
