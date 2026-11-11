import base64
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import macos_credentials as credentials
import macos_release as release
import build

ENV = dict(MACOS_SIGNING_IDENTITY='Developer ID Application: Example Ltd (ABCDEFGHIJ)',
           APPLE_TEAM_ID='ABCDEFGHIJ', MACOS_NOTARY_KEYCHAIN_PROFILE='test-profile',
           MACOS_SIGNING_KEYCHAIN='/private/test.keychain-db')
CI_ENV = dict(ENV, MACOS_CERTIFICATE_P12_BASE64=base64.b64encode(b'test-cert').decode(),
              MACOS_CERTIFICATE_PASSWORD='private-password', APPLE_ID='test@example.invalid',
              APPLE_APP_SPECIFIC_PASSWORD='private-app-password')
SUBMISSION = '12345678-1234-1234-1234-123456789abc'


class CredentialsTests(unittest.TestCase):
    def test_missing_configuration_names_all_requirements_without_values(self):
        with self.assertRaisesRegex(RuntimeError, 'MACOS_CERTIFICATE_P12_BASE64.*notarization'):
            credentials.check({})
        partial = dict(CI_ENV, APPLE_APP_SPECIFIC_PASSWORD='')
        with self.assertRaisesRegex(RuntimeError, 'APPLE_APP_SPECIFIC_PASSWORD') as error:
            credentials.check(partial)
        self.assertNotIn(CI_ENV['MACOS_CERTIFICATE_PASSWORD'], str(error.exception))

    def test_requires_developer_id_matching_team_and_valid_base64(self):
        for key, value in [('MACOS_SIGNING_IDENTITY', 'Apple Distribution: Example (ABCDEFGHIJ)'),
                           ('APPLE_TEAM_ID', 'WRONGTEAM1'), ('MACOS_CERTIFICATE_P12_BASE64', '!invalid!')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                credentials.check(dict(CI_ENV, **{key: value}))

    def test_account_and_team_api_key_authentication(self):
        self.assertEqual(credentials.check(CI_ENV), 'account')
        api = {k: v for k, v in CI_ENV.items() if k not in credentials.ACCOUNT}
        api.update(APPLE_API_KEY_P8='private-key', APPLE_API_KEY_ID='key-id', APPLE_API_ISSUER_ID='issuer-id')
        self.assertEqual(credentials.check(api), 'api')
        with self.assertRaisesRegex(RuntimeError, 'one notarization method'):
            credentials.check(dict(api, APPLE_ID='test@example.invalid'))
        del api['APPLE_API_ISSUER_ID']
        with self.assertRaisesRegex(RuntimeError, 'APPLE_API_ISSUER_ID'):
            credentials.check(api)

    def test_private_commands_redact_failure_and_timeout_details(self):
        command = ['security', 'import', '-P', 'do-not-print']
        with patch.object(credentials.subprocess, 'run', return_value=subprocess.CompletedProcess(command, 1, '', 'do-not-print')):
            with self.assertRaises(RuntimeError) as error:
                credentials.private_run(command)
            self.assertNotIn('do-not-print', str(error.exception))
        with patch.object(credentials.subprocess, 'run', side_effect=subprocess.TimeoutExpired(command, 1)):
            with self.assertRaises(RuntimeError) as error:
                credentials.private_run(command)
            self.assertNotIn('do-not-print', str(error.exception))

    def test_failed_import_removes_private_files_and_restores_keychain_list(self):
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary) / 'credentials'

            def run(command, **kwargs):
                calls.append(list(map(str, command)))
                if command[:2] == ['security', 'list-keychains'] and '-s' not in command:
                    return '"/original.keychain-db"'
                if command[:2] == ['security', 'create-keychain']:
                    Path(command[-1]).touch()
                if command[:2] == ['security', 'import']:
                    if os.name == 'posix':
                        self.assertEqual((folder / 'certificate.p12').stat().st_mode & 0o777, 0o600)
                    raise RuntimeError('import failed')
                return ''

            with patch.object(credentials, 'private_run', side_effect=run):
                with self.assertRaisesRegex(RuntimeError, 'import failed'):
                    credentials.prepare(folder, CI_ENV)
            self.assertFalse(folder.exists())
            self.assertIn(['security', 'list-keychains', '-d', 'user', '-s', '/original.keychain-db'], calls)
            self.assertTrue(any(c[:2] == ['security', 'delete-keychain'] for c in calls))

    def test_prepare_uses_temporary_keychain_and_does_not_export_secrets(self):
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary) / 'credentials'
            output = Path(temporary) / 'github-env'

            def run(command, **kwargs):
                calls.append(list(map(str, command)))
                if command[:2] == ['security', 'find-identity']:
                    return '1) HASH "' + ENV['MACOS_SIGNING_IDENTITY'] + '"'
                return ''

            with patch.object(credentials, 'private_run', side_effect=run):
                credentials.prepare(folder, dict(CI_ENV, GITHUB_ENV=str(output)))
                self.assertFalse((folder / 'certificate.p12').exists())
                if os.name == 'posix':
                    self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
                self.assertIn('MACOS_NOTARY_KEYCHAIN_PROFILE=', output.read_text())
                self.assertNotIn('private-password', output.read_text())
                self.assertNotIn('private-app-password', output.read_text())
                self.assertTrue(any(c[:3] == ['xcrun', 'notarytool', 'store-credentials'] and '--validate' in c for c in calls))
                credentials.cleanup(folder)


