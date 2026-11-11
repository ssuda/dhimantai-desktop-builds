import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {findPodman} from '../src/podman';
import {CourseEngine} from '../src/courseEngine';
import {NotebookCells} from '../src/notebookCells';

// A course image with PostgreSQL 17 and psycopg; no learner course or existing database is touched.
const IMAGE = process.env.DHIMANTAI_SQL_TEST_IMAGE ?? 'localhost/dhimantai-course-runtime-qa:20261110';
test('SQL recovers from initdb and dataset failures, keeps cell state, and executes WHERE/HAVING', {timeout:180_000}, async t => {
  const bin = await findPodman();
  if (!bin) return t.skip('Podman is unavailable');
  try {execFileSync(bin, ['image','exists',IMAGE]);} catch {return t.skip('Set DHIMANTAI_SQL_TEST_IMAGE to a PostgreSQL course image');}
  const work = mkdtempSync(join(tmpdir(),'sql-recovery-'));
  chmodSync(work,0o777);
  const home = join(work,'home'), binaries = join(work,'bin');
  mkdirSync(home); chmodSync(home,0o755); mkdirSync(binaries);
  for (const tool of ['postgres','pg_ctl','psql','pg_isready']) symlinkSync('/usr/lib/postgresql/17/bin/'+tool,join(binaries,tool));
  writeFileSync(join(binaries,'initdb'), `#!/bin/sh
if [ ! -f /tmp/sql-startup-failed-once ]; then
  touch /tmp/sql-startup-failed-once
  echo 'initdb: could not change permissions of directory "/course/home/private/data": Operation not permitted' >&2
  exit 1
fi
exec /usr/lib/postgresql/17/bin/initdb "$@"
`, {mode:0o755});
  const name = 'dhimantai-sql-recovery-'+process.pid;
  const media = resolve(__dirname,'../../media/course');
  execFileSync(bin,['run','-d','--rm','--name',name,'--entrypoint','sleep','--user','1000:1000',
    '-v',work+':/course','-v',home+':/course/home:ro',
    '-v',join(media,'sql_runtime.py')+':/opt/dhimantai/sql_runtime.py:ro',
    '-e','HOME=/course/home','-e','DHIMANTAI_PG_BIN=/course/bin',IMAGE,'infinity']);
  const engine = new CourseEngine(bin,name,work);
  const cells = new NotebookCells(()=>({}),async()=>engine,async()=>work);
  const setup = "CREATE TABLE employees(dept text, salary integer); INSERT INTO employees VALUES ('IT',60000),('IT',50000),('HR',45000),('HR',40000),('Sales',30000);";
  const where = 'SELECT dept, SUM(salary) AS total FROM employees WHERE salary > 35000 GROUP BY dept ORDER BY dept;';
  const having = 'SELECT dept, SUM(salary) AS total FROM employees GROUP BY dept HAVING SUM(salary) > 90000;';
  try {
    const streams:string[]=[];
    const failed = await cells.run('sql',where,'',{event:event=>{if(event.kind==='stream')streams.push(event.text);}});
    assert.equal(failed.exit_code,1);
    assert.equal(failed.stdout,'');
    assert.match(failed.stderr,/Your SQL did not run.*storage permissions.*PG_INITDB/);
    assert.doesNotMatch(failed.stderr+streams.join(''),/CalledProcessError|Traceback|\/course\/home/);
    const log = execFileSync(bin,['exec',name,'cat','/tmp/dhimantai-postgres-1000/startup.log'],{encoding:'utf8'});
    assert.match(log,/Operation not permitted/);
    const leftovers = execFileSync(bin,['exec',name,'find','/tmp/dhimantai-postgres-1000','-name','pg-template-*'],{encoding:'utf8'});
    assert.equal(leftovers.trim(),'');
    const badSetup = await cells.run('sql','SELECT 1','',{setup:'CREATE TABLE partial(id int); SELECT * FROM absent;'});
    assert.equal(badSetup.exit_code,1);
    const initialized = await cells.run('sql',where,'',{setup});
    assert.equal(initialized.exit_code,0,initialized.stderr);
    assert.match(initialized.stdout,/HR\s*\|\s*85000/);
    assert.match(initialized.stdout,/IT\s*\|\s*110000/);
    assert.doesNotMatch(initialized.stdout,/Sales/);
    const missing = await cells.run('sql','SELECT * FROM missing_table;');
    assert.equal(missing.exit_code,1);
    assert.match(missing.stderr,/SQL query failed.*missing_table/s);
    assert.match(missing.stderr,/create and load the required tables/);
    assert.doesNotMatch(missing.stderr,/Traceback|\/course\/|could not initialize/);
    const filtered = await cells.run('sql',having);
    assert.equal(filtered.exit_code,0,filtered.stderr);
    assert.match(filtered.stdout,/IT\s*\|\s*110000/);
    assert.doesNotMatch(filtered.stdout,/HR/);
    const standalone = await engine.run('sql',{source:where,stdin:'',argv:[],files:[{name:'setup.sql',content:setup}]});
    assert.equal(standalone.exit_code,0,standalone.stderr);
    assert.equal(standalone.stdout.trimEnd(),initialized.stdout.trimEnd());
    // The shared home is read-only throughout: the new default must never initialize there.
    assert.equal(execFileSync(bin,['exec',name,'find','/course/home','-name','PG_VERSION'],{encoding:'utf8'}).trim(),'');
  } finally {
    cells.restart();
    execFileSync(bin,['rm','-f',name],{stdio:'ignore'});
    rmSync(work,{recursive:true,force:true});
  }
});
