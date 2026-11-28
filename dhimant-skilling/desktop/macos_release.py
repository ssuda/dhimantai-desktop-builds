"""Developer ID signing, bounded notarization and verification of shipped DMGs."""
import json
from pathlib import Path
import re
import subprocess
import tempfile


def signing_environment(env):
    missing = [key for key in ('MACOS_SIGNING_IDENTITY', 'APPLE_TEAM_ID', 'MACOS_NOTARY_KEYCHAIN_PROFILE')
               if not env.get(key)]
    if missing:
        raise RuntimeError('Missing macOS signing configuration: ' + ', '.join(missing))
    team = env['APPLE_TEAM_ID']
    if not re.fullmatch(r'[A-Z0-9]{10}', team) or not re.fullmatch(
            r'Developer ID Application: [^\r\n]+ \(' + team + r'\)', env['MACOS_SIGNING_IDENTITY']):
        raise RuntimeError('Expected a Developer ID Application identity matching APPLE_TEAM_ID')
    return ['--keychain-profile', env['MACOS_NOTARY_KEYCHAIN_PROFILE'],
            *(['--keychain', env['MACOS_SIGNING_KEYCHAIN']] if env.get('MACOS_SIGNING_KEYCHAIN') else [])]


def notarize(path, env, reports):
    reports.mkdir(parents=True, exist_ok=True)
    report = reports / (path.stem + '-submission.json')
    auth = signing_environment(env)
    # One submission, bounded wait, no automatic re-submission on timeout.
    try:
        result = subprocess.run(['xcrun', 'notarytool', 'submit', str(path), *auth,
                                 '--wait', '--timeout', '20m', '--output-format', 'json'],
                                capture_output=True, text=True, timeout=1500)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Notarization timed out; check notarytool history before resubmitting') from None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError('Notary service returned no JSON result; check authentication/network and notarytool history') from None
    # Only persist known non-secret result fields.
    summary = {key: data[key] for key in ('id', 'status', 'message') if key in data}
    report.write_text(json.dumps(summary, indent=2) + '\n')
    submission = data.get('id', '')
    if not re.fullmatch(r'[a-fA-F0-9-]{36}', submission):
        raise RuntimeError(f'Notary service returned no submission ID; see {report}')
    if result.returncode or data.get('status') != 'Accepted':
        # The Apple report pinpoints rejected nested binaries. Do not print it.
        if data.get('status') in ('Invalid', 'Rejected'):
            try:
                subprocess.run(['xcrun', 'notarytool', 'log', submission, *auth,
                                str(reports / (path.stem + '-issues.json'))],
                               capture_output=True, text=True, timeout=120)
            except (subprocess.TimeoutExpired, OSError):
                pass  # The saved submission ID still allows manual log retrieval.
        raise RuntimeError(f'Notarization did not succeed; see {report}. Do not resubmit pending submissions.')
    return submission


def verify_app(app, env, run, cwd):
    # Require Apple's Developer ID certificate OID and the configured team.
    requirement = ('anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
                   f'and certificate leaf[subject.OU] = "{env["APPLE_TEAM_ID"]}"')
    run(['codesign', '--verify', '--deep', '--strict', '-R', requirement, app], cwd)
    run(['xcrun', 'stapler', 'validate', app], cwd)
    run(['spctl', '--assess', '--type', 'execute', '--verbose=2', app], cwd)


def package_signed(source, built, disk, env, run, cwd):
    signing_environment(env)
    app = built / 'dhimantAI.app'
    reports = disk.parent.parent / (disk.parent.name + '-notarization')
    run(['node', Path(__file__).with_name('sign-macos.mjs'), source, app, 'developer-id'], cwd, env)
    run(['codesign', '--verify', '--deep', '--strict', app], cwd)
    with tempfile.TemporaryDirectory(prefix='desktop-notarize-') as temporary:
        archive = Path(temporary) / (disk.stem + '-app.zip')
        run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], cwd)
        app_submission = notarize(archive, env, reports)
    run(['xcrun', 'stapler', 'staple', app], cwd)
    verify_app(app, env, run, cwd)
    run(['hdiutil', 'create', '-ov', '-format', 'UDZO', '-volname', 'dhimantAI', '-srcfolder', built, disk], cwd)
    keychain = ['--keychain', env['MACOS_SIGNING_KEYCHAIN']] if env.get('MACOS_SIGNING_KEYCHAIN') else []
    run(['codesign', '--force', '--sign', env['MACOS_SIGNING_IDENTITY'], '--timestamp', *keychain, disk], cwd)
    disk_submission = notarize(disk, env, reports)
    run(['xcrun', 'stapler', 'staple', disk], cwd)
    run(['xcrun', 'stapler', 'validate', disk], cwd)
    run(['codesign', '--verify', '--strict', disk], cwd)
    run(['spctl', '--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', disk], cwd)
    # Validate the actual read-only distribution payload after all mutations.
    with tempfile.TemporaryDirectory(prefix='desktop-verify-') as mount:
        run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, disk], cwd)
        try:
            verify_app(Path(mount) / 'dhimantAI.app', env, run, cwd)
        finally:
            run(['hdiutil', 'detach', mount], cwd)
    return {'teamId': env['APPLE_TEAM_ID'], 'appSubmissionId': app_submission,
            'dmgSubmissionId': disk_submission, 'appStapled': True, 'dmgStapled': True,
            'gatekeeperVerified': True}
