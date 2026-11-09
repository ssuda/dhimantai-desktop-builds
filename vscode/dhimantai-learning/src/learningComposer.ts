/** Shared composer shell. Each mode supplies its own actions and transport. */
export function messageComposer(assistant: string, inputId: string, maxlength: number,
    leading = '', audio = '', before = '', after = '') {
  return `<div class="composer-box">${before}
<textarea id="${inputId}" rows="2" maxlength="${maxlength}" aria-describedby="composer-shortcut" placeholder="Ask ${assistant} or reply…"></textarea>
<div class="composer-toolbar">${leading}<small id="composer-shortcut">Ctrl/Cmd+Enter to send</small>
<div class="composer-controls">${audio ? `<div class="composer-audio" role="group" aria-label="Reply audio">${audio}</div>` : ''}
<button id="send" disabled title="Ask ${assistant} (Ctrl/Cmd+Enter)" aria-label="Ask ${assistant}" aria-keyshortcuts="Control+Enter Meta+Enter"><span id="send-label">Ask ${assistant}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14"/></svg></button></div></div>${after}</div>`;
}

/** A message composer, outside the notebook's editable cells. Audio is supplied by its transport. */
export function learningComposer(assistant: 'Instructor' | 'Doubt Solver', practice: boolean, audio: string) {
  return `<footer id="message-bar" aria-label="Talk to ${assistant}"><form id="composer">
${practice ? `<div class="help-ladder"><strong>Stuck?</strong><button type="button" id="practice-help" disabled>Ask me a guiding question</button><span id="help-steps" class="help-steps" role="img"></span><small id="help-trend" class="help-trend"></small></div><small id="help-note" class="help-note" role="status"></small>` : ''}
<details class="more-asks"><summary>Get help</summary><div id="notebook-help-actions" class="lesson-actions" role="group" aria-label="${assistant} help"></div></details>
<small id="notebook-help-status" class="help-note" role="status"></small>
<div class="composer-heading"><label for="message">Ask ${assistant}</label><span id="composer-mode-actions"></span></div>
<small id="composer-context" hidden></small>
${messageComposer(assistant, 'message', 4000, `<details class="workspace-menu composer-menu"><summary aria-label="Add attachments" title="Add photos or PDFs"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></summary><div class="menu-content">
<button type="button" id="attach-images">Attach photos</button><button type="button" id="attach-pdfs">Attach PDFs</button>
${practice ? '<small>Up to 4 files, 2 MB each.</small>' : ''}<hr>
<button type="button" id="teach-back" disabled>Explain it in my own words</button><button type="button" id="video" ${practice ? 'hidden' : ''} disabled>Ask for a video</button></div></details>`, audio,
  '<div id="attachments" class="attachment-tray" aria-label="Attachments" hidden></div>', '<small id="attachment-status" role="status"></small>')}
</form></footer>`;
}
