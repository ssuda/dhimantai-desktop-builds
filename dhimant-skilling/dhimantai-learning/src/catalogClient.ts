declare const acquireVsCodeApi: () => {postMessage(message: unknown): void; getState?(): any; setState?(state: unknown): void};

/** Runs in the catalog webview. Keep navigation state within this account and service. */
export function catalogClient(scope: string, initialQuery: string) {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState?.(), state = saved?.scope === scope ? saved : {};
  const search = document.getElementById('search') as HTMLInputElement | null;
  const course = document.getElementById('project-course') as HTMLSelectElement | null;
  const filters = ['category', 'level', 'status'].map(name => document.getElementById('filter-' + name) as HTMLSelectElement | null);
  const all = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];
  const detailKey = (detail: HTMLDetailsElement) => {
    const card = detail.closest<HTMLElement>('[data-course],[data-project]');
    return [card?.dataset.course ?? card?.dataset.project ?? '', detail.querySelector('summary')?.textContent].join(':');
  };
  const save = () => vscode.setState?.({scope, search:search?.value ?? '', scroll:window.scrollY, projectCourse:course?.value,
    filters:filters.map(filter => filter?.value ?? ''),
    details:all<HTMLDetailsElement>('details[open]').map(detailKey),
    paths:Object.fromEntries(all<HTMLElement>('.essentials').map(section => [section.getAttribute('aria-labelledby'),
      section.querySelector<HTMLElement>('.paths button[aria-pressed="true"]')?.dataset.path ?? '']))});
  const results = document.getElementById('results')!;
  const ranked = document.createElement('div');
  ranked.className = 'courses';
  results.prepend(ranked);
  // Keep the original nodes so buttons, open outlines and the project selector keep their state.
  const words = (text: string) => text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}+#]+/gu) ?? [];
  const entries = all<HTMLElement>('#results .course').map(card => {
    const slot = document.createComment('catalog position');
    card.before(slot);
    return {card, slot, section:card.closest('.essentials'),
      title:words(card.querySelector('h3,h4')?.textContent ?? ''),
      category:words(card.dataset.category ?? ''), topics:words(card.dataset.searchTopics ?? '')};
  });
  const sections = all<HTMLElement>('#results section');
  const filter = (resetPaths = true) => {
    const query = search?.value.trim() ?? '';
    const terms = words(query);
    const phrase = terms.join(' ');
    const exactWords = (field: string[]) => terms.every(word => field.includes(word));
    const rank = (entry: typeof entries[number]) => {
      if (!query) return 0;
      if (!terms.length) return -1;
      const title = entry.title.join(' ');
      if (title === phrase) return 0;
      if (title.startsWith(phrase + ' ')) return 1;
      if (exactWords(entry.title)) return 2;
      if (terms.every(word => entry.title.some(token => token === word || (word.length >= 2 && token.startsWith(word))))) return 3;
      if (exactWords(entry.category) || exactWords(entry.topics)) return 4;
      return -1;
    };
    if (resetPaths) all<HTMLElement>('.paths button').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.path === '')));
    const [category, level, status] = filters.map(filter => filter?.value ?? '');
    const matches: {card: HTMLElement; score: number}[] = [];
    for (const entry of entries) {
      const {card, slot, section} = entry;
      const pathValue = section?.querySelector<HTMLElement>('.paths [aria-pressed="true"]')?.dataset.path;
      const pathIds = pathValue ? pathValue.split(' ') : undefined;
      card.style.order = pathIds && !query ? String(pathIds.indexOf(card.dataset.course!)) : '';
      const score = rank(entry);
      card.hidden = score < 0 || !!category && card.dataset.category !== category || !!level && card.dataset.level !== level
        || !!status && card.dataset[status] !== 'true' || !!pathIds && !pathIds.includes(card.dataset.course!);
      if (!card.hidden) matches.push({card, score});
      if ((!query || card.hidden) && card.parentElement === ranked) slot.after(card);
    }
    ranked.hidden = !query || !matches.length;
    if (query) ranked.append(...matches.sort((a,b) => a.score - b.score).map(match => match.card));
    for (const section of sections) section.hidden = !section.querySelector('.course:not([hidden])');
    const count = matches.length;
    document.getElementById('empty')!.hidden = count > 0;
    const countLabel = document.getElementById('result-count');
    if (countLabel) countLabel.textContent = `${count} matching ${count === 1 ? 'course or project' : 'courses and projects'}`;
  };
  const path = (button: HTMLElement) => {
    const section = button.closest('.essentials')!;
    section.querySelectorAll('.paths button').forEach(item => item.setAttribute('aria-pressed',String(item === button)));
    filter(false);
  };
  const startButtons = all<HTMLButtonElement>('button[data-action="join"],button[data-action="signUp"][data-id]:not([data-id=""]),button[data-action="signIn"][data-id]:not([data-id=""])');
  for (const entry of all<HTMLButtonElement>('.preview-entry')) {
    const dialog = document.getElementById(entry.getAttribute('aria-controls')!) as HTMLDialogElement;
    const feedback = dialog.querySelector<HTMLElement>('.preview-feedback')!;
    const answers = [...dialog.querySelectorAll<HTMLButtonElement>('[data-feedback]')];
    entry.addEventListener('click', () => {
      feedback.textContent = '';
      delete feedback.dataset.correct;
      answers.forEach(answer => answer.setAttribute('aria-pressed', 'false'));
      dialog.showModal();
    });
    for (const answer of answers) answer.addEventListener('click', () => {
      answers.forEach(choice => choice.setAttribute('aria-pressed', String(choice === answer)));
      feedback.dataset.correct = answer.dataset.correct;
      feedback.textContent = answer.dataset.feedback!;
    });
  }
  let checkoutBusy = false;
  let starting = document.querySelector('main')?.dataset.starting ?? '';
  const showCourseStart = (id: string) => {
    starting = id;
    for (const button of startButtons) {
      const pending = !!id && button.dataset.id === id;
      button.dataset.label ??= button.textContent ?? '';
      button.textContent = pending ? 'Starting course…' : button.dataset.label;
      button.disabled = button.dataset.disabled === 'true' || pending || (button.dataset.action === 'join' && (!!id || checkoutBusy));
      button.setAttribute('aria-busy', String(pending));
    }
  };
  document.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
    if (!button || button.disabled) return;
    button.closest('dialog')?.close();
    if (startButtons.includes(button)) {
      showCourseStart(button.dataset.id!);
    } else if (['buy','refresh'].includes(button.dataset.action!)) {
      button.disabled = true;
      document.getElementById('status-message')!.textContent = button.dataset.action === 'buy' ? 'Opening secure checkout…'
        : 'Refreshing courses and purchases…';
    }
    save();
    vscode.postMessage({type:button.dataset.action,id:button.dataset.action === 'courseProject' ? course?.value : button.dataset.id});
  });
  search?.addEventListener('input', () => { filter(); save(); });
  filters.forEach(filterInput => filterInput?.addEventListener('change', () => { filter(); save(); }));
  const discover = (query: string) => {
    if (!search) return;
    search.value = query; filters.forEach(filter => { if (filter) filter.value = ''; });
    filter(); search.focus(); search.scrollIntoView?.({block:'center'}); save();
  };
  all<HTMLElement>('[data-discover]').forEach(button => button.addEventListener('click', () => discover(button.dataset.discover!)));
  course?.addEventListener('change', save);
  all<HTMLElement>('.paths button').forEach(button => button.addEventListener('click', () => { path(button); save(); }));
  document.addEventListener('toggle', save, true);
  window.addEventListener('scroll', save, {passive:true});
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'courseStartState') {
      showCourseStart(message.id ?? '');
    } else if (message?.type === 'catalogStatus') {
      checkoutBusy = !!message.busy;
      document.getElementById('status-message')!.textContent = message.message;
      document.getElementById('payment-check')!.hidden = !message.paymentPending;
      showCourseStart(starting);
      all<HTMLButtonElement>('button[data-action="buy"],button[data-action="refresh"]').forEach(button => {
        button.disabled = button.dataset.disabled === 'true' || !!message.busy;
      });
    } else if (message?.type === 'focusCourse' && search) {
      discover(message.query);
    }
  });
  if (starting) {
    showCourseStart(starting);
    vscode.postMessage({type:'getCourseStartState'});
  }
  if (!initialQuery) filters.forEach((filter, index) => {
    if (filter && [...filter.options].some(option => option.value === state.filters?.[index])) filter.value = state.filters[index];
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
