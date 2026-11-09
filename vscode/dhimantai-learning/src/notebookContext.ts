import type { NotebookCell } from './tutorNotebook';
import type { CodeSnapshot, observedRun } from './roomCode';

export interface SharedNotebookCell {
  id: string; kind: 'code' | 'board' | 'message' | 'diagram' | 'recap' | 'voice';
  text: string; language?: string; stdin?: string;
  run?: {success:boolean; output:string; stderr:string; incomplete:boolean};
  truncated: boolean;
}
export interface SharedNotebookContext {cells: SharedNotebookCell[]; truncated: boolean}
type Context = {snapshot: CodeSnapshot; run?: ReturnType<typeof observedRun>};

/** Only public, active-notebook material. Never include private notes, drafts or input files. */
export function notebookContext(cells: NotebookCell[], code: Context[], selected?: string): SharedNotebookContext {
  const entries: SharedNotebookCell[] = [
    ...[...code].sort((a,b) => Number(b.snapshot.snippet === selected) - Number(a.snapshot.snippet === selected)).map(({snapshot:s,run}) => ({
      id:s.snippet, kind:'code' as const, language:s.language, text:s.source.slice(0,2400), stdin:s.stdin.slice(0,600),
      ...(run ? {run:{success:run.success,output:run.output.slice(0,1000),stderr:run.stderr.slice(0,400),
        incomplete:run.incomplete || run.output.length>1000 || run.stderr.length>400}} : {}),
      truncated:s.source.length>2400 || s.stdin.length>600,
    })),
    ...cells.filter(c => c.kind !== 'note' && c.kind !== 'code').slice().reverse().map(c => ({
      id:c.id,kind:c.kind as SharedNotebookCell['kind'],text:c.text.slice(0,1500),truncated:c.text.length>1500,
    })),
  ];
  const result: SharedNotebookContext = {cells:[],truncated:false};
  for (const cell of entries) {
    result.cells.push(cell);
    if (result.cells.length > 24 || new TextEncoder().encode(JSON.stringify(result)).length > 9000) {
      result.cells.pop(); result.truncated = true;
    }
    if (cell.truncated) result.truncated = true;
  }
  return result;
}

/** Host-side validation: a webview cannot add private/unknown cell kinds or an unbounded payload. */
export function sharedNotebookContext(value: unknown): SharedNotebookContext | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as SharedNotebookContext;
  if (!Array.isArray(v.cells) || v.cells.length>24 || typeof v.truncated!=='boolean'
      || new TextEncoder().encode(JSON.stringify(v)).length>10000) return;
  if (v.cells.some(c => !c || typeof c.id!=='string' || !/^[\w-]{1,100}$/.test(c.id)
      || !['code','board','message','diagram','recap','voice'].includes(c.kind) || typeof c.text!=='string' || c.text.length>3000
      || typeof c.truncated!=='boolean' || (c.stdin!==undefined && (typeof c.stdin!=='string' || c.stdin.length>600))
      || (c.language!==undefined && (typeof c.language!=='string' || c.language.length>32))
      || (c.run!==undefined && (!c.run || typeof c.run.success!=='boolean' || typeof c.run.output!=='string' || c.run.output.length>1000
        || typeof c.run.stderr!=='string' || c.run.stderr.length>400 || typeof c.run.incomplete!=='boolean')))) return;
  return {cells:v.cells.map(c => ({id:c.id,kind:c.kind,text:c.text,truncated:c.truncated,
    ...(c.language!==undefined?{language:c.language}:{}),...(c.stdin!==undefined?{stdin:c.stdin}:{}),
    ...(c.run?{run:{success:c.run.success,output:c.run.output,stderr:c.run.stderr,incomplete:c.run.incomplete}}:{})})),truncated:v.truncated};
}
