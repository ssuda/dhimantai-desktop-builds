"""One real shell per notebook language. Each submission has its own I/O and exit status."""
import contextlib
import os
from pathlib import Path
import pty
import queue
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import termios
import time


class CellShell:
    def __init__(self, shell, env):
        # A session leader can acquire a cell's temporary PTY as its controlling
        # terminal and receive SIGHUP when that cell finishes. Give the shell a
        # process group for cancellation, within the bridge's existing session.
        argv = [shell, '-s']
        group = {}
        if sys.version_info >= (3, 11):
            group['process_group'] = 0
        else:
            argv = [sys.executable, '-c',
                    'import os,sys; os.setpgid(0,0); os.execvp(sys.argv[1],sys.argv[1:])', *argv]
        self.child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, env=env, **group)
        if shell == 'bash':
            self.child.stdin.write(b'shopt -s expand_aliases\n')
            self.child.stdin.flush()
        self.status = 0
        self.cwd = Path.cwd()
        self.environment = dict(env)
        self.database_pipefail = False

    def close(self):
        try:
            os.killpg(self.child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.child.stdin.close()
        self.child.wait()

    def run(self, source, data, answers, env, *, database_bash=False):
        # Commands reach the shell through its control pipe. A program reading stdin
        # sees only its own supplied input or PTY, never future notebook commands.
        with tempfile.TemporaryDirectory(prefix='notebook-shell-', dir='/tmp') as temp, contextlib.ExitStack() as cleanup:
            folder = Path(temp)
            script = folder / 'command'
            script.write_text(source + '\n')
            io = cleanup.enter_context(selectors.DefaultSelector())
            def own(fd):
                cleanup.callback(os.close, fd)
                return fd
            if data.get('interactive'):
                master, slave = map(own, pty.openpty())
                if not database_bash:
                    flags = termios.tcgetattr(slave)
                    flags[3] &= ~termios.ECHO
                    termios.tcsetattr(slave, termios.TCSANOW, flags)
                io.register(master, selectors.EVENT_READ, 1)
                device = shlex.quote(os.ttyname(slave))
                redirects = f'< {device} > {device} 2>&1'
                if data.get('stdin'):
                    # The terminal releases a line only at Enter; add it so `read` sees the last value.
                    stdin = data['stdin']
                    os.write(master, (stdin if stdin.endswith('\n') else stdin + '\n').encode())
            else:
                master = None
                (folder / 'stdin').write_text(data.get('stdin', ''))
                redirects = f'< {temp}/stdin'
                for stream, fd in [('stdout', 1), ('stderr', 2)]:
                    fifo = folder / stream
                    os.mkfifo(fifo)
                    io.register(own(os.open(fifo, os.O_RDWR | os.O_NONBLOCK)), selectors.EVENT_READ, fd)
                    redirects += f' {fd}> {fifo}'

            # A Python cell or a different shell may have changed the shared cwd or exports.
            prelude = []
            if Path.cwd() != self.cwd:
                logical = env.get('PWD', '')
                cwd = logical if logical and os.path.realpath(logical) == os.getcwd() else os.getcwd()
                prelude.append('builtin cd -- ' + shlex.quote(cwd))
            for key in self.environment.keys() | env.keys():
                if (key in ('PWD','OLDPWD','SHLVL','_') or not key.isascii()
                        or not key.isidentifier() or self.environment.get(key) == env.get(key)):
                    continue
                prelude.append('export ' + key + '=' + shlex.quote(env[key]) if key in env else 'unset ' + key)
            # Preserve $? on entry to the next user command. The status, cwd and
            # exported environment are control data; ordinary output stays on its own descriptors.
            invoke = '. ' + shlex.quote(str(script))
            if database_bash:
                if not self.database_pipefail:
                    prelude.append('set -o pipefail')
                    self.database_pipefail = True
                # Snapshot $? and PIPESTATUS together, before another command
                # overwrites them. Bash excludes pipelines handled by if or ||.
                record_pipeline = f'case ${{#PIPESTATUS[@]}} in 1) ;; *) printf "%s\\n" "$?" >> {temp}/errors ;; esac'
                prelude.append(f'if [[ -z $(trap -p ERR) ]]; then trap {shlex.quote(record_pipeline)} ERR; fi')
            control = '\n'.join(prelude + [
                '{', f'if (exit {self.status}); then {invoke}; else {invoke}; fi',
                f'printf "%s" "$?" > {temp}/status',
                *([f'if [[ $(trap -p ERR) == *"{temp}/errors"* ]]; then trap - ERR; fi'] if database_bash else []),
                f'builtin pwd -L > {temp}/cwd', f'command env -0 > {temp}/env',
                f': > {temp}/done', '} ' + redirects, '',
            ])
            self.child.stdin.write(control.encode())
            self.child.stdin.flush()
            drain_until = None
            while True:
                finished = (folder / 'done').exists() or self.child.poll() is not None
                if finished and drain_until is None:
                    # A background process may keep writing after the prompt returns.
                    drain_until = time.monotonic() + 0.2
                events = io.select(0 if finished else 0.03)
                for key, _ in events:
                    chunk = os.read(key.fd, 65536)
                    if chunk:
                        os.write(key.data, chunk.replace(b'\r\n', b'\n') if master is not None else chunk)
                if finished and (not events or time.monotonic() >= drain_until):
                    break
                if master is not None:
                    try: value = answers.get_nowait()
                    except queue.Empty: continue
                    os.write(master, b'\x04' if value is None else (value.rstrip('\n') + '\n').encode())

            if (folder / 'done').exists():
                self.status = int((folder / 'status').read_text()) % 256
                errors = folder / 'errors'
                cell_status = self.status
                if database_bash and cell_status == 0 and errors.exists():
                    cell_status = int(errors.read_text().splitlines()[0]) % 256
                    os.write(2, f'An earlier pipeline in this cell exited with status {cell_status}.\n'.encode())
                logical = (folder / 'cwd').read_text().removesuffix('\n')
                if os.path.isdir(logical):
                    os.chdir(logical)
                self.cwd = Path.cwd()
                updated = dict(pair.split('=', 1) for pair in os.fsdecode((folder / 'env').read_bytes()).split('\0') if '=' in pair)
                for key in env.keys() - updated.keys():
                    os.environ.pop(key, None)
                env.clear()
                env.update(updated)
                os.environ.update(updated)
                self.environment = updated
                return cell_status
            status = self.child.wait()
            return status if status >= 0 else 128 - status
