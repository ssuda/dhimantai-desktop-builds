declare const acquireVsCodeApi: () => {postMessage(message: unknown): void; getState?(): any; setState?(state: unknown): void};

/** Runs in the catalog webview. Keep navigation state within this account and service. */
export function catalogClient(scope: string, initialQuery: string) {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState?.(), state = saved?.scope === scope ? saved : {};
  const search = document.getElementById('search') as HTMLInputElement | null;
  const course = document.getElementById('project-course') as HTMLSelectElement | null;
  const all = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];
  const detailKey = (detail: HTMLDetailsElement) => {
    const card = detail.closest<HTMLElement>('[data-course],[data-project]');
    return [card?.dataset.course ?? card?.dataset.project ?? '', detail.querySelector('summary')?.textContent].join(':');
  };
  const save = () => vscode.setState?.({scope, search:search?.value ?? '', scroll:window.scrollY, projectCourse:course?.value,
    details:all<HTMLDetailsElement>('details[open]').map(detailKey),
    paths:Object.fromEntries(all<HTMLElement>('.essentials').map(section => [section.getAttribute('aria-labelledby'),
      section.querySelector<HTMLElement>('.paths button[aria-pressed="true"]')?.dataset.path ?? '']))});
  const filter = () => {
    const query = search?.value.trim().toLowerCase() ?? ''; let count = 0;
    all<HTMLElement>('.course[data-course],.course[data-project],.course[data-browser-course]').forEach(card => {
      card.style.order = ''; card.hidden = !card.textContent?.toLowerCase().includes(query); if (!card.hidden) count++;
    });
    all<HTMLElement>('.paths button').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.path === '')));
    all<HTMLElement>('#results section').forEach(section => { section.hidden = !all<HTMLElement>('.course').some(card => section.contains(card) && !card.hidden); });
    document.getElementById('empty')!.hidden = count > 0;
  };
  const path = (button: HTMLElement) => {
    const ids = button.dataset.path ? button.dataset.path.split(' ') : undefined, section = button.closest('.essentials')!;
    section.querySelectorAll('.paths button').forEach(item => item.setAttribute('aria-pressed',String(item === button)));
    section.querySelectorAll<HTMLElement>('.course').forEach(card => {
      card.hidden = !!ids && !ids.includes(card.dataset.course!); card.style.order = ids ? String(ids.indexOf(card.dataset.course!)) : '';
    });
  };
  document.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
    if (!button || button.disabled) return;
    if (['join','buy','refresh'].includes(button.dataset.action!)) {
      button.disabled = true;
      document.getElementById('status-message')!.textContent = button.dataset.action === 'buy' ? 'Opening secure checkout…'
        : button.dataset.action === 'refresh' ? 'Refreshing courses and purchases…' : 'Joining…';
    }
    save();
    vscode.postMessage({type:button.dataset.action,id:button.dataset.action === 'courseProject' ? course?.value : button.dataset.id});
  });
  search?.addEventListener('input', () => { filter(); save(); });
  course?.addEventListener('change', save);
  all<HTMLElement>('.paths button').forEach(button => button.addEventListener('click', () => { path(button); save(); }));
  document.addEventListener('toggle', save, true);
  window.addEventListener('scroll', save, {passive:true});
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'catalogStatus') {
      document.getElementById('status-message')!.textContent = message.message;
      document.getElementById('payment-check')!.hidden = !message.paymentPending;
      all<HTMLButtonElement>('button[data-action="buy"],button[data-action="join"],button[data-action="refresh"]').forEach(button => {
        button.disabled = button.dataset.disabled === 'true' || !!message.busy;
      });
    } else if (message?.type === 'focusCourse' && search) {
      search.value = message.query; filter(); window.scrollTo(0,0); save();
    }
  });
  if (search) { search.value = initialQuery || state.search || ''; filter(); }
  if (course && [...course.options].some(option => option.value === state.projectCourse)) course.value = state.projectCourse;
  if (!initialQuery) {
    all<HTMLDetailsElement>('details').forEach(detail => { detail.open = !!state.details?.includes(detailKey(detail)); });
    all<HTMLElement>('.essentials').forEach(section => {
      const selected = state.paths?.[section.getAttribute('aria-labelledby')!];
      const button = [...section.querySelectorAll<HTMLElement>('.paths button')].find(button => button.dataset.path === selected);
      if (button) path(button);
    });
    if (typeof state.scroll === 'number') window.requestAnimationFrame?.(() => window.scrollTo(0,state.scroll));
  }
  save();
}
