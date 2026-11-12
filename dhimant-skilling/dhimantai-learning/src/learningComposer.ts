/** Shared composer shell. Each mode supplies its own actions and transport. */
export function messageComposer(assistant: string, inputId: string, maxlength: number,
    leading = '', audio = '', before = '', after = '') {
  return `<div class="composer-box">${before}
<div class="composer-input"><textarea id="${inputId}" rows="2" maxlength="${maxlength}" aria-describedby="composer-shortcut" placeholder="Ask ${assistant} or reply…"></textarea>
<button type="button" class="composer-expand" aria-controls="${inputId}" aria-expanded="false" aria-label="Expand input" title="Expand input"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button></div>
<div class="composer-toolbar">${leading}<small id="composer-shortcut">Enter for a new line. Use the send button to send.</small>
<div class="composer-controls">${audio ? `<div class="composer-audio" role="group" aria-label="Reply audio">${audio}</div>` : ''}
<button id="send" disabled title="Ask ${assistant}" aria-label="Ask ${assistant}"><span id="send-label">Ask ${assistant}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14"/></svg></button></div></div>${after}</div>`;
}

/** A message composer, outside the notebook's editable cells. Audio is supplied by its transport.
 * Every mode has the help ladder: one rung at a time, from a guiding question to a similar example. */
export function learningComposer(assistant: 'Instructor' | 'Doubt Solver', practice: boolean, audio: string) {
  return `<footer id="message-bar" aria-label="Talk to ${assistant}"><form id="composer">
<div class="help-ladder"><strong>Stuck?</strong><button type="button" id="practice-help" disabled>Ask me a guiding question</button><span id="help-steps" class="help-steps" role="img" aria-label="No help steps used yet"></span><small id="help-trend" class="help-trend"></small>
<details class="more-asks"><summary>Other help</summary><div id="notebook-help-actions" class="lesson-actions" role="group" aria-label="${assistant} help"></div></details></div><small id="help-note" class="help-note" role="status"></small>
<small id="notebook-help-status" class="help-note" role="status"></small>
<div class="composer-heading"><label for="message" class="sr-only">Ask ${assistant}</label><span id="composer-mode-actions"></span></div>
<small id="composer-context" hidden></small>
${messageComposer(assistant, 'message', 4000, `<details class="workspace-menu composer-menu"><summary aria-label="Add attachments" title="Add photos or PDFs"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></summary><div class="menu-content">
<button type="button" id="attach-images">Attach photos</button><button type="button" id="attach-pdfs">Attach PDFs</button>
<button type="button" id="import-data" hidden>Import a CSV or Excel file for the Coach</button>
${practice ? '<small>Up to 4 files, 2 MB each.</small>' : ''}<hr>
<button type="button" id="teach-back" disabled>Explain it in my own words</button><button type="button" id="video" ${practice ? 'hidden' : ''} disabled>Ask for a video</button></div></details>`, audio,
  '<div id="attachments" class="attachment-tray" aria-label="Attachments" hidden></div>', '<small id="attachment-status" role="status"></small>')}
</form></footer>`;
}
