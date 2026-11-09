/** A bounded observation of an owned, paused native debug session. Never saved as assessment evidence. */
export interface DebugEvidence {
  id: string;
  reason: string;
  line: number;
  frames: {name: string; line: number | null; selectedSource: boolean}[];
  variables: {name: string; value: string; type: string}[];
  incomplete: boolean;
}
export interface NativeDebugState {
  phase: 'starting' | 'running' | 'paused' | 'stopped' | 'error';
  message: string;
  canInspect?: boolean;
}
export type NativeDebugAction = 'start' | 'open' | 'stop' | 'inspect' | 'import';
export interface NativeDebugReply { error?: string; source?: string; evidence?: DebugEvidence }

/** Continue/step invalidates even before a slow adapter acknowledges the request. */
export class PauseEpoch {
  private epoch = 0;
  thread?: number;
  reason = '';
  stopped(thread: unknown, reason: unknown) {
    ++this.epoch;
    this.thread = Number.isSafeInteger(thread) && Number(thread) >= 0 ? Number(thread) : undefined;
    this.reason = typeof reason === 'string' ? reason.slice(0, 80) : 'pause';
    return this.epoch;
  }
  invalidate() { ++this.epoch; this.thread = undefined; }
  get current() { return this.epoch; }
  matches(epoch: number) { return this.thread !== undefined && epoch === this.epoch; }
}

export async function deadline<T>(operation: PromiseLike<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The debugger did not respond. Pause in your code and try again.')), ms);
    })]);
  } finally { clearTimeout(timer!); }
}
