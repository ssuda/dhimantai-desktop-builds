/**
 * Course data in the learning notebook: the pure parts (no VS Code imports), so the extension, the notebook webview and
 * the tests share them. File parsing and type inference, identifier sanitising, the client-side single-query check,
 * the framing sent with ordinary Instructor turns, the reply parsing, plain-language SQL errors and the evidence Markdown.
 * The real read-only guard is the database role in media/course/data_lab.py; the check here only gives faster feedback.
 */

export const LIMITS = {fileBytes: 50 * 1024 * 1024, rows: 200_000, columns: 200, previewRows: 20, sampleRows: 5, tables: 20,
  history: 4, question: 500, cell: 200, explainRows: 50, copyRows: 20, displayRows: 100};

/**
 * The Instructor turn's own limits (agent/course_projects/notebook_coach.py, Turn): the framing goes in `question`,
 * the learner's words in `message`, the query in `source` and its result in `observed_run`.
 */
export const TURN = {question: 6000, message: 600, history: 8, historyText: 1500, source: 12000, output: 4000, stderr: 1200};

export type ColumnType = 'text' | 'integer' | 'numeric' | 'date' | 'boolean';
export type Cell = string | number | boolean | null;
export interface TableSchema {name: string; row_count: number; columns: {name: string; type: string}[]; sample_rows: unknown[][]}
export interface HistoryTurn {question: string; sql: string}
export interface QueryResult {columns: string[]; rows: Cell[][]; row_count: number; truncated: boolean; milliseconds: number}
export interface DataAnswer {answer: string; evidence: string[]; caveats: string[]; check_question: string}
// ---- CSV ------------------------------------------------------------------------------------------------------------

/** The delimiter used most on the header line, outside quotes: comma, semicolon or tab. */
export function detectDelimiter(text: string): string {
  const counts: [string, number][] = [[',', 0], [';', 0], ['\t', 0]];
  let quoted = false;
  for (const ch of text.slice(0, 64 * 1024)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted) counts.forEach(c => { if (c[0] === ch) c[1]++; });
  }
  const best = counts.reduce((a, b) => b[1] > a[1] ? b : a);
  return best[1] ? best[0] : ',';
}

/** RFC 4180 CSV: quoted fields with doubled quotes, embedded delimiters and line breaks, CRLF or LF, an optional BOM. */
export function parseCsv(text: string, delimiter = detectDelimiter(text), maxRows = LIMITS.rows + 1): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, i = 0, started = false;
  const endRow = () => {
    row.push(field); field = '';
    if (!(row.length === 1 && row[0] === '' && !started)) rows.push(row);
    row = []; started = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; started = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; started = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      if (rows.length >= maxRows) return rows;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; started = true; i++;
  }
  if (quoted) throw new Error('The file ends inside a quoted value. Check that every opening quote (") has a closing quote.');
  if (field !== '' || row.length || started) endRow();
  return rows;
}

// ---- Types and names -------------------------------------------------------------------------------------------------

const INTEGER = /^-?(0|[1-9]\d{0,17})$/;
const DECIMAL = /^-?(0|[1-9]\d{0,17})\.\d{1,12}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const BOOLEAN: Record<string, boolean> = {true: true, false: false, yes: true, no: false};

function validDate(y: number, m: number, d: number) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1000 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Conservative: text unless every non-blank value is clearly one type. Leading zeros (PIN codes, phone numbers), grouped
 * numbers (1,23,456) and ambiguous dates (03/04/2026) stay text. Day-first dates count only when at least one value has a
 * day above 12, so the order is certain.
 */
export function inferType(values: string[]): ColumnType {
  const filled = values.map(v => v.trim()).filter(v => v !== '');
  if (!filled.length) return 'text';
  if (filled.every(v => INTEGER.test(v) && Math.abs(Number(v)) <= Number.MAX_SAFE_INTEGER)) return 'integer';
  if (filled.every(v => INTEGER.test(v) || DECIMAL.test(v))) return 'numeric';
  if (filled.every(v => { const m = ISO_DATE.exec(v); return !!m && validDate(+m[1], +m[2], +m[3]); })) return 'date';
  if (filled.every(v => { const m = DAY_FIRST.exec(v); return !!m && validDate(+m[3], +m[2], +m[1]); })
      && filled.some(v => +DAY_FIRST.exec(v)![1] > 12)) return 'date';
  if (filled.every(v => v.toLowerCase() in BOOLEAN)) return 'boolean';
  return 'text';
}

