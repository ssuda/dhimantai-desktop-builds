import type {CourseNote} from '../src/courseNoteStore';

declare function acquireVsCodeApi(): {postMessage(message:unknown):void};
const host = acquireVsCodeApi();
const list = document.getElementById('notes')!, status = document.getElementById('status')!;
const search = document.getElementById('search') as HTMLInputElement, reload = document.getElementById('reload')!;
const noteKey = (note:Pick<CourseNote,'scope'|'id'>) => JSON.stringify([note.scope, note.id]);

class NoteEditor {
  readonly row = document.createElement('article');
  readonly input = document.createElement('textarea');
  private message = document.createElement('small');
  private retry = document.createElement('button');
  private discard = document.createElement('button');
  private timer?:number;
  private saved:string|null;
  private expected:string|null;
  private pending = 0;
  private failed = false;
  constructor(readonly note:CourseNote) {
    this.saved = this.expected = this.input.value = note.text;
    this.input.rows = 2; this.input.maxLength = 12000;
    this.label(note.chapter);
    this.retry.textContent = 'Save my edit'; this.discard.textContent = 'Use lesson version';
    this.retry.hidden = this.discard.hidden = true;
    this.message.setAttribute('role','status');
    this.row.append(this.input,this.message,this.retry,this.discard);
    this.input.oninput = () => {
      clearTimeout(this.timer);
      if (!this.failed) this.timer = window.setTimeout(() => this.flush(), 250);
    };
    this.input.onblur = () => this.flush();
    this.retry.onclick = () => {
      this.clearError(); this.flush();
    };
    this.discard.onclick = () => {
      this.clearError(); this.accept(this.saved); filter();
    };
  }
  label(chapter:string) {
    this.note.chapter = chapter; this.input.setAttribute('aria-label','Note from ' + chapter);
  }
  flush() {
    clearTimeout(this.timer);
    const text = this.input.value;
    if (this.failed || this.expected === null || text === this.expected) return;
    host.postMessage({type:'save', scope:this.note.scope, id:this.note.id, text, expected:this.expected});
    this.expected = text; this.pending++; this.message.textContent = 'Saving…';
  }
  receive(text:string|null) {
    if (this.pending) return;
    if (!this.failed && (this.input.value === this.saved || this.input.value === text)) this.accept(text);
    else if (this.saved !== text) {
      this.saved = this.expected = text;
      this.error(text === null ? 'This note was cleared or removed in the lesson. Your edit is still here.'
        : 'The lesson now contains “' + text + '”. Your edit is still here.');
    }
  }
  acknowledge(text:string) {
    this.saved = text;
    if (--this.pending) return;
    this.expected = text;
    if (this.input.value === text) this.accept(text);
    filter();
  }
  reject(message:string) {
    this.pending--; this.expected = this.saved;
    this.error(message);
  }
  private error(message:string) {
    clearTimeout(this.timer); this.failed = true; this.message.textContent = message;
    this.retry.hidden = this.saved === null; this.discard.hidden = false;
  }
  private clearError() {
    this.failed = false; this.message.textContent = ''; this.retry.hidden = this.discard.hidden = true;
  }
  private accept(text:string|null) {
    this.saved = this.expected = text;
    if (!text?.trim()) {
      editors.delete(noteKey(this.note)); this.row.remove();
    } else {
      if (this.input.value !== text) this.input.value = text;
      this.message.textContent = '';
    }
  }
}

const editors = new Map<string,NoteEditor>();
const groups = new Map<string,HTMLElement>();
function group(chapter:string) {
  let section = groups.get(chapter);
  if (!section) {
    section = document.createElement('section');
    const title = document.createElement('h2'); title.textContent = chapter;
    section.append(title); list.append(section); groups.set(chapter,section);
  }
  return section;
}
function filter() {
  const query = search.value.trim().toLowerCase();
  let matches = 0;
  for (const {note,input,row} of editors.values()) {
    row.hidden = !!query && !note.chapter.toLowerCase().includes(query) && !input.value.toLowerCase().includes(query);
    if (!row.hidden) matches++;
  }
  for (const [chapter,section] of groups) {
    if (!section.querySelector('article')) {section.remove(); groups.delete(chapter);}
    else section.hidden = !section.querySelector('article:not([hidden])');
  }
  const total = editors.size + (editors.size === 1 ? ' note' : ' notes');
  status.textContent = !editors.size ? 'No private notes yet. Use ＋ Note in a lesson to add one.'
    : query ? matches + ' of ' + total : total;
}
function sync(notes:CourseNote[]) {
  const missing = new Set(editors.keys());
  for (const note of notes) {
    const key = noteKey(note); missing.delete(key);
    let editor = editors.get(key);
    if (!editor) {editor = new NoteEditor(note); editors.set(key,editor);}
    else {editor.label(note.chapter); editor.receive(note.text);}
    const section = group(note.chapter);
    if (editor.row.parentElement !== section) section.append(editor.row);
  }
  for (const key of missing) editors.get(key)!.receive(null);
  reload.hidden = true; filter();
}
search.oninput = filter;
reload.onclick = () => host.postMessage({type:'load'});
window.addEventListener('pagehide', () => {for (const editor of editors.values()) editor.flush();});
document.addEventListener('visibilitychange', () => {if (document.hidden) for (const editor of editors.values()) editor.flush();});
window.addEventListener('message', ({data}) => {
  if (data.type === 'notes') sync(data.notes);
  else if (data.type === 'saved') editors.get(noteKey(data))?.acknowledge(data.text);
  else if (data.type === 'saveError') editors.get(noteKey(data))?.reject(data.message);
  else if (data.type === 'error') {status.textContent = data.message; reload.hidden = false;}
});
host.postMessage({type:'load'});
