import base64
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from customize import refresh_webview_csp, configure_app_bar


class WebviewCspTests(unittest.TestCase):
    def test_native_app_bar_patch_fails_closed_if_upstream_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'src/vs/workbench/browser/parts/activitybar/activitybarPart.ts'
            path.parent.mkdir(parents=True)
            path.write_text("import { GlobalCompositeBar } from '../globalCompositeBar.js';\n")
            configure_app_bar(root)
            self.assertIn('DhimantaiAppBar as GlobalCompositeBar', path.read_text())
            with self.assertRaises(RuntimeError):
                configure_app_bar(root)

    def test_hash_matches_the_changed_script_without_relaxing_policy(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'index.html'
            script = '\n  window.capture = true;\n'
            path.write_text('script-src \'sha256-stale\' \'self\';<script async type="module">' + script + '</script>')
            refresh_webview_csp(path)
            expected = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
            self.assertIn("script-src 'sha256-" + expected + "' 'self'", path.read_text())
            self.assertNotIn('unsafe-inline', path.read_text())


if __name__ == '__main__':
    unittest.main()
