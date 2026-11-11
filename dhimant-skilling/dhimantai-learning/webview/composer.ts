/** Shared multiline entry: Enter inserts a line; Ctrl/Cmd+Enter submits. */
export function bindComposer(form: HTMLFormElement, field: HTMLTextAreaElement, submit: () => unknown) {
  form.onsubmit = event => { event.preventDefault(); void submit(); };
  field.onkeydown = event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault(); void submit();
    }
  };
  field.addEventListener('input', () => resizeComposer(field));
}
export function resizeComposer(field: HTMLTextAreaElement) {
  field.style.height = 'auto';
  field.style.height = Math.min(240, field.scrollHeight) + 'px';
}
