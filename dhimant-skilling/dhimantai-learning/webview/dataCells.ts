import type { NotebookCell } from '../src/tutorNotebook';
import type { Cell, DataAnswer, DataOutcome } from '../src/dataLab';
import { evidenceMarkdown, evidenceRows, LIMITS, markdownTable } from '../src/dataLab';
import { renderBoard } from './markdown';

/**
 * Course data answers as notebook cells, in the Coach's voice: steps, "How I got this" (the query, collapsed), the result
 * table, the answer with evidence and caveats, then "Check it yourself". Values from the data and from the Coach are
 * always set as text, never as HTML; only the Coach's steps go through the notebook's Markdown renderer, like every reply.
 */
export type DataCell = {kind: NotebookCell['kind']; text: string; packet: Record<string, unknown>};

export function outcomeCells(question: string, outcome: DataOutcome, datasetTitle: (id: string) => string): DataCell[] {
  const group = 'data-' + Date.now().toString(36);
  const cell = (part: string, text: string, packet: Record<string, unknown> = {}): DataCell =>
    ({kind: 'board', text, packet: {data_part: part, data_group: group, ...packet}});
  if (outcome.kind === 'reply') return [cell('reply', outcome.content || 'The Coach returned no reply. Ask again.')];
  if (outcome.kind === 'cannot') return [cell('cannot', outcome.text)];
  const steps = outcome.steps.trim() ? [cell('steps', outcome.steps, {dataset: outcome.dataset})] : [];
  const sql = cell('sql', 'How I got this\n\n```sql\n' + outcome.sql + '\n```', {sql: outcome.sql, question, dataset: outcome.dataset});
  if (outcome.kind === 'sqlError')
    return [...steps, sql, cell('error', 'The query did not run. ' + outcome.plain, {plain: outcome.plain, raw: outcome.raw.slice(0, 1200)})];
  const shown = {columns: outcome.result.columns, rows: outcome.result.rows.slice(0, LIMITS.displayRows), row_count: outcome.result.row_count};
  const answer = outcome.answer;
  const copy = evidenceMarkdown({dataset: datasetTitle(outcome.dataset), question, steps: outcome.steps, sql: outcome.sql, result: outcome.result, answer});
  return [...steps, sql,
    cell('result', markdownTable(shown), {...shown, truncated: outcome.result.truncated, highlight: evidenceRows(shown, answer.evidence)}),
    cell('answer', answerMarkdown(answer), {answer, copy}),
    ...(answer.check_question ? [cell('check', 'Check it yourself: ' + answer.check_question)] : [])];
}

function answerMarkdown(a: DataAnswer) {
  return [a.answer, ...(a.evidence.length ? ['Evidence:\n' + a.evidence.map(s => '- ' + s).join('\n')] : []),
    ...(a.caveats.length ? ['Caveats:\n' + a.caveats.map(s => '- ' + s).join('\n')] : [])].join('\n\n');
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const list = (items: unknown) => {
  const ul = el('ul');
  for (const item of Array.isArray(items) ? items : []) ul.append(el('li', String(item)));
  return ul;
};

function table(columns: unknown, rows: unknown, highlight: unknown = []) {
  const box = el('div', undefined, 'data-grid'), t = el('table'), head = el('tr'), body = el('tbody');
  for (const c of Array.isArray(columns) ? columns : []) head.append(el('th', String(c)));
  const marked = Array.isArray(highlight) ? highlight : [];
  (Array.isArray(rows) ? rows : []).forEach((row: Cell[], i: number) => {
    const tr = el('tr');
    if (marked.includes(i)) tr.className = 'evidence';
    for (const v of Array.isArray(row) ? row : []) {
      const td = el('td', v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));
      if (v === null || v === undefined) td.className = 'null';
      else if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v))) td.className = 'num';
      tr.append(td);
    }
    body.append(tr);
  });
  const thead = el('thead'); thead.append(head); t.append(thead, body); box.append(t);
  return box;
}

