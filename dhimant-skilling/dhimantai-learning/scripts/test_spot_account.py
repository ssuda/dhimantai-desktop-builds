"""GCE setup checks, independent of the developer's installed tools and credentials."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'media/course'))
import spot_account


class GoogleAccountTests(unittest.TestCase):
    def setUp(self):
        self.cli = self.enter_patch('cli', return_value='/tools/gcloud')
        self.sdk = self.enter_patch('sdk_ready', return_value=True)
        self.read = self.enter_patch('quiet')
        self.run_cli = self.enter_patch('subprocess.run')

    def enter_patch(self, name, **options):
        patcher = patch('spot_account.' + name, **options)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def test_missing_tools_or_signed_out_account_never_check_tokens(self):
        self.sdk.return_value = False
        self.assertEqual(spot_account.account_state('gcp'), 'install')
        self.sdk.return_value = True
        self.read.return_value = ''
        self.assertEqual(spot_account.account_state('gcp'), 'login')
        self.run_cli.assert_not_called()

    def test_cli_and_application_credentials_must_both_refresh(self):
        self.read.return_value = 'student'
        self.run_cli.side_effect = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 1)]
        self.assertEqual(spot_account.account_state('gcp'), 'login')
        commands = self.run_cli.call_args_list
        self.assertEqual(commands[0].args[0][1:-1], ['auth', 'print-access-token'])
        self.assertEqual(commands[1].args[0][1:-1], ['auth', 'application-default', 'print-access-token'])
        for call in commands:
            self.assertEqual(call.kwargs['stdout'], subprocess.DEVNULL)
            self.assertEqual(call.kwargs['stderr'], subprocess.DEVNULL)

    def test_existing_accounts_only_need_project_selection_when_unset(self):
        self.run_cli.return_value.returncode = 0
        self.read.side_effect = ['student', '', 'student', 'lab-project']
        self.assertEqual(spot_account.account_state('gcp'), 'project')
        self.assertEqual(spot_account.account_state('gcp'), 'ready')

    def test_sign_in_sets_application_credentials_and_project_must_exist(self):
        spot_account.login('gcp')
        self.run_cli.assert_called_once_with(['/tools/gcloud', 'auth', 'login', '--update-adc'], check=True)
        self.run_cli.reset_mock()
        with patch('builtins.input', return_value='student-lab'):
            self.read.return_value = ''
            with self.assertRaisesRegex(RuntimeError, 'could not access'):
                spot_account.select_gcp_project()
            self.run_cli.assert_not_called()
            self.read.return_value = 'student-lab'
            spot_account.select_gcp_project()
        self.run_cli.assert_called_once_with(['/tools/gcloud', 'config', 'set', 'project', 'student-lab'], check=True)


if __name__ == '__main__':
    unittest.main()
