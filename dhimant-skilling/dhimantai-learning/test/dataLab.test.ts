import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askCourseData, askFraming, checkQuery, chooseDatasets, CourseDataset, CoachReply, dataHistory, datasetName, datasetForQuery,
  evidenceMarkdown, evidenceRows, extractSql, inferType, isDataQuestion, LIMITS, markdownTable, normalizeValue, parseAnswer, parseCsv,
  planImport, plainSqlError, requestNotice, resultOutput, sanitizeIdentifier, TURN, uniqueIdentifiers } from '../src/dataLab';
import { courseData, Recipe } from '../src/courseRecipe';
import { ApiError } from '../src/api';

const extension = join(__dirname, '../..');

test('the sample generator reproduces the shipped seeds byte for byte', () => {
  const out = mkdtempSync(join(tmpdir(), 'datalab-seeds-'));
  try {
    execFileSync('python3', [join(extension, 'scripts/datalab/generate_seeds.py'), '--out', out], {stdio: 'pipe'});
    const shipped = join(extension, 'media/datalab');
    assert.deepEqual(readdirSync(out).sort(), ['about.json', 'clinic.sql', 'school.sql', 'shop.sql']);
    assert.deepEqual(readdirSync(shipped).sort(), readdirSync(out).sort());
    for (const file of readdirSync(out)) assert.ok(readFileSync(join(out, file)).equals(readFileSync(join(shipped, file))), file + ' differs');
    const about = JSON.parse(readFileSync(join(shipped, 'about.json'), 'utf8'));
    for (const name of ['shop', 'school', 'clinic']) {
      assert.ok(about[name].rows <= 5000, name);
      assert.ok(about[name].gaps.length >= 3, name + ' lists what the data cannot say');
      // Every column in the SQL has a meaning on the about card.
      const sql = readFileSync(join(shipped, name + '.sql'), 'utf8');
      for (const table of about[name].tables) assert.match(sql, new RegExp(`CREATE TABLE ${table.name} \\(`));
    }
    assert.match(about.shop.tables.find((t: any) => t.name === 'returns').description, /net sales/);
  } finally { rmSync(out, {recursive: true, force: true}); }
});

test('the shop sample suggests the questions AI at Work Chapter 4 walks through, in the same words', () => {
  const about = JSON.parse(readFileSync(join(extension, 'media/datalab/about.json'), 'utf8'));
  const lesson = readFileSync(join(extension, '../../content/courses/ai-at-work/chapters/ch04_documents_data.py'), 'utf8')
    .replace(/\s+/g, ' ');
  const walkThrough = ['Which branch sold the most in May?', 'Which branch sold the most in May, net of returns?',
    'Which product made the most profit?'];
  assert.deepEqual(about.shop.try.slice(0, 3), walkThrough);
  for (const question of walkThrough) assert.ok(lesson.includes(`"${question}"`), question);
  assert.ok(about.shop.gaps.some((gap: string) => /no cost price/.test(gap)), 'profit stays unanswerable');
});

test('CSV parsing handles quotes, embedded delimiters and line breaks, BOM, CRLF and semicolons', () => {
  assert.deepEqual(parseCsv('﻿name,note\r\n"Rao, S","said ""hi""\nthen left"\r\nAsha,\r\n'),
    [['name', 'note'], ['Rao, S', 'said "hi"\nthen left'], ['Asha', '']]);
  assert.deepEqual(parseCsv('a;b\n1,5;2\n'), [['a', 'b'], ['1,5', '2']]);
  assert.deepEqual(parseCsv('a\tb\nx\ty'), [['a', 'b'], ['x', 'y']]);
  assert.throws(() => parseCsv('a,b\n"open,1\n'), /quoted value/);
});