/** The value as PostgreSQL will read it for the inferred type; blank becomes NULL. */
export function normalizeValue(type: ColumnType, raw: string): string | null {
  const v = raw.trim();
  if (v === '') return null;
  if (type === 'date' && !ISO_DATE.test(v)) { const m = DAY_FIRST.exec(v)!; return iso(+m[3], +m[2], +m[1]); }
  if (type === 'boolean') return BOOLEAN[v.toLowerCase()] ? 'true' : 'false';
  return type === 'text' ? raw : v;
}

const RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast',
  'check', 'collate', 'column', 'constraint', 'create', 'current_catalog', 'current_date', 'current_role', 'current_time',
  'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false',
  'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect', 'into', 'lateral', 'leading',
  'limit', 'localtime', 'localtimestamp', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'placing', 'primary',
  'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'system_user', 'table', 'then', 'to', 'trailing',
  'true', 'union', 'unique', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with',
  // Not reserved by PostgreSQL, but the client-side query check treats them as writes.
  'insert', 'update', 'delete', 'merge', 'drop', 'alter', 'truncate', 'revoke']);

/** A PostgreSQL identifier that never needs quoting: lower-case snake_case, ^[a-z_][a-z0-9_]{0,62}$, not a reserved word. */
export function sanitizeIdentifier(name: string, fallback = 'column'): string {
  let id = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/%/g, ' percent ').replace(/#/g, ' number ').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id) id = fallback;
  if (/^\d/.test(id)) id = (fallback === 'column' ? 'c_' : fallback + '_') + id;
  id = id.slice(0, 63).replace(/_+$/, '');
  if (RESERVED.has(id)) id = id + '_';
  return id;
}

/** Sanitised and unique names, in order: a repeated name gets _2, _3 and so on. */
export function uniqueIdentifiers(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name, i) => {
    const base = sanitizeIdentifier(name, name.trim() ? 'column' : `column_${i + 1}`);
    let id = base, n = 2;
    while (used.has(id)) id = base.slice(0, 63 - String(n).length - 1) + '_' + n++;
    used.add(id);
    return id;
  });
}

/** A dataset name for an import: also the database suffix, so short and plain. */
export const datasetName = (fileName: string) =>
  sanitizeIdentifier(fileName.replace(/\.[^.]+$/, ''), 'data').replace(/_+$/, '').slice(0, 32) || 'data';

export interface ImportPlan {
  table: string; fileName: string; sheet?: string;
  columns: {name: string; original: string; type: ColumnType}[];
  rows: (string | null)[][]; preview: string[][]; total: number; notes: string[];
}

/** Header row plus data rows to a typed table, or a plain-words reason it cannot be imported. */
export function planImport(fileName: string, table: string[][], sheet?: string): ImportPlan {
  const notes: string[] = [];
  const nonBlank = table.filter(r => r.some(v => v.trim() !== ''));
  if (nonBlank.length < 2) throw new Error('The file needs a header row and at least one row of data.');
  if (nonBlank.length - 1 > LIMITS.rows)
    throw new Error(`The file has more than ${LIMITS.rows.toLocaleString('en-IN')} rows. Import a smaller extract, for example one year or one branch.`);
  const header = nonBlank[0];
  const width = Math.max(...nonBlank.map(r => r.length));
  if (width > LIMITS.columns) throw new Error(`The file has ${width} columns; the lab takes up to ${LIMITS.columns}.`);
  const data = nonBlank.slice(1).map(r => r.length === width ? r : [...r, ...Array(width - r.length).fill('')]);
  const ragged = nonBlank.slice(1).filter(r => r.length !== width).length;
  if (ragged) notes.push(`${ragged} row${ragged === 1 ? '' : 's'} had fewer values than the header; the missing values are blank.`);
  const originals = Array.from({length: width}, (_, i) => (header[i] ?? '').trim());
  const names = uniqueIdentifiers(originals);
  const columns = names.map((name, i) => ({name, original: originals[i] || `(column ${i + 1})`, type: inferType(data.map(r => r[i]))}));
  const renamed = columns.filter(c => c.name !== c.original).length;
  if (renamed) notes.push(`${renamed} column name${renamed === 1 ? ' was' : 's were'} changed to plain lower-case names, shown in the preview.`);
  if (columns.some(c => c.type === 'text' && data.some(r => /^-?\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(r[columns.indexOf(c)].trim()))))
    notes.push('Numbers written with commas (like 1,23,456) are kept as text. Remove the commas in your spreadsheet to add them up.');
  if (columns.some((c, i) => c.type === 'text' && data.some(r => /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(r[i].trim()))))
    notes.push('Dates like 03/04/2026 can mean 3 April or 4 March, so they are kept as text unless the day order is certain.');
  return {table: datasetName(fileName), fileName, sheet, columns,
    rows: data.map(r => columns.map((c, i) => normalizeValue(c.type, r[i]))),
    preview: data.slice(0, LIMITS.previewRows), total: data.length, notes};
}

