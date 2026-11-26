"""Start an in-container debugger and wait until its loopback-forwarded port is listening."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

PORT = 5678


def listening():
    for table in (Path('/proc/net/tcp'), Path('/proc/net/tcp6')):
        if table.exists():
            for line in table.read_text().splitlines()[1:]:
                fields = line.split()
                if fields[1].endswith(f':{PORT:04X}') and fields[3] == '0A':
                    return True
    return False


def main():
    if listening():
        sys.exit('A debugger is already running in this course. Finish that session first.')
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=output,
                                 stderr=output, start_new_session=True)
        for _ in range(300):
            if child.poll() is not None:
                output.seek(0)
                sys.exit(output.read(2000).decode(errors='replace') or 'The debugger stopped.')
            if listening():
                return
            time.sleep(0.05)
        os.killpg(child.pid, 9)
        sys.exit('The course debugger did not start listening.')


if __name__ == '__main__':
    main()
