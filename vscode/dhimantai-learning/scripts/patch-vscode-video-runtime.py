#!/usr/bin/env python3
"""Check, patch, or restore the tested VS Code media runtime on macOS arm64.

Default: read-only check. --apply requires VS Code to be closed and keeps the
original app as a full backup. --restore returns that original app and signature.
--prepare creates a separate copy for acceptance testing. Profiles are untouched.

The replacement is development-signed, not Microsoft-signed or notarized.
No operating-system security settings are changed. This is a local repair,
not a redistributable product or a VSIX update.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile

CODE_VERSION = '1.145.2'
CODE_COMMIT = 'c4453f8ea430795f941c1b2ff6c9321135a74a02'
ELECTRON_VERSION = '43.8.3'
ARCHIVE_NAME = f'electron-v{ELECTRON_VERSION}-darwin-arm64.zip'
ARCHIVE_SHA256 = '08e693ae36cfd230105aabe70c626b1a243c13534a529c35a80c1b87cb8da7b4'
ARCHIVE_URL = f'https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/{ARCHIVE_NAME}'
FRAMEWORK = Path('Contents/Frameworks/Electron Framework.framework')
RUNTIME = FRAMEWORK / 'Versions/A/Electron Framework'
EXECUTABLE = Path('Contents/MacOS/Code')


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def running(app):
    output = subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True)
    found = []
    for line in output.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) == 2 and app.resolve() in Path(fields[1]).resolve().parents:
            found.append(int(fields[0]))
    return found


def require_closed(app):
    if running(app):
        raise RuntimeError('VS Code is running. Save your work and quit all its windows, then rerun. No application files were changed.')


def paths(app):
    return (app.with_name(app.name + '.before-dhimantai-video'),
            app.with_name(app.name + '.dhimantai-video.json'))


def identity(app):
    package = json.loads((app / 'Contents/Resources/app/package.json').read_text())
    product = json.loads((app / 'Contents/Resources/app/product.json').read_text())
    with (app / FRAMEWORK / 'Resources/Info.plist').open('rb') as f:
        electron = plistlib.load(f)['CFBundleVersion']
    return package['version'], product.get('commit'), electron


def validate_source(app):
    found = identity(app)
    if found != (CODE_VERSION, CODE_COMMIT, ELECTRON_VERSION):
        raise RuntimeError(f'Untested VS Code build: {found}. This script only supports '
                           f'VS Code {CODE_VERSION} ({CODE_COMMIT}), Electron {ELECTRON_VERSION}.')
    # Verify native signatures. Some official installs have root-only Node cache
    # files in the resource seal; they are omitted from the copy and regenerated.
    run('codesign', '--verify', '--deep', '--strict', '--ignore-resources', app)


def build(app, work, archive):
    archive = archive or work / ARCHIVE_NAME
    if not archive.exists():
        run('curl', '--fail', '--location', '--silent', '--show-error', '--retry', '2',
            '--connect-timeout', '15', '--max-time', '180', ARCHIVE_URL, '--output', archive)
    if digest(archive) != ARCHIVE_SHA256:
        raise ValueError('Electron archive checksum mismatch. Nothing was installed.')
    unpacked, prepared = work / 'stock', work / app.name
    unpacked.mkdir()
    run('unzip', '-q', archive, '-d', unpacked)
    # Packaged Node caches can be unreadable; VS Code regenerates them.
    run('rsync', '-a', '--exclude', '/Contents/Resources/app/node-compile-cache/', str(app) + '/', str(prepared) + '/')
    run('codesign', '--verify', '--deep', '--strict', '--ignore-resources', prepared)
    shutil.rmtree(prepared / FRAMEWORK)
    run('ditto', unpacked / 'Electron.app' / FRAMEWORK, prepared / FRAMEWORK)
    # The existing Microsoft signatures cannot authenticate a different runtime.
    # Sign only the copied app and its helpers as local development applications.
    # The untouched original, including its signatures, is retained for rollback.
    for bundle in [prepared / FRAMEWORK, *sorted((prepared / 'Contents/Frameworks').glob('*.app')), prepared]:
        run('codesign', '--force', '--sign', '-', '--options', '0', '--preserve-metadata=entitlements', bundle)
    run('codesign', '--verify', '--deep', '--strict', prepared)
    return prepared


def install_patch(app, prepared, backup, receipt_path, receipt):
    """Commit the prepared copy or restore the original on an ordinary I/O failure."""
    if os.path.lexists(backup) or os.path.lexists(receipt_path):
        raise FileExistsError('Backup or receipt already exists; nothing was replaced.')
    pending_receipt = prepared.parent / 'pending-receipt.json'
    pending_receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    # Persist recovery information before changing either application directory.
    pending_receipt.rename(receipt_path)
    moved_original = False
    try:
        app.rename(backup)
        moved_original = True
        prepared.rename(app)
    except BaseException:
        if moved_original:
            if app.exists():
                app.rename(prepared)
            backup.rename(app)
        receipt_path.unlink()
        raise


def restore(app, backup, receipt_path):
    require_closed(app)
    # Recovery after interruption between the two directory renames. The full
    # original exists and the app path is absent; no patched app is overwritten.
    if not os.path.lexists(app) and backup.is_dir():
        run('codesign', '--verify', '--deep', '--strict', '--ignore-resources', backup)
        backup.rename(app)
        receipt_path.unlink(missing_ok=True)
        return
    receipt = json.loads(receipt_path.read_text())
    if not backup.exists() and digest(app / EXECUTABLE) == receipt['originalExecutableSha256']:
        # Interrupted before the patch's first rename, or after restoring it.
        run('codesign', '--verify', '--deep', '--strict', '--ignore-resources', app)
        receipt_path.unlink()
        return
    if digest(app / EXECUTABLE) != receipt['patchedExecutableSha256'] or digest(app / RUNTIME) != receipt['patchedRuntimeSha256']:
        raise RuntimeError('VS Code has changed since this patch (possibly an update). Refusing to overwrite that newer or modified app. The original backup is retained.')
    if digest(backup / EXECUTABLE) != receipt['originalExecutableSha256']:
        raise RuntimeError('The original backup has changed; refusing automatic restore.')
    run('codesign', '--verify', '--deep', '--strict', '--ignore-resources', backup)
    require_closed(app)
    with tempfile.TemporaryDirectory(prefix='.dhimantai-video-restore-', dir=app.parent) as tmp:
        patched = Path(tmp) / app.name
        app.rename(patched)
        try:
            backup.rename(app)
        except BaseException:
            patched.rename(app)
            raise
        receipt_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Path('/Applications/Visual Studio Code.app'))
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--apply', action='store_true', help='Patch the closed application, retaining its full original as a backup')
    action.add_argument('--restore', action='store_true', help='Restore the original application and signature')
    action.add_argument('--prepare', type=Path, metavar='NEW_APP', help='Create a separate copy for testing; leave the original untouched')
    parser.add_argument('--archive', type=Path, help='Use an existing stock Electron main ZIP; its pinned SHA-256 is still checked')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        parser.error('Only macOS arm64 has been validated. Windows and Linux need separate testing.')
    app = args.app.expanduser().absolute()
    if app.is_symlink():
        parser.error('Pass the actual application path, not a symlink.')
    app = app.resolve()
    backup, receipt_path = paths(app)
    if args.restore:
        restore(app, backup, receipt_path)
        print(f'Restored original VS Code: {app}')
        return
    if args.apply:
        require_closed(app)
    validate_source(app)
    if receipt_path.exists():
        print(f'Already patched. Use --restore to restore {backup}.')
        return
    if not args.apply and not args.prepare:
        print(f'Supported: VS Code {CODE_VERSION}, Electron {ELECTRON_VERSION}, macOS arm64.')
        print('VS Code is running; quit before --apply.' if running(app) else 'VS Code is closed.')
        print(f'--apply retains the original at: {backup}')
        print('The repaired app is development-signed. Upstream app updates may replace the repair.')
        return
    if args.apply:
        require_closed(app)
        if os.path.lexists(backup):
            raise FileExistsError(f'Backup exists: {backup}. Restore or inspect it first.')
    destination = args.prepare.expanduser().absolute() if args.prepare else app
    if args.prepare and (destination.suffix != '.app' or os.path.lexists(destination) or app in destination.resolve().parents):
        parser.error('--prepare requires a new .app path outside the source application.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    archive = args.archive.expanduser().resolve() if args.archive else None
    if archive is not None and not archive.is_file():
        parser.error('--archive must be an existing ZIP file.')
    with tempfile.TemporaryDirectory(prefix='.dhimantai-video-', dir=destination.parent) as tmp:
        work = Path(tmp)
        original_hash = digest(app / EXECUTABLE)
        prepared = build(app, work, archive)
        receipt = {
            'vscode': CODE_VERSION, 'commit': CODE_COMMIT, 'electron': ELECTRON_VERSION,
            'archiveUrl': ARCHIVE_URL, 'archiveSha256': ARCHIVE_SHA256,
            'originalExecutableSha256': original_hash,
            'patchedExecutableSha256': digest(prepared / EXECUTABLE),
            'patchedRuntimeSha256': digest(prepared / RUNTIME),
            'signing': 'local ad-hoc development signatures; original signatures retained in backup',
        }
        if args.prepare:
            if os.path.lexists(destination):
                raise FileExistsError(destination)
            prepared.rename(destination)
            print(f'Prepared {destination}; source app and profiles are unchanged.')
        else:
            require_closed(app)
            validate_source(app)
            if digest(app / EXECUTABLE) != original_hash:
                raise RuntimeError('Source application changed during preparation; nothing was replaced.')
            install_patch(app, prepared, backup, receipt_path, receipt)
            print(f'Patched {app}. Original backup: {backup}')
    print('Run suiteLearningVideo to verify actual playback and pause/resume. No user profiles were changed.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
