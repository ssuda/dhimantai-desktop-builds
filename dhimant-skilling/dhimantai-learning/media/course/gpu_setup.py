"""Owned SSH lab runtime: prepare, supervise Ray, verify, and execute the shared cell bridge.

No cloud API or credentials are used. Input is the bundled lab recipe, never notebook metadata.
"""
import base64
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile


def progress(message):
    print('DHIMANTAI_PROGRESS ' + message, file=sys.stderr, flush=True)


def run(argv, timeout=60, **kwargs):
    return subprocess.run(argv, check=True, text=True, timeout=timeout, **kwargs)


def output(argv, timeout=60, **kwargs):
    return run(argv, timeout, capture_output=True, **kwargs).stdout.strip()


def paths(config):
    session = config['session']
    if not re.fullmatch(r'[a-f0-9]{24}', session):
        raise ValueError('Invalid runtime session')
    root = Path('/tmp') / ('dhai-' + session)
    if root.exists() and (root.is_symlink() or root.stat().st_uid != os.getuid()):
        raise RuntimeError('The runtime directory is not owned by this account.')
    recipe = config['recipe']['recipe']
    if recipe not in ('inference-nvidia-v1', 'gpu-python-v1'): raise ValueError('Unknown runtime recipe')
    return root, persistent_home(config) / '.local/share/dhimantai' / recipe


def persistent_home(config):
    # JarvisLabs spot containers preserve /home across pause/resume; /root is ephemeral.
    return Path('/home') if config['recipe'].get('managedContainer') else Path.home()


