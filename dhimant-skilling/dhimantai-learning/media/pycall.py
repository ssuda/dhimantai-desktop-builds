"""Call one function of the learner's main.py with literal arguments (public test cases, run locally).
Mirrors the sandbox driver in agent/course_projects/runtime/program.py; compares as Python values.

Usage: python3 -I pycall.py '<call>' '<expected repr>'   (cwd holds main.py)
"""
import ast
import json
import runpy
import sys

call = ast.parse(sys.argv[1], mode='eval').body
if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
    raise SystemExit('invalid test call')
args = [ast.literal_eval(a) for a in call.args]
kwargs = {k.arg: ast.literal_eval(k.value) for k in call.keywords}
namespace = runpy.run_path('main.py', run_name='learner_solution')
value = namespace[call.func.id](*args, **kwargs)
try:
    equal = ast.literal_eval(sys.argv[2]) == value
except (ValueError, SyntaxError, TypeError):
    equal = repr(value) == sys.argv[2].strip()
with open('_dhimantai_value.json', 'w', encoding='utf-8') as handle:
    json.dump({'repr': repr(value), 'equal': equal}, handle)
