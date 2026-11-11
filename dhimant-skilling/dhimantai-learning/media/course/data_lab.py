"""Ask your data: a private, read-only PostgreSQL lab inside the learner's course container.

The extension copies this file into the course folder and runs it with `podman exec`; a JSON request arrives on stdin and
a JSON reply leaves on stdout. One server per container keeps every lab database (`datalab_<dataset>`). It listens only
on a Unix socket under /tmp and keeps running between requests, so a question runs in milliseconds.

Two roles do all the work, never the superuser:
- `datalab_owner` creates and loads the tables (samples shipped with the extension, or a learner's imported file).
- `datalab_reader` runs every question. It may CONNECT to lab databases and SELECT from their tables, nothing else.
  Its sessions are read-only with a 5 second statement timeout, each question runs inside BEGIN READ ONLY ... ROLLBACK
  as a single prepared statement (a second statement is refused by PostgreSQL), and only SELECT/VALUES/WITH queries
  can stand behind the cursor that returns the rows (DECLARE refuses anything that writes).
"""
from __future__ import annotations

from contextlib import contextmanager
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile

sys.path.insert(0, '/opt/dhimantai')
import sql_runtime  # noqa: E402  (the course image's PostgreSQL helpers: binaries, template cluster, value encoding)

ROOT = Path(os.environ.get('DHIMANTAI_DATALAB_ROOT', '/tmp/dhimantai-datalab'))
DATA = ROOT / 'data'
OWNER, READER = 'datalab_owner', 'datalab_reader'
DISPLAY_ROWS = 500
SAMPLE_ROWS = 5
STATEMENT_TIMEOUT = '5s'
NAME = re.compile(r'^[a-z][a-z0-9_]{0,39}$')
IDENT = re.compile(r'^[a-z_][a-z0-9_]{0,62}$')
TYPES = {'text': 'text', 'integer': 'bigint', 'numeric': 'numeric', 'date': 'date', 'boolean': 'boolean'}


def _psycopg():
    import psycopg
    return psycopg


@contextmanager
def _lock():
    ROOT.mkdir(parents=True, exist_ok=True)
    with (ROOT / 'lock').open('w') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def _connect(user, dbname='postgres', **options):
    return _psycopg().connect(host=str(ROOT), dbname=dbname, user=user, connect_timeout=5, **options)


def _running():
    try:
        _connect('postgres', autocommit=True).close()
        return True
    except Exception:
        return False


def ensure_server():
    """Start the lab's server once per container; the cluster lives in the container, never on a network port."""
    if _running():
        return
    with _lock():
        if _running():
            return
        if not (DATA / 'PG_VERSION').exists():
            template = sql_runtime.ensure_template(Path(os.environ.get('DHIMANTAI_PG_TEMPLATE', str(sql_runtime.TEMPLATE))))
            shutil.rmtree(DATA, ignore_errors=True)
            shutil.copytree(template, DATA)
            os.chmod(DATA, 0o700)
            with (DATA / 'postgresql.conf').open('a') as conf:
                conf.write(f"\n# Ask your data\nunix_socket_directories = '{ROOT}'\nlisten_addresses = ''\nport = 5432\n"
                           "max_connections = 12\nshared_buffers = 32MB\nfsync = off\nlog_min_messages = fatal\n")
        # A container restart leaves a stale pid file behind; the server is not running, so it is safe to remove.
        (DATA / 'postmaster.pid').unlink(missing_ok=True)
        subprocess.run([str(sql_runtime.BIN / 'pg_ctl'), '-D', str(DATA), '-l', str(ROOT / 'server.log'), '-w', '-t', '30', 'start'],
                       check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60,
                       start_new_session=True)
        _roles()


