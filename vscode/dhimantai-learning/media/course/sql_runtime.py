"""PostgreSQL programs and tests inside the sandbox.

A run starts a private server from the cluster prepared in the image, listening only on a Unix socket in /tmp.
Every run or test case gets a fresh database owned by the non-superuser role `learner`; the dataset, the
learner's statements and any check query all run as that role, so learner SQL cannot reach the server itself.
Results are JSON ({"columns": [...], "rows": [[...]]}); grading happens outside the container.
"""
from __future__ import annotations

from contextlib import contextmanager
import datetime
import decimal
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

TEMPLATE = Path(os.environ.get('DHIMANTAI_PG_TEMPLATE', '/opt/pg/template'))
BIN = Path(os.environ.get('DHIMANTAI_PG_BIN', '/usr/lib/postgresql/17/bin'))
STATEMENT_TIMEOUT_MS = 5000
MAX_ROWS = 500


def _value(value):
    """JSON for a PostgreSQL value; the same rule produces expected and actual results."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_value(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _value(v) for k, v in value.items()}
    return str(value)


@contextmanager
def server(*, detached=False):
    """A private PostgreSQL server for one sandbox run; it never listens on a network port."""
    root = Path(tempfile.mkdtemp(prefix='pg-'))
    data = root / 'data'
    shutil.copytree(TEMPLATE, data)
    os.chmod(data, 0o700)
    log = (root / 'server.log').open('wb')
    process = subprocess.Popen([str(BIN / 'postgres'), '-D', str(data), '-k', str(root), '-c', 'listen_addresses=',
                                '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
                                '-c', 'max_connections=8', '-c', 'shared_buffers=16MB', '-c', 'log_min_messages=fatal'],
                               stdout=log, stderr=log, start_new_session=detached)
    try:
        deadline = time.monotonic() + 15
        while not (root / '.s.PGSQL.5432').exists():
            if process.poll() is not None or time.monotonic() > deadline:
                raise OSError('PostgreSQL did not start')
            time.sleep(0.05)
        yield str(root)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        log.close()
        shutil.rmtree(root, ignore_errors=True)


_counter = 0


def _database(host):
    """A new, empty database owned by the learner role."""
    import psycopg
    global _counter
    _counter += 1
    name = f'practice_{_counter}'
    with psycopg.connect(host=host, dbname='postgres', user='postgres', autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE {name} OWNER learner TEMPLATE template0')
    return name


def _connect(host, name):
    import psycopg
    connection = psycopg.connect(host=host, dbname=name, user='learner', autocommit=True)
    connection.execute(f'SET statement_timeout = {STATEMENT_TIMEOUT_MS}')
    return connection


def _result_sets(cursor):
    """Every result set a script produced, in order, as (columns, rows)."""
    sets = []
    while True:
        if cursor.description is not None:
            rows = cursor.fetchmany(MAX_ROWS + 1)
            sets.append(([c.name for c in cursor.description], [[_value(v) for v in row] for row in rows[:MAX_ROWS]],
                         len(rows) > MAX_ROWS))
        if not cursor.nextset():
            return sets


def _error(error):
    message = str(error).strip() or type(error).__name__
    return message.splitlines()[0][:600] + ('\n' + '\n'.join(message.splitlines()[1:])[:600] if '\n' in message else '')


def run_script(host, setup, source, check=''):
    """Dataset, then the learner's statements, then an optional check query, in one fresh database.

    Returns (status, result, error): status is 'setup_error', 'error' or 'ok'; result is the check query's rows
    when there is a check, otherwise the last result set the learner's statements produced.
    """
    import psycopg
    import threading
    connection = _connect(host, _database(host))
    # A learner can change statement_timeout; the cancel from outside the session always applies.
    guard = threading.Timer(STATEMENT_TIMEOUT_MS / 1000 * 2, connection.cancel)
    guard.start()
    try:
        with connection.cursor() as cursor:
            if setup.strip():
                try:
                    cursor.execute(setup)
                except psycopg.Error as error:
                    return 'setup_error', None, _error(error)
            try:
                cursor.execute(source)
                sets = _result_sets(cursor)
            except psycopg.Error as error:
                return 'error', None, _error(error)
            if check.strip():
                try:
                    cursor.execute(check)
                    sets = _result_sets(cursor)
                except psycopg.Error as error:
                    return 'error', None, 'After your statements, the check query failed: ' + _error(error)
            return 'ok', sets, ''
    finally:
        guard.cancel()
        connection.close()


def table(columns, rows, more):
    """A psql-style text table for Run output."""
    shown = lambda v: 'NULL' if v is None else ('true' if v else 'false') if isinstance(v, bool) \
        else json.dumps(v) if isinstance(v, (list, dict)) else str(v)
    cells = [[shown(v) for v in row] for row in rows]
    widths = [max([len(c)] + [len(r[i]) for r in cells]) for i, c in enumerate(columns)]
    line = lambda values: ' | '.join(v.ljust(w) for v, w in zip(values, widths)).rstrip()
    out = [line(columns), '-+-'.join('-' * w for w in widths)] + [line(r) for r in cells]
    out.append(f"({len(rows)}{'+' if more else ''} row{'s' if len(rows) != 1 else ''})")
    return '\n'.join(out) + '\n'


def run(source, setup=''):
    """Run for learners: every result set as a table, errors on stderr."""
    with server() as host:
        status, sets, error = run_script(host, setup, source)
    if status != 'ok':
        prefix = 'The exercise dataset failed to load: ' if status == 'setup_error' else ''
        return 1, '', prefix + error
    return 0, '\n'.join(table(*s) for s in sets) or 'Statements ran. No query returned rows.\n', ''


def run_cases(source, cases):
    """Sandbox test results: stdout is the JSON result the judge compares."""
    results = []
    with server() as host:
        for case in cases:
            started = time.monotonic()
            status, sets, error = run_script(host, case.get('setup', ''), source, case.get('check', ''))
            result = {'id': case['id'], 'status': 'exited', 'duration_seconds': round(time.monotonic() - started, 3)}
            if status != 'ok':
                result.update(exit_code=1, stdout='', stderr=error, truncated=False)
            elif not sets:
                result.update(exit_code=1, stdout='', stderr='No query returned rows to check.', truncated=False)
            else:
                columns, rows, more = sets[-1]
                result.update(exit_code=0, stdout=json.dumps({'columns': columns, 'rows': rows}), stderr='', truncated=more)
            results.append(result)
    return results


def ensure_template(path: Path = TEMPLATE) -> Path:
    """Prepare the cluster once where the image did not (the course container keeps it in the learner's home)."""
    if (path / 'PG_VERSION').exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='pg-template-', dir=path.parent))
    data = work / 'data'
    subprocess.run([str(BIN / 'initdb'), '-D', str(data), '-U', 'postgres', '--auth=trust', '--encoding=UTF8',
                    '--locale=C.UTF-8', '--no-sync'], check=True, capture_output=True, timeout=120)
    # The server inherits pg_ctl's output; a log file keeps pipes from staying open after start.
    subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-l', str(work / 'setup.log'), '-o', f'-k {work} -c listen_addresses=',
                    '-w', 'start'], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    try:
        subprocess.run([str(BIN / 'psql'), '-h', str(work), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
                        'CREATE ROLE learner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'], check=True, capture_output=True, timeout=60)
    finally:
        subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-w', 'stop'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=60)
    data.rename(path) if not path.exists() else None
    shutil.rmtree(work, ignore_errors=True)
    return path


