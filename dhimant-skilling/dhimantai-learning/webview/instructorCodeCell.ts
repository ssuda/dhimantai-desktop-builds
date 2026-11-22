import { CodeBuffer } from './codeBuffer';
import { collapseIcon, expandIcon } from './icons';
import type { BufferEdit, CellSuggestion } from '../src/studioJsx';

interface CellOptions {
  id: string;
  key: string;
  languages: Record<string, string>;
  language: string;
  source: string;
  note: string;
  title?: string;
  changeLanguage: (language: string) => void;
  changed: () => void;
  focused?: () => void;
  run: () => void;
  complete?: (source: string, offset: number) => Promise<CellSuggestion[]>;
  resolve?: (ticket: string, source: string, offset: number) => Promise<BufferEdit[] | undefined>;
}

/** The Instructor's editable cell. The owning lesson supplies the runtime and Run action. */
export class InstructorCodeCell {
  readonly element = document.createElement('section');
  readonly heading = document.createElement('div');
  readonly note = document.createElement('small');
  readonly languagePicker = document.createElement('select');
  readonly resizeButton = document.createElement('button');
  readonly buffer = document.createElement('div');
  readonly bar = document.createElement('div');
  readonly runButton = document.createElement('button');
  readonly status = document.createElement('p');
  readonly resultBlock = document.createElement('section');
  readonly runTitle = document.createElement('strong');
  readonly runInput = document.createElement('code');
  readonly output = document.createElement('pre');
  readonly rich = document.createElement('div');
  readonly code: CodeBuffer;

  constructor(options: CellOptions) {
    const {language, languages} = options;
    this.element.className = 'practice-code-editor';
    this.element.id = 'notebook-editor-' + options.key;
    this.element.setAttribute('aria-label', languages[language] + ' practice editor');
    this.languagePicker.setAttribute('aria-label', 'Code cell language');
    for (const [value, label] of Object.entries(languages)) {
      this.languagePicker.add(new Option(label, value));
    }
    this.languagePicker.value = language;
    this.languagePicker.title = options.title ? 'This exercise uses ' + languages[language] : 'Language used to edit and run this cell';
    this.languagePicker.onchange = () => options.changeLanguage(this.languagePicker.value);
    const title = document.createElement('strong');
    if (options.title) title.textContent = options.title;
    else title.append(this.languagePicker, ' · Code cell');
    this.heading.className = 'practice-editor-heading';
    this.heading.append(title, this.resizeButton);
    this.note.textContent = options.note;
    this.buffer.className = 'practice-buffer';
    this.buffer.id = options.id + '-buffer';
    this.resizeButton.type = 'button';
    this.resizeButton.className = 'editor-resize';
    this.resizeButton.setAttribute('aria-controls', this.buffer.id);
    const resize = (expanded: boolean) => {
      this.resizeButton.innerHTML = expanded ? collapseIcon : expandIcon;
      this.resizeButton.title = expanded ? 'Shrink editor' : 'Enlarge editor';
      this.resizeButton.setAttribute('aria-label', this.resizeButton.title);
      this.resizeButton.setAttribute('aria-expanded', String(expanded));
    };
    resize(false);
    this.resizeButton.onclick = () => {
      resize(this.buffer.classList.toggle('is-enlarged'));
      this.code.view.requestMeasure();
    };
    this.code = new CodeBuffer(this.buffer, options.source, language, options.changed,
      options.focused ?? (() => {}), options.complete, options.resolve);
    this.bar.className = 'practice-actions';
    this.runButton.type = 'button';
    this.runButton.dataset.action = 'run';
    this.runButton.textContent = 'Run';
    this.runButton.onclick = options.run;
    this.bar.append(this.runButton);
    this.status.className = 'practice-status';
    this.status.setAttribute('role', 'status');
    this.output.className = 'practice-output';
    this.output.hidden = true;
    this.resultBlock.className = 'execution-result';
    this.resultBlock.hidden = true;
    this.resultBlock.append(this.runTitle, this.runInput, this.output, this.rich);
    this.element.append(this.heading, this.note, this.buffer, this.bar, this.status, this.resultBlock);
  }
}
