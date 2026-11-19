import type { LocalAudioTrack, LocalVideoTrack, Room } from 'livekit-client';

type Device = 'microphone' | 'camera';
type Track = LocalAudioTrack | LocalVideoTrack;
type Connection = {room: Room; agent: string};

/** Capture is explicit, scoped to one connection, and never restarted automatically. */
export class LearningDevices {
  private tracks = new Map<Device, {track: Track; connection: Connection}>();
  private revision = 0;
  private busy = false;
  private notifications: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    current(): Connection | undefined;
    capture(device: Device): Promise<Track>;
    pause(): Promise<boolean>;
    changed(state: {microphone: boolean; camera: boolean; busy: boolean; cameraTrack?: LocalVideoTrack}): void;
    report(message: string): void;
  }) {}

  private changed() {
    this.options.changed({microphone: this.tracks.has('microphone'), camera: this.tracks.has('camera'), busy: this.busy,
      cameraTrack: this.tracks.get('camera')?.track as LocalVideoTrack | undefined});
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
  private release(track: Track, connection: Connection) {
    track.stop(); // Stop hardware before waiting for any network operation.
    void connection.room.localParticipant.unpublishTrack(track, true).catch(() => {});
  }
  stop(device?: Device, commit = false) {
    ++this.revision;
    const connections = new Set<Connection>();
    for (const [kind, entry] of this.tracks) {
      if (device && kind !== device) continue;
      if (kind === 'microphone') connections.add(entry.connection);
      this.tracks.delete(kind);
      this.release(entry.track, entry.connection);
    }
    this.changed();
    const revision = this.revision;
    for (const connection of connections) void this.notify(connection, false, commit).catch(() => {
      if (commit && this.revision === revision && this.options.current()?.room === connection.room)
        this.options.report('Microphone off. Your response could not be confirmed. Type your answer or turn the microphone on and try again.');
    });
  }
  async toggle(device: Device) {
    if (this.tracks.has(device)) {
      this.stop(device, device === 'microphone');
      this.options.report(device === 'microphone' ? 'Microphone off. Sending your response…' : 'Camera off.');
      return;
    }
    const connection = this.options.current();
    if (this.busy || !connection) return;
    this.busy = true; this.changed();
    const revision = this.revision;
    const current = () => revision === this.revision && this.options.current()?.room === connection.room;
    let track: Track | undefined;
    try {
      if (device === 'microphone' && !await this.options.pause()) throw new Error('Pause the lesson video before starting the microphone.');
      if (!current()) return;
      track = await this.options.capture(device);
      if (!current()) { track.stop(); return; }
      if (device === 'microphone') await this.notify(connection, true);
      if (!current()) { track.stop(); if (device === 'microphone') void this.notify(connection, false).catch(() => {}); return; }
      await connection.room.localParticipant.publishTrack(track);
      if (!current()) { this.release(track, connection); if (device === 'microphone') void this.notify(connection, false).catch(() => {}); return; }
      this.tracks.set(device, {track, connection});
      track.mediaStreamTrack.addEventListener('ended', () => {
        if (this.tracks.get(device)?.track === track) { this.stop(device); this.options.report('The ' + device + ' stopped. Select it again to reconnect.'); }
      }, {once: true});
      this.options.report(device === 'microphone' ? 'Microphone on. You can speak now.' : 'Camera on.');
    } catch (error) {
      if (track) this.release(track, connection);
      if (device === 'microphone') void this.notify(connection, false).catch(() => {});
      if (current()) this.options.report(error instanceof Error && error.name === 'NotAllowedError'
        ? 'Device permission was denied. You can keep typing or allow access in your system settings.'
        : error instanceof Error ? error.message : 'Could not start the device.');
    } finally { this.busy = false; this.changed(); }
  }
}
