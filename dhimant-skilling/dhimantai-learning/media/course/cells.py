"""Local notebook session. JSON lines carry control; learner descriptors never carry the protocol.

The course container is the workstation, not a grader. Files and database state survive cells;
Practice tests continue to use the separate disposable grading runtime.
"""
import ast
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from lab_scenarios import prepared_setup
from sql_runtime import PostgresRuntimeError

# Keep the transport on private descriptors before redirecting learner stdout/stderr.
transport = os.fdopen(os.dup(1), 'w', buffering=1)
control = os.fdopen(os.dup(0), 'r')
lock = threading.Lock()
requests = queue.Queue()
answers = queue.Queue()
active = None
stopping = None
process = None
root = Path.cwd().resolve()
sys.path[:0] = ['', str(root)]
namespace = {'__name__': '__main__'}
databases = contextlib.ExitStack()
lab = None
lab_setup = None
lab_failed = False
sql_db = None
shell_env = dict(os.environ)
uploaded_files = {}
LIMIT = 200000


def emit(**value):
    with lock:
        transport.write(json.dumps(value, default=str) + '\n')
        transport.flush()


def interrupt():
    global stopping
    if not active or stopping == active: return
    stopping = active
    if process and process.poll() is None:
        try:
            if os.name == 'posix': os.killpg(process.pid, signal.SIGINT)
            else: process.terminate()
        except ProcessLookupError:
            pass
    if active:
        answers.put(None)
        if os.name == 'posix':
            # killpg(1) becomes kill(-1): Linux broadcasts it across a PID namespace.
            # A standalone container can run this bridge as PID/group 1.
            if os.getpgrp() > 1: os.killpg(os.getpgrp(), signal.SIGINT)
            else: os.kill(os.getpid(), signal.SIGINT)
        else: __import__('_thread').interrupt_main()


def receive():
    try:
        for line in control:
            message = json.loads(line)
            action = message.get('action')
            if action == 'run': requests.put(message)
            elif action == 'input' and message.get('id') == active:
                answers.put(message.get('value'))
            elif action == 'stop': interrupt()
            elif action == 'close': break
    finally:
        if active: interrupt()
        requests.put(None)


def safe_file(name):
    path = (root / name).resolve()
    if not name or path == root or not path.is_relative_to(root):
        raise ValueError('Use a relative file path inside this notebook folder.')
    return path


def display(value=None, raw=False, **kwargs):
    data = value if raw and isinstance(value, dict) else {'text/plain': repr(value)}
    if not raw:
        for method, mime in [('_repr_html_', 'text/html'), ('_repr_png_', 'image/png'), ('_repr_svg_', 'image/svg+xml')]:
            fn = getattr(value, method, None)
            if callable(fn):
                result = fn()
                if isinstance(result, bytes): result = base64.b64encode(result).decode()
                if isinstance(result, str): data[mime] = result
    data = {k: v for k, v in data.items() if k in ('text/plain', 'text/html', 'image/png', 'image/jpeg', 'image/svg+xml')
            and isinstance(v, str) and len(v) <= 2_000_000}
    if data: emit(id=active, kind='display', data=data)


class CellInput(io.TextIOBase):
    def __init__(self, text, interactive):
        self.initial = io.StringIO(text)
        self.interactive = interactive
        self.buffered = ''
        self.eof = False
    def readable(self): return True
    def isatty(self): return self.interactive
    def readline(self, size=-1):
        if size == 0: return ''
        if self.buffered:
            end = self.buffered.find('\n') + 1 or len(self.buffered)
            if size >= 0: end = min(end, size)
            value, self.buffered = self.buffered[:end], self.buffered[end:]
            return value
        value = self.initial.readline(size)
        if value or not self.interactive or self.eof: return value
        emit(id=active, kind='input', prompt='Program input')
        value = answers.get()
        if value is None:
            self.eof = True
            return ''
        self.buffered = value if value.endswith('\n') else value + '\n'
        return self.readline(size)
    def read(self, size=-1):
        if not self.interactive: return self.initial.read(size)
        values, count = [], 0
        while size < 0 or count < size:
            line = self.readline(-1 if size < 0 else size - count)
            if not line: break
            values.append(line)
            count += len(line)
        return ''.join(values)