def _roles():
    """The owner loads data; the reader may only connect and read. Both are plain, non-superuser login roles."""
    with _connect('postgres', autocommit=True) as admin:
        for role in (OWNER, READER):
            if not admin.execute('SELECT 1 FROM pg_roles WHERE rolname = %s', [role]).fetchone():
                admin.execute(f'CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
        admin.execute(f'ALTER ROLE {READER} NOINHERIT CONNECTION LIMIT 4')
        admin.execute(f"ALTER ROLE {READER} SET default_transaction_read_only = on")
        admin.execute(f"ALTER ROLE {READER} SET statement_timeout = '{STATEMENT_TIMEOUT}'")
        admin.execute(f"ALTER ROLE {READER} SET idle_in_transaction_session_timeout = '10s'")
        admin.execute(f"ALTER ROLE {READER} SET lock_timeout = '2s'")
        admin.execute(f"ALTER ROLE {READER} SET search_path = public")


def _database(dataset):
    if not NAME.match(dataset):
        raise ValueError('Dataset names use lower-case letters, digits and underscores.')
    return 'datalab_' + dataset


def _fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _current(admin, database):
    row = admin.execute('SELECT shobj_description(oid, %s) FROM pg_database WHERE datname = %s', ['pg_database', database]).fetchone()
    return row[0] if row else None


def _create(admin, database):
    """A fresh database owned by the owner role; nobody else may connect except the reader."""
    admin.execute(f'DROP DATABASE IF EXISTS {database} WITH (FORCE)')
    admin.execute(f'CREATE DATABASE {database} OWNER {OWNER} TEMPLATE template0 ENCODING UTF8')
    admin.execute(f'REVOKE ALL ON DATABASE {database} FROM PUBLIC')
    admin.execute(f'GRANT CONNECT ON DATABASE {database} TO {READER}')
    with _connect('postgres', database, autocommit=True) as db:
        db.execute('REVOKE ALL ON SCHEMA public FROM PUBLIC')
        db.execute(f'GRANT USAGE ON SCHEMA public TO {READER}')
        db.execute(f'ALTER DEFAULT PRIVILEGES FOR ROLE {OWNER} IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC')
        db.execute(f'ALTER DEFAULT PRIVILEGES FOR ROLE {OWNER} IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC')


def _finish(admin, database, version):
    with _connect(OWNER, database, autocommit=True) as db:
        db.execute(f'GRANT SELECT ON ALL TABLES IN SCHEMA public TO {READER}')
        db.execute('ANALYZE')
    admin.execute(f"COMMENT ON DATABASE {database} IS 'datalab {version}'")


def load_sample(dataset, path):
    """A shipped sample, loaded by the owner role. Reloaded only when the shipped file changes."""
    seed = Path(path).read_text(encoding='utf-8')
    database, version = _database(dataset), _fingerprint(seed)
    with _lock(), _connect('postgres', autocommit=True) as admin:
        if _current(admin, database) == f'datalab {version}':
            return database
        _create(admin, database)
        with _connect(OWNER, database, autocommit=True) as db:
            db.execute('BEGIN')
            db.execute(seed)
            db.execute('COMMIT')
        _finish(admin, database, version)
    return database


def load_import(dataset, path):
    """A learner's file, already parsed and typed by the extension: tables are created and filled with COPY by the owner."""
    from psycopg import sql
    text = Path(path).read_text(encoding='utf-8')
    database, version = _database(dataset), _fingerprint(text)
    with _lock(), _connect('postgres', autocommit=True) as admin:
        if _current(admin, database) == f'datalab {version}':
            return database
        spec = json.loads(text)
        _create(admin, database)
        with _connect(OWNER, database) as db:
            for table in spec['tables']:
                if not IDENT.match(table['name']) or not all(IDENT.match(c['name']) and c['type'] in TYPES for c in table['columns']):
                    raise ValueError('The imported table has an unsafe name or type.')
                columns = [sql.SQL('{} {}').format(sql.Identifier(c['name']), sql.SQL(TYPES[c['type']])) for c in table['columns']]
                db.execute(sql.SQL('CREATE TABLE {} ({})').format(sql.Identifier(table['name']), sql.SQL(', ').join(columns)))
                names = sql.SQL(', ').join(sql.Identifier(c['name']) for c in table['columns'])
                with db.cursor().copy(sql.SQL('COPY {} ({}) FROM STDIN').format(sql.Identifier(table['name']), names)) as copy:
                    for row in table['rows']:
                        copy.write_row([None if v is None or v == '' else v for v in row])
            db.commit()
        _finish(admin, database, version)
    return database


def describe(database):
    """Tables, columns, types, true row counts and the first rows, read through the reader role."""
    with _connect(READER, database, autocommit=True) as db:
        tables = [r[0] for r in db.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
            "ORDER BY table_name").fetchall()]
        out = []
        for name in tables:
            columns = db.execute(
                "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s "
                "ORDER BY ordinal_position", [name]).fetchall()
            quoted = '"' + name.replace('"', '""') + '"'
            count = db.execute(f'SELECT count(*) FROM {quoted}').fetchone()[0]
            rows = db.execute(f'SELECT * FROM {quoted} LIMIT {SAMPLE_ROWS}').fetchall()
            out.append({'name': name, 'row_count': count, 'columns': [{'name': c, 'type': t} for c, t in columns],
                        'sample_rows': [[sql_runtime._value(v) for v in row] for row in rows]})
        return out


