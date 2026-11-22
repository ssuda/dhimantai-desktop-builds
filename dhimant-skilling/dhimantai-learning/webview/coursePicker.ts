/** Keep the room's select as the committed value while the learner searches its options. */
export function bindCoursePicker(picker: HTMLElement) {
  const select = picker.querySelector<HTMLSelectElement>('#lesson-course')!;
  const toggle = picker.querySelector<HTMLButtonElement>('#course-toggle')!;
  const popup = picker.querySelector<HTMLElement>('#course-popup')!;
  const query = picker.querySelector<HTMLInputElement>('#course-query')!;
  const list = picker.querySelector<HTMLElement>('#course-options')!;
  const empty = picker.querySelector<HTMLElement>('#course-no-matches')!;
  let active: Element | null = null;

  function highlight(option: Element | null) {
    active?.classList.remove('active');
    active = option;
    if (active) {
      active.classList.add('active');
      query.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({block:'nearest'});
    } else {
      query.removeAttribute('aria-activedescendant');
    }
  }

  function filter(preferred = select.value) {
    const term = query.value.trim().toLowerCase();
    const matches = [...select.options].filter(option => option.text.toLowerCase().includes(term));
    const rows = matches.map(option => {
      const row = document.createElement('div');
      row.id = 'course-option-' + option.index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected));
      row.textContent = option.text;
      row.dataset.value = option.value;
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = rows.length > 0;
    highlight(rows.find(row => row.dataset.value === preferred) ?? rows[0] ?? null);
  }

  function close() {
    popup.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    query.value = '';
    highlight(null);
    list.replaceChildren();
  }

  function open(term = '') {
    popup.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    query.value = term;
    query.focus();
    filter();
  }

  function choose(option: Element | null) {
    const value = option?.getAttribute('data-value');
    if (value == null) return;
    close();
    toggle.focus();
    if (value !== select.value) {
      select.value = value;
      select.dispatchEvent(new Event('change', {bubbles:true}));
    }
  }

  toggle.onclick = () => popup.hidden ? open() : close();
  toggle.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      open(event.key);
    }
  };
  query.oninput = () => filter();
  query.onkeydown = event => {
    if (event.isComposing) return;
    switch (event.key) {
      case 'ArrowDown': highlight(active?.nextElementSibling ?? active); break;
      case 'ArrowUp': highlight(active?.previousElementSibling ?? active); break;
      case 'Enter': choose(active); break;
      case 'Escape': close(); toggle.focus(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  // Keep focus in the search field until the option's click commits the choice.
  list.onmousedown = event => event.preventDefault();
  list.onclick = event => choose((event.target as Element).closest('[role="option"]'));
  picker.addEventListener('focusout', event => {
    if (!popup.hidden && !picker.contains(event.relatedTarget as Node | null)) close();
  });
  document.addEventListener('pointerdown', event => {
    if (!popup.hidden && !picker.contains(event.target as Node)) close();
  });

  return (visible: boolean) => {
    toggle.textContent = select.selectedOptions[0]?.text ?? 'Choose course';
    toggle.disabled = select.disabled;
    if (popup.hidden) return;
    if (!visible || toggle.disabled) close();
    else filter(active?.getAttribute('data-value') ?? select.value);
  };
}
