import { expandIcon, collapseIcon } from './icons';
import { NotebookAttachments } from './notebookAttachments';
import { NotebookCamera } from './notebookCamera';

/** Snapshot at Send. Only the active agent interprets lesson, passage or milestone context. */
export interface LearnerMessage {
  readonly text: string;
  readonly attachments: readonly File[];
}

export function bindInstructorComposer(host: {postMessage(value: unknown): void}, form: HTMLFormElement,
    deliver: (message: LearnerMessage) => unknown) {
  const playback = window.installCoachAudio?.(host);
  const field = form.querySelector<HTMLTextAreaElement>('.composer-input textarea')!;
  const dictation = window.installDictation?.(host, field, () => playback?.listenForReply());
  return {...bindComposer(form, deliver), playback, dictation};
}

export function bindComposer(form: HTMLFormElement, deliver: (message: LearnerMessage) => unknown,
    options: {changed?: () => void; report?: (message: string) => void; stopResponse?: () => boolean} = {}) {
  const field = form.querySelector<HTMLTextAreaElement>('.composer-input textarea')!;
  const notice = form.querySelector<HTMLElement>('#attachment-status');
  const menu = form.querySelector<HTMLDetailsElement>('#attachment-menu')!;
  const cameraButton = form.querySelector<HTMLButtonElement>('#audio-camera');
  const send = form.querySelector<HTMLButtonElement>('.composer-submit')!;
  let available = false, stopping = false;
  const attachments = new NotebookAttachments(form.querySelector('#attachments'), notice, () => {
    updateSend(); options.changed?.();
  });
  function updateSend() {
    send.disabled = !available || (!stopping && !field.value.trim() && !attachments.count);
  }
  field.addEventListener('input', updateSend);
  const camera = new NotebookCamera(photo => { attachments.add([photo]); field.focus(); },
    options.report ?? (message => { if (notice) notice.textContent = message; }));
  if (cameraButton) cameraButton.onclick = () => { void camera.open(); };
  const cancelCapture = () => { camera.close(); attachments.cancelPicker(); };
  window.addEventListener('pagehide', cancelCapture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelCapture(); });
  const pickers = [form.querySelector<HTMLButtonElement>('#attach-images')!, form.querySelector<HTMLButtonElement>('#attach-pdfs')!];
  for (const picker of pickers) picker.onclick = () => { menu.open = false; attachments.choose(picker.id === 'attach-pdfs'); };
  document.addEventListener('click', event => { if (!menu.contains(event.target as Node)) menu.open = false; });
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    const bounds = menu.getBoundingClientRect();
    const height = menu.querySelector<HTMLElement>('.menu-content')!.offsetHeight;
    menu.classList.toggle('drop-down', bounds.top < height + 16 && window.innerHeight - bounds.bottom > bounds.top);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      event.stopPropagation(); menu.open = false; menu.querySelector('summary')!.focus();
    }
  });
  field.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length && !pickers[0].disabled) { event.preventDefault(); attachments.add(files); }
  });
  function lockAttachments(locked: boolean) {
    for (const picker of pickers) picker.disabled = locked;
    if (cameraButton) cameraButton.disabled = locked;
    if (locked) cancelCapture();
    attachments.lock(locked);
  }
  const input = field.closest<HTMLElement>('.composer-input');
  const expand = input?.querySelector<HTMLButtonElement>('.composer-expand');
  if (input && expand) expand.onclick = () => {
    const expanded = expand.getAttribute('aria-expanded') !== 'true';
    input.dataset.expanded = String(expanded);
    field.rows = expanded ? 8 : 2;
    expand.setAttribute('aria-expanded', String(expanded));
    expand.title = expanded ? 'Collapse input' : 'Expand input';
    expand.setAttribute('aria-label', expand.title);
    expand.innerHTML = expanded ? collapseIcon : expandIcon;
    field.focus();
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (!available || options.stopResponse?.()) return;
    const message: LearnerMessage = {text:field.value, attachments:attachments.snapshot()};
    if (message.text.trim() || message.attachments.length) void deliver(message);
  };
  form.addEventListener('keydown', event => {
    // Keep multiline editing inside the webview without invoking a workbench shortcut.
    if (event.target === field && event.key === 'Enter') event.stopPropagation();
  }, true);
  function setAvailable(enabled: boolean, stop = false) {
    available = enabled;
    stopping = stop;
    updateSend();
    lockAttachments(!enabled || stop);
  }
  setAvailable(false);
  return {attachments, cancelCapture, setAvailable};
}
