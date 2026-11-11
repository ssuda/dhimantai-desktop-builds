"""Initialize the mapped learner before starting a published Compose service."""
import os
from pathlib import Path
import subprocess
import sys

uid, gid = map(int, sys.argv[1:3])
command = sys.argv[3:]
if not command or uid <= 0 or gid < 0:
    raise ValueError('A course service needs a learner identity and a command.')
subprocess.run([sys.executable, '/opt/dhimantai/user.py', str(uid), str(gid)], check=True)
os.setgroups([gid])
os.setgid(gid)
os.setuid(uid)
Path('/tmp/dhimantai-runtime-ready').touch()
os.execvp(command[0], command)