class NotarizationTests(unittest.TestCase):
    def test_only_accepted_submission_succeeds(self):
        with tempfile.TemporaryDirectory() as temporary:
            reports = Path(temporary)
            for status, code in [('Invalid', 0), ('In Progress', 0), ('Accepted', 1)]:
                response = subprocess.CompletedProcess([], code, json.dumps({'id': SUBMISSION, 'status': status}), '')
                with patch.object(release.subprocess, 'run', return_value=response) as run:
                    with self.subTest(status=status), self.assertRaises(RuntimeError):
                        release.notarize(Path('/app.zip'), ENV, reports)
                    self.assertEqual(sum(c.args[0][2] == 'submit' for c in run.call_args_list), 1)
                    self.assertEqual(json.loads((reports / 'app-submission.json').read_text())['status'], status)
            response = subprocess.CompletedProcess([], 0, json.dumps({'id': SUBMISSION, 'status': 'Accepted'}), '')
            with patch.object(release.subprocess, 'run', return_value=response):
                self.assertEqual(release.notarize(Path('/app.zip'), ENV, reports), SUBMISSION)

    def test_timeout_never_resubmits(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(release.subprocess, 'run', side_effect=subprocess.TimeoutExpired('notarytool', 1500)) as run:
                with self.assertRaisesRegex(RuntimeError, 'history before resubmitting'):
                    release.notarize(Path('/app.zip'), ENV, Path(temporary))
                self.assertEqual(run.call_count, 1)

    def test_missing_credentials_stop_before_tool_calls(self):
        with patch.object(release.subprocess, 'run') as run, self.assertRaises(RuntimeError):
            release.signing_environment({})
        run.assert_not_called()

    def test_final_distribution_is_stapled_and_mounted_before_success(self):
        calls = []
        def run(command, *args):
            calls.append(list(map(str, command)))

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(release, 'notarize', return_value=SUBMISSION) as notarize:
                result = release.package_signed(root / 'source', root / 'built', root / 'out/app.dmg', ENV, run, root)
            self.assertEqual(notarize.call_count, 2)
            self.assertTrue(result['gatekeeperVerified'])
            attach = next(i for i, c in enumerate(calls) if c[:2] == ['hdiutil', 'attach'])
            self.assertTrue(any(c[:4] == ['spctl', '--assess', '--type', 'execute'] for c in calls[attach + 1:]))
            self.assertEqual(calls[-1][:2], ['hdiutil', 'detach'])
            self.assertLess(next(i for i, c in enumerate(calls) if c[:3] == ['xcrun', 'stapler', 'staple']),
                            next(i for i, c in enumerate(calls) if c[:2] == ['hdiutil', 'create']))

    def test_apple_rejection_stops_packaging(self):
        calls = []
        with patch.object(release, 'notarize', side_effect=RuntimeError('rejected')):
            with self.assertRaisesRegex(RuntimeError, 'rejected'):
                release.package_signed(Path('/source'), Path('/built'), Path('/out/app.dmg'), ENV,
                                       lambda command, *args: calls.append(list(map(str, command))), Path('/'))
        self.assertFalse(any(c[:2] == ['hdiutil', 'create'] for c in calls))

    def test_failed_payload_assessment_detaches_and_does_not_report_success(self):
        calls = []
        def run(command, *args):
            calls.append(list(map(str, command)))
            if command[0] == 'spctl' and 'desktop-verify-' in str(command[-1]):
                raise RuntimeError('Gatekeeper rejected mounted app')
        with patch.object(release, 'notarize', return_value=SUBMISSION):
            with self.assertRaisesRegex(RuntimeError, 'Gatekeeper rejected'):
                release.package_signed(Path('/source'), Path('/built'), Path('/out/app.dmg'), ENV, run, Path('/'))
        self.assertEqual(calls[-1][:2], ['hdiutil', 'detach'])


class BuildReceiptTests(unittest.TestCase):
    def package(self, root, package_signed):
        source = root / 'cache/vscodium/vscode'
        source.mkdir(parents=True)
        (source / 'product.json').write_text(json.dumps({
            'dhimantaiDesktop': {'version': build.LOCK['release']},
            'builtInExtensionsEnabledWithAutoUpdates': ['optficial.dhimantai-learning'],
        }))
        app = root / 'cache/vscodium/VSCode-darwin-arm64/dhimantAI.app/Contents'
        app.mkdir(parents=True)
        (app / 'Info.plist').write_bytes(plistlib.dumps({}))
        vsix = root / 'extension.vsix'
        vsix.write_bytes(b'extension')
        output = root / 'out'
        output.mkdir()
        receipt = output / f'dhimantAI-{build.LOCK["release"]}-darwin-arm64.json'
        receipt.write_text('stale receipt')
        argv = ['build.py', '--stage', 'package', '--cache', str(root / 'cache'), '--arch', 'arm64',
                '--vsix', str(vsix), '--flutter-env', 'staging=/unused', '--out', str(output)]
        with patch.object(sys, 'argv', argv), patch.dict(os.environ, ENV), \
                patch.object(build.platform, 'system', return_value='Darwin'), \
                patch.object(build.platform, 'machine', return_value='arm64'), \
                patch.object(build.subprocess, 'check_output', side_effect=['v' + build.LOCK['nodeVersion'], 'a' * 40]), \
                patch.object(build, 'bundle_extension', return_value='1.0.0'), \
                patch.object(build, 'verify_copilot_optional', return_value=False), \
                patch.object(build, 'package_signed', side_effect=package_signed):
            build.main()
        return receipt

    def test_receipt_hashes_final_stapled_bytes_and_records_apple_acceptance(self):
        def signed(source, built, disk, *args):
            disk.write_bytes(b'final stapled distribution')
            return {'appSubmissionId': SUBMISSION, 'dmgSubmissionId': SUBMISSION, 'gatekeeperVerified': True}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = json.loads(self.package(root, signed).read_text())
            self.assertEqual(receipt['signing'], 'developer-id-notarized')
            self.assertTrue(receipt['notarization']['gatekeeperVerified'])
            self.assertEqual(receipt['files'][0]['sha256'], build.digest(root / 'out' / receipt['files'][0]['name']))

    def test_signing_failure_removes_stale_success_receipt(self):
        def rejected(*args):
            raise RuntimeError('Apple rejected the submission')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, 'Apple rejected'):
                self.package(root, rejected)
            self.assertEqual(list((root / 'out').glob('*.json')), [])


if __name__ == '__main__':
    unittest.main()