test('type inference is conservative: text unless clearly integer, numeric, date or boolean', () => {
  assert.equal(inferType(['1', '-20', '', '300']), 'integer');
  assert.equal(inferType(['1', '2.50', '']), 'numeric');
  assert.equal(inferType(['600001', '007']), 'text', 'leading zeros (PIN codes, phone numbers) stay text');
  assert.equal(inferType(['1,23,456']), 'text', 'grouped numbers stay text');
  assert.equal(inferType(['2026-01-31', '2026-02-28']), 'date');
  assert.equal(inferType(['2026-02-30']), 'text', 'impossible dates stay text');
  assert.equal(inferType(['03/04/2026', '05/06/2026']), 'text', 'ambiguous day order stays text');
  assert.equal(inferType(['03/04/2026', '25/12/2026']), 'date', 'a day above 12 settles the order');
  assert.equal(normalizeValue('date', '25/12/2026'), '2026-12-25');
  assert.equal(inferType(['Yes', 'no', 'TRUE']), 'boolean');
  assert.equal(normalizeValue('boolean', 'Yes'), 'true');
  assert.equal(inferType(['0', '1']), 'integer');
  assert.equal(inferType(['', '  ']), 'text');
  assert.equal(inferType(['12345678901234567890']), 'text', 'beyond safe integers stays text');
  assert.equal(normalizeValue('integer', ' '), null);
});

test('identifiers become plain, unique lower-case names that never need quoting', () => {
  assert.equal(sanitizeIdentifier('Total Sales (₹)'), 'total_sales');
  assert.equal(sanitizeIdentifier('Growth %'), 'growth_percent');
  assert.equal(sanitizeIdentifier('2026 Target'), 'c_2026_target');
  assert.equal(sanitizeIdentifier('select'), 'select_');
  assert.equal(sanitizeIdentifier('Update'), 'update_');
  assert.equal(sanitizeIdentifier('Café Name'), 'cafe_name');
  assert.equal(sanitizeIdentifier('"; DROP TABLE x; --'), 'drop_table_x');
  assert.equal(sanitizeIdentifier('x'.repeat(100)).length, 63);
  assert.deepEqual(uniqueIdentifiers(['Name', 'name', 'NAME', '', '']), ['name', 'name_2', 'name_3', 'column_4', 'column_5']);
  for (const id of uniqueIdentifiers(['a b', '१२३', '***', 'Order', 'from'])) assert.match(id, /^[a-z_][a-z0-9_]{0,62}$/);
  assert.equal(datasetName('Sales Report (Jan).xlsx'), 'sales_report_jan');
});

test('an import plan previews 20 rows, pads short rows and enforces the row limit', () => {
  const rows = [['Branch', 'Amount', 'Day'], ...Array.from({length: 30}, (_, i) => [`B${i}`, String(i * 10), '2026-01-0' + (i % 9 + 1)]), ['short']];
  const plan = planImport('sales.csv', rows);
  assert.equal(plan.table, 'sales');
  assert.equal(plan.preview.length, LIMITS.previewRows);
  assert.equal(plan.total, 31);
  assert.deepEqual(plan.columns.map(c => [c.name, c.type]), [['branch', 'text'], ['amount', 'integer'], ['day', 'date']]);
  assert.deepEqual(plan.rows.at(-1), ['short', null, null]);
  assert.match(plan.notes.join(' '), /fewer values/);
  const huge = [['a'], ...Array.from({length: LIMITS.rows + 1}, () => ['1'])];
  assert.throws(() => planImport('big.csv', huge), /more than 2,00,000 rows/);
  assert.throws(() => planImport('empty.csv', [['a']]), /header row and at least one row/);
});

test('the client check accepts one read query and refuses anything else', () => {
  const ok = (sql: string) => { const r = checkQuery(sql); assert.ok(r.ok, sql + ': ' + (!r.ok ? r.reason : '')); return r.ok ? r.sql : ''; };
  const no = (sql: string, reason: RegExp) => { const r = checkQuery(sql); assert.ok(!r.ok, sql); assert.match(!r.ok ? r.reason : '', reason); };
  assert.equal(ok('SELECT 1;  \n'), 'SELECT 1');
  ok("SELECT ';' AS x, 'drop table' AS y -- ; comment\nFROM sales");
  ok('WITH m AS (SELECT 1) SELECT * FROM m');
  ok('select "update" from t');
  ok('SELECT $$a;b$$, $q$ ; $q$');
  ok("SELECT E'it\\'s;' AS x");
  ok('/* note; */ SELECT last_update FROM t');
  no('SELECT 1; DROP TABLE sales', /one query at a time/);
  no('DELETE FROM sales', /SELECT or WITH/);
  no('WITH d AS (DELETE FROM sales RETURNING *) SELECT * FROM d', /DELETE/);
  no('SET TRANSACTION READ WRITE', /SELECT or WITH/);
  no("COPY sales TO PROGRAM 'id'", /SELECT or WITH/);
  no("SELECT 'unclosed", /closing quote/);
  no('/* never closed SELECT 1', /not closed/);
  no('   ', /empty/);
});

