import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'media' / 'course'))
from sky_spot import Allocation, best_quote


class SpotVmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.recipe = dict(nodes=2, gpusPerNode=1, minComputeCapability=8.0, minVramMiB=8000)
        self.owner = ['learner', 'account']
        self.sky = Mock()
        self.sky.Task.return_value.set_resources.return_value = self.sky.Task.return_value
        self.sky.ClusterStatus = SimpleNamespace(UP='UP', STOPPED='STOPPED')
        self.sky.exceptions = SimpleNamespace(ResourcesUnavailableError=ConnectionRefusedError,
                                              NoCloudAccessError=PermissionError, NoClusterLaunchedError=FileNotFoundError)
        self.backend = Mock()
        self.entry = None
        self.backend.status.side_effect = lambda *args, **opts: [self.entry] if self.entry else []
        self.backend.down.side_effect = lambda name: setattr(self, 'entry', None)
        self.cloud = Mock()
        self.cloud.get_active_user_identity.return_value = self.owner
        self.sky.CLOUD_REGISTRY.from_str.return_value = self.cloud

    def allocation(self, provider='aws', **fields):
        return Allocation(self.sky, self.backend, dict(provider=provider, recipe=self.recipe, lease='one', **fields), self.folder)

    def offers(self, provider):
        self.offer = SimpleNamespace(region='region', instance_type='gpu-1', cloud=provider,
                                     spot_price=.5, device_memory=None, accelerator_count=1)
        self.sky.list_accelerators.return_value = {'T4': [self.offer], 'L4': [self.offer]}
        self.cloud.__str__ = lambda _: provider
        def resource(**kwargs):
            return SimpleNamespace(**kwargs, get_valid_regions_for_launchable=lambda: [
                SimpleNamespace(name='region', zones=[SimpleNamespace(name='zone-a')])], get_cost=lambda seconds: self.offer.spot_price)
        self.sky.Resources.side_effect = resource

    def launch(self, task, name):
        shape = task.set_resources.call_args.args[0]
        self.entry = dict(name=name, handle=SimpleNamespace(launched_resources=shape), nodes=2, status='UP',
                          owner=self.owner, cluster_hash='actual-id')

    def test_accounts_launch_reconnect_save_and_release(self):
        self.backend.launch.side_effect = self.launch
        for provider in ('aws', 'gcp', 'azure'):
            with self.subTest(provider=provider):
                self.offers(provider)
                plan = self.allocation(provider, region='region').plan()
                quote = plan['quote']
                self.assertEqual((quote['gpu'], quote['nodes'], quote['zone']), ('L4', 2, 'zone-a'))
                connection = self.allocation(provider, plan=plan).connect()
                self.assertEqual(connection['hosts'], [plan['name'], plan['name'] + '-worker1'])
                shape = self.entry['handle'].launched_resources
                self.assertTrue(shape.use_spot)
                self.assertEqual(shape.max_hourly_cost, quote['price'])
                self.assertEqual(shape.labels['dhimantai-lab'], plan['name'])
                self.sky.Task.assert_called_with(num_nodes=2, api_server_access=False)
                self.assertTrue(self.allocation(provider).plan()['existing'])
                with self.assertRaisesRegex(RuntimeError, 'Another session'):
                    self.allocation(provider, plan=plan).connect()
                reconnect = self.allocation(provider, plan=self.allocation(provider).plan())
                reconnect.request['lease'] = 'two'
                reconnect.connect()
                old = self.allocation(provider, name=plan['name'], action='release')
                with self.assertRaisesRegex(RuntimeError, 'Another session'):
                    old.run()
                reconnect.request.update(action='saved', name=plan['name'], file='/archive')
                reconnect.run()
                self.assertEqual(json.loads(reconnect.path.read_text())['artifact'], '/archive')
                reconnect.request['action'] = 'release'
                reconnect.run()
                self.assertFalse(reconnect.path.exists())
        self.assertEqual(self.backend.launch.call_count, 3)
        self.assertEqual(self.backend.down.call_count, 3)

    def test_does_not_substitute_hardware_or_start_at_a_higher_price(self):
        self.offers('azure')
        plan = self.allocation('azure', region='region').plan()
        self.offer.spot_price = 2
        with self.assertRaisesRegex(RuntimeError, 'price changed'):
            self.allocation('azure', plan=plan).connect()
        for change in (dict(spot_price=float('nan')), dict(device_memory=2),
                       dict(accelerator_count=.5), dict(region='elsewhere')):
            self.offers('azure')
            self.offer.__dict__.update(change)
            with self.assertRaisesRegex(RuntimeError, 'No priced'):
                best_quote(self.sky, 'azure', 'region', self.recipe)
        self.backend.launch.assert_not_called()

    def test_lost_response_and_wrong_owner_do_not_destroy_or_duplicate(self):
        self.offers('aws')
        plan = self.allocation(region='region').plan()
        self.backend.launch.side_effect = TimeoutError('lost response')
        with self.assertRaises(TimeoutError):
            self.allocation(plan=plan).connect()
        runtime = self.allocation(name=plan['name'], action='release')
        with self.assertRaisesRegex(RuntimeError, 'unknown'):
            runtime.run()
        with self.assertRaisesRegex(RuntimeError, 'unknown'):
            runtime.plan()
        self.assertTrue(runtime.path.exists())
        self.cloud.get_active_user_identity.return_value = ['another-account']
        with self.assertRaisesRegex(RuntimeError, 'account that owns'):
            self.allocation()
        self.backend.down.assert_not_called()
        self.assertEqual(self.backend.launch.call_count, 1)

    def test_stopped_lab_rechecks_spot_shape_and_price_before_restart(self):
        self.offers('gcp')
        self.backend.launch.side_effect = self.launch
        plan = self.allocation('gcp', region='region').plan()
        self.allocation('gcp', plan=plan).connect()
        self.entry['status'] = 'STOPPED'
        self.offer.spot_price = .8
        resume = self.allocation('gcp').plan()
        self.assertEqual(resume['quote']['price'], .8)
        self.offer.spot_price = .9
        with self.assertRaisesRegex(RuntimeError, 'restart price changed'):
            self.allocation('gcp', plan=resume).connect()
        self.backend.start.assert_not_called()
        self.offer.spot_price = .8
        self.entry['handle'].launched_resources.use_spot = False
        with self.assertRaisesRegex(RuntimeError, 'approved spot'):
            self.allocation('gcp', plan=resume).connect()
        self.backend.start.assert_not_called()
        self.entry['handle'].launched_resources.use_spot = True
        self.backend.start.side_effect = lambda name: self.entry.update(status='UP')
        self.allocation('gcp', plan=resume).connect()
        self.assertEqual(self.backend.launch.call_count, 1)
        self.backend.start.assert_called_once_with(plan['name'])

    def test_preempted_cluster_is_forgotten_without_deleting_or_creating_a_vm(self):
        self.offers('azure')
        self.backend.launch.side_effect = self.launch
        plan = self.allocation('azure', region='region').plan()
        self.allocation('azure', plan=plan).connect()
        self.entry = None
        self.assertIsNone(self.allocation('azure').plan())
        self.backend.down.assert_not_called()
        self.assertEqual(self.backend.launch.call_count, 1)
        self.backend.remove_ssh.assert_called_once_with(plan['name'])

    def test_failed_delete_retains_cleanup_and_checks_tag_before_retry(self):
        self.offers('gcp')
        plan = self.allocation('gcp', region='region').plan()
        self.backend.launch.side_effect = self.launch
        runtime = self.allocation('gcp', plan=plan)
        runtime.connect()
        self.backend.down.side_effect = TimeoutError('delete timed out')
        with self.assertRaises(TimeoutError):
            runtime.release()
        self.assertEqual(json.loads(runtime.path.read_text())['phase'], 'cleanup')
        self.entry['handle'].launched_resources.labels = {'dhimantai-lab': 'somebody-else'}
        with self.assertRaisesRegex(RuntimeError, 'Cannot verify'):
            self.allocation('gcp').plan()
        self.assertEqual(self.backend.down.call_count, 1)


if __name__ == '__main__':
    unittest.main()
