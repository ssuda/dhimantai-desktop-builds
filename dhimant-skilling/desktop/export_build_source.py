#!/usr/bin/env python3
"""Export committed desktop inputs to the separate GitHub build repository."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
INPUTS = ['.github/workflows/desktop-preview.yml', '.github/workflows/desktop-build.yml', '.github/workflows/desktop-windows-acceptance.yml', 'dhimant-skilling/desktop',
          'dhimant-skilling/dhimantai-learning', 'website/upskill/assets/dhimantai-logo.png',
          'assets/epub_reader', 'agent/course_projects/data/book_companions.json',
          'content/courses/build-an-llm-from-scratch/*.md']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if git('status', '--porcelain', '--', *INPUTS).strip():
        raise RuntimeError('Commit desktop build inputs before exporting')
    if args.out.exists():
        raise RuntimeError('Use an empty output directory')
    commit = git('rev-parse', 'HEAD').decode().strip()
    files = git('ls-files', '-z', '--', *INPUTS).decode().strip('\0').split('\0')
    hashes = {}
    for name in files:
        path = Path(name)
        if path.name.startswith('.env') or path.suffix.lower() in (
                '.vsix', '.pem', '.key', '.p8', '.p12', '.pfx', '.keychain', '.keychain-db') or path.name == 'desktop-client.json':
            raise RuntimeError(f'Unexpected private or generated input: {name}')
        data = git('show', f'{commit}:{name}')
        target = args.out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    (args.out / 'build-source.json').write_text(json.dumps(dict(sourceCommit=commit,
        sourceRepository='bitbucket.org/optficial/dhimantai', files=hashes), indent=2) + '\n')
    (args.out / '.gitignore').write_text('node_modules/\n**/out/\n**/__pycache__/\n*.vsix\n.env*\ndesktop-flutter.json\n'
                                      '*.p8\n*.p12\n*.pfx\n*.pem\n*.key\n*.keychain*\n')
    (args.out / '.gitattributes').write_text('# Preserve exported bytes for source provenance on every OS.\n* -text\n')
    (args.out / 'README.md').write_text('# dhimantAI desktop builds\n\nBuild inputs exported from commit `' + commit + '`.\n\n'
        'The source of truth is the Bitbucket repository. Only desktop inputs are mirrored here; '
        'shared reader assets and packaged course data are included, but backend and Flutter app '
        'code and repository history are excluded. Every push to main starts the staging desktop build '
        'automatically: Windows x64 and its installer acceptance, macOS ARM64, macOS x64, then Linux x64, '
        'one job at a time. Linux ARM64 and Windows ARM64 are excluded. '
        'Configure FLUTTER_STAGING_ENV_JSON as an Actions secret '
        'containing only LIVEKIT_TOKEN_URL and LIVEKIT_TOKEN_SECRET. The staging pipeline explicitly uses '
        'ad-hoc macOS signing without notarization. For Developer ID builds, configure the Apple Actions secrets listed in '
        '[the desktop guide](dhimant-skilling/desktop/README.md#macos-developer-id-signing-and-notarization). '
        'Then change both macOS callers to macos_signing: developer-id.\n\n'
        'Installers and their SHA-256 build receipts are retained as workflow artifacts. '
        'Publishing them to dhimant.ai is a separate release step.\n')
    print(f'Exported {len(files)} desktop inputs from {commit} to {args.out}')


if __name__ == '__main__':
    main()
