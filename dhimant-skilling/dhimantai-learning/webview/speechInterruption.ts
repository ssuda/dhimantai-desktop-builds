/** Silence playout before waiting for the agent's interruption acknowledgement. */
export class SpeechInterruption {
  private speaking = false;
  private held = false;
  private agentState = '';
  private stopped = false;
  get muted() { return this.held || this.speaking; }
  get listening() { return this.speaking; }
  constructor(private readonly changed: () => void, private readonly interrupt: (explicit: boolean) => void) {}
  interruptReply() {
    if (this.held || (this.agentState !== 'speaking' && this.agentState !== 'thinking')) return;
    this.held = true;
    this.stopped = false;
    this.changed();
    this.interrupt(true);
  }
  /**
   * Running code stops a spoken explanation so the learner can watch the run.
   * A reply still being prepared is left alone: the learner asked for it.
   */
  pauseForRun(): boolean {
    if (this.held || this.agentState !== 'speaking') return false;
    this.interruptReply();
    return true;
  }
  userSpeaking(value: boolean) {
    if (value === this.speaking) return;
    this.speaking = value;
    if (value) { this.held = true; this.stopped = !!this.agentState && this.agentState !== 'speaking'; }
    else if (this.stopped && this.agentState === 'speaking') this.held = false;
    this.changed();
    if (value) this.interrupt(false);
  }
  agentChanged(state: string) {
    this.agentState = state;
    if (this.held) {
      if (state !== 'speaking') this.stopped = true;
      else if (this.stopped && !this.speaking) this.held = false;
    }
    this.changed();
  }
  reset() { this.speaking = this.held = this.stopped = false; this.agentState = ''; }
}
