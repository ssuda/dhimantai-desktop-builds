"""Run learner commands in a writable Python environment on the container filesystem.

Host shares (especially Windows) need not support pip's chmod/symlink operations.
Image packages remain available; extra packages belong to this container's learner
and survive notebook/terminal restarts. Rebuilds reinstall requirements.txt.
"""
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys
import time


def main():
    root = Path('/tmp', f'dhimantai-python-{os.getuid()}')
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('The learner Python environment is not owned by this account.')
    environment = root / 'venv'
    marker = root / 'ready'
    with os.fdopen(os.open(root / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'w') as lock:
        deadline = time.monotonic() + 90
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Python environment setup is busy. Wait for setup to finish, then retry.')
                time.sleep(0.1)
        if not marker.exists() or not (environment / 'bin/python').exists():
            subprocess.run([sys.executable, '-m', 'venv', '--clear', '--system-site-packages', str(environment)],
                           check=True, timeout=60)
            marker.touch()
    env = dict(os.environ, VIRTUAL_ENV=str(environment), PYTHONNOUSERSITE='1',
               PATH=str(environment / 'bin') + os.pathsep + os.environ.get('PATH', ''),
               PIP_CACHE_DIR=str(root / 'pip-cache'), MPLCONFIGDIR=str(root / 'matplotlib'))
    # A prior shell's --user preference must not redirect pip back onto the host share.
    env.pop('PIP_USER', None)
    args = sys.argv[1:]
    if not args:
        raise ValueError('A learner command is required.')
    os.execvpe(args[0], args, env)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Python environment setup failed: {error}', file=sys.stderr)
        raise SystemExit(1)
