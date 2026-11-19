"""Local SkyPilot bridge for learner-owned AWS, GCE and Azure spot GPU VMs."""
import fcntl
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import time

# Conservative per-device MiB floors for full NVIDIA cards when the catalog omits VRAM.
GPU_SPECS = {'T4': (7.5, 15000), 'A10': (8.6, 22000), 'A10G': (8.6, 22000),
             'L4': (8.9, 22000), 'L40S': (8.9, 44000), 'A100': (8.0, 38000),
             'A100-80GB': (8.0, 76000), 'H100': (9.0, 76000), 'H200': (9.0, 134000)}
PROVIDERS = {'aws', 'gcp', 'azure'}
VERSION = '0.14.3'


def load_sdk(provider=None, account=None):
    from importlib.metadata import PackageNotFoundError, version
    if account and provider in account.SUPPORTED and '--in-sky-env' not in sys.argv:
        python = account.sdk_python(provider)
        if python.is_file():
            os.execv(str(python), [str(python), '-I', __file__, *sys.argv[1:], '--in-sky-env'])
    try:
        installed = version('skypilot')
    except PackageNotFoundError:
        installed = None
    if installed != VERSION:
        launcher = Path(shutil.which('sky') or Path.home() / '.local/bin/sky')
        if launcher.is_file() and '--in-sky-env' not in sys.argv:
            resolved = launcher.resolve()
            interpreters = [resolved.parent / 'python']
            with resolved.open('rb') as file:
                line = file.readline(512).decode(errors='ignore').strip()
            if line.startswith('#!/'):
                interpreters.append(Path(line[2:]))
            for python in interpreters:
                if python.is_file() and os.access(python, os.X_OK):
                    os.execv(str(python), [str(python), '-I', __file__, *sys.argv[1:], '--in-sky-env'])
        raise RuntimeError(f'Install SkyPilot {VERSION} with the selected cloud extra in a Python environment and put its sky command on PATH.')
    # Some SDK operations invoke a CLI installed beside the Python interpreter.
    os.environ['PATH'] = os.pathsep.join([str(Path(sys.executable).parent), os.environ.get('PATH', '')])
    if account and provider in ('aws', 'gcp'):
        command = account.cli(provider)
        if command:
            os.environ['PATH'] = str(Path(command).parent) + os.pathsep + os.environ['PATH']
    import sky
    return sky


def resources(sky, provider, quote, name=None):
    return sky.Resources(cloud=sky.CLOUD_REGISTRY.from_str(provider), region=quote['region'],
                         zone=quote.get('zone') or None, instance_type=quote['type'],
                         accelerators={quote['gpu']: quote['gpusPerNode']}, use_spot=True,
                         disk_size=100, max_hourly_cost=quote.get('price'), labels={'dhimantai-lab': name} if name else None)


def best_quote(sky, provider, region, recipe):
    if not re.fullmatch('[a-z][a-z0-9-]{1,40}', region):
        raise ValueError('Enter a cloud region identifier.')
    layouts = recipe.get('layouts') or [recipe]
    catalog = sky.list_accelerators(clouds=provider, region_filter='^' + region + '$',
                                    name_filter='^(?:' + '|'.join(GPU_SPECS) + ')$', all_regions=True)
    offers = []
    for gpu, rows in catalog.items():
        if gpu not in GPU_SPECS or GPU_SPECS[gpu][0] < recipe['minComputeCapability']:
            continue
        for row in rows:
            memory = row.device_memory * 1024 if row.device_memory and math.isfinite(row.device_memory) else GPU_SPECS[gpu][1]
            if (row.region != region or row.cloud.lower() != provider or not row.instance_type
                    or memory < recipe['minVramMiB']
                    or not math.isfinite(row.spot_price) or row.spot_price <= 0):
                continue
            for layout in layouts:
                if row.accelerator_count != layout['gpusPerNode']:
                    continue
                quote = dict(region=region, type=row.instance_type, gpu=gpu, nodes=layout['nodes'],
                             gpusPerNode=layout['gpusPerNode'], currency='USD')
                shape = resources(sky, provider, quote)
                for location in shape.get_valid_regions_for_launchable():
                    if location.name != region:
                        continue
                    for zone in location.zones or [None]:
                        candidate = dict(quote, zone=zone.name if zone else '')
                        try:
                            rate = resources(sky, provider, candidate).get_cost(3600)
                        except ValueError:
                            continue   # This zone has no priced spot offer.
                        if math.isfinite(rate) and rate > 0:
                            offers.append(dict(candidate, price=rate))
    if not offers:
        raise RuntimeError(f'No priced, compatible spot GPUs in {region}. Choose another region or lab layout.')
    return min(offers, key=lambda q: q['nodes'] * q['price'])


