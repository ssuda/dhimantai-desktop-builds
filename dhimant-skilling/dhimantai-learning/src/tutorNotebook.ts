import { savedTerminalProgram, terminalPrograms } from './notebookTerminal';
import {cellLanguage, cellLanguages, validCellInputs} from './roomCode';
import { validSkillDraft } from './skillPractice';
import type { SkillDraft } from './skillPractice';
import { executionFollowup, validExecutionIssues } from './lessonExecution';
import type { ExecutionIssue } from './lessonExecution';

export const NOTEBOOK_CELL_LIMIT = 1000;

/** Local learning document. Runtime observations and assessment authority are never restored. */
export interface NotebookCell {
  id: string;
  kind: 'board' | 'message' | 'note' | 'code' | 'terminal' | 'diagram' | 'recap' | 'voice';
  text: string;
  collapsed?: boolean;
  packet?: Record<string, unknown>;
}
export interface NotebookDraft {
  key: string; snippet: string; language: string; source: string; stdin: string;
  prediction: string; explanation: string; helped: boolean;
  argv?:string[]; files?:{name:string;content:string}[]; interactive?:boolean;
  commandHistory?: string[];
  promptSubmitted?: true;
  skills?: SkillDraft;
}
export interface ChapterEdition { revision:string; attempt:string }
export function validChapterEdition(value:unknown): value is ChapterEdition {
  const edition = value as ChapterEdition | undefined;
  return typeof edition?.revision === 'string' && /^\d{1,20}$/.test(edition.revision)
    && typeof edition.attempt === 'string' && (edition.attempt === '' || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(edition.attempt));
}

