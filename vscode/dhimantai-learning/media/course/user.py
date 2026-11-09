"""Give the host-mapped learner UID a login identity for the course shell and sudo."""
import grp
import os
import pwd
from pathlib import Path
import subprocess
import sys

uid, gid = map(int, sys.argv[1:])
subprocess.run(['/bin/sh', '/opt/dhimantai/shell.sh'], check=True)
try:
    grp.getgrgid(gid)
except KeyError:
    subprocess.run(['groupadd', '--gid', str(gid), f'course-{gid}'], check=True)
try:
    user = pwd.getpwuid(uid)
    subprocess.run(['usermod', '--home', '/course/.home', '--shell', '/bin/zsh', user.pw_name], check=True)
except KeyError:
    subprocess.run(['useradd', '--no-log-init', '--no-create-home', '--uid', str(uid),
                    '--gid', str(gid), '--home-dir', '/course/.home',
                    '--shell', '/bin/zsh', f'course-{uid}'], check=True)
home = Path('/course/.home')
for folder in [home, home / '.oh-my-zsh-custom', home / '.cache', home / '.cache/oh-my-zsh']:
    folder.mkdir(exist_ok=True)
    os.chown(folder, uid, gid)
try:
    with (home / '.zshrc').open('x') as target:
        target.write(Path('/opt/dhimantai/zshrc').read_text())
    os.chown(home / '.zshrc', uid, gid)
except FileExistsError:
    pass
