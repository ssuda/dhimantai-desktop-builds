"""Installed formative checker. Each program variant runs in a separate disposable interpreter."""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Independent reference behavior is only used to check a learner's test, including before a repair.
REFERENCES = {
    'trail-log': ('trips', 'record_stop', '''
def record_stop(name, stops=None):
    result = [] if stops is None else stops
    result.append(name)
    return list(result)
'''),
    'print-batches': ('labels', 'add', '''
class Batch:
    def __init__(self):
        self.labels = []

    def add(self, label):
        self.labels.append(label)
        return len(self.labels)
'''),
    'ferry-fares': ('fares', 'fare', '''
def fare(age):
    return 5 if age > 12 else 2
'''),
    'meter-blocks': ('meter', 'blocks', '''
def blocks(minutes):
    return (minutes + 29) // 30
'''),
}

BEHAVIOR = {
    'trail-log': '''
previous = ['Depot']
assert record_stop('A') == ['A']
assert record_stop('B', previous) == ['Depot', 'B'] and previous == ['Depot', 'B']
assert record_stop('C') == ['C']
assert record_stop('B', previous) == ['Depot', 'B', 'B']
''',
    'print-batches': '''
one, two = Batch(), Batch()
assert one.labels == two.labels == []
assert one.add('A') == 1 and one.add('A') == 2
assert two.add('B') == 1 and one.add('C') == 3
assert two.labels == ['B'] and one.labels == ['A','A','C']
''',
    'ferry-fares': 'assert [fare(n) for n in (0, 3, 11, 12, 13, 35, 70)] == [2, 2, 2, 2, 5, 5, 5]',
    'meter-blocks': 'assert [blocks(n) for n in (0, 1, 29, 30, 31, 45, 60, 61, 301)] == [0, 1, 1, 1, 2, 2, 2, 3, 11]',
}

# Match a real assertion failure in the learner's test to the same passing test on the reference.
# Only a test that exercised the public operation on the buggy baseline can establish the regression.
TEST_RUNNER = '''
import json, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
module, symbol = sys.argv[1:]
class Evidence(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.passed, self.caught = [], []
    def startTest(self, test):
        super().startTest(test)
        self.called = False
        def observe(frame, event, arg):
            if event == 'call' and frame.f_globals.get('__name__') == module and frame.f_code.co_name == symbol:
                self.called = True
        sys.setprofile(observe)
    def stopTest(self, test):
        sys.setprofile(None)
        super().stopTest(test)
    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed.append(test.id())
    def assertion(self, test, err):
        frame = err[2]
        while frame and frame.tb_frame.f_globals.get('__name__') != 'test_regression':
            frame = frame.tb_next
        if self.called and frame and issubclass(err[0], AssertionError):
            self.caught.append(test.id())
    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.assertion(test, err)
    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err:
            self.assertion(test, err)
suite = unittest.defaultTestLoader.loadTestsFromName('test_regression')
result = Evidence()
suite.run(result)
valid = result.testsRun > 0 and not (result.errors or result.skipped or result.expectedFailures or result.unexpectedSuccesses)
if result.errors:
    problem = 'The suite raised an error. Run python -m unittest test_regression to inspect the traceback.'
elif result.skipped or result.expectedFailures or result.unexpectedSuccesses:
    problem = 'Run the regression as an active test without a skip or expected-failure marker.'
elif not result.testsRun:
    problem = 'No unittest test methods ran in test_regression.py.'
else:
    problem = ''
Path('.check-result').write_text(json.dumps(dict(ok=bool(valid and result.wasSuccessful()), passed=result.passed, caught=result.caught if valid else [], problem=problem)))
'''


def run_variant(files, module, source, program, args=()):
    root = Path.cwd().resolve()
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for name in files:
            local = root / name
            if local.suffix != '.py' or not local.is_file() or not local.resolve().is_relative_to(root) or local.is_symlink():
                continue
            target = work / local.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(local, target)
        (work / (module + '.py')).write_text(source)
        try:
            child = subprocess.run([sys.executable, '-I', '-B', '-c', program, *args], cwd=work,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
            receipt = work / '.check-result'
            if child.returncode == 0 and receipt.is_file() and receipt.stat().st_size < 64000:
                result = json.loads(receipt.read_text())
                if isinstance(result, dict):
                    return result
        except subprocess.TimeoutExpired:
            return {'problem': 'The program exceeded the check time limit.'}
        except (ValueError, OSError):
            pass
        return {'problem': 'The run stopped before it produced a test result.'}


def regression_check(files, module, symbol, original, reference, current, repair):
    if 'test_regression.py' not in files:
        return False, False, 'Write your regression in test_regression.py.'

    def run_tests(source):
        return run_variant(files, module, source, TEST_RUNNER, (module, symbol))

    before = run_tests(original)
    if not before.get('caught'):
        return False, False, before.get('problem') or 'Your test needs to exercise the public API and fail an assertion on the original bug.'
    after = run_tests(reference)
    witnesses = set(before['caught']).intersection(after.get('passed', []))
    if not after.get('ok') or not witnesses:
        return False, False, after.get('problem') or 'Run the same test against the published contract and check what it expects.'
    message = 'Your regression caught the original bug and passed on reference behavior.'
    if not repair:
        return True, False, message
    actual = run_tests(current)
    green = bool(actual.get('ok') and witnesses.intersection(actual.get('passed', [])))
    detail = 'Your suite passed on your repair.' if green else actual.get('problem') or 'Your suite still needs to pass on your repair.'
    return True, green, message + ' ' + detail


def check(project, original, files):
    module, symbol, reference = REFERENCES[project]
    current = Path(module + '.py').read_text()
    verify = ("from pathlib import Path\nimport sys\nsys.path.insert(0, str(Path.cwd()))\n"
              f"from {module} import *\n" + BEHAVIOR[project] + """\nPath('.check-result').write_text('{"ok":true}')""")
    repair = run_variant(files, module, current, verify).get('ok') is True
    regression, green, message = regression_check(files, module, symbol, original, reference, current, repair)
    print('Repair ' + ('passed the behavior checks.' if repair else 'does not yet meet the public contract.'))
    print(message)
    if green:
        return 0
    if repair:
        return 12 if regression else 10
    return 11 if regression else 1


if __name__ == '__main__':
    project, original, paths = sys.argv[1:]
    sys.exit(check(project, original, json.loads(paths)))