export interface TutorNotebook {
  version: 1;
  title: string;
  exerciseId?: string;
  lessonId?: string;
  chapterEdition?: ChapterEdition;
  doubtId?: string;
  doubtCourse?: string;
  doubtMode?: 'adaptive' | 'guided' | 'direct';
  teachingStyle?: 'beginner' | 'practitioner' | 'expert';
  textDraft?: string;
  attemptDraft?: string;
  /** Course data this notebook asked about last ("sample:shop", "import:sales"), so a vague question uses it. */
  dataset?: string;
  /** The learner's imported files this notebook uses, beside the course's preloaded samples. */
  dataImports?: string[];
  cells: NotebookCell[];
  drafts: NotebookDraft[];
  /** Historical local follow-up only; never used as execution or mastery evidence. */
  executionIssues?: ExecutionIssue[];
  xpAwards?: Array<{award_id?: string; amount: number}>;
}
export const emptyNotebook = (): TutorNotebook => ({version: 1, title: 'Instructor notebook', cells: [], drafts: []});
export const NOTEBOOK_LIMIT = 4 * 1024 * 1024;
export const NOTEBOOK_FILE_LIMIT = 12 * 1024 * 1024;
export const NOTEBOOK_FORMAT_HELP = 'Jupyter notebooks (.ipynb), up to 12 MiB. Open a saved Instructor notebook or a standard Jupyter 4 notebook.';
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function readNotebook(value: unknown): TutorNotebook {
  const n = value as TutorNotebook;
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('The saved Instructor notebook data is missing or corrupted.');
  if (n.version !== 1) throw new Error('This Instructor notebook version is not supported. Update the extension or open it in Jupyter.');
  if (JSON.stringify(n).length > NOTEBOOK_LIMIT) throw new Error('The Instructor notebook content exceeds 4 million characters. Save a smaller notebook.');
  if (!text(n.title, 300) || (n.exerciseId !== undefined && !text(n.exerciseId, 100)) || (n.lessonId !== undefined && !text(n.lessonId, 100)) || (n.textDraft !== undefined && !text(n.textDraft, 4000)) || !Array.isArray(n.cells)
      || !Array.isArray(n.drafts)) throw new Error('The saved Instructor notebook has invalid document fields.');
  if (n.chapterEdition !== undefined && !validChapterEdition(n.chapterEdition)) throw new Error('Invalid chapter edition.');
  if (n.doubtMode !== undefined && !['adaptive','guided','direct'].includes(n.doubtMode)) throw new Error('Invalid Doubt Solver learning mode.');
  if (n.attemptDraft !== undefined && !text(n.attemptDraft,1500)) throw new Error('The saved attempt note is too large.');
  if ((n.doubtId !== undefined && !/^[0-9a-f-]{36}$/i.test(n.doubtId)) ||
      (n.doubtCourse !== undefined && !text(n.doubtCourse, 300))) throw new Error('Invalid saved chat identity.');
  const dataId = /^(?:sample|import):[a-z][a-z0-9_]{0,31}$/;
  if ((n.dataset !== undefined && (typeof n.dataset !== 'string' || !dataId.test(n.dataset)))
      || (n.dataImports !== undefined && (!Array.isArray(n.dataImports) || n.dataImports.length > 10
        || !n.dataImports.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(name)))))
    throw new Error('The saved Instructor notebook has invalid course data fields.');
  if (n.cells.length > NOTEBOOK_CELL_LIMIT || n.drafts.length > 1000) throw new Error('This notebook exceeds the limit of 1,000 cells or code drafts.');
  if (n.executionIssues !== undefined && !validExecutionIssues(n.executionIssues))
    throw new Error('This notebook contains invalid coding follow-up notes.');
  if (n.xpAwards !== undefined && (!Array.isArray(n.xpAwards) || n.xpAwards.length > 200
      || !n.xpAwards.every(item => item && typeof item === 'object' && !Array.isArray(item)
        && Number.isSafeInteger(item.amount) && item.amount > 0 && item.amount <= 50
        && (item.award_id === undefined || text(item.award_id, 100)))))
    throw new Error('This notebook contains invalid XP award records.');
  const ids = new Set<string>();
  for (const cell of n.cells) {
    if (!cell || !text(cell.id, 100) || !/^[\w-]+$/.test(cell.id) || ids.has(cell.id)
        || !['board', 'message', 'note', 'code', 'terminal', 'diagram', 'recap', 'voice'].includes(cell.kind)
        || !text(cell.text, 100000) || (cell.collapsed !== undefined && typeof cell.collapsed !== 'boolean')
        || (cell.packet !== undefined && (!cell.packet || typeof cell.packet !== 'object' || Array.isArray(cell.packet))))
      throw new Error('This Instructor notebook contains an invalid cell.');
    ids.add(cell.id);
  }
  const keys = new Set<string>();
  for (const draft of n.drafts) {
    if (!draft || !text(draft.key, 200) || keys.has(draft.key) || !/^code-\d{1,9}$/.test(draft.snippet)
        || !Object.hasOwn(cellLanguages,draft.language) || !validCellInputs(draft)
        || !text(draft.source, 12000) || !text(draft.stdin, 4000) || !text(draft.prediction, 600)
        || !text(draft.explanation, 600) || typeof draft.helped !== 'boolean'
        || (draft.promptSubmitted !== undefined && draft.promptSubmitted !== true)
        || (draft.commandHistory !== undefined && (!Array.isArray(draft.commandHistory) || draft.commandHistory.length > 30
          || !draft.commandHistory.every(command => text(command,12000)) || draft.commandHistory.join('\n').length > 24000))
        || (draft.skills !== undefined && !validSkillDraft(draft.skills)))
      throw new Error('This Instructor notebook contains an invalid draft.');
    keys.add(draft.key);
  }
  const notebook = JSON.parse(JSON.stringify(n)) as TutorNotebook;
  for (const cell of notebook.cells)
    if (cell.kind === 'terminal' && cell.packet?.language === 'bash' && !cell.packet.terminalTypeSelected) cell.packet.language = 'zsh';
  return notebook;
}

