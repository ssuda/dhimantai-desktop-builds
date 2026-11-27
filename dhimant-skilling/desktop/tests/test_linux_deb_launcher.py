import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'linux', 'tests the installed Debian launcher')
class DebianLauncherTests(unittest.TestCase):
    def test_legacy_restart_and_node_invocations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher = root / 'dhimantai'
            shutil.copyfile(Path(__file__).resolve().parents[1] / 'linux-deb-launcher.sh', launcher)
            launcher.chmod(0o755)
            alias = root / 'linked launcher'
            alias.symlink_to(launcher)
            electron = root / 'dhimantai-electron'
            electron.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                                'print(json.dumps([os.getenv("ELECTRON_RUN_AS_NODE"), sys.argv[1:]]))\n')
            electron.chmod(0o755)
            old = subprocess.Popen(['true'])
            old.wait()
            for pid, args, expected in [
                (str(old.pid), [], None),
                (str(os.getpid()), [], '1'),
                ('', [], '1'),
                ('invalid', [], '1'),
                (str(old.pid), ['-e', 'a value with spaces'], '1'),
            ]:
                with self.subTest(pid=pid, args=args):
                    env = dict(os.environ, VSCODE_PID=pid, ELECTRON_RUN_AS_NODE='1')
                    output = subprocess.check_output([alias, *args], env=env)
                    self.assertEqual(json.loads(output), [expected, args])