def same_layout(quote, recipe):
    return any(all(layout[k] == quote[k] for k in ('nodes', 'gpusPerNode'))
               for layout in recipe.get('layouts') or [recipe])


class LocalSky:
    """Use the synchronous backend in this short-lived process, under the allocation lock."""
    def __init__(self, provider):
        from sky import core, execution
        from sky.backends import backend_utils
        self.core = core
        self.execution = execution
        self.backend_utils = backend_utils
        # SkyPilot normally stages local cloud credential files on the VMs. These labs
        # only need SSH. Scope both overrides to this isolated helper process.
        backend_utils.sky_check.get_cloud_credential_file_mounts = lambda excluded_clouds: {}
        backend_utils.logs.get_logging_agent = lambda **kwargs: None
        if provider == 'gcp':
            # Lifecycle operations run on the student's computer. The lab VM
            # needs no project credentials or project IAM bindings.
            from sky.provision.gcp import config
            config._configure_iam_role = lambda config, crm, iam: {'serviceAccounts': []}

    def status(self, name, refresh=False, **options):
        from sky import global_user_state
        from sky.utils.common import StatusRefreshMode
        mode = StatusRefreshMode.FORCE if refresh else StatusRefreshMode.NONE
        # The API-server response model drops local clusters with no server
        # username. Work with the native handle from the same backend lookup.
        rows = self.backend_utils.get_clusters(cluster_names=[name], refresh=mode, **options)
        if not rows and global_user_state.get_cluster_from_name(name) is not None:
            raise RuntimeError(f'SkyPilot could not verify the state of {name}. Retry with its original account.')
        return rows

    def configure_ssh(self, entry):
        from sky.client.cli.command import _write_ssh_config_for_cluster
        handle = entry['handle']
        if not entry['credentials'] or not handle.cached_external_ips or not handle.cached_external_ssh_ports:
            raise RuntimeError('SkyPilot did not return the SSH connection for this lab.')
        _write_ssh_config_for_cluster(handle, entry['credentials'], '')

    def remove_ssh(self, name):
        from sky.utils.cluster_utils import SSHConfigHelper
        SSHConfigHelper.remove_cluster(name)

    def start(self, name):
        self.core.start(name, retry_until_up=False)

    def launch(self, task, name):
        self.execution.launch(task, cluster_name=name, retry_until_up=False, stream_logs=False)

    def down(self, name):
        self.core.down(name)

    def stop(self, name):
        self.core.stop(name)