@contextlib.contextmanager
def capture(result):
    """Capture OS descriptors too: subprocess output is output, never a protocol message."""
    saved_input = os.dup(0)
    null = os.open(os.devnull, os.O_RDONLY); os.dup2(null, 0); os.close(null)
    streams = []
    for fd, kind in [(1, 'stdout'), (2, 'stderr')]:
        saved = os.dup(fd)
        read, write = os.pipe()
        os.dup2(write, fd); os.close(write)
        def drain(read=read, kind=kind, rid=active):
            import codecs
            decoder = codecs.getincrementaldecoder('utf-8')('replace')
            with os.fdopen(read, 'rb', buffering=0) as pipe:
                while chunk := pipe.read(4096):
                    value = decoder.decode(chunk)
                    remaining = max(0, LIMIT - len(result[kind]))
                    result['truncated'] |= len(value) > remaining
                    value = value[:remaining]
                    result[kind] += value
                    if value: emit(id=rid, kind='stream', stream=kind, text=value)
        thread = threading.Thread(target=drain, daemon=True); thread.start()
        streams.append((fd, saved, thread))
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = os.fdopen(os.dup(1), 'w', buffering=1)
    sys.stderr = os.fdopen(os.dup(2), 'w', buffering=1)
    try:
        yield
    finally:
        os.dup2(saved_input, 0); os.close(saved_input)
        sys.stdout.close(); sys.stderr.close()
        sys.stdout, sys.stderr = old_out, old_err
        for fd, saved, thread in streams:
            os.dup2(saved, fd); os.close(saved)
            thread.join(timeout=1)


def command(argv, data, env=None, *, timeout=None):
    """Interactive programs use a PTY on Unix, so prompts and line buffering work inside cells."""
    global process
    terminal = data.get('interactive') and os.name == 'posix'
    master = slave = None
    reader = None
    if terminal:
        import pty, termios
        master, slave = pty.openpty()
        flags = termios.tcgetattr(slave); flags[3] &= ~termios.ECHO; termios.tcsetattr(slave, termios.TCSANOW, flags)
    child = subprocess.Popen(argv, stdin=slave if terminal else subprocess.PIPE,
                             stdout=slave if terminal else None, stderr=slave if terminal else None,
                             env=env or shell_env, start_new_session=os.name == 'posix')
    process = child
    deadline = time.monotonic() + timeout if timeout is not None else None
    if terminal:
        os.close(slave)
        def drain():
            try:
                while chunk := os.read(master, 4096): os.write(1, chunk.replace(b'\r\n', b'\n'))
            except OSError: pass
        reader = threading.Thread(target=drain, daemon=True); reader.start()
    def send(value):
        if terminal: os.write(master, b'\x04' if value is None else value.encode())
        elif not child.stdin.closed:
            if value is None: child.stdin.close()
            else: child.stdin.write(value.encode()); child.stdin.flush()
    try:
        try:
            if data.get('stdin'): send(data['stdin'])
            if not data.get('interactive'): send(None)
        except (BrokenPipeError, OSError): pass
        while child.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError('Lab setup timed out. Restart the notebook runtime to retry.')
            try: value = answers.get(timeout=.05)
            except queue.Empty: continue
            try: send(None if value is None else value if value.endswith('\n') else value+'\n')
            except (BrokenPipeError, OSError): pass
        return child.returncode
    finally:
        if child.poll() is None:
            if os.name == 'posix': os.killpg(child.pid, signal.SIGKILL)
            else: child.kill()
            child.wait()
        if terminal:
            reader.join(timeout=1); os.close(master)
        elif not child.stdin.closed: child.stdin.close()
        process = None


def database(language, setup=''):
    global lab, lab_setup, lab_failed, sql_db
    if os.environ.get('DHIMANTAI_DATABASE_MODE') == 'service':
        # A Compose lab owns the database process and its broken/healthy starting
        # state. Bash must still work when PostgreSQL is down so the learner can fix it.
        import sql_runtime as sql
        if language == 'sql' and (sql_db is None or sql_db.closed):
            import psycopg
            sql_db = databases.enter_context(psycopg.connect(autocommit=True, connect_timeout=10))
        return sql
    if lab_failed:
        raise RuntimeError('The lab setup did not complete. Restart the notebook runtime to retry.')
    if language == 'pglab' and lab is not None and setup != lab_setup:
        raise RuntimeError('A different lab is already open. Restart the notebook runtime before changing challenges.')
    if language == 'pglab' and lab is None:
        setup = prepared_setup(setup)
    import sql_runtime as sql
    sql.TEMPLATE = sql.ensure_template()
    if language == 'pglab' and lab is None:
        # The notebook's Stop signal must interrupt the query, never its persistent database server.
        lab = databases.enter_context(sql.lab_server(detached=True))
        lab_setup = setup
        shell_env.update(sql._lab_env(*lab)); os.environ.update(shell_env)
        if setup:
            try:
                status = command(['bash', '-eo', 'pipefail', '-c', setup], {}, shell_env, timeout=120)
                if status: raise RuntimeError('The lab setup failed. Restart the notebook runtime to retry.')
            except BaseException:
                lab_failed = True
                databases.close()
                raise
    if language == 'sql' and lab is None and sql_db is None:
        # Publish notebook state only after the whole setup succeeds. A failed
        # dataset or connection must not leave the next Run on a partial database.
        with contextlib.ExitStack() as pending:
            host = pending.enter_context(sql.server(detached=True))
            name = sql._database(host)
            connection = pending.enter_context(sql._connect(host, name))
            if setup: connection.execute(setup)
            databases.enter_context(pending.pop_all())
            sql_db = connection
        shell_env.update(PGHOST=host,PGPORT='5432',PGUSER='learner',PGDATABASE=name,PATH=str(sql.BIN)+os.pathsep+shell_env.get('PATH',''))
        os.environ.update(shell_env)
    return sql


