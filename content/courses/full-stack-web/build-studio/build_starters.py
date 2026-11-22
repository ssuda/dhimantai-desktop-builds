"""Build one reproducible Git bundle per entry, from the pilot's explicit file list."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
APP = HERE.parent / 'equipment-desk'
FILES = (
    '.gitignore', 'artisan', 'bootstrap/providers.php',
    'package.json', 'package-lock.json', 'app/Models/Item.php',
    'public/index.php', 'resources/js/Desk.jsx', 'resources/views/desk.blade.php', 'routes/web.php',
    'database/migrations/2026_01_01_000000_create_equipment_tables.php',
)


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    definition = json.loads((HERE / 'entries.json').read_text())
    release = json.loads((HERE.parent / 'runtime.json').read_text())['courses'][definition['course']]
    definition['editor_extensions'] = release['configuration']['editor_extensions']
    env = dict(os.environ, GIT_AUTHOR_DATE='2026-11-21T00:00:00Z',
               GIT_COMMITTER_DATE='2026-11-21T00:00:00Z', GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL=os.devnull)
    with tempfile.TemporaryDirectory() as directory:
        tree = Path(directory)

        def git(*args):
            return subprocess.check_output(['git', '-c', 'user.name=Course author',
                '-c', 'user.email=author@dhimant.ai', '-c', 'core.autocrlf=false',
                *args], cwd=tree, env=env, text=True).strip()

        for name in FILES:
            (tree / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(APP / name, tree / name)
        (tree / 'app/Http/Controllers').mkdir(parents=True)
        shutil.copyfile(HERE / 'LoanController.php', tree / 'app/Http/Controllers/LoanController.php')
        for name in ('composer.json', 'composer.lock'):
            shutil.copyfile(HERE / name, tree / name)
        shutil.copyfile(HERE / 'bootstrap.php', tree / 'bootstrap/app.php')
        shutil.copyfile(HERE / 'jsconfig.json', tree / 'jsconfig.json')
        with (tree / '.gitignore').open('a') as f:
            f.write('\nresources/js/dhimantai-cell-*.jsx\n')
        git('init', '-q', '-b', 'main')
        for entry in definition['entries']:
            if entry['id'] == 'php':
                with (tree / 'routes/web.php').open('a') as f:
                    f.write("\nRoute::get('/items/{item}', fn (Item $item) => $item->only(['id', 'name', 'available']));\n")
            git('add', '.')
            git('commit', '-qm', entry['title'])
            tag = entry['checkpoint']
            git('tag', tag)
            entry['commit'] = git('rev-parse', 'HEAD')
            git('bundle', 'create', str(output.resolve() / (tag + '.bundle')), 'refs/heads/main', 'refs/tags/' + tag)
    (output / 'entries.json').write_text(json.dumps(definition, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    build(parser.parse_args().output)