// ---- The query check --------------------------------------------------------------------------------------------------

/** SQL with comments and string/identifier contents blanked out, so keywords and semicolons can be found safely. */
export function codeOnly(sql: string): string {
  let out = '', i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; out += ' '; continue; }
    if (rest.startsWith('/*')) {
      let depth = 0, j = i;
      do {
        if (sql.startsWith('/*', j)) { depth++; j += 2; } else if (sql.startsWith('*/', j)) { depth--; j += 2; } else j++;
      } while (depth > 0 && j < sql.length);
      if (depth > 0) throw new Error('A comment starting with /* is not closed.');
      i = j; out += ' '; continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw new Error('A $-quoted text is not closed.');
      i = end + dollar[0].length; out += "''"; continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      const backslash = ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '');
      for (;;) {
        if (j >= sql.length) throw new Error(ch === "'" ? 'A quoted text is missing its closing quote (\').' : 'A quoted name is missing its closing quote (").');
        if (backslash && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; }
        j++;
      }
      out += ch === "'" ? "''" : '"x"'; i = j + 1; continue;
    }
    out += ch; i++;
  }
  return out;
}

// Words that only appear in statements that change data. The sanitiser never produces them as bare names.
const WRITES = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke)\b/i;

/** One SELECT (or WITH ... SELECT) query. Returns the query without trailing semicolons, or a plain-words reason. */
export function checkQuery(sql: string): {ok: true; sql: string} | {ok: false; reason: string} {
  let code: string;
  try { code = codeOnly(sql); } catch (error) { return {ok: false, reason: (error as Error).message}; }
  const trimmed = code.replace(/[\s;]+$/, '');
  if (!trimmed.trim()) return {ok: false, reason: 'The query is empty.'};
  if (trimmed.includes(';')) return {ok: false, reason: 'Run one query at a time. This text has more than one statement (a semicolon in the middle).'};
  if (!/^\s*\(*\s*(select|with|values|table)\b/i.test(trimmed))
    return {ok: false, reason: 'The lab only runs questions that read data: start with SELECT or WITH.'};
  const write = WRITES.exec(trimmed);
  if (write) return {ok: false, reason: `The lab only reads data, so it does not run queries containing ${write[1].toUpperCase()}.`};
  // Strip only the trailing semicolons and whitespace that sit after the last bit of code.
  let end = sql.length;
  while (end > 0 && /[\s;]/.test(sql[end - 1])) end--;
  return {ok: true, sql: sql.slice(0, end)};
}

// ---- Course data --------------------------------------------------------------------------------------------------------

/** The about card shipped with a sample (media/datalab/about.json), or written for an imported file. */
export interface About {title: string; summary: string; tables?: {name: string; description: string; columns: Record<string, string>}[]; gaps?: string[]; try?: string[]}
/** One dataset in the course's read-only lab database: a preloaded sample or a learner's imported file. */
export interface CourseDataset {id: string; title: string; source: 'sample' | 'import'; about: About; tables: TableSchema[]}

export const PRIVACY_NOTICE = 'Your data stays on this computer. When you ask about it, only your question, the column names, up to 5 example rows per table and up to 50 result rows for the answer are sent to the Coach.';

/** A cell as the server accepts it: short text, a finite number, a boolean or null. */
export function safeCell(value: unknown, max: number = LIMITS.cell): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const words = (text: string) => ' ' + text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const names = (name: string) => {
  const spaced = name.replace(/_/g, ' ');
  return [spaced, ...(spaced.endsWith('s') && spaced.length > 3 ? [spaced.slice(0, -1)] : []),
    ...(/(?:ch|sh|ss|x)es$/.test(spaced) ? [spaced.slice(0, -2)] : [])];
};
/** The dataset's short name a learner would type: "shop", or an import's table name. */
const shortName = (d: CourseDataset) => d.id.split(':').pop()!;

/** Datasets the text names: a sample by its short name ("shop"), an import by its file or table name. */
export function namedDatasets(text: string, datasets: CourseDataset[]): CourseDataset[] {
  const w = words(text);
  return datasets.filter(d => [shortName(d), ...(d.source === 'import' ? [d.about.title.replace(/\.[^.]+$/, '')] : [])]
    .some(n => n && w.includes(words(n))));
}

/**
 * Whether a composer question goes the data route: it names a dataset, a table or a column of the course data.
 * Deliberately simple; the composer shows which route a question takes, and a reply without a query is a normal reply.
 */
export function isDataQuestion(text: string, datasets: CourseDataset[]): boolean {
  if (!text.trim() || !datasets.length) return false;
  if (namedDatasets(text, datasets).length) return true;
  const w = words(text);
  return datasets.some(d => d.tables.some(t => names(t.name).some(n => w.includes(words(n)))
    || t.columns.some(c => c.name.includes('_') && w.includes(words(c.name.replace(/_id$/, ''))))));
}

/** One dataset as plain text: what it is, its known gaps, and each table with columns, row count and example rows. */
function structure(d: CourseDataset, examples: number, gaps: boolean, tables = d.tables.length) {
  const lines = [`Dataset ${shortName(d)}: ${d.title}${d.about.summary ? '. ' + d.about.summary.slice(0, 300) : ''}`];
  if (gaps && d.about.gaps?.length) lines.push('What this data cannot tell: ' + d.about.gaps.join(' ').slice(0, 500));
  for (const t of d.tables.filter(t => IDENTIFIER.test(t.name)).slice(0, Math.min(tables, LIMITS.tables))) {
    const meaning = d.about.tables?.find(a => a.name === t.name)?.description;
    lines.push(`Table ${t.name} (${t.row_count} rows)${meaning ? ' — ' + meaning.slice(0, 160) : ''}: `
      + t.columns.filter(c => IDENTIFIER.test(c.name)).map(c => `${c.name} ${String(c.type).slice(0, 30)}`).join(', '));
    for (const row of t.sample_rows.slice(0, Math.min(examples, LIMITS.sampleRows)))
      lines.push('  example: ' + JSON.stringify((row as unknown[]).map(v => safeCell(v, 60))));
  }
  return lines.join('\n');
}

export const ASK_FRAMING = 'COURSE DATA QUESTION. The learner is not a programmer and never writes SQL. They asked the question in learner_message '
  + 'about the course data described below, which sits in a read-only PostgreSQL database on their computer. As their Coach:\n'
  + '1. Start with "Steps:" and the plain-language steps you will take, naming the tables you use.\n'
  + '2. Then write exactly one read-only PostgreSQL query (one SELECT, or WITH … SELECT) in a ```sql block, using only the tables and columns below.\n'
  + '3. If the data cannot answer the question, say "The data cannot answer this", say what data would be needed, and write no query.\n'
  + 'The extension runs the query read-only and shows the learner the result; up to 50 result rows come back to you for the answer.';

/**
 * The framing for the first turn, within the turn's 6,000-character question field. When the text is too long, example rows
 * are trimmed first (5 down to 0), then the known gaps, then whole tables from the end. `complete` says no table was dropped.
 */
export function askFraming(datasets: CourseDataset[], extra = ''): {text: string; complete: boolean; examples: number} {
  const build = (examples: number, gaps: boolean, tables = Infinity) =>
    [ASK_FRAMING, ...(extra ? [extra] : []), ...datasets.map(d => structure(d, examples, gaps, tables))].join('\n\n');
  for (const gaps of [true, false]) for (let examples = LIMITS.sampleRows; examples >= 0; examples--) {
    const text = build(examples, gaps);
    if (text.length <= TURN.question) return {text, complete: true, examples};
  }
  for (let tables = Math.max(...datasets.map(d => d.tables.length), 1) - 1; tables >= 1; tables--) {
    const text = build(0, false, tables);
    if (text.length <= TURN.question) return {text, complete: false, examples: 0};
  }
  return {text: build(0, false, 1).slice(0, TURN.question), complete: false, examples: 0};
}

/**
 * Which datasets go with a question: those the question names; otherwise those the notebook names (its title or lesson);
 * otherwise all of them if they fit the turn with every table; otherwise the notebook's last-used dataset.
 */
export function chooseDatasets(question: string, notebookText: string, datasets: CourseDataset[], last?: string): CourseDataset[] {
  const named = namedDatasets(question, datasets);
  if (named.length) return named;
  const context = namedDatasets(notebookText, datasets);
  if (context.length) return context;
  if (askFraming(datasets).complete && askFraming(datasets).examples >= 1) return datasets;
  return [datasets.find(d => d.id === last) ?? datasets[0]].filter(Boolean);
}

/** Which dataset a query reads: the only one sent, or the one whose table names it uses most. */
export function datasetForQuery(sql: string, datasets: CourseDataset[]): CourseDataset | undefined {
  if (datasets.length <= 1) return datasets[0];
  let code: string;
  try { code = words(codeOnly(sql)); } catch { return datasets[0]; }
  const score = (d: CourseDataset) => d.tables.filter(t => code.includes(' ' + t.name.replace(/_/g, ' ') + ' ')).length;
  return [...datasets].sort((a, b) => score(b) - score(a))[0];
}

/** The last question/query pairs as the turn's conversation history (8 items of at most 1,500 characters). */
export function dataHistory(turns: HistoryTurn[]) {
  return turns.slice(-LIMITS.history).flatMap(t => [{role: 'learner' as const, text: t.question.slice(0, TURN.historyText)},
    {role: 'tutor' as const, text: ('Query I used:\n' + t.sql).slice(0, TURN.historyText)}]).slice(-TURN.history);
}

/** The first ```sql block of a reply (or an unlabelled block, or an inline `SELECT …`), and the reply text around it. */
export function extractSql(reply: string): {sql?: string; text: string; cannotAnswer: boolean} {
  const cannotAnswer = /the data cannot answer this/i.test(reply);
  const fences = /```[ \t]*([A-Za-z]*)[^\n]*\n([\s\S]*?)```/g;
  for (const m of reply.matchAll(fences)) {
    const language = m[1].toLowerCase(), body = m[2].trim();
    if (['sql', 'postgres', 'postgresql', 'psql', 'pgsql'].includes(language) || (!language && /^\(*\s*(select|with)\b/i.test(body))) {
      if (!body) continue;
      return {sql: body.slice(0, TURN.source), text: (reply.slice(0, m.index) + reply.slice(m.index! + m[0].length)).trim(), cannotAnswer: false};
    }
  }
  const inline = /`((?:select|with)\b[^`]{6,})`/i.exec(reply);
  if (inline && !cannotAnswer) return {sql: inline[1].trim(), text: reply.replace(inline[0], '').trim(), cannotAnswer: false};
  return {text: reply.trim(), cannotAnswer};
}

/** The query's result for the second turn: column names, up to 50 rows, the true count, within the run's 4,000 characters. */
export function resultOutput(result: Pick<QueryResult, 'columns' | 'rows' | 'row_count' | 'truncated'>): {output: string; shown: number; incomplete: boolean} {
  const line = (r: Cell[]) => r.map(v => v === null ? 'NULL' : String(safeCell(v, 80)).replace(/[\t\r\n]+/g, ' ')).join(' | ');
  let shown = Math.min(result.rows.length, LIMITS.explainRows);
  for (;;) {
    const incomplete = result.truncated || result.row_count > shown;
    const output = [`Columns: ${result.columns.join(' | ')}`,
      `Rows: ${result.row_count}${incomplete ? ` (showing the first ${shown})` : ''}`, ...result.rows.slice(0, shown).map(line)].join('\n');
    if (output.length <= TURN.output || shown === 0) return {output: output.slice(0, TURN.output), shown, incomplete};
    shown = Math.floor(shown * 0.8);
  }
}

export const EXPLAIN_FRAMING = 'COURSE DATA ANSWER. The learner (not a programmer) asked the question in learner_message about the course data. '
  + 'The query in selected_cell_lines ran read-only on their computer; observed_run.output holds its result: the column names, '
  + 'up to 50 rows, the true row count and whether rows were left out. Answer in plain words using only those numbers. Write:\n'
  + 'Answer: one or two sentences.\nEvidence: the result rows you used, quoted.\nCaveats: what the data or the query leaves out.\n'
  + 'Put one short "check it yourself" question, which the learner can check by hand in the rows, as your prompt.';

/** The guidance and prompt of the second turn as answer, evidence rows, caveats and the check question. */
export function parseAnswer(guidance: string, prompt = ''): DataAnswer {
  const sections: Record<string, string> = {};
  let key = 'answer';
  for (const raw of guidance.split('\n')) {
    const m = /^\s*(?:[#*_]+\s*)?(answer|evidence|caveats?|check it yourself)\s*[:*_]*\s*:?\s*[*_]*\s*(.*)$/i.exec(raw);
    if (m) { key = m[1].toLowerCase().replace(/^caveat$/, 'caveats'); sections[key] = (sections[key] ?? '') + (m[2] ? m[2] + '\n' : ''); }
    else sections[key] = (sections[key] ?? '') + raw + '\n';
  }
  const items = (text = '') => text.split('\n').map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 8);
  return {answer: (sections.answer ?? '').trim() || guidance.trim(), evidence: items(sections.evidence), caveats: items(sections.caveats),
    check_question: (prompt.trim() || (sections['check it yourself'] ?? '').trim()).slice(0, 800)};
}

/** What the notebook says for a failed Coach request: access ended and the allowance get their own notices. */
export function requestNotice(status: number, message: string): {kind: 'access' | 'quota' | 'error'; text: string} {
  if (status === 403 || status === 402)
    return {kind: 'access', text: 'Access ended · Buy again. Your course access has ended, so the Coach cannot answer questions about the data. Your data and earlier answers stay on this computer.'};
  if (status === 429)
    return {kind: 'quota', text: 'You have used today\'s Coach questions. The allowance resets tomorrow; your data and earlier answers stay here.'};
  if (status === 503) return {kind: 'error', text: 'The Coach could not reply right now. Wait a minute and ask again.'};
  return {kind: 'error', text: message || 'The request failed. Try again.'};
}

// ---- The data turn ---------------------------------------------------------------------------------------------------

export interface CoachReply {guidance: string; prompt: string}
export interface LabReply extends QueryResult {error?: string; hint?: string}
export interface DataTurnDeps {
  /** One ordinary Instructor turn; its errors (ApiError 403/429…) propagate. */
  coach(body: Record<string, unknown>): Promise<CoachReply>;
  /** The query, run read-only in the course container. */
  run(dataset: CourseDataset, sql: string): Promise<LabReply>;
}
export type DataOutcome =
  | {kind: 'reply'; content: string}
  | {kind: 'cannot'; text: string}
  | {kind: 'answer'; dataset: string; steps: string; sql: string; result: QueryResult; answer: DataAnswer; retried: boolean}
  | {kind: 'sqlError'; dataset: string; steps: string; sql: string; plain: string; raw: string};

const content = (r: CoachReply) => [r.guidance, r.prompt].filter(s => s && s.trim()).join('\n\n');

/**
 * The data route, made of ordinary Instructor turns: the question with the table structure; the query run read-only here;
 * one retry with the error if it fails; then the result for a plain-words answer. A reply without a query is a normal reply.
 */
export async function askCourseData(deps: DataTurnDeps, input: {question: string; datasets: CourseDataset[]; history: HistoryTurn[]}): Promise<DataOutcome> {
  const question = input.question.trim().slice(0, LIMITS.question);
  const base = {stage: 'data', language: 'sql', message: question, previous: ''};
  let history = dataHistory(input.history);
  let reply = await deps.coach({...base, question: askFraming(input.datasets).text, source: '', history});
  let found = extractSql(content(reply));
  let retried = false;
  for (;;) {
    if (!found.sql) return found.cannotAnswer ? {kind: 'cannot', text: found.text} : {kind: 'reply', content: found.text};
    const dataset = datasetForQuery(found.sql, input.datasets)!;
    const check = checkQuery(found.sql);
    const ran = check.ok ? await deps.run(dataset, check.sql) : undefined;
    const raw = !check.ok ? 'Checked on this computer before running: ' + check.reason
      : ran!.error ? ran!.error + (ran!.hint ? '\nHint: ' + ran!.hint : '') : '';
    const sql = check.ok ? check.sql : found.sql;
    if (!raw) {
      const result: QueryResult = {columns: ran!.columns, rows: ran!.rows, row_count: ran!.row_count, truncated: ran!.truncated, milliseconds: ran!.milliseconds};
      const out = resultOutput(result);
      const explained = await deps.coach({...base, question: (EXPLAIN_FRAMING + '\n\nThe question: ' + question).slice(0, TURN.question),
        source: sql, history, observed_run: {success: true, output: out.output, stderr: '', incomplete: out.incomplete}});
      return {kind: 'answer', dataset: dataset.id, steps: found.text, sql, result, answer: parseAnswer(explained.guidance, explained.prompt), retried};
    }
    if (retried) return {kind: 'sqlError', dataset: dataset.id, steps: found.text, sql, plain: check.ok ? plainSqlError(ran!.error!) : check.reason, raw};
    retried = true;
    history = dataHistory([...input.history, {question, sql}]);
    reply = await deps.coach({...base, question: askFraming(input.datasets,
      'Your last query (in selected_cell_lines) failed; observed_run.stderr has the error. Send one corrected query in a ```sql block.').text,
      source: sql, history, observed_run: {success: false, output: '', stderr: raw.slice(0, TURN.stderr), incomplete: false}});
    found = extractSql(content(reply));
  }
}

