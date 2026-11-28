/** One compact index in the existing sticky notebook toolbar. */
export class NotebookNavigation {
  private readonly select = document.createElement('select');
  private readonly progress = document.createElement('details');
  private readonly summary = document.createElement('summary');
  readonly topicPanel = document.createElement('section');
  private readonly label = document.createElement('span');
  private readonly popover = document.createElement('div');
  private readonly description = document.createElement('p');
  private readonly breakdown = document.createElement('ul');
  constructor(toolbar: HTMLElement, private readonly jump: (id: string) => void) {
    this.select.className = 'notebook-index';
    this.select.setAttribute('aria-label', 'Go to notebook entry');
    this.select.onchange = () => {
      if (!this.select.value) return;
      const menu = this.select.closest('details');
      if (menu) menu.open = false;
      this.jump(this.select.value);
      this.select.value = '';
    };
    this.progress.className = 'notebook-progress';
    this.topicPanel.setAttribute('aria-label', 'Lesson topics');
    this.popover.className = 'notebook-progress-popover';
    this.breakdown.className = 'notebook-progress-breakdown';
    this.popover.append(this.description, this.breakdown, this.topicPanel);
    this.summary.append(this.label);
    this.progress.append(this.summary, this.popover);
    document.addEventListener('click', (event) => {
      if (this.progress.open && !this.progress.contains(event.target as Node)) {
        this.progress.open = false;
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.progress.open) {
        if (this.progress.contains(document.activeElement)) this.summary.focus();
        this.progress.open = false;
      }
    });
    toolbar.append(this.select);
    (document.querySelector('.workspace-title') ?? toolbar.parentElement)?.append(this.progress);
  }
  showProgress() {
    this.progress.hidden = false;
    this.progress.open = true;
    this.summary.focus({preventScroll:true});
    this.progress.scrollIntoView?.({block:'nearest'});
  }
  closeProgress() { this.progress.open = false; }
  update(
    entries: {id: string; label: string}[],
    progress: string,
    note: string,
    topics?: {covered:number;total:number;mastered?:number;needsReview?:number;codingDone?:number;codingTotal?:number},
  ) {
    this.select.replaceChildren(new Option('Notebook entries', ''), ...entries.map((entry, index) =>
      new Option(`${index + 1}. ${entry.label}`, entry.id)));
    this.select.hidden = entries.length < 2;
    this.label.textContent = 'Lesson progress';
    this.description.textContent = progress + (note ? ' ' + note : '');
    this.breakdown.replaceChildren();
    if (topics) {
      const rows: string[] = [`Taught: ${topics.covered}/${topics.total}`];
      if (typeof topics.mastered === 'number') rows.push(`Mastered: ${topics.mastered}`);
      if (typeof topics.needsReview === 'number' && topics.needsReview > 0) rows.push(`Needs review: ${topics.needsReview}`);
      if (typeof topics.codingTotal === 'number' && topics.codingTotal > 0) {
        rows.push(`Coding activities: ${topics.codingDone ?? 0}/${topics.codingTotal}`);
      }
      for (const text of rows) {
        const li = document.createElement('li');
        li.textContent = text;
        this.breakdown.append(li);
      }
    }
    this.progress.title = note;
    this.progress.hidden = !progress && !this.topicPanel.hasChildNodes();
  }
}
