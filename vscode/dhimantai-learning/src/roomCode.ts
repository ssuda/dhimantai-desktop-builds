import type { Api, Execution } from './api';
export type { Execution } from './api';

export const codeLanguages: Record<string, string> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', c: 'C',
  java: 'Java', go: 'Go', rust: 'Rust',
};
/** Languages only the notebook editor supports; the earlier Practice panel has no SQL editor or runner. */
export const notebookOnlyLanguages: Record<string, string> = {sql: 'SQL (PostgreSQL)', pglab: 'PostgreSQL lab (bash)', bash:'Bash', zsh:'Zsh'};
export const cellLanguages = {...codeLanguages, ...notebookOnlyLanguages};
export const cellLanguage = (label:string) => codeLanguage(label,true);
export function codeLanguage(label: string, notebook = false): string | undefined {
  const aliases: Record<string, string> = {py: 'python', python3: 'python', js: 'javascript', ts: 'typescript', golang: 'go', rs: 'rust', postgresql: 'sql', postgres: 'sql', sh:'bash', shell:'bash', shellscript:'bash'};
  const value = label.trim().toLowerCase().split(/\s/)[0];
  const language = aliases[value] ?? value;
  return Object.hasOwn(codeLanguages, language) || (notebook && Object.hasOwn(notebookOnlyLanguages, language)) ? language : undefined;
}
export interface CodeSnapshot {
  snippet: string; revision: number; language: string; source: string; stdin: string; question: string;
  argv?:string[]; files?:{name:string;content:string}[]; interactive?:boolean;
}
export interface CodeAction extends CodeSnapshot {
  type: 'codeAction'; attempt: number; request: number;
  action: 'run' | 'check' | 'coach' | 'observe'; message: string; prediction?: string;
}
export type CodeFeedback = Awaited<ReturnType<Api['notebookCoach']>>;
export interface CodeResult {
  type: 'codeResult'; attempt: number; snippet: string; revision: number; request: number;
  execution?: Execution; feedback?: CodeFeedback; error?: string;
  event?:import('./notebookCells').CellEvent;
}
export function validCellInputs(value:any):boolean {
  return (value.interactive === undefined || typeof value.interactive === 'boolean')
    && (value.argv === undefined || (Array.isArray(value.argv) && value.argv.length <= 32 && value.argv.every((a:unknown)=>typeof a==='string') && value.argv.join('').length<=4000))
    && (value.files === undefined || (Array.isArray(value.files) && value.files.length<=20 && value.files.every((f:any)=> f && typeof f.name==='string' && /^[\w.-]+(?:\/[\w.-]+)*$/.test(f.name) && !f.name.split('/').includes('..') && typeof f.content==='string' && f.content.length<=128000) && value.files.reduce((n:number,f:any)=>n+f.content.length,0)<=1000000));
}
export function validSnapshot(value: any): value is CodeSnapshot {
  return !!value && typeof value.snippet === 'string' && /^code-\d+$/.test(value.snippet)
    && value.snippet.length < 40 && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.language === 'string' && Object.hasOwn(cellLanguages, value.language)
    && typeof value.source === 'string' && value.source.length <= 12000
    && typeof value.stdin === 'string' && value.stdin.length <= 4000
    && validCellInputs(value)
    && typeof value.question === 'string' && !!value.question.trim() && value.question.length <= 6000;
}
export function validCodeAction(value: any): value is CodeAction {
  return validSnapshot(value) && (value as CodeAction).type === 'codeAction'
    && Number.isSafeInteger((value as CodeAction).request) && (value as CodeAction).request > 0
    && Number.isSafeInteger((value as CodeAction).attempt)
    && ['run', 'check', 'coach', 'observe'].includes((value as CodeAction).action)
    && typeof (value as CodeAction).message === 'string' && (value as CodeAction).message.length <= 600
    && ((value as CodeAction).prediction === undefined
      || (typeof (value as CodeAction).prediction === 'string' && (value as CodeAction).prediction!.length <= 600));
}
export function observedRun(run: Execution, prediction = '') {
  return {...(prediction ? {prediction} : {}), success: run.status === 'exited' && run.exit_code === 0, output: run.stdout.slice(0, 4000),
    stderr: run.stderr.slice(0, 1200), incomplete: run.truncated || run.stdout.length > 4000 || run.stderr.length > 1200
      || ['toolchain_missing', 'compile_error', 'compile_timeout', 'timeout'].includes(run.status)};
}

