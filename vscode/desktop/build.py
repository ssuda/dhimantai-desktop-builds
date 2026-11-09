#!/usr/bin/env python3
"""Build a pinned, separate dhimantAI desktop preview on its target OS."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import uuid
import zipfile

from customize import customize

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LOCK = json.loads((HERE / 'lock.json').read_text())


def run(args, cwd, env=None, timeout=1800):
    if os.name == 'nt' and args[0] == 'bash':
        # System32/bash.exe is the WSL launcher, not the Git Bash used by VSCodium.
        git = Path(shutil.which('git') or '')
        # Git may be exposed through cmd/, bin/, or mingw64/bin/ on hosted runners.
        candidates = [git.parent / 'bash.exe', *[parent / 'bin/bash.exe' for parent in list(git.parents)[:3]]]
        bash = next((path for path in candidates if path.is_file()), None)
        if bash is None:
            raise RuntimeError('Git for Windows Bash is required; WSL is not a native Windows builder')
        args = [bash, *args[1:]]
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True, timeout=timeout)


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def product():
    data = dict(nameShort='dhimantAI', nameLong='dhimantAI', applicationName='dhimantai',
        dataFolderName='.dhimantai-desktop', linuxIconName='dhimantai', quality='stable',
        urlProtocol='dhimantai', serverApplicationName='dhimantai-server', serverDataFolderName='.dhimantai-server',
        darwinBundleIdentifier='ai.dhimant.desktop', win32AppUserModelId='OptficialLabs.dhimantAI',
        win32DirName='dhimantAI', win32MutexName='dhimantai', win32NameVersion='dhimantAI',
        win32RegValueName='dhimantai', win32ShellNameShort='dhimantAI', tunnelApplicationName='dhimantai-tunnel',
        win32TunnelServiceMutex='dhimantai-tunnelservice', win32TunnelMutex='dhimantai-tunnel',
        electronArtifactFeed='', updateUrl='', downloadUrl='https://dhimant.ai/upskill/', enableTelemetry=False)
    for key in ['win32AppId', 'win32x64AppId', 'win32arm64AppId', 'win32UserAppId', 'win32x64UserAppId', 'win32arm64UserAppId']:
        data[key] = '{{' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'https://dhimant.ai/desktop/' + key)).upper() + '}'
    data['win32ContextMenu'] = {arch: {'clsid': str(uuid.uuid5(uuid.NAMESPACE_URL,
        'https://dhimant.ai/desktop/context/' + arch)).upper()} for arch in ['x64', 'arm64']}
    return data


def checkout(path, repository, commit):
    if path.exists():
        raise RuntimeError(f'Refusing to overwrite {path}; use a new --cache for preparation')
    path.mkdir(parents=True)
    run(['git', 'init', '-q'], path)
    run(['git', 'remote', 'add', 'origin', repository], path)
    run(['git', 'fetch', '--depth=1', 'origin', commit], path, timeout=600)
    run(['git', 'checkout', '--detach', 'FETCH_HEAD'], path)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=path, text=True).strip()
    if actual != commit:
        raise RuntimeError('Source pin mismatch')


def icons(source):
    from PIL import Image, ImageOps
    with Image.open(REPO / 'website/upskill/assets/dhimantai-logo.png') as image:
        image = ImageOps.pad(image.convert('RGBA'), (1024, 1024), color=(255, 255, 255, 0))
        image.save(source / 'resources/darwin/code.icns')
        image.save(source / 'resources/win32/code.ico', sizes=[(n, n) for n in [16, 24, 32, 48, 64, 128, 256]])
        image.resize((512, 512)).save(source / 'resources/linux/code.png')


def bundle_extension(app_resources, vsix, configs):
    destination = app_resources / 'app/extensions/optficial.dhimantai-learning'
    if destination.exists():
        shutil.rmtree(destination)
    with zipfile.ZipFile(vsix) as archive:
        metadata = json.loads(archive.read('extension/package.json'))
        if metadata['publisher'] != 'optficial' or metadata['name'] != 'dhimantai-learning':
            raise RuntimeError('Unexpected extension package')
        for entry in archive.infolist():
            if not entry.filename.startswith('extension/') or entry.is_dir():
                continue
            relative = Path(entry.filename).relative_to('extension')
            if relative.is_absolute() or '..' in relative.parts or '\\' in entry.filename:
                raise RuntimeError('Unsafe VSIX entry')
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
    client = {}
    for value in configs:
        name, filename = value.split('=', 1)
        if name not in ['staging', 'production']:
            raise RuntimeError('Only staging and production Flutter configurations can be packaged')
        data = json.loads(Path(filename).read_text())
        expected = 'https://api-staging.dhimant.ai' if name == 'staging' else 'https://api-prod.dhimant.ai'
        if data.get('LIVEKIT_TOKEN_URL') != expected or not data.get('LIVEKIT_TOKEN_SECRET'):
            raise RuntimeError('Flutter client configuration does not match its environment')
        # Same client HMAC credential shipped by Flutter. Never copy any server/API secrets.
        client[name] = {'tokenUrl': expected, 'signingKey': data['LIVEKIT_TOKEN_SECRET'],
            'appName': 'dhimantAI Staging' if name == 'staging' else 'dhimantAI'}
    if not client:
        raise RuntimeError('Pass --flutter-env staging=/path/to/env.staging.json (or production=...)')
    (destination / 'desktop-client.json').write_text(json.dumps(client))
    metadata['contributes'].setdefault('configurationDefaults', {}).update({
        'workbench.startupEditor': 'none', 'dhimantai.autoUpdate': False,
        'workbench.colorTheme': 'Light Modern',
        'workbench.activityBar.location': 'hidden',
        'dhimantai.environment': 'production' if 'production' in client else 'staging'})
    (destination / 'package.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return metadata['version']


def verify_copilot_optional(app_resources):
    app = app_resources / 'app'
    product = json.loads((app / 'product.json').read_text())
    if not product.get('defaultChatAgent', {}).get('chatExtensionId'):
        raise RuntimeError('The desktop must retain the optional Copilot provider configuration')
    metadata = json.loads((app / 'extensions/optficial.dhimantai-learning/package.json').read_text())
    defaults = metadata['contributes']['configurationDefaults']
    if defaults.get('chat.disableAIFeatures') is not True or defaults.get('workbench.activityBar.location') != 'hidden':
        raise RuntimeError('Expected Copilot disabled and Activity Bar hidden defaults')
    return any(json.loads(path.read_text()).get('publisher', '').lower() == 'github'
        and json.loads(path.read_text()).get('name', '').lower() in ['copilot', 'copilot-chat', 'copilot-nightly']
        for path in (app / 'extensions').glob('*/package.json'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--stage', choices=['prepare', 'build', 'package', 'all'], default='all')
    parser.add_argument('--arch', choices=['x64', 'arm64'], required=True)
    parser.add_argument('--vsix', type=Path)
    parser.add_argument('--flutter-env', action='append', default=[], metavar='ENV=FILE')
    parser.add_argument('--out', type=Path, default=HERE / 'out')
    args = parser.parse_args()
    system = {'Darwin': 'darwin', 'Windows': 'win32', 'Linux': 'linux'}[platform.system()]
    native = 'arm64' if platform.machine().lower() in ['arm64', 'aarch64'] else 'x64'
    if native != args.arch:
        raise RuntimeError('Use a native runner for each architecture')
    node = subprocess.check_output(['node', '--version'], text=True).strip()
    if node != 'v' + LOCK['nodeVersion']:
        raise RuntimeError('Use Node ' + LOCK['nodeVersion'])
    cache = args.cache.resolve(); cache.mkdir(parents=True, exist_ok=True)
    codium = cache / 'vscodium'; source = codium / 'vscode'
    build_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    commit = build_commit
    exported = REPO / 'build-source.json'
    if exported.exists():
        provenance = json.loads(exported.read_text())
        commit = provenance['sourceCommit']
        if not re.fullmatch(r'[a-f0-9]{40}', commit):
            raise RuntimeError('Invalid exported source commit')
        for name, expected in provenance['files'].items():
            relative = Path(name)
            if relative.is_absolute() or '..' in relative.parts or digest(REPO / relative) != expected:
                raise RuntimeError(f'Exported build source mismatch: {name}')
    env = {**os.environ, 'OS_NAME': {'darwin': 'osx', 'win32': 'windows', 'linux': 'linux'}[system],
        'VSCODE_ARCH': args.arch, 'VSCODE_QUALITY': 'stable', 'CI_BUILD': 'no', 'DISABLE_UPDATE': 'yes',
        'RELEASE_VERSION': LOCK['appVersion'], 'APP_NAME': 'dhimantAI', 'APP_NAME_LC': 'dhimantai',
        'BINARY_NAME': 'dhimantai', 'ORG_NAME': 'Optficial Labs Pvt Ltd', 'GLOBAL_DIRNAME': 'dhimantai',
        'ASSETS_REPOSITORY': 'Optficial/dhimantai', 'GH_REPO_PATH': 'Optficial/dhimantai',
        'SHOULD_BUILD_CLI': 'no', 'SHOULD_BUILD_REH': 'no', 'SHOULD_BUILD_REH_WEB': 'no',
        'MAX_OLD_SPACE_SIZE': os.environ.get('MAX_OLD_SPACE_SIZE', '12288'),
        'NODE_OPTIONS': '--max-old-space-size=' + os.environ.get('MAX_OLD_SPACE_SIZE', '12288'),
        'BUILD_SOURCEVERSION': commit, 'VSCODE_PUBLISH_COUNTER': '1'}
    npm = 'npm.cmd' if system == 'win32' else 'npm'
    if args.stage in ['prepare', 'all']:
        checkout(codium, LOCK['vscodiumRepository'], LOCK['vscodiumCommit'])
        checkout(source, LOCK['vscodeRepository'], LOCK['vscodeCommit'])
        (codium / 'product.json').write_text(json.dumps(product(), indent=2))
        preparation = codium / 'prepare_vscode.sh'
        text = preparation.read_text()
        if 'for i in {1..5}; do' not in text or 'if [[ $i == 5 ]]' not in text:
            raise RuntimeError('Dependency retry policy changed upstream')
        text = text.replace('for i in {1..5}; do', 'for i in {1..2}; do').replace('if [[ $i == 5 ]]', 'if [[ $i == 2 ]]')
        text = text.replace('sleep $(( 15 * (i + 1)))', 'sleep 5')
        preparation.write_text(text, newline='\n')
        run(['bash', 'prepare_vscode.sh'], codium, env, timeout=7200)
        customize(source)
    if not source.is_dir():
        raise RuntimeError('Run --stage prepare first')
    actual_product = json.loads((source / 'product.json').read_text())
    if actual_product.get('dhimantaiDesktop', {}).get('version') != LOCK['release']:
        raise RuntimeError('Desktop customization does not match the lock')
    if args.stage in ['build', 'all']:
        icons(source)
        if system == 'win32':
            run(['bash', 'build/windows/rtf/make.sh'], codium, env)
        run([npm, 'run', 'gulp', 'vscode-min-prepack'], source, env, timeout=7200)
        run([npm, 'run', 'gulp', f'vscode-{system}-{args.arch}-min-packing'], source, env, timeout=3600)
    if args.stage not in ['package', 'all']:
        return
    if not args.vsix or not args.vsix.is_file():
        raise RuntimeError('Pass a compiled extension --vsix')
    built = codium / f'VSCode-{system}-{args.arch}'
    app = built / 'dhimantAI.app'
    resources = app / 'Contents/Resources' if system == 'darwin' else built / 'resources'
    extension_version = bundle_extension(resources, args.vsix, args.flutter_env)
    copilot_included = verify_copilot_optional(resources)
    output = args.out.resolve(); output.mkdir(parents=True, exist_ok=True)
    stem = f'dhimantAI-{LOCK["release"]}-{system}-{args.arch}'
    outputs = []
    if system == 'darwin':
        info = app / 'Contents/Info.plist'
        data = plistlib.loads(info.read_bytes())
        data.update(NSMicrophoneUsageDescription='Speak to your dhimantAI Instructor when you turn on the microphone.',
            NSCameraUsageDescription='Share your camera with dhimantAI Instructor when you turn it on.')
        info.write_bytes(plistlib.dumps(data))
        run(['node', HERE / 'sign-preview.mjs', source, app], REPO, env)
        run(['codesign', '--verify', '--deep', '--strict', app], REPO)
        disk = output / (stem + '.dmg')
        run(['hdiutil', 'create', '-ov', '-format', 'UDZO', '-volname', 'dhimantAI Preview', '-srcfolder', built, disk], REPO)
        outputs.append(disk)
    elif system == 'win32':
        # Inno Setup requires the upstream maintenance helper in tools/, even
        # when automatic updates are disabled. It also cleans up manual upgrades.
        run([npm, 'run', 'gulp', f'vscode-win32-{args.arch}-inno-updater'], source, env)
        for name in ['inno_updater.exe', 'vcruntime140.dll']:
            if not (built / 'tools' / name).is_file():
                raise RuntimeError(f'Missing Windows installer helper: {name}')
        run([npm, 'run', 'gulp', f'vscode-win32-{args.arch}-user-setup'], source, env)
        installer = source / f'.build/win32-{args.arch}/user-setup/VSCodeSetup.exe'
        target = output / (stem + '-setup.exe'); shutil.copyfile(installer, target); outputs.append(target)
    else:
        archive = shutil.make_archive(str(output / stem), 'gztar', root_dir=codium, base_dir=built.name)
        outputs.append(Path(archive))
        # Package the same payload for Debian/Ubuntu. RPM is available through the
        # corresponding upstream gulp tasks on a runner with rpmbuild installed.
        run([npm, 'run', 'gulp', f'vscode-linux-{args.arch}-prepare-deb'], source, env)
        run([npm, 'run', 'gulp', f'vscode-linux-{args.arch}-build-deb'], source, env)
        for deb in (source / '.build/linux/deb').rglob('*.deb'):
            target = output / deb.name; shutil.copyfile(deb, target); outputs.append(target)
    receipt = {'release': LOCK['release'], 'pins': LOCK, 'sourceCommit': commit, 'buildCommit': build_commit,
        'extensionVersion': extension_version, 'extensionSha256': digest(args.vsix),
        'platform': system, 'arch': args.arch, 'signing': 'ad-hoc' if system == 'darwin' else 'unsigned',
        'automaticUpdates': False, 'copilotIncluded': copilot_included, 'copilotPolicy': 'course',
        'clientEnvironments': [entry.split('=', 1)[0] for entry in args.flutter_env],
        'files': [{'name': file.name, 'sha256': digest(file), 'bytes': file.stat().st_size} for file in outputs]}
    (output / (stem + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
    print('Preview artifacts:', output)


if __name__ == '__main__':
    main()
