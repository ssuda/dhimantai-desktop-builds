"""Run with Python and IPython inside the course image using disposable sessions."""
import json
import importlib.util
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest


RUNTIME = Path(__file__).resolve().parents[1] / 'media' / 'course'
COURSE = Path(__file__).resolve().parents[3] / 'content/courses/developing-stt-models/chapters/01-foundations.md'


class Session:
    def __init__(self, folder, env=None, prelude=''):
        source = f'import sys; sys.path.insert(0, {str(RUNTIME)!r}); import cells\n' + prelude + '\ncells.main()'
        self.process = subprocess.Popen([sys.executable, '-u', '-c', source], cwd=folder,
                                        env={**os.environ, **(env or {})}, text=True,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.messages = queue.Queue()
        def receive():
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        self.reader = threading.Thread(target=receive, daemon=True)
        self.reader.start()
        self.index = 0
        self.closed = False

    def send(self, **message):
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()

    def run(self, source, **options):
        self.index += 1
        self.send(action='run', id=str(self.index), language='python', source=source, **options)
        while True:
            message = self.messages.get(timeout=30)
            if message['kind'] == 'input': self.send(action='input', id=str(self.index), value='Asha')
            if message['kind'] == 'done': return message['execution']

    def close(self):
        if self.closed: return
        self.closed = True
        self.send(action='close')
        self.process.wait(timeout=10)
        self.reader.join(timeout=2)
        diagnostic = self.process.stderr.read()
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr): pipe.close()
        if self.process.returncode: raise AssertionError(diagnostic)


@unittest.skipUnless(sys.platform == 'linux' and any(Path(marker).is_file() for marker in ('/run/.containerenv', '/.dockerenv')),
                     'Run notebook runtime fixtures inside the Linux course container.')
class PythonNotebookTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)

    def session(self, **kwargs):
        session = Session(self.folder.name, **kwargs)
        self.addCleanup(session.close)
        return session

    def test_broken_shared_profile_does_not_block_cells_or_change_learner_files(self):
        profile = Path(self.folder.name) / 'shared-ipython'
        profile.mkdir()
        marker = profile / 'profile_default'
        marker.write_text('keep learner profile')
        session = self.session(env={'IPYTHONDIR': str(profile)})
        first = session.run('answer = 41\nprint(input("Name: "))', interactive=True)
        self.assertEqual(first['exit_code'], 0, first)
        self.assertEqual(first['stdout'], 'Name: Asha\n')
        self.assertEqual(first['stderr'], '')
        self.assertEqual(session.run('answer + 1')['stdout'], '42\n')
        self.assertEqual(marker.read_text(), 'keep learner profile')
        self.assertEqual(session.run('print(get_ipython().history_manager.hist_file)')['stdout'], ':memory:\n')
        temporary_profile = Path(session.run('print(get_ipython().ipython_dir)')['stdout'].strip())
        self.assertNotEqual(temporary_profile, profile)
        session.close()
        self.assertFalse(temporary_profile.exists())

    def test_initialization_failure_is_actionable_and_never_executes_the_cell(self):
        session = self.session(prelude="cells.tempfile.TemporaryDirectory = lambda **kw: (_ for _ in ()).throw(PermissionError('temporary storage is read-only'))")
        result = session.run('print("learner code ran")')
        self.assertEqual(result['exit_code'], 1)
        self.assertEqual(result['stdout'], '')
        self.assertIn('Your code did not run', result['stderr'])
        self.assertIn('Set up / rebuild course', result['stderr'])
        self.assertIn('PermissionError: temporary storage is read-only', result['stderr'])
        self.assertNotIn('Traceback', result['stderr'])

    def test_missing_dependency_has_recovery_steps_and_session_can_continue(self):
        session = self.session()
        result = session.run('import dhimantai_nonexistent_dependency\nprint("must not run")')
        self.assertEqual(result['exit_code'], 1)
        self.assertEqual(result['stdout'], '')
        self.assertIn('Python dependency could not be loaded', result['stderr'])
        self.assertIn('dhimantai_nonexistent_dependency', result['stderr'])
        self.assertIn('same environment', result['stderr'])
        self.assertIn('Runtime above the notebook → Set up / rebuild course', result['stderr'])
        self.assertIn('Notebook options (⋯) → Restart runtime', result['stderr'])
        self.assertIn('inspect the setup log', result['stderr'])
        self.assertNotIn('Traceback', result['stderr'])
        self.assertEqual(session.run('print("recovered")')['stdout'], 'recovered\n')
        error = session.run('1 / 0')
        self.assertEqual(error['exit_code'], 1)
        self.assertIn('ZeroDivisionError', error['stdout'] + error['stderr'])

    def test_missing_transformers_identifies_package_in_bounded_instructor_context(self):
        # Reproduce an absent package even when this test runs in the corrected course image.
        session = self.session(prelude='''
import importlib.abc
class MissingTransformers(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname == 'transformers':
            raise ModuleNotFoundError("No module named 'transformers'", name='transformers')
sys.meta_path.insert(0, MissingTransformers())
''')
        result = session.run('import hashlib, torch, transformers, json\nprint("must not run")'
                             if importlib.util.find_spec('torch') else 'import transformers\nprint("must not run")')
        self.assertEqual(result['exit_code'], 1, result)
        self.assertEqual(result['stdout'], '')
        self.assertIn("No module named 'transformers'", result['stderr'][:400])
        self.assertIn('Set up / rebuild course', result['stderr'])
        self.assertIn('same environment', result['stderr'])
        self.assertEqual(session.run('print("session still usable")')['stdout'], 'session still usable\n')

    @unittest.skipUnless(importlib.util.find_spec('torch') and importlib.util.find_spec('transformers'),
                         'requires the speech-to-text course dependencies')
    def test_instructor_run_record_with_real_dependencies_and_manifest(self):
        manifest = b'{"samples": []}\n'
        Path(self.folder.name, 'train_manifest.json').write_bytes(manifest)
        result = self.session().run('''import hashlib, torch, transformers, json
def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()[:12]
torch.manual_seed(42)
run_card = {
    'torch': torch.__version__,
    'transformers': transformers.__version__,
    'seed': 42,
    'model_revision': 'fixture-revision',
    'train_manifest_sha256': sha256_of('train_manifest.json'),
}
print(json.dumps(run_card))
''')
        self.assertEqual(result['exit_code'], 0, result)
        self.assertEqual(result['stderr'], '')
        card = json.loads(result['stdout'])
        self.assertEqual(card['torch'].split('+')[0], '2.9.1')
        self.assertEqual(card['transformers'], '4.57.6')
        self.assertEqual(card['seed'], 42)
        self.assertEqual(card['model_revision'], 'fixture-revision')
        self.assertEqual(card['train_manifest_sha256'], __import__('hashlib').sha256(manifest).hexdigest()[:12])

    def test_native_library_import_failure_is_distinct_from_a_learner_file_error(self):
        Path(self.folder.name, 'broken_native_library.py').write_text("raise OSError('libtorch_cpu.so could not be loaded')\n")
        session = self.session()
        result = session.run('import broken_native_library')
        self.assertEqual(result['exit_code'], 1)
        self.assertIn('Python dependency could not be loaded', result['stderr'])
        self.assertIn('libtorch_cpu.so', result['stderr'])
        self.assertNotIn('Traceback', result['stdout'] + result['stderr'])
        result = session.run("open('missing_student_file.txt')")
        self.assertIn('FileNotFoundError', result['stdout'] + result['stderr'])
        self.assertNotIn('Set up / rebuild course', result['stdout'] + result['stderr'])

    @unittest.skipUnless(importlib.util.find_spec('torch'), 'requires the course PyTorch dependency')
    def test_course_hardware_probe_on_real_cpu_pytorch(self):
        source = COURSE.read_text().split('```python\n', 1)[1].split('```', 1)[0]
        result = self.session().run(source)
        self.assertEqual(result['exit_code'], 0, result)
        self.assertIn('PyTorch:', result['stdout'])
        self.assertIn('CUDA available: False', result['stdout'])
        self.assertNotIn('GPU:', result['stdout'])
        self.assertEqual(result['stderr'], '')

    def test_course_hardware_probe_prints_gpu_details_when_cuda_is_available(self):
        source = COURSE.read_text().split('```python\n', 1)[1].split('```', 1)[0]
        # A protocol fixture covers the GPU branch; it is not physical-GPU acceptance.
        Path(self.folder.name, 'torch.py').write_text(
            "from types import SimpleNamespace\n__version__ = 'fixture'\n"
            "cuda = SimpleNamespace(is_available=lambda: True, get_device_name=lambda n: 'Fixture GPU', "
            "get_device_properties=lambda n: SimpleNamespace(total_memory=8 * 2**30))\n")
        result = self.session().run(source)
        self.assertEqual(result['exit_code'], 0, result)
        self.assertIn('CUDA available: True', result['stdout'])
        self.assertIn('GPU: Fixture GPU\nVRAM GiB: 8.0', result['stdout'])
        self.assertEqual(result['stderr'], '')


if __name__ == '__main__':
    import IPython  # Fail clearly if the test environment lacks the real notebook dependency.
    unittest.main()
