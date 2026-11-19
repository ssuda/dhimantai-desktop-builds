/** Silence playout before waiting for the agent's interruption acknowledgement. */
export class SpeechInterruption {
  private speaking = false;
  private held = false;
  private agentState = '';
  private stopped = false;
  get muted() { return this.held || this.speaking; }
  get listening() { return this.speaking; }
  constructor(private readonly changed: () => void, private readonly interrupt: () => void) {}
  userSpeaking(value: boolean) {
    if (value === this.speaking) return;
    this.speaking = value;
    if (value) { this.held = true; this.stopped = !!this.agentState && this.agentState !== 'speaking'; }
    else if (this.stopped && this.agentState === 'speaking') this.held = false;
    this.changed();
    if (value) this.interrupt();
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
