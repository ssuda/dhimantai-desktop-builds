"""Only the owned learning extension may update independently of the native app."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
spec=importlib.util.spec_from_file_location('desktop_build_updates',ROOT/'build.py')
build=importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
from customize import configure_learning_updates


class ExtensionUpdateTests(unittest.TestCase):
    def test_marketplace_does_not_override_the_owned_learning_update_feed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts'
            source.parent.mkdir(parents=True)
            source.write_text('\tprivate shouldAutoUpdateExtension(extension: IExtension): boolean {\n\t\treturn true;\n\t}')
            configure_learning_updates(root)
            self.assertIn("if (extension.identifier.id.toLowerCase() === 'optficial.dhimantai-learning') { return false; }",source.read_text())
            self.assertIn('return true;',source.read_text())
            with self.assertRaises(RuntimeError):configure_learning_updates(root)

    def test_only_learning_extension_can_update_and_native_feeds_remain_disabled(self):
        product=build.product()
        self.assertEqual(product['builtInExtensionsEnabledWithAutoUpdates'],['optficial.dhimantai-learning'])
        self.assertEqual(product['quality'],'stable')
        self.assertEqual(product['updateUrl'],'')

    def test_packaged_desktop_enables_extension_updates_and_keeps_client_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);vsix=root/'learning.vsix';config=root/'env.json'
            config.write_text(json.dumps({'LIVEKIT_TOKEN_URL':'https://api-staging.dhimant.ai','LIVEKIT_TOKEN_SECRET':'fixture-only'}))
            with zipfile.ZipFile(vsix,'w') as archive:
                archive.writestr('extension/package.json',json.dumps({'publisher':'optficial','name':'dhimantai-learning','version':'0.39.10','contributes':{}}))
            build.bundle_extension(root/'resources',vsix,['staging='+str(config)])
            bundle=root/'resources/app/extensions/optficial.dhimantai-learning'
            manifest=json.loads((bundle/'package.json').read_text())
            self.assertIs(manifest['contributes']['configurationDefaults']['dhimantai.autoUpdate'],True)
            self.assertEqual(manifest['contributes']['configurationDefaults']['workbench.activityBar.location'],'default')
            self.assertIs(manifest['contributes']['configurationDefaults']['workbench.activityBar.compact'],True)
            self.assertEqual(manifest['contributes']['configurationDefaults']['dhimantai.environment'],'staging')
            self.assertEqual(json.loads((bundle/'desktop-client.json').read_text())['staging']['signingKey'],'fixture-only')


if __name__=='__main__':unittest.main()
