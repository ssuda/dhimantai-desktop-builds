/**
 * What the room's status line says about the Instructor and the learner's code.
 * The learner should always see whether the Instructor is listening, thinking or
 * replying, whether their code is running, and whether an explanation was paused
 * for the run and is waiting for them.
 */
export type AgentStatus = {
  ready: boolean;
  listening: boolean;
  /** A retracted or replaced reply is being held back. */
  outputPaused: boolean;
  /** The agent's state, with thinking/speaking cleared once the reply is on screen. */
  activity: string;
  running: boolean;
  pausedForRun: boolean;
  runFinished: boolean;
};

export function agentStatusLabel(s: AgentStatus): string {
  if (!s.ready) return '';
  if (s.listening) return 'Listening…';
  if (s.running) return s.pausedForRun ? 'Running your code · explanation paused' : 'Running your code…';
  if (s.outputPaused) return '';
  if (s.activity === 'thinking') return 'Thinking…';
  if (s.activity === 'speaking') return 'Replying…';
  if (s.pausedForRun) return 'Run finished · explanation paused. Ask to continue when you are ready.';
  if (s.runFinished) return 'Run finished · Ready';
  return '';
}

/** Tracks the learner's run and an explanation paused for it. */
export class RunStatus {
  running = false;
  pausedForRun = false;
  finished = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly changed: () => void, private readonly finishedMs = 5000) {}
  setRunning(value: boolean) {
    if (value === this.running) return;
    this.running = value;
    this.clearTimer();
    this.finished = !value;
    // "Ready" is a short confirmation; a paused explanation stays visible until a reply starts.
    if (!value) this.timer = setTimeout(() => { this.timer = undefined; this.finished = false; this.changed(); }, this.finishedMs);
    this.changed();
  }
  paused() {
    if (this.pausedForRun) return;
    this.pausedForRun = true;
    this.changed();
  }
  /** A new reply (the run review or the continued explanation) replaces the paused state. */
  replyStarted() {
    if (!this.pausedForRun && !this.finished) return;
    this.pausedForRun = this.finished = false;
    this.clearTimer();
    this.changed();
  }
  reset() {
    this.running = this.pausedForRun = this.finished = false;
    this.clearTimer();
  }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