// ---- Plain-language errors and evidence ------------------------------------------------------------------------------

/** A PostgreSQL error in plain words. */
export function plainSqlError(message: string): string {
  const m = (re: RegExp) => re.exec(message);
  let x;
  if ((x = m(/syntax error at or near "(insert|update|delete|drop|alter|create|truncate|copy|set|grant|merge|call)"/i)))
    return `This lab only reads data. The query tried to change something (${x[1].toUpperCase()}), so PostgreSQL refused it.`;
  if (m(/read-only transaction|permission denied/i)) return 'This lab only reads data. The query tried to do something a reader may not do, so PostgreSQL refused it.';
  if (m(/multiple commands/i)) return 'Run one query at a time. This text has more than one statement.';
  if (m(/data-modifying statements/i)) return 'This lab only reads data. The query contains a step that would change rows.';
  if (m(/statement timeout|canceling statement/i)) return 'The query took longer than 5 seconds and was stopped. Ask for a smaller result, for example one month or one branch.';
  if ((x = m(/column "([^"]+)" does not exist/i))) return `The query uses a column called "${x[1]}", which this data does not have.`;
  if ((x = m(/relation "([^"]+)" does not exist/i))) return `The query uses a table called "${x[1]}", which this data does not have.`;
  if ((x = m(/column reference "([^"]+)" is ambiguous/i))) return `The column "${x[1]}" is in more than one of the joined tables, so PostgreSQL does not know which one to use.`;
  if ((x = m(/must appear in the GROUP BY clause/i))) return 'The query mixes totals with single rows: every column shown must either be grouped or be added up (sum, count, avg).';
  if (m(/division by zero/i)) return 'The query divided by zero somewhere. Some group probably has no rows or a zero total.';
  if ((x = m(/invalid input syntax for type (\w+)/i))) return `A value could not be read as ${x[1]}. Check that the column holds the kind of value the query expects.`;
  if (m(/operator does not exist/i)) return 'The query compares or combines values of different kinds (for example text with a number).';
  if (m(/syntax error/i)) return 'The query is not valid SQL.';
  return 'PostgreSQL could not run the query.';
}

const mdCell = (v: Cell) => (v === null ? '' : String(v)).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** A Markdown table of up to `limit` rows with the true row count. */
export function markdownTable(result: Pick<QueryResult, 'columns' | 'rows' | 'row_count'>, limit = LIMITS.copyRows): string {
  if (!result.columns.length) return '_No columns._';
  const lines = ['| ' + result.columns.map(c => mdCell(c)).join(' | ') + ' |', '|' + result.columns.map(() => ' --- |').join(''),
    ...result.rows.slice(0, limit).map(r => '| ' + r.map(mdCell).join(' | ') + ' |')];
  const shown = Math.min(limit, result.rows.length);
  lines.push('', result.row_count > shown ? `_Showing ${shown} of ${result.row_count} rows._` : `_${result.row_count} row${result.row_count === 1 ? '' : 's'}._`);
  return lines.join('\n');
}

export interface Evidence {dataset: string; question: string; steps: string; sql: string; result?: QueryResult; answer?: DataAnswer}

/** Question, steps, SQL, result table (up to 20 rows) and answer as Markdown, ready to paste into a Written Practice task. */
export function evidenceMarkdown(e: Evidence): string {
  const fence = e.sql.includes('```') ? '~~~' : '```';
  const parts = [`### Question\n${e.question}`, `Dataset: ${e.dataset}`];
  if (e.steps) parts.push(`### The Coach's steps\n${e.steps}`);
  if (e.sql) parts.push(`### How I got this\n${fence}sql\n${e.sql}\n${fence}`);
  if (e.result) parts.push(`### Result (${e.result.row_count} row${e.result.row_count === 1 ? '' : 's'})\n` + markdownTable(e.result));
  if (e.answer?.answer) parts.push(`### Answer\n${e.answer.answer}`);
  if (e.answer?.evidence.length) parts.push('### Evidence\n' + e.answer.evidence.map(s => `- ${s}`).join('\n'));
  if (e.answer?.caveats.length) parts.push('### Caveats\n' + e.answer.caveats.map(s => `- ${s}`).join('\n'));
  if (e.answer?.check_question) parts.push(`### Check it yourself\n${e.answer.check_question}`);
  return parts.join('\n\n') + '\n';
}

/**
 * Which result rows an evidence sentence cites: a row matches when the sentence names one of its text values, or its
 * first column value with any other value from the row. Highlighting is a reading aid; the learner checks the rows.
 */
export function evidenceRows(result: Pick<QueryResult, 'rows'>, evidence: string[]): number[] {
  const text = evidence.join('\n').toLowerCase();
  const plain = (v: Cell) => v === null ? '' : String(v).toLowerCase();
  const mentioned = (v: Cell) => {
    const s = plain(v);
    if (s.length < 2) return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const variants = [s, s.replace(/\.0+$/, ''), Number(s).toLocaleString('en-IN'), Number(s).toLocaleString('en-US')];
      return variants.some(n => n.length >= 2 && new RegExp(`(^|[^\\d.,])${n.replace(/[.,]/g, m => '\\' + m)}([^\\d]|$)`).test(text));
    }
    return text.includes(s);
  };
  const out: number[] = [];
  result.rows.forEach((row, i) => {
    const texts = row.filter(v => typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v));
    if (texts.some(mentioned) || (row.length > 1 && mentioned(row[0]) && row.slice(1).some(mentioned))) out.push(i);
  });
  return out.slice(0, 50);
}

/** The about cards and the privacy note as one Markdown info cell. */
export function aboutMarkdown(datasets: CourseDataset[]): string {
  const parts = ['## Course data', `Course data ready: ${datasets.map(shortName).join(', ')}. Ask the Coach about it in plain words; `
    + 'mention the dataset ("shop", "school", "clinic") or what you want to know, for example a table such as sales or attendance.', `_${PRIVACY_NOTICE}_`];
  for (const d of datasets) {
    const lines = [`### ${d.about.title || d.title}`, d.about.summary];
    if (d.about.tables?.length) lines.push(d.about.tables.map(t => `- **${t.name}**: ${t.description}`).join('\n'));
    if (d.about.gaps?.length) lines.push('**What this data cannot tell you:** ' + d.about.gaps.join(' '));
    if (d.about.try?.length) lines.push('**Questions to try:** ' + d.about.try.map(q => `“${q}”`).join(' · '));
    parts.push(lines.filter(Boolean).join('\n\n'));
  }
  return parts.join('\n\n');
}
