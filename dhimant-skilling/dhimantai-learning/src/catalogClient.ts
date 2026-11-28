declare const acquireVsCodeApi: () => {postMessage(message: unknown): void; getState?(): any; setState?(state: unknown): void};

declare const initializeDesktopControls: ((api: ReturnType<typeof acquireVsCodeApi>) => void) | undefined;

/** Runs in the catalog webview. Keep navigation state within this account and service. */
export function catalogClient(scope: string, initialCourse: string, openSetup = false, projects = false) {
  const vscode = acquireVsCodeApi();
  if (typeof initializeDesktopControls === 'function') initializeDesktopControls(vscode);
  const saved = vscode.getState?.(), state = saved?.scope === scope ? saved : {};
  const search = document.getElementById('search') as HTMLInputElement | null;
  const course = document.getElementById('project-course') as HTMLSelectElement | null;
  const guide = document.getElementById('course-guide') as HTMLDialogElement;
  const guideTrigger = document.getElementById('open-guide')!;
  const guideCourse = document.getElementById('guide-course') as HTMLSelectElement | null;
  const guideFeedback = document.getElementById('guide-feedback')!;
  const tabs = [...guide.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  let guideTopic = tabs[0];
  let guideReturnScroll = 0;
  const all = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];
  const options = all<HTMLInputElement>('.filter-options input[name]');
  const values = (name: string) => options.filter(input => input.name === name && input.checked && input.value).map(input => input.value);
  const choose = (name: string, values: string[]) => {
    for (const input of options.filter(input => input.name === name))
      input.checked = values.includes(input.value) || (!values.length && input.value === '');
  };
  const home = document.getElementById('catalog-home');
  const explore = document.getElementById('catalog-explore');
  const sort = document.getElementById('catalog-sort') as HTMLSelectElement | null;
  const pageSize = 24;
  let pageLimit = Math.max(pageSize, Number(state.pageLimit) || 0);
  let groupLimits = new Map<string, number>((Array.isArray(state.groupLimits) ? state.groupLimits : []).filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && entry[1] >= 6));
  let view = state.view === 'explore' ? 'explore' : 'home';
  let selectedPath: string = state.path ?? '';
  const selectView = (next: string, focus = true) => {
    view = next;
    if (home && explore) {
      home.hidden = view !== 'home';
      explore.hidden = view !== 'explore';
      for (const link of all<HTMLElement>('[data-view]')) {
        if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      if (focus) document.getElementById(view + '-title')?.focus();
    }
  };
  const detailKey = (detail: HTMLDetailsElement) => {
    const card = detail.closest<HTMLElement>('[data-course],[data-project],[data-bundle],[data-browser-course]');
    return [card?.dataset.course ?? card?.dataset.project ?? card?.dataset.bundle ?? card?.dataset.browserCourse ?? '', detail.querySelector('summary')?.textContent].join(':');
  };
  const loading = document.querySelector('main')?.dataset.loading === 'true';
  const save = () => !loading && vscode.setState?.({scope, view, pageLimit, path:selectedPath, sort:sort?.value, search:search?.value ?? '', scroll:guide.open ? guideReturnScroll : window.scrollY, projectCourse:course?.value,
    guide:guide.open ? guideTopic.id : undefined, guideCourse:guideCourse?.value,
    choices:options.filter(input => input.checked && input.value).map(input => [input.name, input.value]), groupLimits:[...groupLimits],
    details:all<HTMLDetailsElement>('details[open]').map(detailKey)});
  let prepared: Set<string> | undefined;
  const showReadiness = () => {
    if (guideCourse && prepared) document.getElementById('guide-ready')!.textContent = prepared.has(guideCourse.value)
      ? 'Previously set up on this computer.' : 'No completed setup recorded on this computer.';
  };
  const checkReadiness = () => {
    if (guideTopic.id === 'tab-code' && guideCourse) vscode.postMessage({type:'getPreparedCourses'});
  };
  const selectTopic = (tab: HTMLButtonElement) => {
    guideTopic = tab;
    if (guide.open) checkReadiness();
    for (const item of tabs) {
      item.tabIndex = item === tab ? 0 : -1;
      item.setAttribute('aria-selected', String(item === tab));
      document.getElementById(item.getAttribute('aria-controls')!)!.hidden = item !== tab;
    }
  };
  const openGuide = (scroll: number) => {
    guideReturnScroll = scroll;
    guideTrigger.focus({preventScroll:true});
    guide.showModal();
    guideTopic.focus({preventScroll:true});
    checkReadiness();
    save();
  };
  guideTrigger.addEventListener('click', () => openGuide(window.scrollY));
  guide.addEventListener('close', () => {
    if (document.activeElement === guideTrigger || document.activeElement === document.body || guide.contains(document.activeElement)) {
      guideTrigger.focus({preventScroll:true});
      window.scrollTo(0, guideReturnScroll);
    }
    save();
  });
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => { selectTopic(tab); save(); });
    tab.addEventListener('keydown', event => {
      const next: Record<string, number> = {ArrowRight:i+1, ArrowDown:i+1, ArrowLeft:i-1, ArrowUp:i-1, Home:0, End:tabs.length-1};
      if (!(event.key in next)) return;
      event.preventDefault();
      const target = tabs[(next[event.key] + tabs.length) % tabs.length];
      selectTopic(target); target.focus(); save();
    });
  }
  guideCourse?.addEventListener('change', () => { showReadiness(); save(); });
  if (guideCourse && [...guideCourse.options].some(option => option.value === state.guideCourse)) guideCourse.value = state.guideCourse;
  const nav = document.querySelector<HTMLElement>('.catalog-bar');
  if (nav && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
    document.documentElement.style.scrollPaddingTop = (nav.offsetHeight + 8) + 'px';
  }).observe(nav);
  const results = document.getElementById('results')!;
  const words = (text: string) => text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}+#]+/gu) ?? [];
  const groups = all<HTMLElement>('#results [data-group]').map(section => ({
    section, key:section.dataset.group!, grid:section.querySelector<HTMLElement>('.category-grid')!,
    more:section.querySelector<HTMLButtonElement>('.group-more')!, count:section.querySelector<HTMLElement>('.group-count'),
  }));
  const entries = all<HTMLElement>('#results .course').map(card => {
    const kind = card.dataset.project ? 'project' : card.dataset.bundle ? 'bundle' : 'course';
    const levels: string[] = card.dataset.levels ? JSON.parse(card.dataset.levels) : [card.dataset.level ?? ''];
    const group = card.closest<HTMLElement>('[data-group]')!;
    return {card, kind, levels, group:group.dataset.group!,
      title:words(card.querySelector('h3,h4')?.textContent ?? ''),
      category:words([card.dataset.category, group.dataset.title].filter(Boolean).join(' ')), topics:[...words(card.dataset.searchTopics ?? card.dataset.track ?? ''), kind, kind + 's']};
  });
  const more = document.getElementById('more-results');
  const paths = document.getElementById('essential-paths');
  const clear = document.getElementById('clear-filters') as HTMLButtonElement | null;
  const filter = (resetPage = true) => {
    if (resetPage) { pageLimit = pageSize; groupLimits.clear(); }
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
    const category = values('category')[0] ?? '', price = values('price')[0], show = values('show')[0];
    const levels = values('level'), statuses = values('status');
    const kind = category.startsWith('type:') ? category.slice(5) : '';
    if (paths) paths.hidden = category !== 'Engineering Essentials';
    if (category !== 'Engineering Essentials') selectedPath = '';
    const pathIds = selectedPath ? selectedPath.split(' ') : [];
    for (const button of all<HTMLElement>('[data-path]')) button.setAttribute('aria-pressed', String(button.dataset.path === selectedPath));
    const matches = entries.map(entry => ({entry, score:rank(entry)})).filter(({entry, score}) => {
      const data = entry.card.dataset;
      return score >= 0 && (kind ? entry.kind === kind : !category || entry.group === category)
        && (!levels.length || levels.some(level => entry.levels.includes(level)))
        && (!statuses.length || statuses.includes(data.status ?? ''))
        && (!show || (show === 'freeStart' ? data.available === 'true' && ['free','preview'].includes(data.price ?? '') : data[show] === 'true'))
        && (!price || data.price === price) && (!pathIds.length || pathIds.includes(data.course ?? ''));
    });
    matches.sort((a, b) => {
      if (sort?.value === 'title') return a.entry.title.join(' ').localeCompare(b.entry.title.join(' '));
      if (pathIds.length) return pathIds.indexOf(a.entry.card.dataset.course!) - pathIds.indexOf(b.entry.card.dataset.course!);
      return a.score - b.score;
    });
    const count = matches.length;
    document.getElementById('empty')!.hidden = count > 0;
    results.classList.toggle('flat', !!category);
    if (more) more.hidden = !category || count <= pageLimit;
    const countLabel = document.getElementById('result-count');
    if (category) {
      results.replaceChildren(...matches.slice(0, pageLimit).map(match => match.entry.card));
      const noun = kind || 'course';
      if (countLabel) countLabel.textContent = count > pageLimit ? `Showing ${pageLimit} of ${count} results`
        : `${count} matching ${noun}${count === 1 ? '' : 's'}`;
    } else {
      const sections: HTMLElement[] = [];
      for (const group of groups) {
        const cards = matches.filter(match => match.entry.group === group.key);
        if (!cards.length) continue;
        const limit = groupLimits.get(group.key) ?? 6;
        group.grid.replaceChildren(...cards.slice(0, limit).map(match => match.entry.card));
        group.more.hidden = limit >= cards.length;
        if (group.count) group.count.textContent = `${Math.min(limit, cards.length)} of ${cards.length}`;
        sections.push(group.section);
      }
      results.replaceChildren(...sections);
      if (countLabel) countLabel.textContent = `${count} matching result${count === 1 ? '' : 's'} · grouped by category`;
    }
    const active = document.getElementById('active-filters');
    active?.replaceChildren();
    for (const field of options) {
      if (!active || !field.checked || !field.value) continue;
      const chip = document.createElement('button');
      const label = field.labels?.[0]?.textContent ?? field.value;
      chip.className = 'secondary';
      chip.textContent = label + ' ×';
      chip.setAttribute('aria-label', 'Remove filter ' + label);
      chip.addEventListener('click', () => {
        if (field.type === 'radio') choose(field.name, []); else field.checked = false;
        filter(); save(); document.getElementById('search')?.focus();
      });
      active.append(chip);
    }
    if (clear) clear.disabled = !query && !options.some(field => field.checked && field.value) && !selectedPath;
  };
  const browse = (category = '', price = '', query = '') => {
    if (search) search.value = query;
    for (const name of ['category','level','price','status','show']) choose(name, []);
    choose('category', [category]); choose('price', [price]);
    selectedPath = '';
    selectView('explore'); filter(); save();
  };
  all<HTMLButtonElement>('[data-view]').forEach(link => link.addEventListener('click', () => { selectView(link.dataset.view!); save(); }));
  all<HTMLButtonElement>('[data-browse-category],[data-browse-price]').forEach(link => link.addEventListener('click', () =>
    browse(link.dataset.browseCategory, link.dataset.browsePrice, link.dataset.browseQuery)));
  clear?.addEventListener('click', () => browse());
  document.querySelector('[data-reset-search]')?.addEventListener('click', () => browse());
  document.getElementById('toggle-filters')?.addEventListener('click', event => {
    const toggle = event.currentTarget as HTMLButtonElement;
    toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
  });
  sort?.addEventListener('change', () => { filter(); save(); });
  for (const group of groups) group.more.addEventListener('click', () => {
    const previous = groupLimits.get(group.key) ?? 6;
    groupLimits.set(group.key, previous + 6);
    filter(false); save();
    const heading = group.grid.children[previous]?.querySelector<HTMLElement>('h3,h4');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  });
  more?.addEventListener('click', () => {
    const firstNew = results.children.length;
    pageLimit += pageSize; filter(false); save();
    const heading = results.children[firstNew]?.querySelector('h3');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  });
  all<HTMLElement>('[data-path]').forEach(button => button.addEventListener('click', () => {
    selectedPath = button.dataset.path ?? ''; filter(); save();
  }));
  const checkoutButtons = all<HTMLButtonElement>('button[data-action="buy"],button[data-action="refresh"]');
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
    button.closest<HTMLDialogElement>('dialog.course-preview')?.close();
    if (button.dataset.action === 'payments' && guide.open) guide.close();
    if (startButtons.includes(button)) {
      showCourseStart(button.dataset.id!);
    } else if (['buy','refresh'].includes(button.dataset.action!)) {
      button.disabled = true;
      document.getElementById('status-message')!.textContent = button.dataset.action === 'buy' ? 'Opening secure checkout…'
        : 'Refreshing courses and purchases…';
      if (guide.open) guideFeedback.textContent = document.getElementById('status-message')!.textContent;
    }
    save();
    const action = button.dataset.action;
    const id = action === 'setupCourse' ? guideCourse?.value : action === 'courseProject' ? course?.value : button.dataset.id;
    vscode.postMessage({type:action, id});
  });
  search?.addEventListener('input', () => { filter(); save(); });
  for (const input of options) input.addEventListener('change', () => { filter(); save(); });
  const discover = (query: string, outline?: HTMLDetailsElement | null) => {
    if (!search) return;
    selectView('explore', false);
    search.value = query;
    for (const name of ['category','level','price','status','show']) choose(name, []);
    selectedPath = '';
    filter();
    if (outline) outline.open = true;
    const target = outline?.querySelector('summary') ?? search;
    target.focus(); target.scrollIntoView?.({block:'center'}); save();
  };
  const focusCourse = (id: string) => {
    const entry = entries.find(e => (e.card.dataset.course ?? e.card.dataset.browserCourse) === id)
      ?? entries.find(e => Array.from(e.card.querySelectorAll<HTMLElement>('[data-catalog-chapter]')).some(ch => ch.dataset.catalogChapter === id));
    if (!entry) return false;
    discover(entry.card.querySelector('h3,h4')!.textContent!, entry.card.querySelector<HTMLDetailsElement>('details[data-course-outline]'));
    return true;
  };
  all<HTMLElement>('[data-discover]').forEach(button => button.addEventListener('click', () => discover(button.dataset.discover!)));
  course?.addEventListener('change', save);

  document.addEventListener('toggle', save, true);
  window.addEventListener('scroll', save, {passive:true});
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'courseStartState') {
      showCourseStart(message.id ?? '');
    } else if (message?.type === 'preparedCourses') {
      prepared = new Set(message.names);
      showReadiness();
    } else if (message?.type === 'setupStatus') {
      document.getElementById('guide-setup-status')!.textContent = message.message;
      const setup = guide.querySelector<HTMLButtonElement>('[data-action=setupCourse]');
      if (setup) setup.disabled = !!message.busy || !guideCourse;
      if (guideCourse) guideCourse.disabled = !!message.busy;
      if (!message.busy && guide.open) checkReadiness();
    } else if (message?.type === 'catalogStatus') {
      guideFeedback.textContent = message.message;
      checkoutBusy = !!message.busy;
      document.getElementById('status-message')!.textContent = message.message;
      document.getElementById('payment-check')!.hidden = !message.paymentPending;
      showCourseStart(starting);
      checkoutButtons.forEach(button => {
        button.disabled = button.dataset.disabled === 'true' || !!message.busy;
      });
    } else if (message?.type === 'browseProjects') {
      if (guide.open) guide.close();
      browse('type:project');
    } else if (message?.type === 'focusCourse' && search) {
      if (guide.open) guide.close();
      focusCourse(message.id);
    }
  });
  if (starting) {
    showCourseStart(starting);
    vscode.postMessage({type:'getCourseStartState'});
  }
  if (course && [...course.options].some(option => option.value === state.projectCourse)) course.value = state.projectCourse;
  if (projects) browse('type:project');
  else if (!initialCourse || !focusCourse(initialCourse)) {
    // Upgrade saved dropdown choices from earlier versions of the catalog.
    const choices: string[][] = Array.isArray(state.choices) ? state.choices : ['category','level','status','price'].flatMap((name, index) => {
      const value = state.filters?.[index];
      return value ? [[name === 'status' && value !== 'covered' ? 'show' : name, value]] : [];
    });
    for (const name of ['category','level','price','status','show']) {
      const restored = choices.filter(pair => Array.isArray(pair) && pair[0] === name && options.some(field => field.name === name && field.value === pair[1]));
      choose(name, restored.map(pair => pair[1]));
    }
    selectView(view, false);
    if (sort && state.sort === 'title') sort.value = 'title';
    if (search) { search.value = state.search || ''; filter(false); }
    all<HTMLDetailsElement>('details').forEach(detail => { detail.open = !!state.details?.includes(detailKey(detail)); });
    const restored = tabs.find(tab => tab.id === (openSetup ? 'tab-code' : state.guide));
    if (restored) {
      selectTopic(restored); openGuide(state.scroll ?? 0);
    }
    if (typeof state.scroll === 'number') window.requestAnimationFrame?.(() => window.scrollTo(0,state.scroll));
  }
  save();
}