def private_ipv4(value):
    address = ipaddress.ip_address(value)
    return address.version == 4 and any(address in ipaddress.ip_network(net) for net in
                                       ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


def inventory(recipe):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise RuntimeError('Use a Linux x86_64 or ARM64 GPU machine.')
    rows = output(['nvidia-smi', '--query-gpu=uuid,name,compute_cap,memory.total',
                   '--format=csv,noheader,nounits'], 20).splitlines()
    devices = []
    for row in rows:
        uuid, name, capability, memory = [part.strip() for part in row.rsplit(',', 3)]
        if float(capability) >= recipe['minComputeCapability'] and float(memory) >= recipe['minVramMiB']:
            devices.append({'uuid': uuid, 'name': name, 'memory': float(memory)})
    if len(devices) < recipe['gpusPerNode']:
        raise RuntimeError('This machine does not meet the lab GPU and memory requirements.')
    used = output(['nvidia-smi', '--query-compute-apps=gpu_uuid', '--format=csv,noheader'], 20)
    selected = devices[:recipe['gpusPerNode']]
    if any(device['uuid'] in used for device in selected):
        raise RuntimeError('A required GPU is already running another workload. Use idle, dedicated lab machines.')
    interfaces = json.loads(output(['ip', '-j', '-4', 'address', 'show', 'scope', 'global'])) if shutil.which('ip') else []
    addresses = [{'ip': a['local'], 'interface': interface['ifname']}
                 for interface in interfaces if not interface['ifname'].startswith(('docker', 'br-', 'veth'))
                 for a in interface.get('addr_info', []) if private_ipv4(a['local'])]
    if recipe['nodes'] > 1 and not addresses:
        raise RuntimeError('Cluster machines need private VPC addresses. Put every VM in the same private network.')
    identity = Path('/etc/machine-id')
    return {'machine': identity.read_text().strip() if identity.exists() else socket.gethostname(), 'hostname': socket.gethostname(),
            'architecture': platform.machine(), 'gpus': selected, 'addresses': addresses,
            'user': output(['id', '-un']), 'sshPort': int(os.environ.get('SSH_CONNECTION', '0 0 0 22').split()[-1])}


def install_uv(root, version):
    target = root / ('uv-' + version)
    if target.is_file():
        return target
    arch = platform.machine()
    with urllib.request.urlopen('https://pypi.org/pypi/uv/' + version + '/json', timeout=30) as response:
        metadata = json.load(response)
    wheel = next(item for item in metadata['urls'] if item['filename'].endswith('.whl')
                 and 'manylinux_2_17_' + arch in item['filename'])
    if not wheel['url'].startswith('https://files.pythonhosted.org/'):
        raise RuntimeError('Unexpected Python package source.')
    with urllib.request.urlopen(wheel['url'], timeout=120) as response:
        content = response.read(100_000_000)
    if hashlib.sha256(content).hexdigest() != wheel['digests']['sha256']:
        raise RuntimeError('The Python installer download did not match its checksum.')
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        binary = next(name for name in archive.namelist() if name.endswith('/scripts/uv'))
        temporary = target.with_suffix('.tmp')
        temporary.write_bytes(archive.read(binary))
        temporary.chmod(0o700)
        temporary.replace(target)
    return target


def prepare(config):
    recipe = config['recipe']
    record = inventory(recipe)  # Reject wrong/busy GPUs before downloading or changing packages.
    root, cache = paths(config)
    root.mkdir(mode=0o700, exist_ok=True)
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    import fcntl
    with (cache / '.setup.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another lab setup is running on this machine. Wait and retry.') from None
        if shutil.disk_usage(cache).free < 25 * 1024**3 and not (cache / 'env/bin/python').is_file():
            raise RuntimeError('Allow at least 25 GB free disk space for the GPU environment and model.')
        progress('Preparing Python ' + recipe['python'])
        uv = install_uv(cache, recipe['uv'])
        env = dict(os.environ, UV_HTTP_RETRIES='2', UV_HTTP_TIMEOUT='60', UV_PYTHON_INSTALL_DIR=str(cache / 'python'))
        python = cache / 'env/bin/python'
        if not python.is_file():
            run([str(uv), 'venv', '--python', recipe['python'], '--managed-python', str(cache / 'env')], 600, env=env, stdout=sys.stderr)
        progress('Installing the pinned inference and cluster packages')
        packages = ['ipython==' + recipe['ipython']]
        packages += ['vllm==' + recipe['vllm'], 'ray[default]==' + recipe['ray']] if recipe['recipe'] == 'inference-nvidia-v1' else ['torch==2.9.1', 'numpy==2.1.3']
        run([str(uv), 'pip', 'install', '--python', str(python), *packages], 2400, env=env, stdout=sys.stderr)
        gpu_env = dict(env, CUDA_VISIBLE_DEVICES=','.join(device['uuid'] for device in record['gpus']))
        run([str(python), '-c', 'import torch; assert torch.cuda.is_available(); '
             'x=torch.ones(2,device="cuda"); assert x.sum().item()==2'], 180, env=gpu_env, stdout=sys.stderr)
        if recipe['recipe'] == 'inference-nvidia-v1':
            progress('Downloading the lab model at its pinned revision')
            model = cache / ('model-' + recipe['revision'])
            script = ('from huggingface_hub import snapshot_download; '
                  'snapshot_download(repo_id=' + repr(recipe['model']) + ',revision=' + repr(recipe['revision'])
                  + ',local_dir=' + repr(str(model)) + ')')
            run([str(python), '-c', script], 1200, env=env, stdout=sys.stderr)
            (root / 'model').symlink_to(model, target_is_directory=True)
        for name, content in config['files'].items():
            if name not in ('cells.py', 'cell_shell.py', 'lesson_trace.py', 'sql_runtime.py', 'lab_scenarios.py', 'gpu_setup.py', 'cluster.py'):
                raise ValueError('Unknown runtime asset')
            (root / name).write_bytes(base64.b64decode(content))
        freeze = output([str(uv), 'pip', 'freeze', '--python', str(python)], env=env)
        record.update(python=str(python), root=str(root), packages=hashlib.sha256(freeze.encode()).hexdigest())
        (root / 'node.json').write_text(json.dumps(record))
        return record


def node(config):
    root, _ = paths(config)
    return root, json.loads((root / 'node.json').read_text())


def firewall(config):
    """Root wrapper owns only a session-specific chain and removes it when SSH closes."""
    if os.geteuid() != 0:
        raise RuntimeError('Administrator access is required to isolate the cluster ports.')
    peers = config['peers']
    if not peers or any(not private_ipv4(ip) for ip in peers):
        raise RuntimeError('Ray requires private addresses on every machine.')
    chain = 'DHAI_' + config['session'][:16]
    ports = '8265,10001,16379:16431,32768:60999'
    rule = ['INPUT', '-p', 'tcp', '-m', 'multiport', '--dports', ports, '-j', chain]
    created = []
    try:
        ssh_port = int(config['sshPort'])
        if not 1 <= ssh_port <= 65535: raise ValueError('Invalid SSH port')
        for command in ('iptables', 'ip6tables'):
            run([command, '-w', '10', '-N', chain]); created.append(command)
            run([command, '-w', '10', '-A', chain, '-i', 'lo', '-j', 'ACCEPT'])
            run([command, '-w', '10', '-A', chain, '-p', 'tcp', '--dport', str(ssh_port), '-j', 'RETURN'])
            if command == 'iptables':
                for peer in peers: run([command, '-w', '10', '-A', chain, '-s', peer, '-j', 'ACCEPT'])
            run([command, '-w', '10', '-A', chain, '-j', 'REJECT'])
            run([command, '-w', '10', '-I', *rule])
        # Drop privilege before running any course package. The parent retains cleanup permission.
        import pwd
        account = pwd.getpwnam(config['user'])
        env = dict(os.environ, HOME=account.pw_dir, USER=account.pw_name, LOGNAME=account.pw_name)
        child = subprocess.Popen([config['python'], config['root'] + '/gpu_setup.py', 'serve',
                                  base64.b64encode(json.dumps(config).encode()).decode()], env=env,
                                 user=account.pw_uid, group=account.pw_gid, extra_groups=[])
        def stop(*_):
            child.terminate()
        signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGHUP, stop)
        code = child.wait()
        if code: raise RuntimeError('The cluster service stopped.')
    finally:
        for command in created:
            subprocess.run([command, '-w', '10', '-D', *rule], capture_output=True, timeout=20)
            subprocess.run([command, '-w', '10', '-F', chain], capture_output=True, timeout=20)
            subprocess.run([command, '-w', '10', '-X', chain], capture_output=True, timeout=20)


