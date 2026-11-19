/** One compact index in the existing sticky notebook toolbar. */
export class NotebookNavigation {
  private readonly select = document.createElement('select');
  private readonly progress = document.createElement('p');
  constructor(toolbar: HTMLElement, private readonly jump: (id: string) => void) {
    this.select.className = 'notebook-index';
    this.select.setAttribute('aria-label', 'Go to notebook entry');
    this.select.onchange = () => { if (this.select.value) this.jump(this.select.value); this.select.value = ''; };
    this.progress.className = 'notebook-progress';
    this.progress.setAttribute('role', 'status');
    toolbar.append(this.select);
    toolbar.after(this.progress);
  }
  update(entries: {id: string; label: string}[], progress: string, note: string) {
    this.select.replaceChildren(new Option('Go to…', ''), ...entries.map((entry, index) =>
      new Option(`${index + 1}. ${entry.label}`, entry.id)));
    this.select.hidden = entries.length < 2;
    this.progress.textContent = progress;
    this.progress.title = note;
    this.progress.hidden = !progress;
  }
}
