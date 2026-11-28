import { dictationStatus } from './dictation';
import { mediaIcon } from './mediaIcons';

interface ComposerOptions {
  assistant: string;
  maxlength: number;
  audio: string;
  camera?: boolean;
  formId?: string;
  inputId?: string;
  sendId?: string;
  support?: string;
  menuActions?: string;
  toolbarAction?: string;
}

/** The learner's message form on every desktop learning surface. */
export function messageComposer({assistant, maxlength, audio, camera, formId = 'composer', inputId = 'message',
    sendId = 'send', support = '', menuActions = '', toolbarAction = ''}: ComposerOptions) {
  return `<form id="${formId}" aria-label="Ask ${assistant}">${support}<div class="composer-box">
<div id="attachments" class="attachment-tray" aria-label="Attachments" hidden></div>
<div class="composer-input"><textarea id="${inputId}" aria-label="Ask ${assistant}" rows="2" maxlength="${maxlength}" aria-describedby="composer-shortcut" placeholder="Ask ${assistant} or reply…"></textarea>
<button type="button" class="composer-expand" aria-controls="${inputId}" aria-expanded="false" aria-label="Expand input" title="Expand input"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button></div>
<div class="composer-toolbar"><details id="attachment-menu" class="workspace-menu composer-menu"><summary aria-label="Add attachments" title="Add photos or PDFs"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></summary><div class="menu-content">
<button type="button" id="attach-images">Attach photos</button><button type="button" id="attach-pdfs">Attach PDFs</button>${menuActions}</div></details>${toolbarAction}
<small id="composer-shortcut">Press Enter to send or Shift+Enter for a new line.</small>
<div class="composer-controls"><div class="composer-audio">${audio}</div>${camera ? '<button type="button" id="audio-camera" disabled aria-haspopup="dialog" aria-label="Take photo" title="Take photo">' + mediaIcon('camera', true) + '</button>' : ''}
<button id="${sendId}" type="submit" class="composer-submit" disabled title="Ask ${assistant}" aria-label="Ask ${assistant}"><span id="send-label">Ask ${assistant}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14"/></svg></button></div></div>
<small id="attachment-status" role="status"></small></div>${dictationStatus}</form>`;
}

/** The notebook surrounds the shared form with the lesson's help and checkpoint controls. */
export function notebookMessageBar(assistant: 'Instructor' | 'Doubt Solver', practice: boolean, audio: string, camera = false, toolbarAction = '') {
  const support = `<div class="composer-support">
<div class="composer-quick-actions" role="group" aria-label="Learning actions"><div class="help-ladder"><strong>Stuck?</strong><button type="button" id="practice-help" disabled>Ask me a guiding question</button><span id="help-steps" class="help-steps" role="img" aria-label="No help steps used yet"></span></div><div id="composer-mode-actions"></div>
<details class="more-asks"><summary>Other help</summary><div id="notebook-help-actions" class="lesson-actions" role="group" aria-label="${assistant} help"></div></details></div><small id="help-trend" class="help-trend"></small><small id="help-note" class="help-note" role="status"></small>
<small id="notebook-help-status" class="help-note" role="status"></small>
<small id="assistant-activity" role="status" aria-live="polite" aria-atomic="true" hidden></small>
<small id="media-control-status" class="help-note" role="status" hidden></small>
<label for="message" class="sr-only">Ask ${assistant}</label>
<small id="composer-context" hidden></small></div>`;
  const menuActions = `<button type="button" id="import-data" hidden>Import a CSV or Excel file for the Coach</button>
${practice ? '<small>Up to 4 files, 2 MB each.</small>' : ''}<hr>
<button type="button" id="teach-back" disabled>Explain it in my own words</button><button type="button" id="video" ${practice ? 'hidden' : ''} disabled>Ask for a video</button>`;
  return `<footer id="message-bar" aria-label="Talk to ${assistant}">${messageComposer({assistant, maxlength:4000, audio, camera, support, menuActions, toolbarAction})}</footer>`;
}
