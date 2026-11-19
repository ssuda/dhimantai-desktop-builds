/** Presentation only: keep the existing notebook, composer, readiness gates and transport. */
export function bindLearningWorkspace(doc: Document = document) {
  const lessonList = doc.getElementById('lesson-list');
  const composer = doc.getElementById('message-bar');
  if (!composer) return;
  const win = doc.defaultView!;
  const previous = doc.getElementById('previous-chapter') as HTMLButtonElement;
  const updateNavigation = () => {
    if (!lessonList || !previous) return;
    const chapters = [...(lessonList?.querySelectorAll<HTMLButtonElement>('.lesson-outline > button') ?? [])];
    const index = chapters.findIndex(button => button.getAttribute('aria-pressed') === 'true');
    const target = chapters.slice(0, Math.max(0, index)).reverse().find(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    previous.hidden = !lessonList || !!doc.getElementById('tutor-lessons')?.hidden || index < 0;
    previous.disabled = !target || !!(doc.getElementById('workspace-mode') as HTMLSelectElement)?.disabled;
    previous.title = target ? 'Review ' + target.textContent : 'First available chapter';
    previous.onclick = () => target?.click();
  };
  const observer = new win.MutationObserver(updateNavigation);
  const lessons = doc.getElementById('tutor-lessons');
  if (lessons) observer.observe(lessons, {childList:true, subtree:true, attributes:true, attributeFilter:['hidden','aria-pressed','disabled']});
  const mode = doc.getElementById('workspace-mode');
  if (mode) observer.observe(mode, {attributes:true, attributeFilter:['disabled']});
  // Keyboard shortcut focuses the same composer without submitting or replacing a draft.
  doc.addEventListener('keydown', event => {
    if (!(event.altKey && event.shiftKey && event.key.toLowerCase() === 'a') || composer.hidden) return;
    if (doc.body.classList.contains('selecting-course')) return;
    event.preventDefault();
    doc.getElementById('message')?.focus();
  });
  updateNavigation();
  win.addEventListener('pagehide', () => observer.disconnect(), {once:true});
}

if (typeof document !== 'undefined') bindLearningWorkspace();
