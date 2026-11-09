"""Keep terminal cancellation and the execution deadline inside the container."""
import os
import json
from pathlib import Path
import re
import signal
import subprocess
import sys
import shlex
import threading
import time

action, job, *args = sys.argv[1:]
if not re.fullmatch(r'[0-9a-f-]{36}', job):
    raise SystemExit(2)
if action == 'state':
    # Inspect this terminal's foreground process group without sending anything to stdin.
    # This also works with an existing learner-edited .zshrc and requires no shell hooks.
    state = 'starting'
    marker = ('DHIMANTAI_TERMINAL_ID=' + job).encode()
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if marker not in (process / 'environ').read_bytes().split(b'\0'):
                continue
            stat = (process / 'stat').read_text()
            if stat[stat.index('(') + 1:stat.rindex(')')] != 'zsh':
                continue
            fields = stat[stat.rindex(')') + 2:].split()
            state = 'ready' if fields[2] == fields[5] and fields[0] == 'S' else 'busy'
            break
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    print(state)
    raise SystemExit(0)
pid = Path('/tmp', 'dhimantai-job-' + job)
cancelled = pid.with_suffix('.cancel')
def stop():
    try:
        os.killpg(int(pid.read_text()), signal.SIGKILL)
    except (FileNotFoundError, ProcessLookupError, ValueError):
        pass

if action == 'capture':
    directory = Path('/course/.dhimantai/jobs')
    spec = json.loads((directory / (job + '.json')).read_text())
    command = [spec['command'], *spec['args']]
    print(shlex.join(command), flush=True)
    started = time.monotonic()
    outputs = {'stdout': bytearray(), 'stderr': bytearray()}
    limit = 200000
    state = {'truncated': False, 'timed_out': False, 'interactive': False}
    try:
        child = subprocess.Popen(command, cwd=spec['cwd'], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as error:
        result = dict(status='toolchain_missing', exit_code=None, command=shlex.join(command),
                      stdout='', stderr=str(error), duration_seconds=time.monotonic()-started, truncated=False)
        temporary = directory / (job + '.result.tmp')
        temporary.write_text(json.dumps(result))
        temporary.replace(directory / (job + '.result.json'))
        print(error, file=sys.stderr, flush=True)
        raise SystemExit(127)
    pid.write_text(str(child.pid))

    def copy(source, target, key):
        while chunk := source.read1(4096):
            remaining = max(0, limit - len(outputs[key]))
            outputs[key].extend(chunk[:remaining])
            state['truncated'] |= len(chunk) > remaining
            target.buffer.write(chunk)
            target.flush()

    def input_lines():
        try:
            while child.poll() is None:
                line = sys.stdin.buffer.readline()
                if not line:
                    child.stdin.close()
                    return
                state['interactive'] = True
                child.stdin.write(line)
                child.stdin.flush()
        except (BrokenPipeError, ValueError):
            pass

    threads = [threading.Thread(target=copy, args=(child.stdout, sys.stdout, 'stdout')),
               threading.Thread(target=copy, args=(child.stderr, sys.stderr, 'stderr'))]
    for thread in threads:
        thread.start()
    if spec['stdin']:
        child.stdin.write(spec['stdin'].encode())
        child.stdin.close()
    else:
        threading.Thread(target=input_lines, daemon=True).start()
    def interrupt(_signal, _frame):
        stop()
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        if cancelled.exists():
            stop()
        try:
            code = child.wait(timeout=spec['timeout'])
        except subprocess.TimeoutExpired:
            state['timed_out'] = True
            stop()
            code = child.wait()
        for thread in threads:
            thread.join(timeout=2)
            state['truncated'] |= thread.is_alive()
        result = dict(status='timeout' if state['timed_out'] else 'exited',
                      exit_code=None if state['timed_out'] else code, command=shlex.join(command),
                      stdout=outputs['stdout'].decode(errors='replace'), stderr=outputs['stderr'].decode(errors='replace'),
                      duration_seconds=time.monotonic()-started, truncated=state['truncated'], interactive_input=state['interactive'])
        temporary = directory / (job + '.result.tmp')
        temporary.write_text(json.dumps(result))
        temporary.replace(directory / (job + '.result.json'))
    finally:
        pid.unlink(missing_ok=True)
        cancelled.unlink(missing_ok=True)
    # Avoid waiting for the daemon reader of the interactive terminal at interpreter shutdown.
    os._exit(124 if state['timed_out'] else code if code >= 0 else 128 - code)
elif action == 'stop':
    cancelled.touch()
    stop()
else:
    timeout = float(args.pop(0))
    child = subprocess.Popen(args, start_new_session=True)
    try:
        pid.write_text(str(child.pid))
        if cancelled.exists(): stop()
        try:
            result = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop()
            child.wait()
            result = 124
    finally:
        pid.unlink(missing_ok=True)
        cancelled.unlink(missing_ok=True)
    raise SystemExit(result if result >= 0 else 128 - result)
