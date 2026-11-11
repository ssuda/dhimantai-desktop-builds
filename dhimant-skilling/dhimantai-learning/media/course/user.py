"""Give the host-mapped learner UID a login identity for the course shell and sudo."""
import grp
import os
import pwd
from pathlib import Path
import subprocess
import sys

uid, gid = map(int, sys.argv[1:])
home = Path(os.environ.get('HOME', '/course/.home')).resolve()
if not home.is_relative_to('/course/.home'):
    raise ValueError('The learner home must be inside the course home directory.')
subprocess.run(['/bin/sh', '/opt/dhimantai/shell.sh'], check=True)
try:
    grp.getgrgid(gid)
except KeyError:
    subprocess.run(['/usr/sbin/groupadd', '--gid', str(gid), f'course-{gid}'], check=True)
try:
    user = pwd.getpwuid(uid)
    subprocess.run(['/usr/sbin/usermod', '--home', str(home), '--shell', '/bin/zsh', user.pw_name], check=True)
except KeyError:
    subprocess.run(['/usr/sbin/useradd', '--no-log-init', '--no-create-home', '--uid', str(uid),
                    '--gid', str(gid), '--home-dir', str(home),
                    '--shell', '/bin/zsh', f'course-{uid}'], check=True)
for folder in [Path('/course/.home'), home, home / '.oh-my-zsh-custom', home / '.cache', home / '.cache/oh-my-zsh']:
    folder.mkdir(parents=True, exist_ok=True)
    os.chown(folder, uid, gid)
try:
    with (home / '.zshrc').open('x') as target:
        target.write(Path('/opt/dhimantai/zshrc').read_text())
    os.chown(home / '.zshrc', uid, gid)
except FileExistsError:
    pass
