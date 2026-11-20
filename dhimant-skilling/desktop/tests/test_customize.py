import base64
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from customize import refresh_webview_csp, configure_app_bar, hide_developer_activity, hide_developer_status


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

    def test_new_profiles_do_not_pin_developer_tools(self):
        upstream = (
            "\t\t\t// Pin it by default if it is new\n"
            "\t\t\tconst cachedViewContainer = this.cachedViewContainers.filter(({ id }) => id === viewContainer.id)[0];\n"
            "\t\t\tif (!cachedViewContainer) {\n"
            "\t\t\t\tthis.compositeBar.pin(viewContainer.id);\n"
            "\t\t\t}\n")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'src/vs/workbench/browser/parts/paneCompositeBar.ts'
            path.parent.mkdir(parents=True)
            path.write_text(upstream)
            hide_developer_activity(root)
            patched = path.read_text()
            for container in ('search', 'scm', 'debug', 'extensions'):
                self.assertIn(f"'workbench.view.{container}'", patched)
            self.assertNotIn('explorer', patched)
            self.assertIn('this.compositeBar.unpin(viewContainer.id);', patched)
            self.assertIn('} else if (!cachedViewContainer) {\n\t\t\t\tthis.compositeBar.pin(viewContainer.id);\n\t\t\t}', patched)
            with self.assertRaises(RuntimeError):
                hide_developer_activity(root)

    def test_new_profiles_hide_developer_status_items(self):
        upstream = "\t\tconst hiddenRaw = this.storageService.get(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);\n"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'src/vs/workbench/browser/parts/statusbar/statusbarModel.ts'
            path.parent.mkdir(parents=True)
            path.write_text(upstream)
            hide_developer_status(root)
            self.assertIn("StorageScope.PROFILE, '[\"status.problems\",\"status.host\"]')", path.read_text())
            with self.assertRaises(RuntimeError):
                hide_developer_status(root)

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
