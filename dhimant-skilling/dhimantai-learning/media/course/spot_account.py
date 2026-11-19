"""Student-local cloud CLI setup. Invoked in the same OS/WSL as SkyPilot."""
import fcntl
import hashlib
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import venv

SKY_VERSION = '0.14.3'
TOOLS = Path.home() / '.local/share/dhimantai/spot-tools'
SUPPORTED = ('aws', 'gcp', 'azure')
GCLOUD_VERSION = '594.0.0'
# SHA-256 for Google’s versioned archives, from the Homebrew gcloud-cli 594.0.0 cask.
GCLOUD_ARCHIVES = {
    ('darwin', 'arm64'): ('darwin-arm', '45fbcc5a2caf9ec43847383d2f9fe4720eb8a650349be8d9bd271bdfb6912b55'),
    ('darwin', 'x86_64'): ('darwin-x86_64', 'f8c788cb2ce0af3bd03f236d67c825afe810908f4cd1ade435eb7b5bfb4173c7'),
    ('linux', 'aarch64'): ('linux-arm', 'e58fb86fff3dfd7101e1ff138f06bd4e338c7bf12a7508a7871985e7ea886275'),
    ('linux', 'x86_64'): ('linux-x86_64', '1f7233537c26bba94a3ea3f9085a60396745eaf44b21b8454fc6fdd15bb6fcde'),
}


def quiet(args, timeout=30):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                                env=dict(os.environ, AWS_CLI_AUTO_PROMPT='off', AWS_PAGER='',
                                         AWS_EC2_METADATA_DISABLED='true'))
    except (OSError, subprocess.TimeoutExpired):
        return ''
    return result.stdout.strip() if result.returncode == 0 else ''


def sdk_python(provider):
    return TOOLS / provider / 'bin/python'


def installed_sdk_python(provider):
    python = sdk_python(provider)
    if python.is_file():
        return python
    sky = shutil.which('sky')
    return Path(sky).resolve().with_name('python') if sky else None


def sdk_ready(provider):
    python = installed_sdk_python(provider)
    if python is None:
        return False
    imports = {'aws': 'import boto3, awscrt', 'azure': 'import azure.cli.core, msgraph',
               'gcp': 'import googleapiclient.discovery, google.cloud.storage, OpenSSL'}[provider]
    return quiet([str(python), '-I', '-c', imports + '; from importlib.metadata import version; print(version("skypilot"))']) == SKY_VERSION


def cli(provider):
    if provider == 'gcp':
        local = TOOLS / ('google-cloud-cli-' + GCLOUD_VERSION) / 'bin/gcloud'
        return str(local) if os.access(local, os.X_OK) else shutil.which('gcloud')
    if provider == 'azure':
        local = sdk_python(provider).with_name('az')
        return str(local) if local.is_file() else shutil.which('az')
    # SkyPilot's aws extra also installs CLI v1. Browser login needs CLI v2.
    bins = [str(TOOLS / 'aws-cli/aws'), str(TOOLS / 'bin/aws')]
    bins += [str(Path(p) / 'aws') for p in os.get_exec_path() if p]
    for path in dict.fromkeys(bins):
        if os.access(path, os.X_OK):
            match = re.search(r'aws-cli/(\d+)\.(\d+)', quiet([path, '--version']))
            if match and tuple(map(int, match.groups())) >= (2, 32):
                return path
    return None


