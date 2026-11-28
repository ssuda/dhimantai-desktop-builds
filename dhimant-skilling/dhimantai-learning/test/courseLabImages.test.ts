import {test} from 'node:test';
import {spawn} from 'node:child_process';
import * as assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {CourseEngine} from '../src/courseEngine';
import {NotebookCells} from '../src/notebookCells';

// Opt-in acceptance against a disposable, already-built course image. Never execute labs on the host.
const container = process.env.DHIMANTAI_COURSE_LAB_CONTAINER;
const root = process.env.DHIMANTAI_COURSE_LAB_ROOT;
const postgresImage = process.env.DHIMANTAI_POSTGRES_NOTEBOOK_IMAGE;
test('the DBA cell runs a real psql prompt, completes batch queries and reports broken pipelines',
  {skip: !postgresImage, timeout: 100_000}, async () => {
    const bridge = resolve(__dirname, '../../media/course');
    const cells = new NotebookCells(() => ({}), undefined, undefined, 30_000, {
      target:'PostgreSQL course container',
      start: async () => spawn(process.env.DHIMANTAI_CONTAINER_ENGINE || 'podman', [
        'run', '--rm', '-i', '--network=none', '--workdir=/tmp', '-v', bridge + ':/bridge:ro',
        '--entrypoint=python3', postgresImage!, '-u', '/bridge/cells.py']),
    });
    const options = {database:'lab' as const, interactive:true};
    try {
      const socket = await cells.postgresSocket();
      assert.match(socket, /^\/tmp\/pglab-[\w-]+$/);
      assert.equal((await cells.run('bash', 'printf %s "$PGHOST"', '', options)).stdout, socket);
      let buffer = '', step = 0;
      const dialogue = [
        {prompt:/postgres=# $/, input:'SELECT 40 +'},
        {prompt:/postgres-# $/, input:'2 AS answer;'},
        {prompt:/42[\s\S]*postgres=# $/, input:'\\conninfo'},
        {prompt:/connected to database[\s\S]*postgres=# $/i, input:'\\c template1'},
        {prompt:/template1=# $/, input:'\\q'},
      ];
      const execution = await cells.run('bash', 'psql', '', {...options, event:event => {
        if (event.kind !== 'stream') return;
        buffer += event.text;
        const next = dialogue[step];
        if (next?.prompt.test(buffer)) { step++; buffer = ''; cells.input(next.input); }
      }});
      assert.equal(execution.exit_code, 0, JSON.stringify(execution));
      assert.equal(step, dialogue.length);
      assert.match(execution.stdout, /postgres=# SELECT 40 \+\n/);
      assert.match(execution.stdout, /postgres-# 2 AS answer;\n/);
      assert.equal(execution.postgres_environment?.pager_disabled, true);
      const batch = await cells.run('pglab', 'psql -c "SELECT generate_series(1, 250)"', '', options);
      assert.equal(batch.exit_code, 0, JSON.stringify(batch));
      assert.match(batch.stdout, /\(250 rows\)/);
      const broken = await cells.run('bash', 'false | cat\necho continued', '', options);
      assert.equal(broken.exit_code, 1, JSON.stringify(broken));
      assert.match(broken.stderr, /earlier pipeline/);
      const handled = await cells.run('bash', 'false | cat || echo handled', '', options);
      assert.equal(handled.exit_code, 0, JSON.stringify(handled));
      assert.match(handled.stdout, /handled/);
    } finally { await cells.close(); }
  });

test('image scenario persists across cells, isolates attempts, rejects substitutions and resets',
  {skip: !container || !root, timeout: 240_000}, async () => {
    const engine = new CourseEngine(process.env.DHIMANTAI_CONTAINER_ENGINE || 'podman', container!, root!);
    const catalog = JSON.parse(await readFile(resolve(__dirname, '../../../../content/courses/runtime-assets/scenarios/postgresql-dba.json'), 'utf8'));
    const stopped = catalog.scenarios.find((s: any) => s.title === 'Bring the server back').setup;
    const other = catalog.scenarios.find((s: any) => s.title === 'Clear the configuration errors').setup;
    const make = () => new NotebookCells(() => ({}), async () => engine,
      async () => mkdtemp(join(root!, '.image-lab-test-')), 130_000);
    const cells = make(), isolated = make();
    const run = (language: string, source: string, setup = stopped, session = cells) =>
      session.run(language, source, '', {database: 'lab', setup});
    const status = 'pg_ctl status -D "$PGDATA"';
    try {
      const broken = await run('pglab', status);
      assert.equal(broken.exit_code, 3, JSON.stringify(broken));
      assert.match(broken.stdout, /no server running/);
      // A second cell observes the same fault; setup must not run again.
      assert.equal((await run('bash', status)).exit_code, 3);
      const direct = await engine.run('pglab', {source:status, stdin:'', argv:[], files:[{name:'lab_setup.sh',content:stopped}]});
      assert.equal(direct.exit_code, 3, JSON.stringify(direct));
      const substituted = await engine.run('pglab', {source:'echo MUST_NOT_RUN', stdin:'', argv:[],
        files:[{name:'lab_setup.sh',content:stopped+'\necho INJECTED'}]});
      assert.match(substituted.stderr, /not packaged/);
      assert.equal(substituted.stdout, '');
      const repair = await run('bash', 'pg_ctl start -D "$PGDATA" -l "$LAB/qa-server.log" -w');
      assert.equal(repair.exit_code, 0, JSON.stringify(repair));
      assert.match((await run('sql', 'SELECT 42 AS answer')).stdout, /42/);
      // A separate notebook gets the original fault, leaving the repaired attempt alone.
      assert.equal((await run('bash', status, stopped, isolated)).exit_code, 3);
      assert.equal((await run('bash', status)).exit_code, 0);
      const changed = await run('bash', 'echo MUST_NOT_RUN', other);
      assert.match(changed.stderr, /different lab is already open/);
      assert.doesNotMatch(changed.stdout, /MUST_NOT_RUN/);
      assert.equal((await run('bash', status)).exit_code, 0);
      cells.restart();
      const injected = await run('bash', 'echo MUST_NOT_RUN', stopped + '\necho INJECTED');
      assert.match(injected.stderr, /not packaged/);
      assert.doesNotMatch(injected.stdout, /INJECTED|MUST_NOT_RUN/);
      assert.equal((await run('bash', status)).exit_code, 3);
    } finally {
      cells.restart(); isolated.restart();
    }
  });

test('every packaged DBA challenge prepares in the actual course image',
  {skip: !container || !root, timeout: 600_000}, async t => {
    const engine = new CourseEngine(process.env.DHIMANTAI_CONTAINER_ENGINE || 'podman', container!, root!);
    const catalog = JSON.parse(await readFile(resolve(__dirname, '../../../../content/courses/runtime-assets/scenarios/postgresql-dba.json'), 'utf8'));
    assert.equal(catalog.scenarios.length, 36);
    for (const scenario of catalog.scenarios) {
      const cells = new NotebookCells(() => ({}), async () => engine,
        async () => mkdtemp(join(root!, '.scenario-test-')), 130_000);
      try {
        const result = await cells.run('pglab', 'printf "LAB_READY\\n"', '',
          {database:'lab', setup:scenario.setup, signal:t.signal});
        assert.equal(result.exit_code, 0, scenario.title + ': ' + JSON.stringify(result));
        assert.match(result.stdout, /LAB_READY/);
        t.diagnostic(scenario.title + ': prepared');
      } finally { cells.restart(); }
    }
  });