def main():
    """Course container entry: run/tests or lab/lab_tests on stdin, JSON on stdout."""
    import sys
    global TEMPLATE
    request = json.load(sys.stdin)
    TEMPLATE = ensure_template()
    if request.get('mode') == 'tests':
        print(json.dumps({'tests': run_cases(request['source'], request['tests'])}))
    elif request.get('mode') == 'lab_tests':
        print(json.dumps({'tests': run_lab_cases(request['source'], request['tests'])}))
    elif request.get('mode') == 'lab':
        code, stdout, stderr = run_lab(request['source'], request.get('setup', ''))
        print(json.dumps({'exit_code': code, 'stdout': stdout, 'stderr': stderr}))
    else:
        code, stdout, stderr = run(request['source'], request.get('setup', ''))
        print(json.dumps({'exit_code': code, 'stdout': stdout, 'stderr': stderr}))


# ---- Administration labs ------------------------------------------------------------------------------------
# A lab is a bash script run with the PostgreSQL tools on PATH against a fresh server that this run owns. The lab's
# setup script runs first (it may plant problems: settings, roles, data, a blocking session), then the learner's
# script, then a SQL check as the superuser. The learner may restart the server or start more servers (a replica)
# under $LAB; every server under the lab folder is stopped at the end. In the Practice sandbox the container is the
# security boundary, as it is for any learner program.
LAB_TIMEOUT = 90
LAB_CHECK_TIMEOUT = 30


def _lab_env(root: Path, data: Path):
    env = {k: v for k, v in os.environ.items() if k in ('LANG', 'LC_ALL', 'TZ', 'HOME')}
    env.update(PATH=f"{BIN}:/usr/local/bin:/usr/bin:/bin", PGHOST=str(root), PGPORT='5432', PGUSER='postgres',
               PGDATABASE='postgres', PGDATA=str(data), LAB=str(root / 'lab'), HOME=env.get('HOME', str(root)))
    return env


