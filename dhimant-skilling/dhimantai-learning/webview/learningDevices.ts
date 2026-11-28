import type { LocalAudioTrack, Room } from 'livekit-client';

type Connection = {room: Room; agent: string};
type Opening = {connection:Connection; track?:LocalAudioTrack; timer:ReturnType<typeof setTimeout>};

/** Capture is explicit, scoped to one connection, and never restarted automatically. */
export class LearningDevices {
  private microphone?: {track: LocalAudioTrack; connection: Connection};
  private revision = 0;
  private opening?: Opening;
  private notifications: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    current(): Connection | undefined;
    capture(): Promise<LocalAudioTrack>;
    pause(): Promise<boolean>;
    changed(state: {microphone: boolean; busy: boolean}): void;
    report(message: string): void;
  }) {}

  private changed() {
    this.options.changed({microphone: !!this.microphone, busy: !!this.opening});
  }
  private async notify(connection: Connection, enabled: boolean, commit = false) {
    const notification = this.notifications.then(async () => {
      const reply = await connection.room.localParticipant.performRpc({destinationIdentity: connection.agent,
        method: 'toggle_audio', payload: JSON.stringify({input_enabled: enabled, ...(commit ? {commit_turn:true} : {})}), responseTimeout: 8000});
      if (reply !== 'ok') throw new Error(reply.startsWith('error:') ? reply.slice(6).trim() : 'Device access was not confirmed by the learning room.');
    });
    // Preserve stop/start ordering even when the preceding RPC fails or is slow.
    this.notifications = notification.catch(() => {});
    return notification;
  }
  private release(track: LocalAudioTrack, connection: Connection) {
    track.stop(); // Stop hardware before waiting for any network operation.
    void connection.room.localParticipant.unpublishTrack(track, true).catch(() => {});
  }
  stop(commit = false) {
    const revision = ++this.revision;
    const opening = this.opening;
    this.opening = undefined;
    if (opening) {
      clearTimeout(opening.timer);
      if (opening.track) {
        this.release(opening.track, opening.connection);
        void this.notify(opening.connection, false).catch(() => {});
      }
    }
    const entry = this.microphone;
    this.microphone = undefined;
    if (entry) this.release(entry.track, entry.connection);
    this.changed();
    if (entry) void this.notify(entry.connection, false, commit).catch(() => {
      if (commit && this.revision === revision && this.options.current()?.room === entry.connection.room)
        this.options.report('Microphone off. Your response could not be confirmed. Type your answer or turn the microphone on and try again.');
    });
  }
  async toggle() {
    if (this.microphone) {
      this.stop(true);
      this.options.report('Microphone off.');
      return;
    }
    const connection = this.options.current();
    if (this.opening || !connection) return;
    const revision = this.revision;
    const timer = setTimeout(() => {
      if (this.revision !== revision) return;
      this.stop();
      this.options.report('Microphone connection timed out. Check your input device and try again.');
    }, 30000);
    const opening: Opening = {connection, timer};
    this.opening = opening;
    this.changed();
    const current = () => revision === this.revision && this.options.current()?.room === connection.room;
    try {
      if (!await this.options.pause()) throw new Error('Pause the lesson video before starting the microphone.');
      if (!current()) return;
      const track = await this.options.capture();
      if (!current()) { track.stop(); return; }
      opening.track = track;
      await this.notify(connection, true);
      if (!current()) return;
      await connection.room.localParticipant.publishTrack(track);
      if (!current()) { void connection.room.localParticipant.unpublishTrack(track, true).catch(() => {}); return; }
      this.microphone = {track, connection};
      track.mediaStreamTrack.addEventListener('ended', () => {
        if (this.microphone?.track === track) { this.stop(); this.options.report('The microphone stopped. Select it again to reconnect.'); }
      }, {once: true});
      this.options.report('Microphone on. You can speak now.');
    } catch (error) {
      if (this.opening !== opening) return;
      if (opening.track) {
        this.release(opening.track, connection);
        void this.notify(connection, false).catch(() => {});
      }
      if (current()) this.options.report(error instanceof Error && error.name === 'NotAllowedError'
        ? 'Device permission was denied. You can keep typing or allow access in your system settings.'
        : error instanceof Error ? error.message : 'Could not start the device.');
    } finally {
      clearTimeout(timer);
      if (this.opening === opening) { this.opening = undefined; this.changed(); }
    }
  }
}
