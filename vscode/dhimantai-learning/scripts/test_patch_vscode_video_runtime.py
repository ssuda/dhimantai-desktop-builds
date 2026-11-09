"""Exercise application replacement and rollback without touching an installed app."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('video_runtime', Path(__file__).with_name('patch-vscode-video-runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.app, self.prepared = self.root / 'Code.app', self.root / 'prepared.app'
        for app, content in [(self.app, b'original'), (self.prepared, b'repaired')]:
            for name in [runtime.EXECUTABLE, runtime.RUNTIME]:
                path = app / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
        self.backup, self.receipt_path = runtime.paths(self.app)
        self.receipt = {
            'originalExecutableSha256': runtime.digest(self.app / runtime.EXECUTABLE),
            'patchedExecutableSha256': runtime.digest(self.prepared / runtime.EXECUTABLE),
            'patchedRuntimeSha256': runtime.digest(self.prepared / runtime.RUNTIME),
        }

    def apply(self):
        runtime.install_patch(self.app, self.prepared, self.backup, self.receipt_path, self.receipt)

    def test_apply_and_restore_preserve_original_bytes(self):
        self.apply()
        self.assertEqual((self.app / runtime.EXECUTABLE).read_bytes(), b'repaired')
        self.assertEqual((self.backup / runtime.EXECUTABLE).read_bytes(), b'original')
        with patch.object(runtime, 'running', return_value=[]), patch.object(runtime, 'run'):
            runtime.restore(self.app, self.backup, self.receipt_path)
        self.assertEqual((self.app / runtime.EXECUTABLE).read_bytes(), b'original')
        self.assertFalse(self.backup.exists())
        self.assertFalse(self.receipt_path.exists())

    def test_second_rename_failure_rolls_back_original(self):
        rename = Path.rename
        def fail_install(path, target):
            if path == self.prepared:
                raise OSError('simulated filesystem failure')
            return rename(path, target)
        with patch.object(Path, 'rename', fail_install), self.assertRaisesRegex(OSError, 'filesystem'):
            self.apply()
        self.assertEqual((self.app / runtime.EXECUTABLE).read_bytes(), b'original')
        self.assertFalse(self.backup.exists())
        self.assertFalse(self.receipt_path.exists())

    def test_existing_backup_is_never_overwritten(self):
        self.backup.mkdir()
        (self.backup / 'keep').write_text('unrelated')
        with self.assertRaises(FileExistsError):
            self.apply()
        self.assertEqual((self.backup / 'keep').read_text(), 'unrelated')
        self.assertEqual((self.app / runtime.EXECUTABLE).read_bytes(), b'original')

    def test_running_app_is_detected_without_matching_script_arguments(self):
        listing = f'100 {self.app}/Contents/MacOS/Code\n101 {self.app}/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper\n102 /usr/bin/python3\n'
        with patch.object(runtime.subprocess, 'check_output', return_value=listing):
            self.assertEqual(runtime.running(self.app), [100, 101])
            with self.assertRaisesRegex(RuntimeError, 'running'):
                runtime.require_closed(self.app)

    def test_restore_refuses_to_overwrite_an_upstream_update(self):
        self.apply()
        (self.app / runtime.EXECUTABLE).write_bytes(b'new upstream release')
        with patch.object(runtime, 'running', return_value=[]), self.assertRaisesRegex(RuntimeError, 'changed since'):
            runtime.restore(self.app, self.backup, self.receipt_path)
        self.assertEqual((self.app / runtime.EXECUTABLE).read_bytes(), b'new upstream release')
        self.assertTrue(self.backup.exists())

    def test_restore_recovers_interruption_before_installing_prepared_copy(self):
        self.receipt_path.write_text(json.dumps(self.receipt))
        self.app.rename(self.backup)
        with patch.object(runtime, 'running', return_value=[]), patch.object(runtime, 'run'):
            runtime.restore(self.app, self.backup, self.receipt_path)
        self.assertEqual((self.app / runtime.EXECUTABLE).read_bytes(), b'original')
        self.assertFalse(self.receipt_path.exists())

    def test_restore_recovers_interruption_before_first_rename(self):
        self.receipt_path.write_text(json.dumps(self.receipt))
        with patch.object(runtime, 'running', return_value=[]), patch.object(runtime, 'run'):
            runtime.restore(self.app, self.backup, self.receipt_path)
        self.assertEqual((self.app / runtime.EXECUTABLE).read_bytes(), b'original')
        self.assertFalse(self.receipt_path.exists())


if __name__ == '__main__':
    unittest.main()