def _stop_all(root: Path):
    """Stop every server started under the lab, including replicas the learner created.

    A copied data directory (cp -a of a running server) carries the original's postmaster.pid. Its second line
    names the data directory the process really serves, so a copy is skipped instead of signalling the original;
    cleanup never fails the run.
    """
    for pid_file in sorted(root.rglob('postmaster.pid'), key=lambda f: len(f.parts), reverse=True):
        try:
            lines = pid_file.read_text().splitlines()
            if len(lines) < 2 or Path(lines[1]).resolve() != pid_file.parent.resolve():
                continue
            subprocess.run([str(BIN / 'pg_ctl'), '-D', str(pid_file.parent), '-m', 'immediate', '-t', '10', 'stop'],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            continue


@contextmanager
def lab_server(*, detached=False):
    root = Path(tempfile.mkdtemp(prefix='pglab-'))
    data = root / 'data'
    shutil.copytree(TEMPLATE, data)
    os.chmod(data, 0o700)
    (root / 'lab').mkdir()
    # The lab's settings live in postgresql.conf, as on a real server, so a plain `pg_ctl start -D "$PGDATA"` works and a
    # copy of the data directory (a replica) inherits them, including the socket folder and port it must change.
    with (data / 'postgresql.conf').open('a') as conf:
        conf.write(f"\n# Lab server\nunix_socket_directories = '{root}'\nlisten_addresses = ''\nport = 5432\n"
                   "fsync = off\nmax_connections = 20\nshared_buffers = 16MB\n")
    try:
        # pg_ctl, not a child process: the learner may restart the server with pg_ctl too.
        subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-l', str(root / 'server.log'), '-w', '-t', '30', 'start'],
                       check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, start_new_session=detached)
        yield root, data
    finally:
        _stop_all(root)
        shutil.rmtree(root, ignore_errors=True)


def _bash(script, env, cwd, timeout=LAB_TIMEOUT):
    # Output goes to files, not pipes: a server the script (re)starts inherits them and would hold a pipe open.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            code = subprocess.run(['bash', '-eo', 'pipefail', '-c', script], env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                                  stdout=out, stderr=err, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            return None, '', f'Stopped after {timeout} seconds.'
        out.seek(0); err.seek(0)
        return code, out.read().decode(errors='replace')[-12000:], err.read().decode(errors='replace')[-6000:]


def _superuser_rows(root, check):
    """The check query's last result set, as the superuser, once the server accepts connections."""
    import psycopg
    import threading
    deadline = time.monotonic() + 20
    while True:
        try:
            connection = psycopg.connect(host=str(root), dbname='postgres', user='postgres', autocommit=True, connect_timeout=3)
            break
        except psycopg.OperationalError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.2)
    with connection, connection.cursor() as cursor:
        # Checks may wait for replication/recovery, but a learner's abandoned lock must not hang grading.
        # Cancel externally so checks can still inspect the server's actual timeout settings and their source.
        guard = threading.Timer(LAB_CHECK_TIMEOUT, connection.cancel)
        guard.start()
        try:
            cursor.execute(check)
            return _result_sets(cursor)
        finally:
            guard.cancel()


def run_lab(source, setup=''):
    """Run for learners: the lab setup, then the script; shows the script's output."""
    with lab_server() as (root, data):
        env = _lab_env(root, data)
        if setup.strip():
            code, _, err = _bash(setup, env, root / 'lab')
            if code != 0:
                return 1, '', 'The lab setup failed: ' + err
        code, out, err = _bash(source, env, root / 'lab')
        return (1 if code is None else code), out, err


def run_lab_cases(source, cases):
    """Each case on its own fresh server: setup, the learner's script, then the check query's rows as JSON."""
    import psycopg
    results = []
    for case in cases:
        started = time.monotonic()
        result = {'id': case['id'], 'status': 'exited', 'truncated': False}
        with lab_server() as (root, data):
            env = _lab_env(root, data)
            code, _, err = _bash(case.get('setup', ''), env, root / 'lab') if case.get('setup', '').strip() else (0, '', '')
            if code != 0:
                result.update(exit_code=1, stdout='', stderr='The lab setup failed: ' + err)
            else:
                code, out, err = _bash(source, env, root / 'lab')
                if code is None:
                    result.update(status='timeout', exit_code=None, stdout='', stderr=err)
                elif code != 0:
                    result.update(exit_code=code, stdout='', stderr=(err or out)[-2000:])
                else:
                    try:
                        sets = _superuser_rows(root, case.get('check') or 'SELECT 1 AS ok')
                        columns, rows, more = sets[-1]
                        result.update(exit_code=0, stdout=json.dumps({'columns': columns, 'rows': rows}), stderr='', truncated=more)
                    except psycopg.errors.QueryCanceled as error:
                        result.update(status='timeout', exit_code=None, stdout='',
                                      stderr='After your script, the lab check timed out: ' + _error(error))
                    except (psycopg.Error, IndexError) as error:
                        result.update(exit_code=1, stdout='', stderr='After your script, the lab check failed: ' + _error(error))
        result['duration_seconds'] = round(time.monotonic() - started, 3)
        results.append(result)
    return results


if __name__ == '__main__':
    main()
