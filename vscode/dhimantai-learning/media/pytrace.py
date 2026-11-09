"""Record a learner program's execution, line by line, for the "Watch it run" stepper.

Usage: python3 -I pytrace.py <limit> main.py [argv...]   (cwd holds main.py and the input files)
Writes the program's own stdout/stderr through unchanged and a JSON trace to the file named in
DHIMANTAI_TRACE_OUT. Only frames from main.py are recorded; values are short reprs, never objects.
"""
import json
import os
import runpy
import sys

LIMIT = int(sys.argv[1])
TARGET = os.path.abspath(sys.argv[2])
OUT = os.environ['DHIMANTAI_TRACE_OUT']
steps = []
stopped = None


class TraceLimit(BaseException):
    pass


def short(value):
    try:
        text = repr(value)
    except Exception:
        text = '<' + type(value).__name__ + '>'
    return text if len(text) <= 80 else text[:77] + '...'


def visible(frame):
    names = {}
    for name, value in frame.f_locals.items():
        if name.startswith('__') or callable(value) and not isinstance(value, (list, dict, set, tuple)):
            continue
        if type(value).__name__ == 'module':
            continue
        names[name] = short(value)
    return names


def depth(frame):
    level = 0
    while frame is not None:
        if frame.f_code.co_filename == TARGET:
            level += 1
        frame = frame.f_back
    return level - 1


def tracer(frame, event, arg):
    global stopped
    if frame.f_code.co_filename != TARGET:
        return None
    if event in ('line', 'return', 'exception'):
        if len(steps) >= LIMIT:
            stopped = 'limit'
            raise TraceLimit()
        step = {'line': frame.f_lineno, 'event': event, 'function': frame.f_code.co_name,
                'depth': depth(frame), 'locals': visible(frame),
                'output': sys.stdout.length if isinstance(sys.stdout, Capture) else None}
        if event == 'return':
            step['value'] = short(arg)
        if event == 'exception':
            step['exception'] = arg[0].__name__ + ': ' + short(arg[1])[:200]
        steps.append(step)
    return tracer


class Capture:
    """Mirror stdout so each step knows how much output existed when it ran."""
    def __init__(self, stream):
        self.stream, self.text = stream, []
        self.length = 0
    def write(self, data):
        self.text.append(data)
        self.length += len(data)
        return self.stream.write(data)
    def flush(self):
        self.stream.flush()
    def __getattr__(self, name):
        return getattr(self.stream, name)


sys.stdout = Capture(sys.stdout)
sys.argv = [TARGET] + sys.argv[3:]
sys.path.insert(0, os.path.dirname(TARGET))
error = None
sys.settrace(tracer)
try:
    runpy.run_path(TARGET, run_name='__main__')
except TraceLimit:
    pass
except SystemExit as exit:
    error = None if exit.code in (None, 0) else 'SystemExit: ' + str(exit.code)
except BaseException as exc:
    error = type(exc).__name__ + ': ' + str(exc)[:300]
    raise
finally:
    sys.settrace(None)
    output = ''.join(sys.stdout.text)
    with open(OUT, 'w', encoding='utf-8') as handle:
        json.dump({'steps': steps, 'stopped': stopped, 'error': error, 'stdout': output}, handle)
