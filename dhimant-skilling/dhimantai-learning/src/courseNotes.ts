import {randomBytes} from 'node:crypto';
import * as vscode from 'vscode';
import type {CourseNote} from './courseNoteStore';
import type {TutorNotebook} from './tutorNotebook';

/** One native course tab. Each private note stays in its original notebook. */
export class CourseNotes {
  private panels = new Map<string, {panel:vscode.WebviewPanel; refresh:()=>Promise<void>}>();
  constructor(private media:vscode.Uri) {}

  notebookSaved(key:string, before:TutorNotebook, after:TutorNotebook) {
    const entry = this.panels.get(key);
    if (!entry) return;
    const notes = (book:TutorNotebook) => book.cells.filter(c => c.kind === 'note' && c.text.trim()).map(c => [c.id,c.text]);
    if ((after.doubtId && after.title !== before.title) || JSON.stringify(notes(before)) !== JSON.stringify(notes(after))) void entry.refresh();
  }

  open(key:string, course:string, current:()=>Promise<boolean>, load:()=>Promise<CourseNote[]>,
      save:(note:CourseNote, expected:string)=>Promise<void>) {
    const existing = this.panels.get(key);
    if (existing) {existing.panel.reveal(); return;}
    const panel = vscode.window.createWebviewPanel('dhimantai.courseNotes', 'Course Notes · ' + course,
      vscode.ViewColumn.One, {enableScripts:true, retainContextWhenHidden:true, localResourceRoots:[this.media]});
    const nonce = randomBytes(16).toString('hex');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.media,'learning-room','courseNotes.js'));
    let visible:CourseNote[] = [], disposed = false;
    let work = Promise.resolve();
    const post = async (message:object) => {
      if (!disposed && await current()) await panel.webview.postMessage(message);
    };
    const reload = async () => {
      visible = await load();
      await post({type:'notes', notes:visible});
    };
    // Process refreshes and edits in delivery order, including a final edit received before close.
    const enqueue = (action:()=>Promise<void>) => {
      work = work.then(async () => {
        if (await current()) await action();
        else if (!disposed) panel.dispose();
      }).catch(async error => {await post({type:'error', message:String(error)});});
      return work;
    };
    let scheduled:Promise<void>|undefined;
    const refresh = () => {
      if (scheduled) return scheduled;
      const next = enqueue(async () => {
        scheduled = undefined;
        if (!disposed) await reload();
      });
      scheduled = next;
      void next.finally(() => {if (scheduled === next) scheduled = undefined;});
      return next;
    };
    this.panels.set(key,{panel,refresh});
    panel.onDidDispose(() => {disposed = true; this.panels.delete(key);});
    panel.onDidChangeViewState(({webviewPanel}) => {if (webviewPanel.active) void refresh();});
    panel.webview.onDidReceiveMessage(msg => {
      if (msg?.type === 'load') return refresh();
      if (msg?.type !== 'save') return;
      return enqueue(async () => {
        const note = visible.find(n => n.scope === msg.scope && n.id === msg.id);
        try {
          if (!note || msg.expected !== note.text) throw new Error('The lesson version changed.');
          if (typeof msg.text !== 'string' || msg.text.length > 12000) throw new Error('Notes can contain up to 12,000 characters.');
          await save({...note,text:msg.text}, note.text);
          note.text = msg.text;
          await post({type:'saved', ...note});
        } catch (error) {
          await post({type:'saveError',scope:msg.scope,id:msg.id,message:String(error)});
          await reload();
        }
      });
    });
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
body{color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:20px;max-width:900px;margin:auto}
header{position:sticky;top:0;background:var(--vscode-editor-background);padding:8px 0}h1{font-size:20px}h2{font-size:16px}
input,textarea{box-sizing:border-box;width:100%;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);padding:8px;font:inherit}
textarea{display:block;field-sizing:content;min-height:3em;resize:vertical}article{margin:8px 0}section{margin:18px 0}small{color:var(--vscode-descriptionForeground)}button{margin:4px}
</style></head><body><header><h1>Course Notes</h1><p>Private notes from this course sync automatically on this computer.</p>
<input id="search" type="search" aria-label="Search course notes" placeholder="Search notes and chapters"><p id="status" role="status">Loading notes…</p>
<button id="reload" hidden>Retry loading notes</button></header><main id="notes"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  dispose() {for (const {panel} of this.panels.values()) panel.dispose(); this.panels.clear();}
}