/** Same local Practice runner and notebook Instructor, with temporary, revision-bound evidence. */
export class RoomCodeSession {
  private entries = new Map<string, {snapshot: CodeSnapshot; execution?: Execution; previous?: string; request?: number}>();
  private busy?: {snippet: string; phase: 'run' | 'coach'; abort: AbortController};
  constructor(private readonly deps: {
    current: () => Promise<boolean>;
    run: (snapshot: CodeSnapshot, signal?:AbortSignal, event?:(event:import('./notebookCells').CellEvent)=>void) => Promise<Execution>;
    coach: (body: object, signal: AbortSignal) => Promise<CodeFeedback>;
    aiEnabled: () => boolean;
  }) {}
  matches(snapshot: CodeSnapshot) { const entry = this.entries.get(snapshot.snippet); return !!entry && sameSnapshot(entry.snapshot, snapshot); }
  stop() { this.busy?.abort.abort(); }
  clear() { this.entries.clear(); this.busy?.abort.abort(); this.busy = undefined; }
  change(snapshot: CodeSnapshot) {
    if (!validSnapshot(snapshot)) return;
    const old = this.entries.get(snapshot.snippet);
    if (old && snapshot.revision < old.snapshot.revision) return;
    if (old && sameSnapshot(old.snapshot, snapshot)) return;
    if (this.busy?.snippet === snapshot.snippet) {
      this.busy.abort.abort();
      if(this.busy.phase === 'coach')this.busy = undefined;
    }
    this.entries.set(snapshot.snippet, {snapshot: {...snapshot}});
    if (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!);
  }
  async handle(message: CodeAction, emit: (result: CodeResult) => void) {
    if (!validCodeAction(message)) return;
    const {snippet, revision, language, source, stdin, question, argv, files, interactive} = message;
    const snapshot: CodeSnapshot = {snippet, revision, language, source, stdin, question, argv, files, interactive};
    this.change(snapshot);
    const entry = this.entries.get(message.snippet)!;
    if (!sameSnapshot(entry.snapshot, snapshot)) return;
    const reply = (result: Partial<CodeResult>) => emit({type: 'codeResult', attempt: message.attempt,
      snippet: message.snippet, revision: message.revision, request: message.request, ...result});
    if (this.busy) { reply({error: 'Another snippet is being checked or run. Try again when it finishes.'}); return; }
    entry.request = message.request;
    const current = async () => await this.deps.current()
      && this.entries.get(message.snippet) === entry && entry.request === message.request;
    const operation = {snippet: message.snippet, phase: 'run' as 'run' | 'coach', abort: new AbortController()};
    this.busy = operation;
    try {
      if (!await current()) return;
      if (message.action !== 'run' && !this.deps.aiEnabled()) throw new Error('AI assistance is off. You can still edit and run code.');
      // Check always runs the exact current buffer. A previous output never stands in for a fresh check.
      if (message.action === 'run' || message.action === 'check') {
        if (!message.source.trim()) throw new Error('Write some code before running it.');
        entry.execution = undefined;
        const execution = await this.deps.run(snapshot, operation.abort.signal, event=>{void current().then(ok=>{if(ok)reply({event});});});
        if (!await current()) return;
        entry.execution = execution;
        reply({execution});
      }
      if (message.action !== 'run') {
        operation.phase = 'coach';
        if (!await current() || !this.deps.aiEnabled()) return;
        const execution = entry.execution;
        const feedback = await this.deps.coach({stage: message.action === 'check' ? 'review' : 'guide',
          language: message.language, source: message.source,
          message: message.message || (message.action === 'observe'
            ? 'The learner paused editing or just ran this snippet. Offer one short, useful hint or question about the current work. Do not give the solution or assume they are stuck.'
            : message.action === 'check' ? 'Check this code against the task using this run and input. Explain what is still unchecked; do not award a score or mastery.' : 'Help me reason about this code without giving the solution.'),
          previous: entry.previous ?? '', error: execution?.stderr.slice(0, 1200) ?? '',
          ...(execution ? {observed_run: observedRun(execution, message.prediction?.trim())} : {}),
          // Include input as task context; the shared Instructor schema intentionally accepts no arbitrary fields.
          question: (message.question.slice(0, 1900) + '\n\nStandard input for this snippet:\n' + message.stdin).slice(0, 6000),
        }, operation.abort.signal);
        if (!await current() || !this.deps.aiEnabled()) return;
        if (!feedback || typeof feedback.guidance !== 'string' || !feedback.guidance.trim()
            || typeof feedback.prompt !== 'string') throw new Error('Instructor could not return readable guidance. Try again.');
        entry.previous = (feedback.guidance + '\n' + feedback.prompt).slice(0, 1500);
        reply({feedback});
      }
    } catch (error) {
      if (await current()) reply({error: error instanceof Error ? error.message : 'Could not complete this action. Your edits are still here.'});
    } finally { if (this.busy === operation) this.busy = undefined; }
  }
}

function sameSnapshot(a: CodeSnapshot, b: CodeSnapshot) {
  return a.snippet === b.snippet && a.revision === b.revision && a.language === b.language
    && a.source === b.source && a.stdin === b.stdin && a.question === b.question
    && JSON.stringify(a.argv??[])===JSON.stringify(b.argv??[]) && JSON.stringify(a.files??[])===JSON.stringify(b.files??[]) && !!a.interactive===!!b.interactive;
}
