"""Call one function of the learner's main.py with literal arguments (public test cases, run locally).
Mirrors the sandbox driver in agent/course_projects/runtime/program.py; compares as Python values.

Usage: python3 -I pycall.py '<call>' '<expected repr>'   (cwd holds main.py)
"""
import ast
import json
import runpy
import sys
from pathlib import Path

if sys.platform != 'linux' or not any(Path(marker).is_file() for marker in ('/run/.containerenv', '/.dockerenv')):
    raise SystemExit('Host execution is disabled. Use the course container or a remote runtime.')


def expand_test_rows(value):
    """Expand a bounded literal test fixture before passing ordinary lists to student code."""
    if not isinstance(value, tuple) or len(value) != 2 or value[0] != 'generated_rows_v1':
        return value, False
    blocks = value[1]
    if not isinstance(blocks, list) or not 1 <= len(blocks) <= 8:
        raise ValueError('invalid generated test blocks')
    rows = []
    for count, template in blocks:
        if type(count) is not int or not 0 <= count <= 100000 - len(rows):
            raise ValueError('invalid generated row count')
        if isinstance(template, list):
            if len(template) > 8 or not all(type(x) in (int, str) for x in template):
                raise ValueError('invalid generated row')
            rows.extend([[index if arg == '$index' else arg for arg in template] for index in range(count)])
        elif type(template) is int:
            rows.extend([template] * count)
        else:
            raise ValueError('invalid generated value')
    return rows, True


def apply_test_call(function, args, kwargs):
    expanded = [expand_test_rows(arg) for arg in args]
    values = [value for value, _ in expanded]
    if not any(generated for _, generated in expanded):
        return function(*values, **kwargs)

    # Count Python work only in scaled fixtures. Ordinary small examples retain their normal time limit.
    remaining = 5000000
    def count_work(frame, event, arg):
        nonlocal remaining
        if event == 'line':
            remaining -= 1
            if remaining <= 0:
                raise RuntimeError('Work limit exceeded on the generated input')
        return count_work
    sys.settrace(count_work)
    try:
        return function(*values, **kwargs)
    finally:
        sys.settrace(None)

call = ast.parse(sys.argv[1], mode='eval').body
if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
    raise SystemExit('invalid test call')
args = [ast.literal_eval(a) for a in call.args]
kwargs = {k.arg: ast.literal_eval(k.value) for k in call.keywords}
namespace = runpy.run_path('main.py', run_name='learner_solution')
value = apply_test_call(namespace[call.func.id], args, kwargs)
try:
    equal = ast.literal_eval(sys.argv[2]) == value
except (ValueError, SyntaxError, TypeError):
    equal = repr(value) == sys.argv[2].strip()
with open('_dhimantai_value.json', 'w', encoding='utf-8') as handle:
    json.dump({'repr': repr(value), 'equal': equal}, handle)