def query(database, text):
    """One question's query, as the reader, read-only, rolled back. Shows up to 500 rows and reports the true count."""
    psycopg = _psycopg()
    source = text.strip().rstrip(';').strip()
    if not source:
        return {'error': 'The query is empty.'}
    started = time.monotonic()
    connection = _connect(READER, database, autocommit=True)
    # A query can change its own session settings; this cancel from outside always applies.
    guard = threading.Timer(10, connection.cancel)
    guard.start()
    try:
        with connection.cursor() as cursor:
            for setting in ("SET default_transaction_read_only = on", f"SET statement_timeout = '{STATEMENT_TIMEOUT}'",
                            "SET idle_in_transaction_session_timeout = '10s'"):
                cursor.execute(setting)
            cursor.execute('BEGIN TRANSACTION READ ONLY')
            try:
                # Prepared: PostgreSQL refuses a second statement. DECLARE: only a query that reads can stand behind it.
                cursor.execute('DECLARE datalab_result NO SCROLL CURSOR FOR ' + source, prepare=True)
                cursor.execute(f'FETCH FORWARD {DISPLAY_ROWS} FROM datalab_result')
                columns = [c.name for c in cursor.description or []]
                rows = [[sql_runtime._value(v) for v in row] for row in cursor.fetchall()]
                cursor.execute('MOVE FORWARD ALL IN datalab_result')
                total = len(rows) + (cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0)
            finally:
                cursor.execute('ROLLBACK')
        return {'columns': columns, 'rows': rows, 'row_count': total, 'truncated': total > len(rows),
                'milliseconds': round((time.monotonic() - started) * 1000)}
    except psycopg.errors.QueryCanceled:
        return {'error': 'canceling statement due to statement timeout'}
    except psycopg.Error as error:
        message = (getattr(error.diag, 'message_primary', None) or str(error)).strip()
        hint = getattr(error.diag, 'message_hint', None)
        return {'error': message.split('\n')[0][:600], 'hint': (hint or '')[:300]}
    finally:
        guard.cancel()
        connection.close()


