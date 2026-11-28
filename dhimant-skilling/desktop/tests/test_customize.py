import base64
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from customize import refresh_webview_csp, configure_app_bar, open_home_on_launch, hide_developer_activity, hide_developer_status


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

    def test_launch_opens_home_instead_of_the_last_project(self):
        main = ("\t\t\trestoreWindows = 'all'; // always reopen all windows when an update was applied\n"
            "\t\t\trestoreWindows = windowConfig?.restoreWindows || 'all'; // by default restore all windows\n"
            "\t\t\tif (!['preserve', 'all', 'folders', 'one', 'none'].includes(restoreWindows)) {\n"
            "\t\t\t\trestoreWindows = 'all'; // by default restore all windows\n")
        setting = ("\t\t\t\t'default': 'all',\n\t\t\t\t'scope': ConfigurationScope.APPLICATION,\n"
            "\t\t\t\t'description': localize('restoreWindows', \"Controls how windows are restored.\")\n")
        upstream_layout = Path.home() / '.cache/dhimantai-desktop/vscodium/vscode/src/vs/workbench/browser/layout.ts'
        sidebar = ("\t\t\t} else if (\n"
            "\t\t\t\tviewContainerToRestore !== this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id &&\n"
            "\t\t\t\tviewContainerToRestore !== this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.AuxiliaryBar)?.id\n"
            "\t\t\t) {\n"
            "\t\t\t\t// fallback to default viewlet otherwise if the viewlet is not a default viewlet\n"
            "\t\t\t\tviewContainerToRestore = this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id;\n"
            "\t\t\t}\n")
        if upstream_layout.exists():
            sidebar = upstream_layout.read_text()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            windows = root / 'src/vs/platform/windows/electron-main/windowsMainService.ts'
            contribution = root / 'src/vs/workbench/electron-browser/desktop.contribution.ts'
            layout = root / 'src/vs/workbench/browser/layout.ts'
            for path, text in ((windows, main), (contribution, setting), (layout, sidebar)):
                path.parent.mkdir(parents=True)
                path.write_text(text)
            open_home_on_launch(root)
            patched = windows.read_text()
            self.assertIn("windowConfig?.restoreWindows || 'none'", patched)
            self.assertIn("\t\t\t\trestoreWindows = 'none';", patched)
            # Relaunching after an applied update still returns the learner to their work.
            self.assertIn("restoreWindows = 'all'; // always reopen all windows when an update was applied", patched)
            self.assertIn("'default': 'none'", contribution.read_text())
            # Launch opens the Learning sidebar, not the Explorer.
            self.assertIn("viewContainerToRestore = 'workbench.view.extension.dhimantai-learning';", layout.read_text())
            self.assertNotIn('fallback to default viewlet', layout.read_text())
            with self.assertRaises(RuntimeError):
                open_home_on_launch(root)

    def test_new_and_existing_student_sidebar_pins(self):
        upstream = (
            "\tprivate getViewContainer(id: string): ViewContainer | undefined {\n"
            "return this.viewDescriptorService.getViewContainersByLocation(this.location);\n"
            "for (const viewContainer of viewContainers) {\n\t\t\tthis.addComposite(viewContainer);\n"
            "return JSON.parse(this.pinnedViewContainersValue);\n")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'src/vs/workbench/browser/parts/paneCompositeBar.ts'
            path.parent.mkdir(parents=True)
            path.write_text(upstream)
            hide_developer_activity(root)
            patched = path.read_text()
            self.assertIn("this.location !== ViewContainerLocation.Sidebar || id === 'workbench.view.extension.dhimantai-learning'", patched)
            self.assertIn("stored.filter(view => this.showsStudentRailItem(view.id)).map(view => ({ ...view, pinned: true }))", patched)
            self.assertIn("if (!this.showsStudentRailItem(viewContainer.id)) { continue; }", patched)
            self.assertIn("if (!this.showsStudentRailItem(id)) { return undefined; }", patched)
            self.assertIn("getViewContainersByLocation(this.location).filter(view => this.showsStudentRailItem(view.id))", patched)
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