/** Import text/code only. Jupyter output and execution counts never become run evidence. */
export function importNotebook(content: Uint8Array, title = 'Imported notebook'): TutorNotebook {
  if (content.byteLength > NOTEBOOK_FILE_LIMIT) throw new Error('This notebook exceeds the 12 MiB file limit. Save a smaller .ipynb file.');
  let file: any;
  try { file = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(content).replace(/^\uFEFF/, '')); }
  catch { throw new Error('This notebook is corrupted or is not valid UTF-8 JSON. Re-save it as a Jupyter .ipynb file.'); }
  if (!file || file.nbformat !== 4 || !Array.isArray(file.cells))
    throw new Error('Unsupported notebook format. Choose a Jupyter 4 notebook (.ipynb).');
  if (file.metadata?.dhimantai_tutor_notebook !== undefined) return readNotebook(file.metadata.dhimantai_tutor_notebook);
  if (file.cells.length > 1000) throw new Error('This notebook exceeds the limit of 1,000 cells.');
  const book = emptyNotebook(); book.title = title.slice(0,300);
  const aliases: Record<string,string> = {py:'python', python3:'python', js:'javascript', ts:'typescript'};
  for (const [index, cell] of file.cells.entries()) {
    const source = typeof cell?.source === 'string' ? cell.source : Array.isArray(cell?.source) && cell.source.every((s: unknown) => typeof s === 'string') ? cell.source.join('') : undefined;
    if (source === undefined || !['code','markdown','raw'].includes(cell?.cell_type)) throw new Error(`Cell ${index + 1} is corrupted or has an unsupported cell type.`);
    const id = 'import-' + index;
    if (cell.cell_type === 'code') {
      const original = cell.metadata?.dhimantai?.language ?? cell.metadata?.vscode?.languageId ?? file.metadata?.language_info?.name ?? file.metadata?.kernelspec?.language ?? 'python';
      const language = cellLanguage(aliases[original] ?? original);
      if (!language) throw new Error(`Cell ${index + 1} uses an unsupported language. Supported: Python, JavaScript, TypeScript, C, Java, Go, Rust, SQL, Bash and Zsh.`);
      if (source.length > 12000) throw new Error(`Code cell ${index + 1} exceeds 12,000 characters. Split it into smaller cells in Jupyter.`);
      book.cells.push({id,kind:'code',text:'',packet:{language}});
      // External source has no verified assistance history; it cannot become independent evidence.
      book.drafts.push({key:id + ':0',snippet:'code-' + (index + 1),language,source,stdin:'',prediction:'',explanation:'',helped:true});
    } else {
      if (source.length > 100000) throw new Error(`Text cell ${index + 1} exceeds 100,000 characters. Split it into smaller cells in Jupyter.`);
      book.cells.push({id,kind:cell.cell_type === 'raw' ? 'note' : 'recap',text:source});
    }
  }
  return readNotebook(book);
}

export function serializeNotebook(notebook: TutorNotebook): string {
  const content = JSON.stringify(exportNotebook(readNotebook(notebook)));
  if (new TextEncoder().encode(content).byteLength > NOTEBOOK_FILE_LIMIT)
    throw new Error('This export exceeds the 12 MiB file limit. Remove unneeded content before saving a copy.');
  return content;
}

/** Ordinary Jupyter cells remain usable outside Instructor; no credentials or live run evidence. */
export function exportNotebook(notebook: TutorNotebook) {
  const cells: object[] = [];
  const code = (draft: NotebookDraft) => cells.push({id: draft.snippet, cell_type: 'code', source: draft.source,
    metadata: {vscode:{languageId:['bash','zsh','pglab'].includes(draft.language)?'shellscript':draft.language}, dhimantai: {author: 'learner', language:draft.language, assisted: draft.helped}}, execution_count: null, outputs: []});
  for (const cell of notebook.cells) {
    if (cell.kind === 'terminal') cells.push({id:cell.id, cell_type:'markdown', source:terminalPrograms[savedTerminalProgram(cell.packet?.language)].label + ' terminal',
      metadata:{dhimantai:{author:'learner',kind:'terminal'}}});
    else if (cell.kind !== 'code') cells.push({id: cell.id, cell_type: 'markdown', source: cell.text
      + (cell.packet?.session_summary && notebook.executionIssues?.length ? '\n\n' + executionFollowup(notebook.executionIssues) : ''),
      metadata: {dhimantai: {author: ['message', 'note'].includes(cell.kind) ? 'learner' : 'tutor', kind: cell.kind}}});
    for (const draft of notebook.drafts.filter(d => d.key.startsWith(cell.id + ':'))) code(draft);
  }
  // A replayed task's editor belongs to the most recent question card.
  for (const draft of notebook.drafts.filter(d => d.key.startsWith('checkpoint:'))) code(draft);
  if (notebook.textDraft?.trim()) cells.push({id:'text-draft', cell_type:'markdown', source:notebook.textDraft,
    metadata:{dhimantai:{author:'learner',kind:'note'}}});
  const languages = [...new Set(notebook.drafts.map(d => d.language))];
  const language = languages[0] ?? 'python';
  return {nbformat: 4, nbformat_minor: 5, metadata: {
    ...(languages.length <= 1 ? {kernelspec: {name: language === 'python' ? 'python3' : language, display_name: language, language},
      language_info: {name: language}} : {}), dhimantai_tutor_notebook: notebook,
  }, cells};
}
