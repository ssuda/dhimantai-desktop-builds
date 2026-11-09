import { messageComposer } from './learningComposer';

// Flutter's volume_off / volume_up speaker toggle, kept in the composer.
const soundControl = `<button type="button" id="sound" class="sound-control" aria-pressed="false" aria-label="Unmute speaker" title="Unmute speaker">
<svg viewBox="0 0 24 24" aria-hidden="true"><path class="sound-off" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zM19 12c0 .94-.2 1.82-.5 2.64l1.51 1.51C20.64 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.43.94-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>
<path class="sound-on" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></button>`;
const attachmentMenu = `<details id="attachment-menu" class="study-attachments"><summary aria-label="Add attachments" title="Add attachments"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></summary><div class="attachment-options"><button type="button" id="attach-images">Attach photos</button><button type="button" id="attach-pdfs">Attach PDFs</button></div></details>`;

/** Static shell shared with the interaction tests. */
export function studyHtml(asset: (path: string) => unknown, cspSource: string, nonce: string) {
    // EPUB documents run in epub.js's sandboxed iframe, with scripts disabled.
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} https: data: blob:; font-src ${cspSource} data:; connect-src ${cspSource} blob: https: wss:; media-src blob:; frame-src blob: ${cspSource};">
      <title>dhimantAI Study</title><link rel="stylesheet" href="${asset('study/study.css')}"></head><body>
      <header class="reader-header"><span class="wordmark">Study</span><h1 id="title" class="sr-only"></h1><div class="selectors"><div class="course-selector"><span class="muted">Course</span><button id="course" class="secondary" title="Search and choose a course" aria-haspopup="dialog">Choose course…</button></div><label>Chapter<select id="chapter"></select></label></div>
      <details class="reading-details"><summary>Reading links</summary><div class="reading-details-content"><div id="reading-links"></div><p id="source-note" class="muted"></p></div></details>
      <p id="notice" role="status"></p><button id="sign-in" hidden>Sign in</button></header>
      <main><section id="reading" aria-label="Ebook reader"><div id="viewer"></div><div id="loading" role="status"><span id="loading-text">Opening chapter…</span></div>
      <div id="crop-overlay" hidden tabindex="0" aria-label="Select and adjust an area of the book" aria-describedby="crop-instructions"><div class="crop-guidance"><span id="crop-instructions">Drag a box, then move or resize it. Arrows move; Shift+arrows resize; Enter applies.</span><button id="apply-crop" disabled>Apply crop</button><button id="cancel-crop" class="secondary">Cancel</button></div><div id="crop-box" hidden></div></div><p id="crop-status" role="status" hidden></p>
      <div id="crop-toolbar" hidden role="region" aria-label="Crop preview"><img id="crop-preview" alt="Selected area of the book"><div><button id="explain-crop">Explain crop</button><button id="dismiss-crop" class="secondary">Discard</button></div></div>
      <div id="selection-toolbar" hidden role="region" aria-label="Selected passage"><blockquote id="selection" hidden></blockquote><button id="explain" disabled>Explain selection</button><button id="dismiss-selection" class="secondary" aria-label="Dismiss selection">×</button></div></section></main>
      <footer class="reader-toolbar"><nav aria-label="Reading controls"><button id="previous" class="secondary" aria-label="Previous page">←</button><span id="page" aria-live="polite"></span><button id="next" class="secondary" aria-label="Next page">→</button></nav>
      <label class="font-control">Text size<select id="font"><option>100%</option><option>125%</option><option>150%</option></select></label>
      <div class="actions"><button id="crop" class="secondary" aria-pressed="false" disabled>Crop &amp; explain</button><button id="summary" class="secondary" disabled>Summarize chapter</button><button id="quiz" class="secondary" disabled>Quiz chapter</button><button id="open-study" disabled>Ask Study</button></div></footer>
      <dialog id="study-dialog" aria-labelledby="help-title"><div class="study-view"><header class="study-header"><button id="close-study" class="secondary">← Back to book</button><div class="study-heading"><h2 id="help-title">Ask Study</h2><p id="study-context" class="muted"></p></div></header>
      <div id="study-content"><p id="help-status" role="status"></p><details id="crop-reference" class="source-reference" hidden open><summary>Selected textbook area</summary><img id="crop-reference-image" alt="Area being explained"></details><details id="text-reference" class="source-reference" hidden open><summary>Selected textbook passage</summary><blockquote id="text-reference-content"></blockquote></details><p id="submitted-question" hidden></p><div id="response" aria-live="polite"></div><div id="questions"></div></div>
      <form id="ask" aria-label="Ask Study">
      <div id="attachments" class="attachment-tray" aria-label="Attachments" hidden></div>
      ${messageComposer('Study', 'question', 1200, '<button type="button" id="clear-question" class="secondary" aria-label="Clear draft" title="Clear draft" hidden>×</button>', soundControl, attachmentMenu)}<small id="attachment-status" role="status"></small></form></div></dialog>
      <script nonce="${nonce}" src="${asset('study/jszip.min.js')}"></script><script nonce="${nonce}" src="${asset('study/epub.min.js')}"></script>
      <script nonce="${nonce}" src="${asset('study/reader_bridge.js')}"></script><script nonce="${nonce}" src="${asset('livekit-client.umd.js')}"></script><script nonce="${nonce}" src="${asset('study/study.js')}"></script></body></html>`;
}