def account_state(provider):
    command = cli(provider)
    if not command or not sdk_ready(provider):
        return 'install'
    if provider == 'gcp':
        if not quiet([command, 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']):
            return 'login'
        # The CLI and SkyPilot use separate credential stores. Discard token
        # output entirely, including when a refresh fails or requires interaction.
        for args in (['auth', 'print-access-token'], ['auth', 'application-default', 'print-access-token']):
            try:
                result = subprocess.run([command, *args, '--quiet'], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            except (OSError, subprocess.TimeoutExpired):
                return 'login'
            if result.returncode:
                return 'login'
        project = quiet([command, 'config', 'list', '--format=value(core.project)'])
        return 'ready' if project else 'project'
    args = (['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']
            if provider == 'aws' else ['account', 'get-access-token', '--query', 'subscription', '-o', 'tsv'])
    return 'ready' if quiet([command, *args]) else 'login'


def download(url, dest):
    subprocess.run(['curl', '--fail', '--location', '--retry', '2', '--proto', '=https',
                    '--proto-redir', '=https', '--output', str(dest), url], check=True)


def install_gcloud():
    archive = GCLOUD_ARCHIVES.get((sys.platform, platform.machine()))
    if archive is None:
        raise RuntimeError('Google Cloud CLI requires a supported 64-bit macOS or Linux/WSL installation.')
    platform_name, checksum = archive
    filename = f'google-cloud-cli-{GCLOUD_VERSION}-{platform_name}.tar.gz'
    with tempfile.TemporaryDirectory(dir=TOOLS) as scratch:
        tmp = Path(scratch)
        package = tmp / filename
        download('https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/' + filename, package)
        digest = hashlib.sha256()
        with package.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != checksum:
            raise RuntimeError('The Google Cloud CLI download did not match its published checksum.')
        subprocess.run(['tar', '-xzf', str(package), '-C', str(tmp)], check=True)
        (tmp / 'google-cloud-sdk').rename(TOOLS / ('google-cloud-cli-' + GCLOUD_VERSION))


def install_aws(tmp):
    if sys.platform == 'darwin':
        pkg = tmp / 'AWSCLIV2.pkg'
        download('https://awscli.amazonaws.com/AWSCLIV2.pkg', pkg)
        subprocess.run(['/usr/sbin/pkgutil', '--check-signature', str(pkg)], check=True)
        choices = tmp / 'choices.plist'
        choices.write_bytes(plistlib.dumps([dict(choiceIdentifier='default', choiceAttribute='customLocation',
                                                attributeSetting=str(TOOLS))]))
        subprocess.run(['/usr/sbin/installer', '-pkg', str(pkg), '-target', 'CurrentUserHomeDirectory',
                        '-applyChoiceChangesXML', str(choices)], check=True)
        return
    arch = platform.machine()
    if sys.platform != 'linux' or arch not in ('x86_64', 'aarch64'):
        raise RuntimeError('AWS CLI requires a supported macOS or 64-bit Linux/WSL installation.')
    if not shutil.which('gpg') or not shutil.which('unzip'):
        if not shutil.which('apt-get'):
            raise RuntimeError('Install GnuPG and unzip with your Linux package manager, then retry.')
        subprocess.run(['sudo', 'apt-get', 'update'], check=True)
        subprocess.run(['sudo', 'apt-get', 'install', '-y', 'gnupg', 'unzip'], check=True)
    archive = tmp / 'aws.zip'
    url = 'https://awscli.amazonaws.com/awscli-exe-linux-' + arch + '.zip'
    download(url, archive)
    signature = tmp / 'aws.sig'
    download(url + '.sig', signature)
    keyring = tmp / 'gnupg'
    keyring.mkdir(mode=0o700)
    gpg = ['gpg', '--batch', '--homedir', str(keyring)]
    subprocess.run([*gpg, '--import', str(Path(__file__).with_name('aws-cli-signing-key.txt'))], check=True)
    subprocess.run([*gpg, '--verify', str(signature), str(archive)], check=True)
    subprocess.run(['unzip', '-q', str(archive), '-d', str(tmp)], check=True)
    subprocess.run([str(tmp / 'aws/install'), '--update', '--install-dir', str(TOOLS / 'aws-cli'),
                    '--bin-dir', str(TOOLS / 'bin')], check=True)


def install(provider):
    TOOLS.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (TOOLS / 'install.lock').open('a') as lock, tempfile.TemporaryDirectory() as scratch:
        fcntl.flock(lock, fcntl.LOCK_EX)
        tmp = Path(scratch)
        if provider == 'aws' and not cli(provider):
            install_aws(tmp)
        if provider == 'gcp' and not cli(provider):
            install_gcloud()
        if not sdk_ready(provider) or not cli(provider):
            uv = shutil.which('uv')
            if not uv and sys.platform == 'linux':
                # Minimal WSL distributions often ship Python without ensurepip.
                from gpu_setup import install_uv
                uv = str(install_uv(tmp, '0.13.8'))
            if not uv:
                venv.EnvBuilder(with_pip=True).create(tmp / 'bootstrap')
                subprocess.run([str(tmp / 'bootstrap/bin/python'), '-m', 'pip', 'install', 'uv==0.13.8'], check=True)
                uv = str(tmp / 'bootstrap/bin/uv')
            python = sdk_python(provider)
            if not python.is_file():
                subprocess.run([uv, 'venv', '--seed', '--python', '3.12', '--managed-python', str(TOOLS / provider)], check=True)
            packages = ['skypilot[' + provider + ']==' + SKY_VERSION, 'wheel', 'setuptools', 'pip']
            if provider == 'aws':
                packages.append('boto3[crt]>=1.41')
            # Azure CLI pins beta Azure SDKs. pip honors those pins while keeping
            # other dependencies stable. Kiota still uses the httpx 0.x API.
            if provider == 'azure':
                subprocess.run([str(python), '-m', 'pip', 'install', *packages, 'httpx==0.28.1'], check=True)
            else:
                subprocess.run([uv, 'pip', 'install', '--python', str(python), *packages], check=True)
        if not cli(provider) or not sdk_ready(provider):
            raise RuntimeError('The cloud tools did not finish installing. Check the installer output and retry.')


def login(provider):
    command = cli(provider)
    if not command:
        raise RuntimeError('Install the provider CLI before signing in.')
    if provider == 'gcp':
        args = ['auth', 'login', '--update-adc']
    elif provider == 'azure':
        # Keep Azure's interactive subscription selection but omit account details in terminal output.
        args = ['login', '--output', 'none']
    else:
        sso = any(quiet([command, 'configure', 'get', key]) for key in ('sso_session', 'sso_start_url'))
        args = ['sso', 'login'] if sso else ['login']
    subprocess.run([command, *args], check=True)


def select_gcp_project():
    command = cli('gcp')
    project = input('Enter the ID of your existing Google Cloud lab project: ').strip()
    if not project or project.startswith('-'):
        raise ValueError('Enter a Google Cloud project ID.')
    project_id = quiet([command, 'projects', 'describe', project, '--quiet', '--format=value(projectId)'])
    if not project_id:
        raise RuntimeError('This account could not access that Google Cloud project.')
    subprocess.run([command, 'config', 'set', 'project', project_id], check=True)