def serve(config):
    """A kept-open SSH stream owns this node's Ray processes; no global `ray stop`."""
    import psutil
    root, record = node(config)
    address = config['address']
    if not private_ipv4(address): raise RuntimeError('Choose a private cluster address.')
    env = dict(os.environ, VLLM_HOST_IP=address, RAY_USAGE_STATS_ENABLED='0',
               CUDA_VISIBLE_DEVICES=','.join(g['uuid'] for g in record['gpus']), DHIMANTAI_RUNTIME_SESSION=config['session'])
    args = [str(Path(record['python']).with_name('ray')), 'start', '--block', '--disable-usage-stats',
            '--node-ip-address=' + address, '--num-gpus=' + str(config['recipe']['gpusPerNode']),
            '--node-manager-port=16400', '--object-manager-port=16401', '--runtime-env-agent-port=16402',
            '--dashboard-agent-listen-port=16403', '--dashboard-agent-grpc-port=16404',
            '--metrics-export-port=16405', '--min-worker-port=16410', '--max-worker-port=16431',
            '--temp-dir=' + str(root / 'ray')]
    args += ['--head', '--port=16379', '--include-dashboard=false'] if config['head'] == address else ['--address=' + config['head'] + ':16379']
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGHUP, lambda *_: stopped.set())
    def controls():
        for _ in sys.stdin: pass
        stopped.set()
    threading.Thread(target=controls, daemon=True).start()
    child = subprocess.Popen(args, env=env, stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not stopped.is_set():
            if child.poll() is not None: raise RuntimeError('Ray failed to start. Check the private network and available ports.')
            try:
                with socket.create_connection((address, 16400), timeout=1): break
            except OSError: stopped.wait(.5)
        else: raise RuntimeError('Ray startup timed out.')
        print('DHIMANTAI_READY ' + json.dumps({'address': address}), flush=True)
        while not stopped.wait(1):
            if child.poll() is not None: raise RuntimeError('Ray stopped; reconnect the lab runtime.')
    finally:
        owned = []
        for process in psutil.process_iter(['pid', 'uids']):
            try:
                if process.pid != os.getpid() and process.uids().real == os.getuid() and process.environ().get('DHIMANTAI_RUNTIME_SESSION') == config['session']:
                    owned.append(process)
            except (psutil.NoSuchProcess, psutil.AccessDenied): pass
        for process in owned:
            try: process.terminate()
            except psutil.NoSuchProcess: pass
        _, alive = psutil.wait_procs(owned, timeout=8)
        for process in alive:
            try: process.kill()
            except psutil.NoSuchProcess: pass


def verify(config):
    root, record = node(config)
    env = runtime_env(config, record)
    if config['recipe']['recipe'] == 'gpu-python-v1':
        code = 'import torch; assert torch.cuda.is_available(); assert torch.ones(4,device="cuda").sum().item()==4'
    elif config['recipe']['nodes'] == 1:
        code = ('from vllm import LLM, SamplingParams; m=LLM(model=' + repr(str(root / 'model'))
                + ',tensor_parallel_size=' + str(config['recipe']['gpusPerNode'])
                + ',dtype="half",max_model_len=1024,gpu_memory_utilization=0.7,enforce_eager=True); '
                'r=m.generate(["Hello"],SamplingParams(max_tokens=4)); assert r[0].outputs[0].token_ids')
    else:
        code = '''import ray, torch
from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy
ray.init(address="auto", logging_level="ERROR")
nodes=[n for n in ray.nodes() if n['Alive'] and n.get('Resources',{}).get('GPU',0)>0]
expected=EXPECTED
assert sorted(n['NodeManagerAddress'] for n in nodes)==sorted(expected), 'Ray membership differs from the supplied machines'
@ray.remote(num_gpus=1)
def probe():
    import torch, ray
    assert torch.ones(2,device='cuda').sum().item()==2
    return ray.get_runtime_context().get_node_id()
results=ray.get([probe.options(scheduling_strategy=NodeAffinitySchedulingStrategy(n['NodeID'],soft=False)).remote() for n in nodes],timeout=90)
assert len(set(results))==len(expected), 'A GPU worker was not verified'
ray.shutdown()
'''.replace('EXPECTED', repr(config['peers']))
    progress('Verifying GPU execution on every required machine')
    run([record['python'], '-c', code], 360, env=env, stdout=sys.stderr)
    if config['recipe']['nodes'] > 1:
        progress('Testing distributed vLLM inference')
        run([record['python'], str(root / 'cluster.py'), '--model-path', str(root / 'model')], 600, env=env, stdout=sys.stderr)
    return {'nodes': config['recipe']['nodes'], 'gpus': config['recipe']['nodes'] * config['recipe']['gpusPerNode']}


def runtime_env(config, record):
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=','.join(g['uuid'] for g in record['gpus']),
                VLLM_HOST_IP=config.get('address', '127.0.0.1'),
                RAY_USAGE_STATS_ENABLED='0',
                PATH=str(Path(record['python']).parent) + ':' + os.environ.get('PATH', ''))
    env.pop('RAY_ADDRESS', None)
    env['DHIMANTAI_GPU_NODES'] = str(config['recipe']['nodes'])
    env['DHIMANTAI_GPUS_PER_NODE'] = str(config['recipe']['gpusPerNode'])
    if config['recipe']['recipe'] == 'inference-nvidia-v1':
        env['DHIMANTAI_INFERENCE_PYTHON'] = record['python']
        env['DHIMANTAI_MODEL_PATH'] = record['root'] + '/model'
    if config['recipe']['nodes'] > 1: env['RAY_ADDRESS'] = config['head'] + ':16379'
    return env


