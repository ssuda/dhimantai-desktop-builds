"""Own one course debug server by PID and process start time; keep learner stdin exact."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parent
pidfile = root / 'debug-server.pid'


def started(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, IndexError):
        return None


def stop():
    if pidfile.exists():
        pid, stamp = json.loads(pidfile.read_text())
        if stamp and started(pid) == stamp:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        pidfile.unlink(missing_ok=True)


def listening():
    for name in ('tcp', 'tcp6'):
        p = Path('/proc/net') / name
        if p.exists():
            for line in p.read_text().splitlines()[1:]:
                parts = line.split()
                if parts[1].endswith(':162E') and parts[3] == '0A':  # port 5678
                    return True
    return False


if sys.argv[1:] == ['stop']:
    stop()
elif sys.argv[1:] == ['start']:
    if listening():
        sys.exit('Another debugger is using this course. Stop it before starting this cell.')
    command = json.loads((root / 'debug-command.json').read_text())
    with (root / 'stdin.txt').open('rb') as stdin, (root / 'debug-server.log').open('wb') as output:
        process = subprocess.Popen(command, cwd=root, stdin=stdin, stdout=output, stderr=output, start_new_session=True)
    pidfile.write_text(json.dumps([process.pid, started(process.pid)]))
    for _ in range(100):
        if process.poll() is not None:
            stop()
            sys.exit((root / 'debug-server.log').read_text(errors='replace')[-1500:] or 'Debugger exited before connecting.')
        if listening():
            print('ready')
            break
        time.sleep(0.1)
    else:
        stop()
        sys.exit('Debugger startup timed out. Retry explicitly after checking the runtime.')
else:
    sys.exit('Expected start or stop')