/** Fills a data cell's card body. `copy` sends the evidence Markdown to the clipboard through the extension. */
export function renderDataBody(body: HTMLElement, cell: NotebookCell, copy: (text: string) => void) {
  const p = cell.packet ?? {}, part = p.data_part;
  body.classList.add('data-cell', 'data-' + String(part));
  if (part === 'sql') {
    const details = el('details'), summary = el('summary', 'How I got this'), pre = el('pre'), code = el('code', String(p.sql ?? ''));
    pre.append(code);
    details.append(summary, el('p', 'The query the Coach ran on your computer, read-only. It is here so you can check it; you never need to write or change it.', 'muted'), pre);
    body.append(details);
    return;
  }
  if (part === 'result') {
    const count = Number(p.row_count) || 0, shown = Array.isArray(p.rows) ? p.rows.length : 0;
    body.append(el('h3', 'Result'), el('p', (count > shown ? `Showing ${shown} of ${count.toLocaleString('en-IN')} rows` : `${count} row${count === 1 ? '' : 's'}`)
      + (p.truncated ? ' (the lab returns at most 500 rows)' : '') + '. Highlighted rows are the evidence for the answer.', 'muted'),
    table(p.columns, p.rows, p.highlight));
    return;
  }
  if (part === 'answer') {
    const a = (p.answer ?? {}) as Partial<DataAnswer>;
    body.append(el('h3', 'Answer'), el('p', String(a.answer ?? cell.text)));
    if (a.evidence?.length) body.append(el('h4', 'Evidence (rows used)'), list(a.evidence));
    if (a.caveats?.length) body.append(el('h4', 'Caveats'), list(a.caveats));
    if (typeof p.copy === 'string') {
      const actions = el('div', undefined, 'lesson-actions'), button = el('button', 'Copy evidence');
      button.type = 'button'; button.dataset.copyEvidence = '';
      button.title = 'Copy the question, steps, query, up to 20 result rows and the answer as Markdown for a Written Practice task';
      button.onclick = () => copy(p.copy as string);
      actions.append(button); body.append(actions);
    }
    return;
  }
  if (part === 'check') {
    const box = el('div', undefined, 'your-turn is-open');
    box.append(el('strong', 'Check it yourself'), el('p', cell.text.replace(/^Check it yourself:\s*/, '')));
    body.append(box);
    return;
  }
  if (part === 'error') {
    body.append(el('p', String(p.plain ?? cell.text)));
    if (typeof p.raw === 'string' && p.raw) {
      const details = el('details'); details.append(el('summary', 'PostgreSQL said'), el('pre', p.raw)); body.append(details);
    }
    body.append(el('p', 'I tried once more with that error. Ask again in other words, or ask about one thing at a time.', 'muted'));
    return;
  }
  if (part === 'cannot') {
    body.append(el('h3', 'The data cannot answer this'));
    const text = el('div'); text.innerHTML = renderBoard(cell.text.replace(/^\s*the data cannot answer this[.:!]?\s*/i, '')); body.append(text);
    return;
  }
  if (part === 'steps') body.append(el('h3', 'How I’ll work it out'));
  const text = el('div'); text.innerHTML = renderBoard(cell.text); body.append(text);
}

export interface ImportPreview {fileName: string; table: string; sheet?: string; columns: {name: string; original: string; type: string}[]; preview: string[][]; total: number; notes: string[]}

/** The import preview: what the file will become, before anything is created. Every value is text. */
export function previewCard(plan: ImportPreview, create: () => void, cancel: () => void) {
  const card = el('article', undefined, 'data-preview');
  card.setAttribute('aria-label', 'Import preview');
  card.append(el('small', 'Import preview'), el('h3', plan.fileName),
    el('p', `Table ${plan.table} · ${Number(plan.total).toLocaleString('en-IN')} rows · ${plan.columns.length} columns${plan.sheet ? ' · sheet ' + plan.sheet : ''}`));
  for (const note of plan.notes ?? []) card.append(el('p', note, 'muted'));
  card.append(el('p', 'The first rows, with the type used for each column. Anything unclear stays text.', 'muted'),
    table(plan.columns.map(c => `${c.name} (${c.type}) ← ${c.original}`), plan.preview));
  const actions = el('div', undefined, 'lesson-actions'), ok = el('button', 'Create table'), no = el('button', 'Cancel');
  ok.type = no.type = 'button'; ok.onclick = create; no.onclick = cancel; actions.append(ok, no); card.append(actions);
  return card;
}
