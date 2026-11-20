/** Presentation only: keep the existing notebook, composer, readiness gates and transport. */
export function bindLearningWorkspace(doc: Document = document) {
  const composer = doc.getElementById('message-bar');
  if (!composer) return;
  // Keyboard shortcut focuses the same composer without submitting or replacing a draft.
  doc.addEventListener('keydown', event => {
    if (!(event.altKey && event.shiftKey && event.key.toLowerCase() === 'a') || composer.hidden) return;
    if (doc.body.matches('.selecting-course, .browsing-practice')) return;
    event.preventDefault();
    doc.getElementById('message')?.focus();
  });
}

if (typeof document !== 'undefined') bindLearningWorkspace();