// ---- Course data through ordinary Instructor turns --------------------------------------------------------------------

const about = JSON.parse(readFileSync(join(extension, 'media/datalab/about.json'), 'utf8'));
/** The shipped samples with their real tables and a few long example rows. */
function samples(): CourseDataset[] {
  return ['shop', 'school', 'clinic'].map(name => ({id: 'sample:' + name, title: about[name].title.split(':')[0], source: 'sample' as const, about: about[name],
    tables: about[name].tables.map((t: any) => ({name: t.name, row_count: 1000, columns: Object.keys(t.columns).map(c => ({name: c, type: 'text'})),
      sample_rows: Array.from({length: 9}, (_, i) => Object.keys(t.columns).map(() => 'value ' + i + ' '.repeat(10)))}))}));
}

test('AI at Work ships the shop, school and clinic samples; other courses ship none', () => {
  const profiles: Record<string, Recipe> = JSON.parse(readFileSync(join(extension, 'media/course/profiles.json'), 'utf8'));
  assert.deepEqual(courseData(profiles, 'AI at Work'), ['shop', 'school', 'clinic']);
  assert.deepEqual(profiles['ai at work'].services, ['postgres'], 'the course container has PostgreSQL for the samples');
  assert.deepEqual(courseData(profiles, 'Databases with PostgreSQL'), []);
  assert.deepEqual(courseData(profiles, 'Python'), []);
  assert.deepEqual(courseData({x: {data: ['shop']}}, 'x'), [], 'data without the PostgreSQL service is never preloaded');
  for (const name of courseData(profiles, 'AI at Work')) assert.ok(readdirSync(join(extension, 'media/datalab')).includes(name + '.sql'));
});

