import { expandIcon, collapseIcon } from './icons';

/** Shared multiline entry; only the send button submits. */
export function bindComposer(form: HTMLFormElement, field: HTMLTextAreaElement, submit: () => unknown) {
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
  form.onsubmit = event => { event.preventDefault(); void submit(); };
  form.addEventListener('keydown', event => {
    // Keep multiline editing inside the webview without invoking a workbench shortcut.
    if (event.target === field && event.key === 'Enter') event.stopPropagation();
  }, true);
}
