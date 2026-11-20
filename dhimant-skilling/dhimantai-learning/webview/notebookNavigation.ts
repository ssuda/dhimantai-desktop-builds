/** One compact index in the existing sticky notebook toolbar. */
export class NotebookNavigation {
  private readonly select = document.createElement('select');
  private readonly progress = document.createElement('details');
  private readonly summary = document.createElement('summary');
  private readonly meter = document.createElement('progress');
  private readonly label = document.createElement('span');
  private readonly description = document.createElement('p');
  constructor(toolbar: HTMLElement, private readonly jump: (id: string) => void) {
    this.select.className = 'notebook-index';
    this.select.setAttribute('aria-label', 'Go to notebook entry');
    this.select.onchange = () => { if (this.select.value) this.jump(this.select.value); this.select.value = ''; };
    this.progress.className = 'notebook-progress';
    this.meter.className = 'dh-progress';
    this.meter.setAttribute('aria-hidden', 'true');
    this.summary.append(this.label, this.meter);
    this.progress.append(this.summary, this.description);
    toolbar.append(this.select);
    (document.querySelector('.workspace-title') ?? toolbar.parentElement)?.append(this.progress);
  }
  update(entries: {id: string; label: string}[], progress: string, note: string, topics?: {covered:number;total:number}) {
    this.select.replaceChildren(new Option('Notebook entries', ''), ...entries.map((entry, index) =>
      new Option(`${index + 1}. ${entry.label}`, entry.id)));
    this.select.hidden = entries.length < 2;
    this.label.textContent = topics ? `${topics.covered}/${topics.total} topics covered` : 'Chapter progress';
    this.meter.hidden = !topics;
    if (topics) { this.meter.max = topics.total; this.meter.value = topics.covered; }
    this.description.textContent = progress + ' ' + note;
    this.progress.title = note;
    this.progress.hidden = !progress;
  }
}
