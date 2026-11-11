/** The app's split speaker control, shared by Instructor and the learning room. */
export class SpeakerControl {
  private readonly group = document.createElement('div');
  private readonly picker = document.createElement('div');
  private readonly devices = document.createElement('div');
  private readonly chevron = document.createElement('button');
  private readonly notice = document.createElement('p');
  private disabled = false;
  private selecting = false;
  private revision = 0;
  private selected = 'default';

  constructor(private readonly main: HTMLButtonElement, private readonly options: {
    supported: () => boolean;
    select: (deviceId: string) => Promise<void>;
    actions?: HTMLElement;
    menuLabel?: string;
  }) {
    this.group.className = 'audio-split';
    main.before(this.group);
    this.group.append(main, this.chevron, this.picker);
    main.classList.add('audio-main');
    this.chevron.type = 'button';
    this.chevron.className = 'audio-chevron';
    this.chevron.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg>';
    this.chevron.setAttribute('aria-label', options.menuLabel ?? 'Choose audio output');
    this.chevron.title = options.menuLabel ?? 'Choose audio output';
    this.chevron.setAttribute('aria-expanded', 'false');
    this.chevron.setAttribute('aria-controls', main.id + '-outputs');
    this.picker.id = main.id + '-outputs';
    this.picker.className = 'audio-picker';
    this.picker.hidden = true;
    const title = document.createElement('strong');
    title.textContent = 'Audio Output';
    this.devices.setAttribute('role', 'group');
    this.devices.setAttribute('aria-label', 'Audio output devices');
    this.notice.setAttribute('role', 'status');
    this.picker.append(title, this.devices, this.notice);
    if (options.actions) this.picker.append(options.actions);
    this.chevron.onclick = () => {
      if (this.picker.hidden) {
        this.picker.hidden = false;
        this.chevron.setAttribute('aria-expanded', 'true');
        void this.refresh(true);
      } else this.close();
    };
    document.addEventListener('click', e => {
      if (!this.group.contains(e.target as Node)) this.close(false);
    });
    this.group.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.picker.hidden) { e.preventDefault(); this.close(); }
    });
    this.group.addEventListener('focusout', e => {
      if (e.relatedTarget && !this.group.contains(e.relatedTarget as Node)) this.close(false);
    });
    navigator.mediaDevices?.addEventListener('devicechange', () => { void this.refresh(); });
    this.update(false);
  }

  get deviceId() { return this.selected; }

  update(muted: boolean, disabled = false, action?: string, icon: 'speaker' | 'play' | 'pause' = 'speaker') {
    this.disabled = disabled;
    this.group.dataset.muted = String(muted);
    this.main.disabled = disabled;
    this.chevron.disabled = disabled || this.selecting;
    this.main.setAttribute('aria-pressed', String(muted));
    const label = action ?? (muted ? 'Unmute speaker' : 'Mute speaker');
    this.main.setAttribute('aria-label', label);
    this.main.title = label;
    this.main.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      (icon === 'play' ? '<path d="m8 4 12 8-12 8Z"/>' : icon === 'pause' ? '<path d="M8 5v14M16 5v14"/>' :
        '<path d="M11 4 6 8H3v8h3l5 4Z"/>' + (muted ? '<path d="m16 9 6 6m0-6-6 6"/>' : '<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>')) + '</svg>';
    const text = document.createElement('span');
    text.className = 'audio-sr-only';
    text.textContent = action ?? (muted ? 'Unmute' : 'Mute');
    this.main.append(text);
    if (disabled) this.close(false);
  }

  private close(focus = true) {
    ++this.revision;
    const wasOpen = !this.picker.hidden;
    this.picker.hidden = true;
    this.chevron.setAttribute('aria-expanded', 'false');
    if (focus && wasOpen) this.chevron.focus();
  }

  private async refresh(focus = false) {
    if (this.selecting) return;
    const revision = ++this.revision;
    this.devices.replaceChildren();
    this.notice.textContent = 'Loading audio outputs…';
    if (!this.options.supported() || !navigator.mediaDevices?.enumerateDevices) {
      this.notice.textContent = 'Use your computer’s sound settings to choose the audio output.';
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (revision !== this.revision) return;
      const outputs = all.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default');
      if (this.selected !== 'default' && !outputs.some(d => d.deviceId === this.selected)) {
        await this.options.select('default');
        this.selected = 'default';
        if (revision !== this.revision) return;
      }
      const choices = [{deviceId: 'default', label: 'System default'}, ...outputs];
      const seen = new Set<string>();
      for (const [index, device] of choices.entries()) {
        if (seen.has(device.deviceId)) continue;
        seen.add(device.deviceId);
        const option = document.createElement('button');
        option.type = 'button';
        option.setAttribute('aria-pressed', String(device.deviceId === this.selected));
        option.textContent = device.label || `Audio output ${index}`;
        option.onclick = () => { void this.choose(device.deviceId); };
        this.devices.append(option);
      }
      this.notice.textContent = outputs.length ? '' : 'Your computer’s default output is available.';
      if (focus && !this.picker.hidden) this.devices.querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus();
    } catch {
      if (revision === this.revision) this.notice.textContent = 'Could not list audio outputs. Try opening the picker again.';
    }
  }

  private async choose(deviceId: string) {
    if (this.selecting || this.disabled) return;
    this.selecting = true;
    this.chevron.disabled = true;
    for (const button of this.devices.querySelectorAll('button')) button.disabled = true;
    this.notice.textContent = 'Switching audio output…';
    let restoreFocus = false;
    try {
      await this.options.select(deviceId);
      this.selected = deviceId;
      restoreFocus = !this.picker.hidden;
      this.close(false);
    } catch {
      this.notice.textContent = 'Could not switch audio output. Try again or use your computer’s sound settings.';
    } finally {
      this.selecting = false;
      this.chevron.disabled = this.disabled;
      for (const button of this.devices.querySelectorAll('button')) button.disabled = false;
      if (restoreFocus) this.chevron.focus();
    }
  }
}
