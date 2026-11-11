#!/usr/bin/env python3
"""Provision an isolated CI signing keychain without logging credential values."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import subprocess

PROFILE = 'dhimantai-notarization'
COMMON = ('MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD',
          'MACOS_SIGNING_IDENTITY', 'APPLE_TEAM_ID')
API = ('APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER_ID')
ACCOUNT = ('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD')


def check(env):
    missing = [name for name in COMMON if not env.get(name)]
    api = any(env.get(name) for name in API)
    account = any(env.get(name) for name in ACCOUNT)
    if api and account:
        raise RuntimeError('Configure one notarization method: API key OR Apple ID')
    if not api and not account:
        missing.append('notarization: APPLE_API_KEY_P8 + APPLE_API_KEY_ID + APPLE_API_ISSUER_ID '
                       '(or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD)')
    else:
        missing.extend(name for name in (API if api else ACCOUNT) if not env.get(name))
    if missing:
        raise RuntimeError('Missing Actions secrets: ' + ', '.join(missing))
    team = env['APPLE_TEAM_ID']
    if not re.fullmatch(r'[A-Z0-9]{10}', team):
        raise RuntimeError('APPLE_TEAM_ID must be the 10-character Developer Team ID')
    identity = env['MACOS_SIGNING_IDENTITY']
    if not re.fullmatch(r'Developer ID Application: [^\r\n]+ \(' + team + r'\)', identity):
        raise RuntimeError('MACOS_SIGNING_IDENTITY must be a Developer ID Application name matching APPLE_TEAM_ID')
    try:
        certificate = base64.b64decode(''.join(env['MACOS_CERTIFICATE_P12_BASE64'].split()), validate=True)
        if not certificate:
            raise ValueError()
    except ValueError:
        raise RuntimeError('MACOS_CERTIFICATE_P12_BASE64 must contain a base64-encoded .p12') from None
    return 'api' if api else 'account'


def private_run(args, timeout=120):
    # security/notarytool arguments and diagnostics can contain passwords or keys.
    # Never let CalledProcessError/TimeoutExpired echo their argv into build logs.
    try:
        result = subprocess.run(list(map(str, args)), capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        raise RuntimeError(f'{args[0]} credential operation failed or timed out; details suppressed') from None
    if result.returncode:
        raise RuntimeError(f'{args[0]} credential operation failed (exit {result.returncode}); details suppressed')
    return result.stdout


def write_private(path, data):
    with path.open('xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def prepare(folder, env):
    method = check(env)
    folder.mkdir(mode=0o700)  # Refuse to reuse a previous job's credentials.
    keychain = folder / 'signing.keychain-db'
    password = secrets.token_urlsafe(32)
    try:
        original = shlex.split(private_run(['security', 'list-keychains', '-d', 'user']))
        (folder / 'original-keychains.json').write_text(json.dumps(original))
        private_run(['security', 'create-keychain', '-p', password, keychain])
        private_run(['security', 'set-keychain-settings', '-lut', '7200', keychain])
        private_run(['security', 'unlock-keychain', '-p', password, keychain])
        certificate = folder / 'certificate.p12'
        write_private(certificate, base64.b64decode(''.join(env['MACOS_CERTIFICATE_P12_BASE64'].split()), validate=True))
        private_run(['security', 'import', certificate, '-k', keychain, '-P', env['MACOS_CERTIFICATE_PASSWORD'],
                     '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'])
        certificate.unlink()
        private_run(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:',
                     '-s', '-k', password, keychain])
        private_run(['security', 'list-keychains', '-d', 'user', '-s', keychain, *original])
        identities = private_run(['security', 'find-identity', '-v', '-p', 'codesigning', keychain])
        if '"' + env['MACOS_SIGNING_IDENTITY'] + '"' not in identities:
            raise RuntimeError('The .p12 has no valid matching Developer ID Application identity with a private key')
        command = ['xcrun', 'notarytool', 'store-credentials', PROFILE, '--keychain', keychain, '--validate']
        if method == 'api':
            key = folder / 'AuthKey.p8'
            write_private(key, env['APPLE_API_KEY_P8'].encode())
            command += ['--key', key, '--key-id', env['APPLE_API_KEY_ID'], '--issuer', env['APPLE_API_ISSUER_ID']]
        else:
            command += ['--apple-id', env['APPLE_ID'], '--password', env['APPLE_APP_SPECIFIC_PASSWORD'],
                        '--team-id', env['APPLE_TEAM_ID']]
        private_run(command)
        (folder / 'AuthKey.p8').unlink(missing_ok=True)
    except Exception:
        cleanup(folder)
        raise
    # Only non-secret paths/profile names are shared with the packaging step.
    with Path(env['GITHUB_ENV']).open('a') as output:
        output.write(f'MACOS_SIGNING_KEYCHAIN={keychain}\nMACOS_NOTARY_KEYCHAIN_PROFILE={PROFILE}\n')


def cleanup(folder):
    if not folder.exists():
        return
    try:
        original = folder / 'original-keychains.json'
        if original.exists():
            private_run(['security', 'list-keychains', '-d', 'user', '-s', *json.loads(original.read_text())])
    finally:
        try:
            keychain = folder / 'signing.keychain-db'
            if keychain.exists():
                private_run(['security', 'delete-keychain', keychain])
        finally:
            shutil.rmtree(folder)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'prepare', 'cleanup'])
    args = parser.parse_args()
    if args.action == 'check':
        check(os.environ)
        print('Signing/notarization secrets are present; import and Apple authentication are checked before packaging.')
    else:
        folder = Path(os.environ['RUNNER_TEMP']) / 'desktop-signing'
        if args.action == 'prepare':
            prepare(folder, os.environ)
        else:
            cleanup(folder)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