def drop(dataset):
    database = _database(dataset)
    with _lock(), _connect('postgres', autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS {database} WITH (FORCE)')
    return {'dropped': database}


# ---- Excel workbooks ---------------------------------------------------------------------------------------------
MAX_ROWS = 200_000


def workbook(data: bytes):
    """The first worksheet of an .xlsx as rows of text. openpyxl when the image has it, otherwise the standard library."""
    try:
        import openpyxl  # type: ignore
    except ImportError:
        return _workbook_stdlib(data)
    book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sheet = book.worksheets[0]
    rows = []
    for row in sheet.iter_rows(values_only=True):
        rows.append(['' if v is None else _cell_text(v) for v in row])
        if len(rows) > MAX_ROWS + 1:
            break
    return {'sheet': sheet.title, 'sheets': len(book.worksheets), 'rows': rows}


def _cell_text(value):
    import datetime
    if isinstance(value, datetime.datetime):
        return value.date().isoformat() if value.time() == datetime.time() else value.isoformat(sep=' ')
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _workbook_stdlib(data: bytes):
    import xml.etree.ElementTree as ET
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
          'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(i.file_size for i in archive.infolist()) > 400 * 1024 * 1024:
            raise ValueError('This workbook expands to more than 400 MB. Save the sheet as CSV and import that.')
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            for item in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', ns):
                shared.append(''.join(t.text or '' for t in item.iter('{%s}t' % ns['m'])))
        book = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = book.findall('m:sheets/m:sheet', ns)
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        target = next(r.get('Target') for r in rels if r.get('Id') == sheets[0].get('{%s}id' % ns['r']))
        target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        dates = _date_styles(archive, ns)
        rows = []
        for row in ET.fromstring(archive.read(target)).iter('{%s}row' % ns['m']):
            values = {}
            for cell in row.findall('m:c', ns):
                ref, kind, style = cell.get('r', ''), cell.get('t'), cell.get('s')
                column = _column(ref) if ref else len(values)
                v = cell.find('m:v', ns)
                text = v.text if v is not None and v.text is not None else ''
                if kind == 's' and text:
                    text = shared[int(text)]
                elif kind == 'inlineStr':
                    text = ''.join(t.text or '' for t in cell.iter('{%s}t' % ns['m']))
                elif kind == 'b':
                    text = 'true' if text == '1' else 'false'
                elif text and style is not None and int(style) in dates:
                    text = _serial_date(float(text))
                elif text and re.fullmatch(r'-?\d+\.0+', text):
                    text = text.split('.')[0]
                values[column] = text
            rows.append([values.get(i, '') for i in range(max(values) + 1)] if values else [])
            if len(rows) > MAX_ROWS + 1:
                break
        return {'sheet': sheets[0].get('name', 'Sheet1'), 'sheets': len(sheets), 'rows': rows}


def _column(ref):
    letters = re.match(r'[A-Z]+', ref).group(0)
    index = 0
    for ch in letters:
        index = index * 26 + ord(ch) - 64
    return index - 1


def _date_styles(archive, ns):
    """Cell styles whose number format is a date, so serial numbers become ISO dates."""
    import xml.etree.ElementTree as ET
    if 'xl/styles.xml' not in archive.namelist():
        return set()
    styles = ET.fromstring(archive.read('xl/styles.xml'))
    custom = {int(f.get('numFmtId')): f.get('formatCode', '') for f in styles.findall('m:numFmts/m:numFmt', ns)}
    builtin = set(range(14, 18)) | {22}
    xfs = styles.findall('m:cellXfs/m:xf', ns)
    out = set()
    for i, xf in enumerate(xfs):
        fid = int(xf.get('numFmtId', '0'))
        code = re.sub(r'"[^"]*"|\[[^\]]*\]', '', custom.get(fid, '')).lower()
        if fid in builtin or (fid in custom and re.search(r'[dy]', code) and 'h' not in code):
            out.add(i)
    return out


def _serial_date(serial):
    import datetime
    return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(serial))).isoformat()


def main():
    request = json.load(sys.stdin)
    op = request.get('op')
    try:
        if op == 'xlsx':
            reply = workbook(base64.b64decode(request['data']))
        elif op == 'drop':
            ensure_server()
            reply = drop(request['dataset'])
        else:
            ensure_server()
            source = request.get('source', {})
            if source.get('kind') == 'sample':
                database = load_sample(request['dataset'], source['path'])
            elif source.get('kind') == 'import':
                database = load_import(request['dataset'], source['path'])
            else:
                raise ValueError('Unknown dataset source.')
            reply = {'tables': describe(database)} if op == 'open' else query(database, request.get('sql', '')) if op == 'query' \
                else {'error': 'Unknown request.'}
    except Exception as error:  # Reported to the learner in plain words by the extension.
        reply = {'fatal': (str(error).strip() or type(error).__name__)[:600]}
    print(json.dumps(reply))


if __name__ == '__main__':
    main()