test('the table structure fits the turn: at most 5 example rows per table, trimmed first, then whole tables', () => {
  const all = samples();
  const framing = askFraming(all);
  assert.ok(framing.text.length <= TURN.question);
  for (const table of all.flatMap(d => d.tables)) {
    const examples = framing.text.split('\n').filter(line => line.startsWith('  example: ') && line.includes('value')).length;
    assert.ok(examples <= LIMITS.sampleRows * all.flatMap(d => d.tables).length);
    assert.ok(framing.text.includes(`Table ${table.name} (1000 rows)`), table.name);
  }
  const one = askFraming([all[0]]);
  assert.equal(one.examples, LIMITS.sampleRows, 'a small dataset keeps all five example rows');
  for (const table of all[0].tables)
    assert.equal(one.text.split(`Table ${table.name} `)[1].split('\nTable ')[0].split('\n').filter(l => l.startsWith('  example: ')).length, 5, 'never more than 5');
  assert.match(one.text, /```sql block/);
  assert.match(one.text, /The data cannot answer this/);
  const huge: CourseDataset = {...all[0], tables: Array.from({length: 30}, (_, i) => ({name: 't' + i, row_count: 5,
    columns: Array.from({length: 40}, (_, c) => ({name: 'column_' + c, type: 'numeric'})), sample_rows: [Array(40).fill('x'.repeat(500))]}))};
  const trimmed = askFraming([huge]);
  assert.ok(trimmed.text.length <= TURN.question);
  assert.equal(trimmed.examples, 0, 'example rows go first');
  assert.equal(trimmed.complete, false, 'then tables');
  assert.doesNotMatch(trimmed.text, /x{60}/, 'example values are shortened');
  const history = dataHistory(Array.from({length: 9}, (_, i) => ({question: 'q' + i + 'x'.repeat(2000), sql: 'SELECT ' + i})));
  assert.equal(history.length, TURN.history);
  assert.ok(history.every(item => item.text.length <= TURN.historyText));
  assert.match(history[0].text, /^q5/, 'the last four question and query pairs');
});

test('a question names its dataset; otherwise all three if they fit, otherwise the last one used', () => {
  const all = samples();
  assert.deepEqual(chooseDatasets('Which doctor has the longest wait at the clinic?', '', all).map(d => d.id), ['sample:clinic']);
  assert.deepEqual(chooseDatasets('What is the average?', 'School attendance lesson', all).map(d => d.id), ['sample:school']);
  const small = all.map(d => ({...d, about: {...d.about, gaps: []}, tables: d.tables.map(t => ({...t, sample_rows: []}))}));
  assert.deepEqual(chooseDatasets('What is the average?', '', small).length, 3, 'all three when they fit');
  const wide = all.map(d => ({...d, tables: d.tables.map(t => ({...t, columns: Array.from({length: 60}, (_, c) => ({name: 'c' + c + '_' + 'y'.repeat(30), type: 'text'}))}))}));
  assert.deepEqual(chooseDatasets('What is the average?', '', wide, 'sample:school').map(d => d.id), ['sample:school'], 'the last-used one when they do not');
  assert.equal(datasetForQuery('SELECT d.doctor_name FROM appointments a JOIN doctors d USING (doctor_id)', all)!.id, 'sample:clinic');
  assert.equal(isDataQuestion('Which branch sold the most in May?', all), true);
  assert.equal(isDataQuestion('How is attendance this term?', all), true);
  assert.equal(isDataQuestion('Can you explain prompts again?', all), false);
  assert.equal(isDataQuestion('anything', []), false);
});

test('the query comes from the first sql block; a reply without one is a normal reply', () => {
  const reply = 'Steps: add up sales by branch, using sales and branches.\n\n```sql\nSELECT b.branch_name, SUM(s.amount)\nFROM sales s JOIN branches b USING (branch_id)\nGROUP BY 1\n```\n\nAssumption: May 2026.\n```sql\nSELECT 2\n```';
  const found = extractSql(reply);
  assert.match(found.sql!, /^SELECT b\.branch_name/);
  assert.doesNotMatch(found.sql!, /SELECT 2/);
  assert.match(found.text, /^Steps: add up sales/);
  assert.match(found.text, /Assumption: May 2026/);
  assert.equal(extractSql('```\nWITH m AS (SELECT 1) SELECT * FROM m\n```').sql, 'WITH m AS (SELECT 1) SELECT * FROM m');
  assert.equal(extractSql('```python\nprint(1)\n```').sql, undefined);
  assert.equal(extractSql('Run `SELECT count(*) FROM sales` to count them.').sql, 'SELECT count(*) FROM sales');
  const teach = extractSql('Good question! What do you think "net of returns" means?');
  assert.deepEqual([teach.sql, teach.cannotAnswer, teach.text], [undefined, false, 'Good question! What do you think "net of returns" means?']);
  const cannot = extractSql('The data cannot answer this: there is no cost price, so profit is unknown.');
  assert.equal(cannot.cannotAnswer, true);
});

test('the result goes back as at most 50 rows within the run output, with the true count', () => {
  const result = {columns: ['n', 'note'], rows: Array.from({length: 500}, (_, i) => [i, 'x'.repeat(150)]), row_count: 1234, truncated: true};
  const out = resultOutput(result);
  assert.ok(out.output.length <= TURN.output);
  assert.ok(out.shown <= LIMITS.explainRows);
  assert.match(out.output, /^Columns: n \| note\nRows: 1234 \(showing the first \d+\)/);
  assert.equal(out.incomplete, true);
  const small = resultOutput({columns: ['n'], rows: [[1], [null]], row_count: 2, truncated: false});
  assert.deepEqual([small.shown, small.incomplete, small.output], [2, false, 'Columns: n\nRows: 2\n1\nNULL']);
  assert.deepEqual(parseAnswer('Answer: Pune sold the most.\nEvidence:\n- Pune: 255675\nCaveats:\n- Returns are not subtracted.', 'Which branch came second?'),
    {answer: 'Pune sold the most.', evidence: ['Pune: 255675'], caveats: ['Returns are not subtracted.'], check_question: 'Which branch came second?'});
  assert.equal(parseAnswer('Plain words only.').answer, 'Plain words only.');
});

function coach(replies: (CoachReply | Error)[]) {
  const bodies: any[] = [];
  return {bodies, fn: async (body: Record<string, unknown>) => {
    bodies.push(body);
    const next = replies.shift();
    if (!next) throw new Error('unexpected turn');
    if (next instanceof Error) throw next;
    return next;
  }};
}
const ok = {columns: ['branch_name', 'total'], rows: [['Pune', 255675], ['Nashik', 183113]], row_count: 2, truncated: false, milliseconds: 3};

test('the data route: question with structure, the query run here, then the result for a plain answer', async () => {
  const all = samples();
  const turns = coach([{guidance: 'Steps: total the sales table by branch.\n```sql\nSELECT branch_name, SUM(amount) AS total FROM sales JOIN branches USING (branch_id) GROUP BY 1;\n```', prompt: ''},
    {guidance: 'Answer: Pune sold the most.\nEvidence:\n- Pune: 255675\nCaveats:\n- Returns are not subtracted.', prompt: 'How much more than Nashik?'}]);
  const ran: [string, string][] = [];
  const outcome = await askCourseData({coach: turns.fn, run: async (d, sql) => { ran.push([d.id, sql]); return ok; }},
    {question: 'Which branch sold the most?', datasets: all, history: [{question: 'Earlier?', sql: 'SELECT 1'}]});
  assert.equal(outcome.kind, 'answer');
  if (outcome.kind !== 'answer') return;
  assert.deepEqual(ran, [['sample:shop', 'SELECT branch_name, SUM(amount) AS total FROM sales JOIN branches USING (branch_id) GROUP BY 1']], 'one statement, run once, on the shop');
  assert.deepEqual([outcome.dataset, outcome.answer.check_question, outcome.retried], ['sample:shop', 'How much more than Nashik?', false]);
  assert.match(outcome.steps, /^Steps: total the sales table/);
  const [ask, explain] = turns.bodies;
  for (const body of turns.bodies) {
    assert.ok(String(body.question).length <= TURN.question && String(body.message).length <= TURN.message);
    assert.equal(body.language, 'sql'); assert.equal(body.stage, 'data');
    assert.equal(body.attachments, undefined, 'no attachments on the data route');
  }
  assert.equal(ask.message, 'Which branch sold the most?');
  assert.match(ask.question, /^COURSE DATA QUESTION/);
  assert.deepEqual(ask.history.map((h: any) => h.role), ['learner', 'tutor']);
  assert.match(explain.question, /^COURSE DATA ANSWER/);
  assert.equal(explain.source, ran[0][1]);
  assert.deepEqual(explain.observed_run, {success: true, output: 'Columns: branch_name | total\nRows: 2\nPune | 255675\nNashik | 183113', stderr: '', incomplete: false});
});

test('no query means a normal reply; "cannot answer" is shown plainly; nothing is run for either', async () => {
  const run = async () => { throw new Error('nothing runs'); };
  const teach = coach([{guidance: 'Before we count: what does "sold the most" mean to you, rupees or items?', prompt: 'Which one?'}]);
  assert.deepEqual(await askCourseData({coach: teach.fn, run}, {question: 'Who sold the most in the shop?', datasets: samples(), history: []}),
    {kind: 'reply', content: 'Before we count: what does "sold the most" mean to you, rupees or items?\n\nWhich one?'});
  const cannot = coach([{guidance: 'The data cannot answer this. Profit needs a cost price for each product, and the shop data has none.', prompt: ''}]);
  const outcome = await askCourseData({coach: cannot.fn, run}, {question: 'Which product made the most profit?', datasets: samples(), history: []});
  assert.equal(outcome.kind, 'cannot');
});

test('a failed query is retried once with the error, then shown plainly', async () => {
  const bad = {guidance: 'Steps: x\n```sql\nSELECT nope FROM sales\n```', prompt: ''};
  const errors = {...ok, error: 'column "nope" does not exist', hint: 'Perhaps you meant amount.'};
  const twice = coach([bad, bad]);
  let runs = 0;
  const outcome = await askCourseData({coach: twice.fn, run: async () => { runs++; return errors; }}, {question: 'Total of the shop sales?', datasets: samples(), history: []});
  assert.equal(outcome.kind, 'sqlError');
  assert.equal(runs, 2); assert.equal(twice.bodies.length, 2, 'one retry, and no explain turn');
  if (outcome.kind === 'sqlError') assert.match(outcome.plain, /column called "nope"/);
  const retry = twice.bodies[1];
  assert.deepEqual(retry.observed_run, {success: false, output: '', stderr: 'column "nope" does not exist\nHint: Perhaps you meant amount.', incomplete: false});
  assert.equal(retry.source, 'SELECT nope FROM sales');
  assert.match(retry.question, /Your last query .* failed/);
  assert.equal(retry.history.at(-1).text, 'Query I used:\nSELECT nope FROM sales');

  const fixed = coach([{guidance: '```sql\nDELETE FROM sales\n```', prompt: ''}, {guidance: '```sql\nSELECT 1 AS total FROM sales\n```', prompt: ''}, {guidance: 'Answer: 1', prompt: ''}]);
  const ran: string[] = [];
  const recovered = await askCourseData({coach: fixed.fn, run: async (_d, sql) => { ran.push(sql); return ok; }}, {question: 'Total of the shop sales?', datasets: samples(), history: []});
  assert.equal(recovered.kind, 'answer');
  assert.deepEqual(ran, ['SELECT 1 AS total FROM sales'], 'a write is refused on this computer and never runs');
  assert.match(fixed.bodies[1].observed_run.stderr, /^Checked on this computer before running: .*read data/);
  if (recovered.kind === 'answer') assert.equal(recovered.retried, true);
});

test('403 and 429 from the Instructor become the access and allowance notices', async () => {
  for (const [status, kind, text] of [[403, 'access', /^Access ended · Buy again/], [429, 'quota', /today's Coach questions/]] as const) {
    const turns = coach([new ApiError(status, 'refused')]);
    await assert.rejects(askCourseData({coach: turns.fn, run: async () => ok}, {question: 'Total of the shop sales?', datasets: samples(), history: []}),
      (error: unknown) => error instanceof ApiError && error.status === status);
    assert.equal(requestNotice(status, 'refused').kind, kind);
    assert.match(requestNotice(status, 'refused').text, text);
  }
  assert.equal(requestNotice(402, '').kind, 'access');
  assert.equal(requestNotice(500, 'Boom').text, 'Boom');
});

test('evidence Markdown carries the question, steps, SQL, at most 20 rows and the answer', () => {
  const result = {columns: ['branch', 'net'], rows: Array.from({length: 30}, (_, i) => [`B|${i}`, i]), row_count: 30, truncated: false, milliseconds: 7};
  const md = evidenceMarkdown({dataset: 'Shop', question: 'Net sales?', steps: 'Add sales, then subtract returns.', sql: 'SELECT 1',
    result, answer: {answer: 'Indore leads.', evidence: ['B|0 has 0'], caveats: ['Hubballi opened in March.'], check_question: 'Add Indore\'s returns.'}});
  assert.match(md, /### Question\nNet sales\?/);
  assert.match(md, /### The Coach's steps\nAdd sales/);
  assert.match(md, /```sql\nSELECT 1\n```/);
  assert.match(md, /B\\\|19/);
  assert.doesNotMatch(md, /B\\\|20/);
  assert.match(md, /Showing 20 of 30 rows/);
  assert.match(md, /### Check it yourself/);
  assert.match(markdownTable({columns: ['a'], rows: [[null]], row_count: 1}), /_1 row\._/);
});


test('evidence sentences highlight the rows they cite', () => {
  const rows = [['Indore Rajwada', '245617.00'], ['Pune Kothrud', '255675.00'], ['Nashik', '183113.00']];
  assert.deepEqual(evidenceRows({rows}, ['Pune Kothrud had ₹2,55,675 gross, but returns...']), [1]);
  assert.deepEqual(evidenceRows({rows}, ['Indore Rajwada: 245617']), [0]);
  assert.deepEqual(evidenceRows({rows}, ['Nothing here']), []);
});

test('SQL errors read in plain words', () => {
  assert.match(plainSqlError('syntax error at or near "INSERT"'), /only reads data/);
  assert.match(plainSqlError('column "net_sales" does not exist'), /column called "net_sales"/);
  assert.match(plainSqlError('canceling statement due to statement timeout'), /5 seconds/);
  assert.match(plainSqlError('column reference "branch_id" is ambiguous'), /more than one of the joined tables/);
  assert.match(plainSqlError('permission denied for table sales'), /only reads data/);
});

test('the notebook keeps its last dataset and imported files, and refuses anything else in those fields', () => {
  const { emptyNotebook, readNotebook } = require('../src/tutorNotebook') as typeof import('../src/tutorNotebook');
  const saved = readNotebook({...emptyNotebook(), dataset: 'import:fees', dataImports: ['fees', 'old_file']});
  assert.deepEqual([saved.dataset, saved.dataImports], ['import:fees', ['fees', 'old_file']]);
  for (const bad of [{dataset: 'shop'}, {dataset: 'sample:../x'}, {dataImports: ['Fees.csv']}, {dataImports: 'fees'}])
    assert.throws(() => readNotebook({...emptyNotebook(), ...bad}), /course data fields/);
});
