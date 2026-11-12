#!/usr/bin/env python3
"""Install, inspect, launch the CLI, and uninstall on a disposable Windows runner."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys


def main():
    if platform.system() != 'Windows' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Run only on a disposable GitHub Windows runner')
    receipt_path = Path(sys.argv[1]).resolve()
    receipt = json.loads(receipt_path.read_text())
    arch = {'AMD64': 'x64', 'ARM64': 'arm64'}[platform.machine().upper()]
    assert receipt['platform'] == 'win32' and receipt['arch'] == arch
    assert receipt['clientEnvironments'] == ['staging']
    assert receipt['automaticUpdates'] is False and receipt['copilotIncluded'] is False
    assert len(receipt['files']) == 1
    item = receipt['files'][0]
    assert Path(item['name']).name == item['name'] and item['name'].endswith('-setup.exe')
    installer = receipt_path.parent / item['name']
    with installer.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256']
    assert installer.stat().st_size == item['bytes']
    root = Path(os.environ['RUNNER_TEMP']) / 'dhimantai-installer-smoke'
    if root.exists():
        raise RuntimeError('Use a fresh runner; refusing to replace an existing installation')
    try:
        subprocess.run([str(installer), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
                        '/TASKS=', '/DIR=' + str(root)], check=True, timeout=300)
        app = root / 'resources/app'
        product = json.loads((app / 'product.json').read_text())
        assert product['applicationName'] == 'dhimantai' and not product['updateUrl']
        assert product['dhimantaiDesktop']['mediaCapture'] is True
        assert product['dhimantaiDesktop']['version'] == receipt['release']
        extension = app / 'extensions/optficial.dhimantai-learning'
        package = json.loads((extension / 'package.json').read_text())
        assert package['version'] == receipt['extensionVersion']
        defaults = package['contributes']['configurationDefaults']
        assert defaults['dhimantai.environment'] == 'staging'
        assert defaults['workbench.colorTheme'] == 'Light Modern'
        assert defaults['workbench.activityBar.location'] == 'default'
        assert defaults['workbench.activityBar.compact'] is True
        assert defaults['chat.disableAIFeatures'] is True
        client = json.loads((extension / 'desktop-client.json').read_text())
        assert set(client) == {'staging'}
        assert client['staging']['tokenUrl'] == 'https://api-staging.dhimant.ai'
        assert client['staging']['signingKey']
        assert not list((app / 'extensions').glob('github.copilot*'))
        for name in ['inno_updater.exe', 'vcruntime140.dll']:
            assert (root / 'tools' / name).is_file()
        with (root / 'dhimantAI.exe').open('rb') as stream:
            assert stream.read(2) == b'MZ'
            stream.seek(60)
            stream.seek(int.from_bytes(stream.read(4), 'little'))
            assert stream.read(4) == b'PE\0\0'
            assert int.from_bytes(stream.read(2), 'little') == {'x64': 0x8664, 'arm64': 0xAA64}[arch]
        version = subprocess.check_output(['cmd.exe', '/d', '/c', str(root / 'bin/dhimantai.cmd'),
                                           '--version'], text=True, timeout=60).strip().splitlines()
        assert receipt['pins']['appVersion'] in version and arch in version
    finally:
        uninstaller = root / 'unins000.exe'
        if uninstaller.exists():
            subprocess.run([str(uninstaller), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
                           check=True, timeout=180)
    assert not (root / 'dhimantAI.exe').exists()
    output = Path(os.environ['RUNNER_TEMP']) / 'windows-install-acceptance.json'
    result = dict(arch=arch, file=item['name'], sha256=item['sha256'], bytes=item['bytes'],
                  installed=True, cliVersion=version, uninstalled=True, defaultsVerified=True,
                  environment='staging', guiMediaAcceptance=False,
                  sourceCommit=receipt['sourceCommit'], buildCommit=receipt['buildCommit'])
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