def execute(config):
    root, record = node(config)
    enter_workspace(config)
    os.execve(record['python'], [record['python'], '-u', str(root / 'cells.py'), '--ssh-runtime'], runtime_env(config, record))


def enter_workspace(config):
    if not re.fullmatch(r'[a-f0-9]{24}', config['workspace']): raise ValueError('Invalid workspace')
    workspace = persistent_home(config) / 'dhimantai/labs' / config['workspace']
    workspace.mkdir(parents=True, exist_ok=True)
    os.chdir(workspace)


def terminal(config):
    _, record = node(config)
    enter_workspace(config)
    os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], runtime_env(config, record))


def archive(config):
    if not re.fullmatch(r'[a-f0-9]{24}', config['workspace']): raise ValueError('Invalid workspace')
    workspace = persistent_home(config) / 'dhimantai/labs' / config['workspace']
    workspace.mkdir(parents=True, exist_ok=True)
    # Stream without following links. Package environments are reproducible, not learner artifacts.
    import tarfile
    def keep(info):
        return None if any(part in ('.venv', '.cache', '.dhimantai-inference', '.tts-bootstrap', '__pycache__') for part in Path(info.name).parts) else info
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz', dereference=False) as bundle:
        bundle.add(workspace, arcname='lab', filter=keep)
        root, _ = node(config)
        bundle.add(root / 'node.json', arcname='runtime/node.json')
        logs = root / 'ray/session_latest/logs'
        if logs.is_dir(): bundle.add(logs.resolve(), arcname='runtime/ray-logs', filter=keep)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        action, encoded = sys.argv[1:3]
        config = json.loads(base64.b64decode(sys.stdin.read() if encoded == '-' else encoded))
        result = {'prepare': prepare, 'firewall': firewall, 'serve': serve, 'verify': verify, 'execute': execute, 'terminal': terminal, 'archive': archive}[action](config)
        if result is not None: print('DHIMANTAI_RESULT ' + json.dumps(result), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