class Allocation:
    def __init__(self, sky, backend, request, directory):
        self.sky = sky
        self.backend = backend
        self.request = request
        self.provider = request['provider']
        self.path = directory / (self.provider + '.json')
        self.record = json.loads(self.path.read_text()) if self.path.exists() else None
        identity = sky.CLOUD_REGISTRY.from_str(self.provider).get_active_user_identity()
        if not identity or not all(isinstance(val, str) and val for val in identity):
            raise RuntimeError('Sign in to the cloud account and run sky check for this provider.')
        self.owner = identity
        if self.record and self.record['owner'] != identity:
            raise RuntimeError('Sign in to the cloud account that owns the saved lab allocation.')

    def save(self):
        temp = self.path.with_suffix('.tmp')
        with temp.open('w') as output:
            json.dump(self.record, output)
            output.flush()
            os.fsync(output.fileno())
        temp.replace(self.path)

    def cluster(self, ssh=False):
        r = self.record
        records = self.backend.status(r['name'], refresh=True, include_credentials=ssh)
        if not records:
            return None
        entry = records[0]
        handle = entry['handle']
        actual = handle.launched_resources if handle else None
        if (len(records) != 1 or entry['name'] != r['name'] or not actual
                or (actual.labels or {}).get('dhimantai-lab') != r['name']
                or entry['owner'] != self.owner or str(actual.cloud).lower() != self.provider
                or r.get('hash', entry['cluster_hash']) != entry['cluster_hash']):
            raise RuntimeError('Cannot verify the saved cluster owner and lab identifier. Inspect it in SkyPilot.')
        return entry

    def plan(self):
        recipe = self.request['recipe']
        if self.record:
            if self.record.get('phase') == 'cleanup':
                self.release()
            else:
                quote = dict(self.record['quote'])
                entry = self.cluster()
                if entry is None:
                    if not (self.record.get('hash') or self.record.get('launchFailed')):
                        raise RuntimeError(f'The create result for {self.record["name"]} is unknown. Inspect it in SkyPilot and the provider console.')
                    # A preempted or externally released cluster has gone. Forget its
                    # local alias without issuing a delete based on a second lookup.
                    self.forget()
                    return self.plan()
                if entry and entry['status'] == self.sky.ClusterStatus.STOPPED:
                    quote['price'] = resources(self.sky, self.provider, quote).get_cost(3600)
                    if not math.isfinite(quote['price']) or quote['price'] <= 0:
                        raise RuntimeError('A current spot quote is required to restart the saved cluster.')
                if not same_layout(quote, recipe):
                    raise RuntimeError('Reconnect the original lab layout and finish it before changing machines.')
                return dict(name=self.record['name'], owner=self.owner, quote=quote, existing=True)
        if not self.request.get('region'):
            return None
        quote = best_quote(self.sky, self.provider, self.request['region'], recipe)
        return dict(name='dhai-' + secrets.token_hex(8), owner=self.owner, quote=quote, existing=False)

    def connect(self):
        sky, request = self.sky, self.request
        plan = request['plan']
        quote = plan['quote']
        if plan['owner'] != self.owner:
            raise RuntimeError('The cloud account changed. Review the allocation again.')
        if self.record:
            original = dict(self.record['quote'], price=quote['price'])
            if self.record['name'] != plan['name'] or not plan['existing'] or original != quote:
                raise RuntimeError('Another session changed this lab allocation. Select the runtime again.')
            if self.record['phase'] == 'cleanup':
                raise RuntimeError('Cleanup is pending. Select the runtime again.')
        else:
            if plan['existing'] or not re.fullmatch(r'dhai-[a-f0-9]{16}', plan['name']):
                raise RuntimeError('The reviewed allocation changed. Select the runtime again.')
            shape = resources(sky, self.provider, quote, plan['name'])
            cost = shape.get_cost(3600)
            if not math.isfinite(cost) or not 0 < cost <= quote['price']:
                raise RuntimeError('The spot price changed. Review a new quote.')
            if self.backend.status(plan['name'], all_users=True):
                raise RuntimeError('The cluster name is already in use. Review a new allocation.')
            self.record = dict(name=plan['name'], quote=quote, owner=self.owner, phase='creating',
                               expiresAt=int(time.time() * 1000) + 180 * 60000, lease=request['lease'])
            self.save()  # Persist intent before submitting a billable request.
            task = sky.Task(num_nodes=quote['nodes'], api_server_access=False).set_resources(shape)
            try:
                self.backend.launch(task, plan['name'])
            except (sky.exceptions.ResourcesUnavailableError, sky.exceptions.NoCloudAccessError,
                    sky.exceptions.NoClusterLaunchedError):
                # SkyPilot completed failover and cleaned up failed attempts, unless
                # it explicitly retained the cluster (e.g. a failed teardown).
                self.record['launchFailed'] = True
                self.save()
                raise
        r = self.record
        entry = self.cluster(ssh=True)
        if not entry and r.get('launchFailed'):
            self.path.unlink()
            self.record = None
            raise RuntimeError('Spot capacity was unavailable. Select the provider to review a new quote.')
        if entry and plan['existing'] and entry['status'] == sky.ClusterStatus.STOPPED:
            self.verify_shape(entry, quote)
            rate = resources(sky, self.provider, quote).get_cost(3600)
            if not math.isfinite(rate) or not 0 < rate <= quote['price']:
                raise RuntimeError('The restart price changed. Review a new quote.')
            self.backend.start(r['name'])
            r.update(quote=quote, expiresAt=int(time.time() * 1000) + 180 * 60000)
            self.save()
            entry = self.cluster(ssh=True)
        if not entry or entry['status'] != sky.ClusterStatus.UP:
            raise RuntimeError(f'{r["name"]} is unavailable. Check sky status and the provider console before retrying.')
        self.verify_shape(entry, quote)
        self.backend.configure_ssh(entry)
        r.update(phase='running', hash=entry['cluster_hash'], lease=request['lease'])
        self.save()
        return dict(hosts=[r['name'] if i == 0 else f'{r["name"]}-worker{i}' for i in range(quote['nodes'])],
                    expiresAt=r['expiresAt'])

    @staticmethod
    def verify_shape(entry, quote):
        actual = entry['handle'].launched_resources
        if (not actual.use_spot or actual.region != quote['region'] or
                (quote['zone'] and actual.zone != quote['zone']) or actual.instance_type != quote['type'] or
                actual.accelerators != {quote['gpu']: quote['gpusPerNode']} or entry['nodes'] != quote['nodes']):
            raise RuntimeError('The cluster does not match the approved spot allocation.')

    def release(self):
        r = self.record
        if r is None:
            return
        entry = self.cluster()
        if not entry and not (r.get('launchFailed') or r.get('hash')):
            raise RuntimeError(f'The create result for {r["name"]} is unknown. Check the provider console; the allocation record is retained.')
        if entry:
            r['hash'] = entry['cluster_hash']
        r['phase'] = 'cleanup'
        self.save()
        if entry:
            self.backend.down(r['name'])
            if self.cluster():
                raise RuntimeError('Cloud deletion is still pending. Retry cleanup.')
        self.forget()

    def forget(self):
        self.backend.remove_ssh(self.record['name'])
        self.path.unlink()
        self.record = None

    def run(self):
        action = self.request['action']
        if action == 'plan':
            return self.plan()
        if action == 'connect':
            return self.connect()
        r = self.record
        if not r:
            return
        if r['name'] != self.request['name'] or r['lease'] != self.request['lease']:
            raise RuntimeError('Another session owns this lab allocation. Reconnect before changing it.')
        if action == 'saved':
            r['artifact'] = self.request['file']
            self.save()
        elif action == 'pause':
            if self.cluster():
                self.backend.stop(r['name'])
        elif action == 'release':
            self.release()
        else:
            raise ValueError('Unknown cloud operation.')