def execute(data):
    language, source = data['language'], data['source']
    if data.get('database') == 'lab': database('pglab', data.get('setup', ''))
    for file in data.get('files', []):
        path = safe_file(file['name']); path.parent.mkdir(parents=True, exist_ok=True)
        # Preserve edits made by cells unless the learner uploads a revised input file.
        if not path.exists() or (str(path) in uploaded_files and uploaded_files[str(path)] != file['content']):
            path.write_text(file['content'])
        uploaded_files[str(path)] = file['content']
    if source.startswith('%%writefile '):
        name, _, body = source.partition('\n')
        path = safe_file(name.removeprefix('%%writefile ').strip())
        path.parent.mkdir(parents=True, exist_ok=True); path.write_text(body)
        print('Saved ' + str(path.relative_to(root)))
        return 0
    if language in ('sql', 'pglab'):
        sql = database('sql' if language == 'sql' and os.environ.get('DHIMANTAI_DATABASE_MODE') == 'service'
                       else 'pglab' if data.get('database') == 'lab' else language, data.get('setup', ''))
        if language == 'sql':
            import psycopg
            if lab:
                connection = psycopg.connect(host=str(lab[0]), dbname='postgres', user='postgres', autocommit=True)
            else: connection = sql_db
            try:
                with connection.cursor() as cursor:
                    cursor.execute(source)
                    for result in sql._result_sets(cursor): print(sql.table(*result))
            except psycopg.Error as error:
                print('SQL query failed: ' + sql._error(error), file=sys.stderr)
                if isinstance(error, psycopg.errors.UndefinedTable):
                    print('Run the cells that create and load the required tables, then try this query again.', file=sys.stderr)
                return 1
            finally:
                if lab: connection.close()
            return 0
    if language in ('bash', 'zsh', 'pglab') or source.startswith(('%%bash\n', '%%sh\n', '%%zsh\n')):
        shell = 'zsh' if language == 'zsh' or source.startswith('%%zsh') else 'bash'
        if source.startswith('%%'): source = source.partition('\n')[2]
        # Persist cwd and exported variables without sourcing learner-controlled state as code.
        fd, name = tempfile.mkstemp(prefix='.cell-env-', dir=root)
        os.close(fd); state = Path(name)
        script = source + '\n'
        save = 'cell_exit=$?; pwd > "$DHIMANTAI_CELL_STATE.cwd"; env -0 > "$DHIMANTAI_CELL_STATE"; exit "$cell_exit"'
        env = {**shell_env, 'DHIMANTAI_CELL_STATE': str(state)}
        try:
            code = command([shell, '-c', 'trap ' + __import__('shlex').quote(save) + ' EXIT\n' + script], data, env)
            updated = {}
            for pair in state.read_bytes().split(b'\0'):
                key, _, value = pair.partition(b'=')
                if key and key != b'DHIMANTAI_CELL_STATE': updated[key.decode()] = value.decode(errors='replace')
            if updated:
                for key in shell_env.keys() - updated.keys(): os.environ.pop(key, None)
                shell_env.clear(); shell_env.update(updated)
            os.environ.update(shell_env)
            cwd = Path(str(state)+'.cwd')
            if cwd.exists() and Path(cwd.read_text().strip()).is_dir(): os.chdir(cwd.read_text().strip())
            return code
        finally:
            state.unlink(missing_ok=True); Path(str(state)+'.cwd').unlink(missing_ok=True)
    if language == 'python':
        old_input, old_argv = sys.stdin, sys.argv
        sys.stdin = CellInput(data.get('stdin', ''), data.get('interactive', False))
        sys.argv = ['<notebook cell>', *data.get('argv', [])]
        namespace['display'] = display
        try:
            try:
                from IPython.core.interactiveshell import InteractiveShell
                shell = InteractiveShell.instance(user_ns=namespace)
                shell.colors='NoColor'
                # This is a headless notebook; inline figures do not need a GUI event loop.
                shell.enable_gui=lambda gui=None: None
                shell.displayhook.write_output_prompt=lambda: None
                shell.display_pub.publish = lambda data, *args, **kwargs: display(data, raw=True)
                def formatted(data, *args, **kwargs):
                    if 'text/plain' in data: print(data['text/plain'])
                    if any(mime != 'text/plain' for mime in data): display(data, raw=True)
                shell.displayhook.write_format_data = formatted
                if 'matplotlib' in source or 'plt.' in source:
                    try: shell.run_line_magic('matplotlib','inline')
                    except (ImportError, KeyError): pass
                outcome = shell.run_cell(source, store_history=True)
                return 0 if outcome.success else 1
            except ModuleNotFoundError as error:
                if error.name not in ('IPython','IPython.core','IPython.core.interactiveshell'): raise
                if source.startswith('!'): return command(['bash', '-c', source[1:]], data)
                tree = ast.parse(source, '<notebook cell>')
                last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
                exec(compile(tree, '<notebook cell>', 'exec'), namespace)
                if last:
                    value = eval(compile(ast.Expression(last.value), '<notebook cell>', 'eval'), namespace)
                    if value is not None:
                        print(repr(value))
                        if any(callable(getattr(value, method, None)) for method in ('_repr_html_', '_repr_png_', '_repr_svg_')): display(value)
                return 0
        finally: sys.stdin, sys.argv = old_input, old_argv
    plans = {
        'javascript': ('main.js', [], ['node', 'main.js']),
        'typescript': ('main.ts', ['tsc', 'main.ts', '--target', 'ES2022', '--module', 'commonjs', '--noEmitOnError'], ['node', 'main.js']),
        'c': ('main.c', ['cc', '-std=c17', 'main.c', '-o', 'main', '-lm'], ['./main']),
        'rust': ('main.rs', ['rustc', '--edition=2021', 'main.rs', '-o', 'main'], ['./main']),
        'go': ('main.go', ['go', 'build', '-o', 'main', 'main.go'], ['./main']),
        'java': ('Main.java', ['javac', 'Main.java'], ['java', '-cp', '.', 'Main']),
    }
    filename, build, run = plans[language]
    tools=data.get('tools', {})
    if build: build=[tools.get({'cc':'cc','rustc':'rustc','go':'go','javac':'javac','tsc':'tsc'}[build[0]],build[0]), *build[1:]]
    if run[0] in ('node','java'): run=[tools.get(run[0],run[0]), *run[1:]]
    Path(filename).write_text(source)
    if language=='typescript' and Path('/usr/local/lib/node_modules/@types').is_dir(): build += ['--typeRoots','/usr/local/lib/node_modules/@types']
    if build:
        code = command(build, {})
        if code: return code
    # stdbuf makes prompts/logs observable even for programs with fully buffered C stdio.
    if os.name == 'posix' and shutil.which('stdbuf'): run = ['stdbuf', '-oL', '-eL', *run]
    return command([*run, *data.get('argv', [])], data)


def main():
    global active, stopping
    if os.name == 'posix':
        try: os.setsid()
        except PermissionError: pass
    threading.Thread(target=receive, daemon=True).start()
    try:
        while (data := requests.get()) is not None:
            active = data['id']; stopping = None
            while not answers.empty(): answers.get_nowait()
            result = dict(stdout='', stderr='', truncated=False, status='exited', exit_code=0)
            started = time.monotonic()
            with capture(result):
                try: result['exit_code'] = execute(data)
                except KeyboardInterrupt:
                    result.update(status='cancelled', exit_code=None)
                    print('Stopped.', file=sys.stderr)
                except PostgresRuntimeError as error:
                    result['exit_code'] = 1
                    print(str(error), file=sys.stderr)
                except BaseException:
                    result['exit_code'] = 1
                    traceback.print_exc()
            if stopping == active: result.update(status='cancelled', exit_code=None)
            result.update(duration_seconds=round(time.monotonic()-started, 3), command=data['language']+' notebook cell')
            emit(id=active, kind='done', execution=result)
            active = None
    finally:
        databases.close()


if __name__ == '__main__':
    main()
