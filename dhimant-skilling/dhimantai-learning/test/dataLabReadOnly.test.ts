import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPodman } from '../src/podman';
import { labExecArgs, runLab } from '../src/dataLabEngine';

/**
 * The read-only guard against a real PostgreSQL 17 in a container, with the extension's own data_lab.py and seeds.
 * Needs Podman and an image with PostgreSQL 17 and psycopg (the course image after `dhimantai-language sql`).
 * Set DHIMANTAI_DATALAB_IMAGE to choose the image; skipped when either is missing.
 */
const IMAGE = process.env.DHIMANTAI_DATALAB_IMAGE ?? 'localhost/dhimantai-project-sql:v1';
const extension = join(__dirname, '../..');

test('as datalab_reader, writes fail and reads work', {timeout: 240_000}, async t => {
  const bin = await findPodman();
  if (!bin) return t.skip('Podman is not installed');
  try { execFileSync(bin, ['image', 'exists', IMAGE]); } catch { return t.skip(`image ${IMAGE} is not available`); }
  const name = 'dhimantai-datalab-test-' + process.pid;
  const work = mkdtempSync(join(tmpdir(), 'datalab-it-'));
  chmodSync(work, 0o755);
  // The learner's home in the course folder, where the course keeps its PostgreSQL template cluster.
  const home = mkdtempSync(join(tmpdir(), 'datalab-home-'));
  chmodSync(home, 0o777);
  const mount = (from: string, to: string) => ['-v', `${from}:${to}:ro`];
  execFileSync(bin, ['run', '-d', '--rm', '--name', name, '--entrypoint', 'sleep',
    ...mount(join(extension, 'media/course/sql_runtime.py'), '/opt/dhimantai/sql_runtime.py'),
    ...mount(join(extension, 'media/course/data_lab.py'), '/course/.datalab/data_lab.py'),
    ...mount(join(extension, 'media/datalab'), '/course/.datalab/samples'),
    ...mount(work, '/course/.datalab/imports'), '-v', `${home}:/course/.home`,
    '-e', 'DHIMANTAI_PG_TEMPLATE=/tmp/pg-template', IMAGE, 'infinity']);
  try {
    const args = labExecArgs(name, '/course/.datalab/data_lab.py', 'python3');
    const shop = {dataset: 'shop', source: {kind: 'sample' as const, path: '/course/.datalab/samples/shop.sql'}};
    const query = (sql: string) => runLab<any>(bin, args, {op: 'query', ...shop, sql});

    const opened = await runLab<any>(bin, args, {op: 'open', ...shop});
    assert.deepEqual(opened.tables.map((x: any) => x.name), ['branches', 'products', 'returns', 'sales']);
    assert.ok(opened.tables.every((x: any) => x.sample_rows.length <= 5));
    const salesCount = opened.tables.find((x: any) => x.name === 'sales').row_count;

    // A read works, shows at most 500 rows and reports the true count.
    const all = await query('SELECT * FROM sales;');
    assert.equal(all.rows.length, 500);
    assert.equal(all.row_count, salesCount);
    assert.equal(all.truncated, true);
    // The planted trap: Pune leads May on gross sales, Indore once returns are subtracted.
    const net = await query(`WITH g AS (SELECT branch_id, sum(amount) s FROM sales WHERE sale_date BETWEEN '2026-05-01' AND '2026-05-31' GROUP BY 1),
      r AS (SELECT branch_id, sum(refund_amount) s FROM returns WHERE return_date BETWEEN '2026-05-01' AND '2026-05-31' GROUP BY 1)
      SELECT b.branch_name, g.s AS gross, g.s - coalesce(r.s, 0) AS net FROM g JOIN branches b USING (branch_id) LEFT JOIN r USING (branch_id)`);
    const top = (column: number) => [...net.rows].sort((a: any, b: any) => Number(b[column]) - Number(a[column]))[0][0];
    assert.equal(top(1), 'Pune Kothrud');
    assert.equal(top(2), 'Indore Rajwada');

    // Through the lab's own path (BEGIN READ ONLY, one prepared statement behind a cursor), every write fails.
    for (const sql of ["INSERT INTO branches VALUES (9, 'x', 'x', 'x', '2026-01-01', 1)", 'UPDATE sales SET amount = 0', 'DROP TABLE sales',
      'SET TRANSACTION READ WRITE', "COPY sales TO PROGRAM 'id'", 'SELECT 1; DELETE FROM sales',
      'WITH d AS (DELETE FROM returns RETURNING *) SELECT * FROM d', 'SELECT * INTO copy_of_sales FROM sales'])
      assert.ok((await query(sql)).error, sql + ' must fail');
    assert.match((await query('SELECT pg_sleep(8)')).error, /statement timeout/);

    // The role itself is the guard: a direct session as datalab_reader, without the lab's wrapper, cannot write either.
    const direct = execFileSync(bin, ['exec', '-i', name, 'python3', '-c', `
import json, psycopg
out = {}
def attempt(label, *statements):
    with psycopg.connect(host='/tmp/dhimantai-datalab', dbname='datalab_shop', user='datalab_reader', autocommit=True) as c:
        try:
            c.execute('BEGIN')
            for s in statements: c.execute(s)
            c.execute('COMMIT'); out[label] = 'ok'
        except psycopg.Error as e:
            out[label] = type(e).__name__ + ': ' + str(e).splitlines()[0]
attempt('insert', "INSERT INTO branches VALUES (9, 'x', 'x', 'x', '2026-01-01', 1)")
attempt('update', 'UPDATE sales SET amount = 0')
attempt('drop', 'DROP TABLE sales')
attempt('read_write_insert', 'SET TRANSACTION READ WRITE', "INSERT INTO branches VALUES (9, 'x', 'x', 'x', '2026-01-01', 1)")
attempt('read_write_create', 'SET TRANSACTION READ WRITE', 'CREATE TABLE public.mine (a int)')
attempt('copy_program', 'SET TRANSACTION READ WRITE', "COPY sales TO PROGRAM 'id'")
attempt('temp', 'SET TRANSACTION READ WRITE', 'CREATE TEMP TABLE t (a int)')
attempt('select', 'SELECT count(*) FROM sales')
with psycopg.connect(host='/tmp/dhimantai-datalab', dbname='postgres', user='postgres') as c:
    out['reader'] = c.execute("SELECT rolsuper, rolcreatedb, rolcreaterole, rolconfig FROM pg_roles WHERE rolname = 'datalab_reader'").fetchone()
print(json.dumps(out, default=str))`]).toString();
    const roles = JSON.parse(direct);
    for (const label of ['insert', 'update', 'drop']) assert.match(roles[label], /ReadOnlySqlTransaction/, label);
    for (const label of ['read_write_insert', 'read_write_create', 'copy_program', 'temp'])
      assert.match(roles[label], /InsufficientPrivilege/, label);
    assert.equal(roles.select, 'ok');
    assert.deepEqual(roles.reader.slice(0, 3), [false, false, false]);
    assert.match(String(roles.reader[3]), /default_transaction_read_only=on/);
    assert.match(String(roles.reader[3]), /statement_timeout=5s/);
    assert.equal((await query('SELECT count(*) AS n FROM sales')).rows[0][0], salesCount, 'the data is unchanged');

    // An imported file: hostile text stays data, typed columns load, and only the owner role created the table.
    writeFileSync(join(work, 'mine.json'), JSON.stringify({tables: [{name: 'mine', columns: [{name: 'note', type: 'text'}, {name: 'n', type: 'integer'},
      {name: 'day', type: 'date'}], rows: [["'); DROP TABLE mine; --", '7', '2026-01-02'], ['<img src=x onerror=alert(1)>', null, null]]}]}));
    const imported = {dataset: 'u_mine', source: {kind: 'import' as const, path: '/course/.datalab/imports/mine.json'}};
    const schema = await runLab<any>(bin, args, {op: 'open', ...imported});
    assert.deepEqual(schema.tables[0].columns, [{name: 'note', type: 'text'}, {name: 'n', type: 'bigint'}, {name: 'day', type: 'date'}]);
    const rows = await runLab<any>(bin, args, {op: 'query', ...imported, sql: 'SELECT note, n, day FROM mine ORDER BY n NULLS LAST'});
    assert.deepEqual(rows.rows, [["'); DROP TABLE mine; --", 7, '2026-01-02'], ['<img src=x onerror=alert(1)>', null, null]]);
    assert.ok((await runLab<any>(bin, args, {op: 'query', ...imported, sql: 'DELETE FROM mine'})).error);

    // An Excel workbook, read in the container without openpyxl.
    const xlsx = execFileSync(bin, ['exec', '-i', name, 'python3', '-c', `
import base64, io, zipfile
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
    z.writestr('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Branch</t></si><si><t>Amount</t></si><si><t>Day</t></si><si><t>Indore</t></si></sst>')
    z.writestr('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
    z.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1250.0</v></c><c r="C2" s="1"><v>46023</v></c></row></sheetData></worksheet>')
print(base64.b64encode(b.getvalue()).decode())`]).toString().trim();
    const book = await runLab<any>(bin, args, {op: 'xlsx', data: xlsx});
    assert.deepEqual(book, {sheet: 'Sales', sheets: 1, rows: [['Branch', 'Amount', 'Day'], ['Indore', '1250', '2026-01-01']]});
  } finally {
    try { execFileSync(bin, ['rm', '-f', name], {stdio: 'ignore'}); } catch { /* already gone */ }
    rmSync(work, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});