def main():
    # Isolated Python excludes even the bundled script directory from sys.path.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import spot_account
    mode, provider = (sys.argv[1:3] if len(sys.argv) >= 3 else ('--cloud', None))
    if provider == 'gcp':
        # macOS archives rely on an external Python. Use the runtime's managed
        # interpreter for the CLI even when the desktop inherited only system Python.
        python = spot_account.installed_sdk_python('gcp')
        if python and python.is_file():
            os.environ.setdefault('CLOUDSDK_PYTHON', str(python))
        if mode == '--project':
            spot_account.select_gcp_project()
            return
    if mode in ('--account', '--install', '--login') and provider in spot_account.SUPPORTED:
        if mode == '--account':
            print('DHIMANTAI_RESULT ' + json.dumps(spot_account.account_state(provider)))
        elif mode == '--install':
            spot_account.install(provider)
        else:
            spot_account.login(provider)
        return
    sky = load_sdk(provider, spot_account)
    request = json.load(sys.stdin)
    if request['provider'] not in PROVIDERS or not re.fullmatch('[a-f0-9]{64}', request['scope']):
        raise ValueError('Invalid cloud or lab identifier.')
    directory = Path.home() / '.local/share/dhimantai/spot' / request['scope']
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / (request['provider'] + '.lock')).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('A cloud operation is already running for this lab.') from None
        value = Allocation(sky, LocalSky(request['provider']), request, directory).run()
    print('DHIMANTAI_RESULT ' + json.dumps(value, allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('DHIMANTAI_ERROR ' + json.dumps(str(error)), file=sys.stderr)
        sys.exit(1)
